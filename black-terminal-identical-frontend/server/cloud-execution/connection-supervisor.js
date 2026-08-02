import { sanitizeError } from "./repository.js";
import { createCloudExchangeAdapter } from "./adapters/registry.js";
import { ReconciliationWorker } from "./reconciliation-worker.js";
import { normalizeBybitExecutionEnvironment } from "../exchanges/bybit-endpoints.js";

export class BrokerConnectionManager {
  constructor(supabase, repository, options = {}) {
    this.supabase = supabase;
    this.repository = repository;
    this.workerId = repository.workerId;
    this.refreshIntervalMs = options.refreshIntervalMs || 15_000;
    this.reconcileIntervalMs = options.reconcileIntervalMs || 30_000;
    this.leaseTtlSeconds = options.leaseTtlSeconds || 30;
    this.connections = new Map();
    this.reconciliationWorker = new ReconciliationWorker(supabase, this.workerId);
    this.running = false;
    this.refreshTimer = null;
  }

  async start() {
    this.running = true;
    await this.refresh();
  }

  async stop() {
    this.running = false;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    await Promise.allSettled([...this.connections.keys()].map((id) => this.stopConnection(id, "worker_shutdown")));
  }

  diagnostics() {
    const health = [...this.connections.values()].map((runtime) => runtime.adapter?.getHealth?.() || {});
    return {
      activeConnections: this.connections.size,
      readyConnections: health.filter((row) => row.connected === true && row.state === "READY").length,
      degradedConnections: health.filter((row) => row.state === "DEGRADED").length,
      reconnectCount: health.reduce((sum, row) => sum + Number(row.reconnectAttempts || 0), 0),
      oldestAccountStreamAgeMs: health.reduce((oldest, row) => row.lastAccountEventAt
        ? Math.max(oldest, Date.now() - Number(row.lastAccountEventAt))
        : oldest, 0)
    };
  }

  async refresh() {
    if (!this.running) return;
    try {
      const { data, error } = await this.supabase
        .from("connectivity_connections")
        .select("*")
        .in("connection_mode", ["CLOUD_DELEGATED", "HYBRID"])
        .is("revoked_at", null)
        .is("disabled_at", null);
      if (error) throw error;
      const desired = new Set((data || []).map((row) => row.id));
      for (const row of data || []) {
        const runtime = this.connections.get(row.id);
        if (!runtime) await this.startConnection(row).catch((error) => this.recordStartFailure(row, error));
        else {
          runtime.connection = row;
          await this.repository.requireAutomationMandate(row.id, "read").catch(async () => this.stopConnection(row.id, "mandate_inactive"));
        }
      }
      for (const id of this.connections.keys()) {
        if (!desired.has(id)) await this.stopConnection(id, "connection_disabled");
      }
    } finally {
      if (this.running) this.refreshTimer = setTimeout(() => void this.refresh(), this.refreshIntervalMs);
    }
  }

