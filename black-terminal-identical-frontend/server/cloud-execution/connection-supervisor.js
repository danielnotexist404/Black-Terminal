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
    this.metrics = {
      leaseRenewals: 0,
      leaseFailures: 0,
      reconciliationRuns: 0,
      reconciliationDurationMs: 0,
      privateEvents: 0,
      orderEvents: 0,
      executionEvents: 0
    };
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
        : oldest, 0),
      ...this.metrics
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
      this.metrics.leaseFailures += 1;
      await this.stopConnection(runtime.connection.id, "lease_lost");
      return;
    }
    this.metrics.leaseRenewals += 1;
    await this.writeHealth(runtime);
  }

  async handleEvent(runtime, event) {
    if (runtime.stopped || this.isDuplicate(runtime, event)) return;
    this.metrics.privateEvents += 1;
    if (event.type === "order") this.metrics.orderEvents += 1;
    if (event.type === "execution") this.metrics.executionEvents += 1;
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
    const { data: order } = await this.supabase.from("execution_orders").select("id,user_id,filled_quantity,quantity,actual_fees,funding_cost,mandate_id,group_intent_id,symbol,side,reduce_only,reference_price,actual_slippage_bps,slippage_limit_bps,effective_leverage").eq("account_id", runtime.account.id).eq("client_order_id", fill.clientOrderId).maybeSingle();
    if (!order) return;
    const previousFilled = Number(order.filled_quantity || 0);
    const fillQuantity = Number(fill.quantity || 0);
    const cumulative = previousFilled + fillQuantity;
    const filled = cumulative + 1e-12 >= Number(order.quantity || 0);
    const referencePrice = Number(order.reference_price || 0);
    const fillPrice = Number(fill.price || 0);
    const fillSlippageBps = referencePrice > 0 && fillPrice > 0
      ? (order.side === "sell" ? referencePrice - fillPrice : fillPrice - referencePrice) / referencePrice * 10_000
      : null;
    const actualSlippageBps = fillSlippageBps == null || cumulative <= 0
      ? order.actual_slippage_bps
      : (Number(order.actual_slippage_bps || 0) * previousFilled + fillSlippageBps * fillQuantity) / cumulative;
    await updateOrThrow(this.supabase.from("execution_orders").update({
      status: filled ? "filled" : "partially-filled",
      filled_quantity: cumulative,
      average_fill_price: fill.price,
      actual_fees: Number(order.actual_fees || 0) + Number(fill.fee || 0),
      actual_slippage_bps: actualSlippageBps
    }).eq("id", order.id));
    const { data: followerPlan } = await this.supabase.from("follower_execution_plans").select("safe_result").eq("execution_order_id", order.id).maybeSingle();
    const divergence = Number.isFinite(Number(actualSlippageBps)) && Number(actualSlippageBps) > Number(order.slippage_limit_bps ?? Infinity);
    await updateOrThrow(this.supabase.from("follower_execution_plans").update({
      execution_status: filled ? "FILLED" : "PARTIALLY_FILLED",
      safe_result: { ...(followerPlan?.safe_result || {}), slippageBps: actualSlippageBps, divergence }
    }).eq("execution_order_id", order.id));
    if (divergence && followerPlan?.safe_result?.divergence !== true) await this.notifyExecutionDivergence(order, actualSlippageBps);
    if (order.group_intent_id && order.mandate_id) await this.applyGroupPositionFill(runtime, order, fill);
  }

  async applyGroupPositionFill(runtime, order, fill) {
    const [intent, mandate] = await Promise.all([
      single(this.supabase.from("group_trade_intents").select("group_id").eq("id", order.group_intent_id)),
      single(this.supabase.from("group_execution_mandates").select("membership_id,effective_leverage,max_leverage").eq("id", order.mandate_id))
    ]);
    if (!mandate.membership_id) return;
    const direction = order.side === "sell" ? "short" : "long";
    const fillQuantity = Math.abs(Number(fill.quantity || 0));
    const fillPrice = Number(fill.price || 0);
    if (!Number.isFinite(fillQuantity) || fillQuantity <= 0 || !Number.isFinite(fillPrice) || fillPrice <= 0) return;
    const { data: current, error } = await this.supabase.from("position_lifecycle_positions")
      .select("*")
      .eq("mandate_id", order.mandate_id)
      .eq("symbol", order.symbol)
      .in("lifecycle_state", ["opening", "open", "protected", "scaling", "closing"])
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const existingSourceOrderIds = current?.source_order_ids || [];
    const firstFillForOrder = !existingSourceOrderIds.includes(order.id);
    const sourceOrderIds = [...new Set([...existingSourceOrderIds, order.id])];
    if (!current) {
      if (order.reduce_only) return;
      await updateOrThrow(this.supabase.from("position_lifecycle_positions").insert({
        user_id: order.user_id,
        account_id: runtime.account.id,
        connection_id: runtime.connection.id,
        exchange: runtime.connection.provider,
        symbol: order.symbol,
        direction,
        lifecycle_state: "open",
        quantity: fillQuantity,
        average_price: fillPrice,
        current_price: fillPrice,
        realized_pnl: 0,
        unrealized_pnl: 0,
        margin: fillQuantity * fillPrice / Number(order.effective_leverage || mandate.effective_leverage || mandate.max_leverage || 1),
        leverage: Number(order.effective_leverage || mandate.effective_leverage || mandate.max_leverage || 1),
        source_order_ids: sourceOrderIds,
        origin: "INVESTMENT_GROUP",
        group_id: intent.group_id,
        membership_id: mandate.membership_id,
        mandate_id: order.mandate_id,
        fees: Number(fill.fee || 0),
        funding: Number(order.funding_cost || 0),
        opened_at: new Date(Number(fill.time || Date.now())).toISOString()
      }));
      await this.emitNotification(order.user_id, "position_opened", "Investment Group Position Opened", `${order.symbol} opened from an independently validated follower execution.`, {
        groupId: intent.group_id, membershipId: mandate.membership_id, mandateId: order.mandate_id, symbol: order.symbol
      });
      return;
    }
    if (!order.reduce_only && current.direction !== direction) throw typedError("GROUP_POSITION_DIRECTION_DIVERGENCE", "A group fill conflicts with the canonical managed-position direction.");
    const currentQuantity = Math.abs(Number(current.quantity || 0));
    const nextQuantity = order.reduce_only ? Math.max(0, currentQuantity - fillQuantity) : currentQuantity + fillQuantity;
    const closedQuantity = order.reduce_only ? Math.min(currentQuantity, fillQuantity) : 0;
    const realizedDelta = closedQuantity > 0
      ? (current.direction === "long" ? fillPrice - Number(current.average_price) : Number(current.average_price) - fillPrice) * closedQuantity
      : 0;
    const averagePrice = order.reduce_only
      ? Number(current.average_price)
      : ((Number(current.average_price) * currentQuantity) + (fillPrice * fillQuantity)) / nextQuantity;
    const lifecycleState = nextQuantity <= 1e-12 ? "closed" : "open";
    await updateOrThrow(this.supabase.from("position_lifecycle_positions").update({
      lifecycle_state: lifecycleState,
      quantity: nextQuantity,
      average_price: averagePrice,
      current_price: fillPrice,
      realized_pnl: Number(current.realized_pnl || 0) + realizedDelta,
      unrealized_pnl: nextQuantity <= 1e-12 ? 0 : (current.direction === "long" ? fillPrice - averagePrice : averagePrice - fillPrice) * nextQuantity,
      margin: nextQuantity * fillPrice / Number(order.effective_leverage || mandate.effective_leverage || mandate.max_leverage || 1),
      leverage: Number(order.effective_leverage || mandate.effective_leverage || mandate.max_leverage || 1),
      source_order_ids: sourceOrderIds,
      fees: Number(current.fees || 0) + Number(fill.fee || 0),
      funding: Number(current.funding || 0) + (firstFillForOrder ? Number(order.funding_cost || 0) : 0),
      closed_at: nextQuantity <= 1e-12 ? new Date(Number(fill.time || Date.now())).toISOString() : null,
      updated_at: new Date().toISOString()
    }).eq("id", current.id));
    if (nextQuantity <= 1e-12) {
      await this.emitNotification(order.user_id, "position_closed", "Investment Group Position Closed", `${order.symbol} closed in the canonical Position Manager ledger.`, {
        groupId: intent.group_id, membershipId: mandate.membership_id, mandateId: order.mandate_id, positionId: current.id, symbol: order.symbol
      });
      await this.finalizeWhenFlatMembership(mandate.membership_id, intent.group_id, order.user_id);
    }
  }

  async finalizeWhenFlatMembership(membershipId, groupId, userId) {
    const { data: membership } = await this.supabase.from("investment_group_members").select("membership_state").eq("id", membershipId).maybeSingle();
    if (membership?.membership_state !== "LEAVING") return;
    const { data: request } = await this.supabase.from("group_member_exit_requests").select("id").eq("membership_id", membershipId).eq("exit_policy", "WHEN_FLAT").is("completed_at", null).maybeSingle();
    if (!request) return;
    const { count, error } = await this.supabase.from("position_lifecycle_positions").select("id", { count: "exact", head: true }).eq("membership_id", membershipId).in("lifecycle_state", ["opening", "open", "protected", "scaling", "closing"]);
    if (error) throw error;
    if ((count || 0) > 0) return;
    const now = new Date().toISOString();
    await updateOrThrow(this.supabase.from("investment_group_members").update({ membership_state: "LEFT", status: "removed", left_at: now, updated_at: now }).eq("id", membershipId).eq("membership_state", "LEAVING"));
    await updateOrThrow(this.supabase.from("group_member_exit_requests").update({ completed_at: now }).eq("id", request.id).is("completed_at", null));
    const { data: group } = await this.supabase.from("investment_groups").select("owner_user_id").eq("id", groupId).maybeSingle();
    await this.emitNotification(userId, "leave_completed", "Investment Group Exit Completed", "All group-originated positions are flat and the membership is now left.", { groupId, membershipId });
    if (group?.owner_user_id && group.owner_user_id !== userId) await this.emitNotification(group.owner_user_id, "member_left", "Investment Group Member Left", "A when-flat exit completed after the final group position closed.", { groupId, membershipId });
    await this.repository.audit({
      userId, groupId, eventType: "GROUP_MEMBER_LEFT", purpose: "investment_group_membership",
      message: "A when-flat membership exit completed after the final attributed position closed.", metadata: { membershipId, exitRequestId: request.id }
    }).catch(() => null);
  }

  async refreshGroupPositionMarks(runtime) {
    const [managedResult, accountResult] = await Promise.all([
      this.supabase.from("position_lifecycle_positions").select("id,symbol,direction,quantity,average_price").eq("connection_id", runtime.connection.id).eq("origin", "INVESTMENT_GROUP").in("lifecycle_state", ["opening", "open", "protected", "scaling", "closing"]),
      this.supabase.from("account_positions").select("symbol,current_price").eq("account_id", runtime.account.id)
    ]);
    if (managedResult.error) throw managedResult.error;
    if (accountResult.error) throw accountResult.error;
    const marks = new Map((accountResult.data || []).map((row) => [String(row.symbol).toUpperCase(), Number(row.current_price || 0)]));
    for (const position of managedResult.data || []) {
      const mark = marks.get(String(position.symbol).toUpperCase());
      if (!Number.isFinite(mark) || mark <= 0) continue;
      const quantity = Math.abs(Number(position.quantity || 0));
      const average = Number(position.average_price || 0);
      const unrealized = (position.direction === "long" ? mark - average : average - mark) * quantity;
      await updateOrThrow(this.supabase.from("position_lifecycle_positions").update({ current_price: mark, unrealized_pnl: unrealized, updated_at: new Date().toISOString() }).eq("id", position.id));
    }
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
    const startedAt = Date.now();
    try {
      const result = await this.reconciliationWorker.run({ adapter: runtime.adapter, connection: runtime.connection, account: runtime.account, triggerType });
      if (!result.executionState?.tradingEnabled) {
        throw typedError("CREDENTIAL_PERMISSION_CHANGED", result.executionState?.readinessReason || "Bybit credential permissions no longer satisfy the trade-only execution contract.");
      }
      if (String(result.brokerAccountUid || "") !== String(runtime.connection.broker_account_uid || "")) {
        throw typedError("BROKER_ACCOUNT_UID_MISMATCH", "The reconciled Bybit UID no longer matches this connection.");
      }
      await this.refreshGroupPositionMarks(runtime);
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
      this.metrics.reconciliationRuns += 1;
      this.metrics.reconciliationDurationMs = Date.now() - startedAt;
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
    const firstDegradation = runtime.connection.health_status !== "DEGRADED";
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
    runtime.connection.health_status = "DEGRADED";
    await this.repository.audit({
      userId: runtime.connection.user_id,
      connectionId: runtime.connection.id,
      eventType: "CONNECTION_DEGRADED",
      severity: "WARNING",
      purpose: "connection_health",
      message,
      metadata: { provider: runtime.connection.provider }
    }).catch(() => null);
    if (firstDegradation) await this.emitNotification(runtime.connection.user_id, "connection_degraded", "Broker Connection Degraded", "Investment Group entries are blocked until Black Cloud reconciliation recovers.", {
      connectionId: runtime.connection.id, provider: runtime.connection.provider, code: error?.code || "PRIVATE_STREAM_ERROR"
    });
    if (firstDegradation) await this.notifyConnectionDegradedManagers(runtime.connection, error?.code || "PRIVATE_STREAM_ERROR");
  }

  async emitNotification(userId, eventType, title, body, metadata) {
    if (!userId) return;
    await this.supabase.from("notification_events").insert({ user_id: userId, event_type: eventType, title, body, metadata }).then(({ error }) => {
      if (error) return null;
      return true;
    });
  }

  async notifyConnectionDegradedManagers(connection, code) {
    const { data: mandates } = await this.supabase.from("group_execution_mandates").select("group_id").eq("broker_connection_id", connection.id).in("status", ["ACTIVE", "PAUSED", "EXIT_ONLY"]);
    const groupIds = [...new Set((mandates || []).map((row) => row.group_id).filter(Boolean))];
    if (!groupIds.length) return;
    const { data: groups } = await this.supabase.from("investment_groups").select("id,owner_user_id").in("id", groupIds);
    for (const group of groups || []) {
      if (!group.owner_user_id || group.owner_user_id === connection.user_id) continue;
      await this.emitNotification(group.owner_user_id, "member_connection_degraded", "Member Connection Degraded", "A member broker connection is stale or degraded; new group entries are blocked for that member.", {
        groupId: group.id, connectionId: connection.id, code
      });
    }
  }

  async notifyExecutionDivergence(order, actualSlippageBps) {
    const { data: intent } = await this.supabase.from("group_trade_intents").select("group_id").eq("id", order.group_intent_id).maybeSingle();
    const { data: group } = intent?.group_id ? await this.supabase.from("investment_groups").select("owner_user_id").eq("id", intent.group_id).maybeSingle() : { data: null };
    const metadata = { groupId: intent?.group_id || null, orderId: order.id, symbol: order.symbol, actualSlippageBps, slippageLimitBps: order.slippage_limit_bps };
    await this.emitNotification(order.user_id, "copy_execution_divergence", "Copy Execution Divergence", `${order.symbol} exceeded the signed slippage limit.`, metadata);
    if (group?.owner_user_id && group.owner_user_id !== order.user_id) await this.emitNotification(group.owner_user_id, "follower_execution_divergence", "Follower Execution Divergence", `A ${order.symbol} follower fill exceeded its slippage cap.`, metadata);
    await this.repository.audit({
      userId: order.user_id, groupId: intent?.group_id || null, groupIntentId: order.group_intent_id,
      eventType: "FOLLOWER_EXECUTION_DIVERGENCE", severity: "WARNING", purpose: "group_order_execution",
      message: "A follower fill exceeded the effective member/manager slippage cap.", metadata
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
