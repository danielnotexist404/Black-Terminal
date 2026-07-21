import { sanitizeError } from "./repository.js";
import { createCloudExchangeAdapter } from "./adapters/registry.js";
import { ReconciliationWorker } from "./reconciliation-worker.js";

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
        if (!this.connections.has(row.id)) await this.startConnection(row).catch((error) => this.recordStartFailure(row, error));
      }
      for (const id of this.connections.keys()) {
        if (!desired.has(id)) await this.stopConnection(id, "connection_disabled");
      }
    } finally {
      if (this.running) this.refreshTimer = setTimeout(() => void this.refresh(), this.refreshIntervalMs);
    }
  }

  async startConnection(connection) {
    if (connection.provider !== "bybit" || process.env.BYBIT_CLOUD_EXECUTION_ENABLED !== "true") return;
    const connectionNetwork = connection.metadata?.network || "mainnet";
    const workerNetwork = process.env.BLACK_CLOUD_NETWORK || "testnet";
    if (connectionNetwork !== workerNetwork) throw Object.assign(new Error(`Connection network ${connectionNetwork} cannot run on ${workerNetwork} worker.`), { code: "WORKER_NETWORK_MISMATCH" });
    const lease = await this.repository.acquireLease(connection.id, this.leaseTtlSeconds);
    if (!lease) return;
    const [account, secretReference] = await Promise.all([
      single(this.supabase.from("exchange_accounts").select("*").eq("id", connection.account_id)),
      single(this.supabase.from("broker_secret_references").select("id").eq("connection_id", connection.id).eq("status", "ACTIVE"))
    ]);
    const credentials = await this.repository.readBrokerSecret(secretReference.id, "private_stream_authentication");
    const adapter = createCloudExchangeAdapter(connection.provider, {
      credentials,
      network: connectionNetwork,
      connectionId: connection.id
    });
    const runtime = {
      connection,
      account,
      credentials,
      adapter,
      client: null,
      fencingToken: Number(lease.fencing_token),
      stopped: false,
      reconciling: false,
      reconcileTimer: null,
      heartbeatTimer: null,
      periodicTimer: null,
      seenEvents: new Map()
    };
    this.connections.set(connection.id, runtime);
    await updateOrThrow(this.supabase.from("connectivity_connections").update({
      health_status: "RECONCILING",
      lifecycle_status: "VALIDATING",
      last_error_code: null,
      last_error_at: null
    }).eq("id", connection.id));
    runtime.client = await adapter.subscribePrivateEvents({
      onMessage: (event) => void this.handleEvent(runtime, event),
      onError: (error) => void this.handleError(runtime, error)
    });
    await updateOrThrow(this.supabase.from("connectivity_connections").update({
      lifecycle_status: "CONNECTED",
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
      metadata: { provider: "bybit", network: connection.metadata?.network || account.network || "mainnet" }
    });
  }

  startTimers(runtime) {
    runtime.heartbeatTimer = setInterval(() => void this.heartbeat(runtime), Math.max(5_000, this.leaseTtlSeconds * 400));
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
    const eventAt = new Date(Number(event.time || Date.now())).toISOString();
    await updateOrThrow(this.supabase.from("connectivity_connections").update({
      health_status: "CONNECTED_CLOUD",
      lifecycle_status: "HEALTHY",
      last_private_event_at: eventAt,
      last_heartbeat_at: new Date().toISOString(),
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
      metadata: safeEventMetadata(event)
    });
    this.scheduleReconciliation(runtime, "PRIVATE_EVENT");
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
      await updateOrThrow(this.supabase.from("connectivity_connections").update({
        health_status: "CONNECTED_CLOUD",
        lifecycle_status: "HEALTHY",
        last_reconciled_at: result.syncedAt,
        last_error_code: null
      }).eq("id", runtime.connection.id));
    } catch (error) {
      await this.handleError(runtime, error);
    } finally {
      runtime.reconciling = false;
    }
  }

  async writeHealth(runtime) {
    const diagnostics = runtime.client.diagnostics();
    const healthStatus = diagnostics.status === "connected" ? "CONNECTED_CLOUD" : diagnostics.status === "stale" ? "DEGRADED" : "RECONCILING";
    const lifecycleStatus = diagnostics.status === "connected" ? "HEALTHY" : diagnostics.status === "reconnecting" || diagnostics.status === "connecting" || diagnostics.status === "authenticating" ? "RECONNECTING" : "DEGRADED";
    await updateOrThrow(this.supabase.from("connectivity_connections").update({
      health_status: healthStatus,
      lifecycle_status: lifecycleStatus,
      last_heartbeat_at: new Date().toISOString(),
      last_private_event_at: diagnostics.lastMessageAt ? new Date(Number(diagnostics.lastMessageAt)).toISOString() : runtime.connection.last_private_event_at,
      last_error_code: diagnostics.lastError ? "PRIVATE_STREAM_ERROR" : null,
      last_error_at: diagnostics.lastError ? new Date().toISOString() : null
    }).eq("id", runtime.connection.id));
    runtime.connection.health_status = healthStatus;
    runtime.connection.lifecycle_status = lifecycleStatus;
    await this.supabase.from("broker_connection_health").insert({
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
    });
  }

  async handleError(runtime, error) {
    const message = sanitizeError(error?.message || error);
    await updateOrThrow(this.supabase.from("connectivity_connections").update({
      health_status: "DEGRADED",
      lifecycle_status: "DEGRADED",
      last_error_code: error?.code || "PRIVATE_STREAM_ERROR",
      last_error_at: new Date().toISOString()
    }).eq("id", runtime.connection.id));
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
    await updateOrThrow(this.supabase.from("connectivity_connections").update({
      health_status: "ERROR",
      lifecycle_status: "FAILED",
      last_error_code: error?.code || "WORKER_START_FAILED",
      last_error_at: new Date().toISOString()
    }).eq("id", connection.id)).catch(() => null);
  }

  async stopConnection(connectionId, reason) {
    const runtime = this.connections.get(connectionId);
    if (!runtime) return;
    runtime.stopped = true;
    runtime.client.disconnect();
    if (runtime.reconcileTimer) clearTimeout(runtime.reconcileTimer);
    if (runtime.heartbeatTimer) clearInterval(runtime.heartbeatTimer);
    if (runtime.periodicTimer) clearInterval(runtime.periodicTimer);
    runtime.credentials = null;
    this.connections.delete(connectionId);
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