  async startConnection(connection) {
    if (connection.provider !== "bybit") throw typedError("PROVIDER_UNSUPPORTED", `${connection.provider} has no registered persistent Black Cloud adapter.`);
    if (process.env.BYBIT_CLOUD_EXECUTION_ENABLED !== "true") throw typedError("PROVIDER_DISABLED", "The Bybit Black Cloud adapter is disabled by rollout policy.");
    const connectionEnvironment = normalizeBybitExecutionEnvironment(connection.execution_environment || connection.metadata?.executionEnvironment || connection.metadata?.network);
    const workerEnvironment = normalizeBybitExecutionEnvironment(process.env.BLACK_CLOUD_EXECUTION_ENVIRONMENT || process.env.BYBIT_EXECUTION_ENVIRONMENT || process.env.BLACK_CLOUD_NETWORK);
    if (connectionEnvironment !== workerEnvironment) throw Object.assign(new Error(`Connection environment ${connectionEnvironment} cannot run on ${workerEnvironment} worker.`), { code: "WORKER_ENVIRONMENT_MISMATCH" });
    const lease = await this.repository.acquireLease(connection.id, this.leaseTtlSeconds);
    if (!lease) return;
    const [account, secretReference, mandate] = await Promise.all([
      single(this.supabase.from("exchange_accounts").select("*").eq("id", connection.account_id)),
      single(this.supabase.from("broker_secret_references").select("id").eq("connection_id", connection.id).eq("status", "ACTIVE")),
      this.repository.requireAutomationMandate(connection.id, "trade")
    ]);
    const credentials = await this.repository.readBrokerSecret(secretReference.id, "private_stream_authentication");
    const credentialEnvironment = normalizeBybitExecutionEnvironment(credentials.executionEnvironment || credentials.network);
    if (credentialEnvironment !== connectionEnvironment) throw typedError("CREDENTIAL_ENVIRONMENT_MISMATCH", "The broker credential is bound to a different execution environment.");
    if (normalizeBybitExecutionEnvironment(mandate.execution_environment) !== connectionEnvironment) throw typedError("MANDATE_ENVIRONMENT_MISMATCH", "The active automation mandate is bound to a different execution environment.");
    const adapter = createCloudExchangeAdapter(connection.provider, {
      credentials,
      executionEnvironment: connectionEnvironment,
      endpointProfile: connection.endpoint_profile || connection.metadata?.endpointProfile || "GLOBAL",
      connectionId: connection.id
    });
    const runtime = {
      connection,
      account,
      credentials,
      adapter,
      mandate,
      client: null,
      fencingToken: Number(lease.fencing_token),
      stopped: false,
      reconciling: false,
      reconcileTimer: null,
      heartbeatTimer: null,
      periodicTimer: null,
      lastPrivateStreamStatus: "disconnected",
      lastReconnectCount: 0,
      seenEvents: new Map()
    };
    this.connections.set(connection.id, runtime);
    await updateOrThrow(this.supabase.from("connectivity_connections").update({
      status: "degraded",
      health_status: "RECONCILING",
      lifecycle_status: "VALIDATING",
      credential_state: "VERIFYING",
      worker_state: "STARTING",
      synchronization_state: "NOT_SYNCHRONIZED",
      execution_readiness: "BLOCKED",
      current_lease_generation: Number(lease.fencing_token),
      degradation_reasons: [],
      last_error_code: null,
      last_error_at: null
    }).eq("id", connection.id));
    const verification = await adapter.verifyCredentials();
    if (verification?.diagnostics?.permissions?.withdrawal) throw typedError("WITHDRAWAL_PERMISSION_DETECTED", "Withdrawal-enabled credentials are forbidden.");
    if (verification?.diagnostics?.permissions?.transfer) throw typedError("TRANSFER_PERMISSION_DETECTED", "Wallet-transfer-enabled credentials are forbidden.");
    if (!verification?.diagnostics?.permissions?.trading) throw typedError("PERMISSION_REJECTED", "The broker credential does not permit trading.");
    if (String(verification?.diagnostics?.accountUid || "") !== String(connection.broker_account_uid || "")) throw typedError("BROKER_ACCOUNT_UID_MISMATCH", "The authenticated Bybit UID no longer matches this connection.");
    runtime.client = await adapter.subscribeAccountEvents(
      (event) => void this.handleEvent(runtime, event).catch((error) => this.handleError(runtime, error)),
      { onError: (error) => void this.handleError(runtime, error) }
    );
    runtime.lastPrivateStreamStatus = runtime.client.diagnostics().status;
    runtime.lastReconnectCount = Number(runtime.client.diagnostics().reconnectCount || 0);
    await updateOrThrow(this.supabase.from("connectivity_connections").update({
      lifecycle_status: "CONNECTED",
      credential_state: "AUTHENTICATED",
      worker_state: "LIVE",
      permission_snapshot: verification.diagnostics.permissionSnapshot || {},
      certification_state: "SYNCHRONIZING",
      last_authenticated_at: new Date().toISOString()
    }).eq("id", connection.id));
    await this.reconcile(runtime, "STARTUP");
    this.startTimers(runtime);
    await this.repository.audit({
      userId: connection.user_id,
      connectionId: connection.id,
      eventType: "PRIVATE_STREAM_STARTED",
      userVisible: true,
      purpose: "private_stream_authentication",
      message: "Black Cloud started the persistent Bybit private stream.",
      metadata: { provider: "bybit", executionEnvironment: connectionEnvironment, endpointProfile: connection.endpoint_profile || "GLOBAL" }
    });
  }

  startTimers(runtime) {
    runtime.heartbeatTimer = setInterval(
      () => void this.heartbeat(runtime).catch((error) => this.handleError(runtime, error).catch(() => null)),
      Math.max(5_000, this.leaseTtlSeconds * 400)
    );
    runtime.periodicTimer = setInterval(() => void this.reconcile(runtime, "SCHEDULED"), this.reconcileIntervalMs);
  }

  async heartbeat(runtime) {
    if (runtime.stopped) return;
    const lease = await this.repository.acquireLease(runtime.connection.id, this.leaseTtlSeconds).catch(() => null);
    if (!lease || Number(lease.fencing_token) !== runtime.fencingToken) {
      await this.stopConnection(runtime.connection.id, "lease_lost");
      return;
    }
    await this.writeHealth(runtime);
  }

  async handleEvent(runtime, event) {
    if (runtime.stopped || this.isDuplicate(runtime, event)) return;
    const inbox = await this.repository.recordInboxEvent(runtime.connection, event);
    if (!inbox.inserted) return;
    const eventAt = new Date(Number(event.time || Date.now())).toISOString();
    try {
      await updateOrThrow(this.supabase.from("connectivity_connections").update({
        health_status: "CONNECTED_CLOUD",
        lifecycle_status: "HEALTHY",
        worker_state: "LIVE",
        last_private_event_at: eventAt,
        last_account_event_at: eventAt,
        last_order_event_at: ["order", "execution"].includes(event.type) ? eventAt : runtime.connection.last_order_event_at,
        last_heartbeat_at: new Date().toISOString(),
        degradation_reasons: [],
        last_error_code: null
      }).eq("id", runtime.connection.id));
      if (event.type === "order") await this.applyOrderEvent(runtime, event.report);
      if (event.type === "execution") await this.applyFillEvent(runtime, event.fill);
      await this.repository.audit({
        userId: runtime.connection.user_id,
        connectionId: runtime.connection.id,
        eventType: `PRIVATE_${String(event.type).toUpperCase()}_EVENT`,
        userVisible: ["order", "execution", "position"].includes(event.type),
        purpose: "private_stream_event",
        message: `Bybit private ${event.type} event received by Black Cloud.`,
        metadata: { ...safeEventMetadata(event), eventIdentity: inbox.eventIdentity }
      });
      await this.repository.markInboxEvent(inbox.id, "APPLIED");
      this.scheduleReconciliation(runtime, "PRIVATE_EVENT");
    } catch (error) {
      await this.repository.markInboxEvent(inbox.id, "FAILED", error?.code || "EVENT_APPLY_FAILED").catch(() => null);
      throw error;
    }
  }

  async applyOrderEvent(runtime, report) {
    if (!report?.clientOrderId?.startsWith("bt-")) return;
    const { data: order } = await this.supabase.from("execution_orders").select("id").eq("account_id", runtime.account.id).eq("client_order_id", report.clientOrderId).maybeSingle();
    if (!order) return;
    await updateOrThrow(this.supabase.from("execution_orders").update({
      status: normalizeOrderStatus(report.status),
      exchange_order_id: report.exchangeOrderId || report.orderId,
      filled_quantity: report.filledQuantity || 0,
      average_fill_price: report.averageFillPrice,
      rejection_reason: report.rejectReason || null
    }).eq("id", order.id));
    await updateOrThrow(this.supabase.from("follower_execution_plans").update({
      execution_status: normalizePlanStatus(report.status)
    }).eq("execution_order_id", order.id));
  }

  async applyFillEvent(runtime, fill) {
    if (!fill?.clientOrderId?.startsWith("bt-")) return;
    const { data: order } = await this.supabase.from("execution_orders").select("id,filled_quantity,quantity").eq("account_id", runtime.account.id).eq("client_order_id", fill.clientOrderId).maybeSingle();
    if (!order) return;
    const cumulative = Number(order.filled_quantity || 0) + Number(fill.quantity || 0);
    const filled = cumulative + 1e-12 >= Number(order.quantity || 0);
    await updateOrThrow(this.supabase.from("execution_orders").update({
      status: filled ? "filled" : "partially-filled",
      filled_quantity: cumulative,
      average_fill_price: fill.price,
      actual_fees: fill.fee
    }).eq("id", order.id));
    await updateOrThrow(this.supabase.from("follower_execution_plans").update({
      execution_status: filled ? "FILLED" : "PARTIALLY_FILLED"
    }).eq("execution_order_id", order.id));
  }

  scheduleReconciliation(runtime, triggerType) {
    if (runtime.reconcileTimer || runtime.stopped) return;
    runtime.reconcileTimer = setTimeout(() => {
      runtime.reconcileTimer = null;
      void this.reconcile(runtime, triggerType);
    }, 750);
  }

  async reconcile(runtime, triggerType) {
    if (runtime.stopped || runtime.reconciling) return;
    runtime.reconciling = true;
    try {
      const result = await this.reconciliationWorker.run({ adapter: runtime.adapter, connection: runtime.connection, account: runtime.account, triggerType });
      if (!result.executionState?.tradingEnabled) {
        throw typedError("CREDENTIAL_PERMISSION_CHANGED", result.executionState?.readinessReason || "Bybit credential permissions no longer satisfy the trade-only execution contract.");
      }
      if (String(result.brokerAccountUid || "") !== String(runtime.connection.broker_account_uid || "")) {
        throw typedError("BROKER_ACCOUNT_UID_MISMATCH", "The reconciled Bybit UID no longer matches this connection.");
      }
      await updateOrThrow(this.supabase.from("connectivity_connections").update({
        status: "connected",
        health_status: "CONNECTED_CLOUD",
        lifecycle_status: "HEALTHY",
        worker_state: "LIVE",
        synchronization_state: "SYNCHRONIZED",
        execution_readiness: runtime.connection.control_state === "ACTIVE" ? "READY" : "PAUSED",
        certification_state: runtime.connection.control_state === "ACTIVE" ? "READY" : "SYNCHRONIZING",
        permission_snapshot: result.permissionSnapshot || {},
        last_reconciled_at: result.syncedAt,
        last_position_sync_at: result.syncedAt,
        degradation_reasons: [],
        last_error_code: null
      }).eq("id", runtime.connection.id));
      const diagnostics = runtime.client?.diagnostics?.();
      runtime.connection.status = "connected";
      runtime.connection.health_status = "CONNECTED_CLOUD";
      runtime.connection.lifecycle_status = "HEALTHY";
      runtime.connection.synchronization_state = "SYNCHRONIZED";
      runtime.connection.execution_readiness = runtime.connection.control_state === "ACTIVE" ? "READY" : "PAUSED";
      runtime.connection.last_reconciled_at = result.syncedAt;
      runtime.lastPrivateStreamStatus = diagnostics?.status || runtime.lastPrivateStreamStatus;
      runtime.lastReconnectCount = Number(diagnostics?.reconnectCount || runtime.lastReconnectCount || 0);
    } catch (error) {
      await this.handleError(runtime, error);
    } finally {
      runtime.reconciling = false;
    }
  }

  async writeHealth(runtime) {
    const diagnostics = runtime.client.diagnostics();
    const reconnected = diagnostics.status === "connected"
      && (runtime.lastPrivateStreamStatus !== "connected"
        || Number(diagnostics.reconnectCount || 0) > runtime.lastReconnectCount);
    const synchronizationState = diagnostics.status !== "connected"
      ? "STALE"
      : reconnected
        ? "SYNCHRONIZING"
        : runtime.connection.synchronization_state || "NOT_SYNCHRONIZED";
    const executionReady = diagnostics.status === "connected"
      && synchronizationState === "SYNCHRONIZED"
      && runtime.connection.control_state === "ACTIVE";
    const healthStatus = diagnostics.status === "connected" ? "CONNECTED_CLOUD" : diagnostics.status === "stale" ? "DEGRADED" : "RECONCILING";
    const lifecycleStatus = diagnostics.status === "connected" ? "HEALTHY" : diagnostics.status === "reconnecting" || diagnostics.status === "connecting" || diagnostics.status === "authenticating" ? "RECONNECTING" : "DEGRADED";
    await updateOrThrow(this.supabase.from("connectivity_connections").update({
      status: diagnostics.status === "connected" ? "connected" : "degraded",
      health_status: healthStatus,
      lifecycle_status: lifecycleStatus,
      worker_state: diagnostics.status === "connected" ? "LIVE" : diagnostics.status === "reconnecting" ? "RECONNECTING" : "DEGRADED",
      synchronization_state: synchronizationState,
      execution_readiness: executionReady ? "READY" : "BLOCKED",
      certification_state: executionReady ? "READY" : "DEGRADED",
      last_heartbeat_at: new Date().toISOString(),
      last_private_event_at: diagnostics.lastMessageAt ? new Date(Number(diagnostics.lastMessageAt)).toISOString() : runtime.connection.last_private_event_at,
      last_error_code: diagnostics.lastError ? "PRIVATE_STREAM_ERROR" : null,
      last_error_at: diagnostics.lastError ? new Date().toISOString() : null,
      reconnect_attempts: Number(diagnostics.reconnectCount || 0),
      current_lease_generation: runtime.fencingToken,
      degradation_reasons: diagnostics.lastError ? ["PRIVATE_STREAM_ERROR"] : []
    }).eq("id", runtime.connection.id));
    runtime.connection.health_status = healthStatus;
    runtime.connection.lifecycle_status = lifecycleStatus;
    runtime.connection.synchronization_state = synchronizationState;
    runtime.connection.execution_readiness = executionReady ? "READY" : "BLOCKED";
    runtime.lastPrivateStreamStatus = diagnostics.status;
    runtime.lastReconnectCount = Number(diagnostics.reconnectCount || 0);
    await updateOrThrow(this.supabase.from("broker_connection_health").insert({
      connection_id: runtime.connection.id,
      user_id: runtime.connection.user_id,
      health_status: healthStatus,
      worker_id: this.workerId,
      private_stream_status: diagnostics.status,
      reconciliation_status: runtime.reconciling ? "RUNNING" : "IDLE",
      reconnect_count: diagnostics.reconnectCount,
      last_private_event_at: diagnostics.lastMessageAt ? new Date(Number(diagnostics.lastMessageAt)).toISOString() : null,
      last_reconciled_at: runtime.connection.last_reconciled_at,
      stale_after: diagnostics.lastMessageAt ? new Date(Number(diagnostics.lastMessageAt) + diagnostics.staleAfterMs).toISOString() : null,
      error_code: diagnostics.lastError ? "PRIVATE_STREAM_ERROR" : null,
      safe_details: { authenticated: diagnostics.authenticated, topics: diagnostics.topics, subscriptionCount: diagnostics.subscriptionCount }
    }));
    if (reconnected) this.scheduleReconciliation(runtime, "PRIVATE_STREAM_RECONNECTED");
  }

  async handleError(runtime, error) {
    const message = sanitizeError(error?.message || error);
    await updateOrThrow(this.supabase.from("connectivity_connections").update({
      status: "degraded",
      health_status: "DEGRADED",
      lifecycle_status: "DEGRADED",
      worker_state: "DEGRADED",
      synchronization_state: "STALE",
      execution_readiness: "BLOCKED",
      degradation_reasons: [error?.code || "PRIVATE_STREAM_ERROR"],
      last_error_code: error?.code || "PRIVATE_STREAM_ERROR",
      last_error_at: new Date().toISOString()
    }).eq("id", runtime.connection.id));
    runtime.connection.synchronization_state = "STALE";
    runtime.connection.execution_readiness = "BLOCKED";
    await this.repository.audit({
      userId: runtime.connection.user_id,
      connectionId: runtime.connection.id,
      eventType: "CONNECTION_DEGRADED",
      severity: "WARNING",
      purpose: "connection_health",
      message,
      metadata: { provider: runtime.connection.provider }
    }).catch(() => null);
  }

  async recordStartFailure(connection, error) {
    const runtime = this.connections.get(connection.id);
    if (runtime) {
      runtime.stopped = true;
      if (runtime.reconcileTimer) clearTimeout(runtime.reconcileTimer);
      if (runtime.heartbeatTimer) clearInterval(runtime.heartbeatTimer);
      if (runtime.periodicTimer) clearInterval(runtime.periodicTimer);
      await runtime.adapter?.disconnect?.("start_failed").catch(() => null);
      runtime.credentials = null;
      this.connections.delete(connection.id);
    }
    await updateOrThrow(this.supabase.from("connectivity_connections").update({
      status: "degraded",
      health_status: "ERROR",
      lifecycle_status: "FAILED",
      worker_state: "FAILED",
      synchronization_state: "FAILED",
      execution_readiness: "FAILED",
      degradation_reasons: [error?.code || "WORKER_START_FAILED"],
      last_error_code: error?.code || "WORKER_START_FAILED",
      last_error_at: new Date().toISOString()
    }).eq("id", connection.id)).catch(() => null);
    await this.repository.audit({
      userId: connection.user_id,
      connectionId: connection.id,
      eventType: "PERSISTENT_CONNECTION_START_FAILED",
      severity: "ERROR",
      purpose: "worker_lifecycle",
      userVisible: true,
      message: sanitizeError(error?.message || error),
      metadata: { provider: connection.provider, code: error?.code || "WORKER_START_FAILED" }
    }).catch(() => null);
  }

  async stopConnection(connectionId, reason) {
    const runtime = this.connections.get(connectionId);
    if (!runtime) return;
    runtime.stopped = true;
    await runtime.adapter.disconnect(reason).catch(() => null);
    if (runtime.reconcileTimer) clearTimeout(runtime.reconcileTimer);
    if (runtime.heartbeatTimer) clearInterval(runtime.heartbeatTimer);
    if (runtime.periodicTimer) clearInterval(runtime.periodicTimer);
    runtime.credentials = null;
    this.connections.delete(connectionId);
    await updateOrThrow(this.supabase.from("connectivity_connections").update({
      status: "disconnected",
      worker_state: reason === "lease_lost" ? "SUSPENDED" : "OFFLINE",
      execution_readiness: "BLOCKED",
      degradation_reasons: [reason]
    }).eq("id", connectionId)).catch(() => null);
    await this.repository.audit({
      userId: runtime.connection.user_id,
      connectionId,
      eventType: "PRIVATE_STREAM_STOPPED",
      severity: reason === "lease_lost" ? "WARNING" : "INFO",
      purpose: "worker_lifecycle",
      userVisible: reason !== "worker_shutdown",
      message: "Black Cloud stopped the persistent private stream.",
      metadata: { reason }
    }).catch(() => null);
  }

  isDuplicate(runtime, event) {
    const key = [event.type, event.report?.orderId, event.fill?.fillId, event.time].filter(Boolean).join(":");
    if (!key) return false;
    const now = Date.now();
    for (const [eventKey, seenAt] of runtime.seenEvents) if (now - seenAt > 10 * 60_000) runtime.seenEvents.delete(eventKey);
    if (runtime.seenEvents.has(key)) return true;
    runtime.seenEvents.set(key, now);
    return false;
  }
}

// Compatibility alias for pre-Chapter-II imports.
export const CloudConnectionSupervisor = BrokerConnectionManager;

function safeEventMetadata(event) {
  if (event.type === "order") return { orderId: event.report?.orderId, clientOrderId: event.report?.clientOrderId, status: event.report?.status, symbol: event.report?.symbol };
  if (event.type === "execution") return { fillId: event.fill?.fillId, orderId: event.fill?.orderId, symbol: event.fill?.symbol, quantity: event.fill?.quantity, price: event.fill?.price };
  if (event.type === "position") return { symbol: event.position?.symbol, direction: event.position?.direction, quantity: event.position?.quantity };
  if (event.type === "wallet") return { asset: event.wallet?.asset, accountType: event.wallet?.accountType };
  return { type: event.type };
}

function normalizeOrderStatus(value) {
  if (value === "partially-filled") return "partially-filled";
  if (["filled", "cancelled", "rejected", "expired"].includes(value)) return value;
  return "accepted";
}

function normalizePlanStatus(value) {
  if (value === "partially-filled") return "PARTIALLY_FILLED";
  if (value === "filled") return "FILLED";
  if (value === "cancelled") return "CANCELLED";
  if (value === "rejected") return "VENUE_REJECTED";
  return "WORKING";
}

async function single(query) {
  const { data, error } = await query.single();
  if (error || !data) throw error || new Error("Required cloud connection record was not found.");
  return data;
}

async function updateOrThrow(query) {
  const { error } = await query;
  if (error) throw error;
}

function typedError(code, message) { return Object.assign(new Error(message), { code }); }
