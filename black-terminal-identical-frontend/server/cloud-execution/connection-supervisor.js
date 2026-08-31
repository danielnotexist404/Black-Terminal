import crypto from "node:crypto";
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
      executionEvents: 0,
      protectionRepairsQueued: 0,
      groupProtectionIncidents: 0
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
      const workerEnvironment = normalizeBybitExecutionEnvironment(process.env.BLACK_CLOUD_EXECUTION_ENVIRONMENT || process.env.BYBIT_EXECUTION_ENVIRONMENT || process.env.BLACK_CLOUD_NETWORK);
      const { data, error } = await this.supabase
        .from("connectivity_connections")
        .select("*")
        .in("connection_mode", ["CLOUD_DELEGATED", "HYBRID"])
        .eq("execution_environment", workerEnvironment)
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
    const { data: order, error } = await this.supabase.from("execution_orders").select("id").eq("account_id", runtime.account.id).eq("client_order_id", report.clientOrderId).maybeSingle();
    if (error) throw error;
    if (!order) return;
    await this.repository.applyExecutionOrderState({
      orderId: order.id,
      accountId: runtime.account.id,
      status: report.status,
      cumulativeFilledQuantity: report.filledQuantity ?? report.cumulativeFilledQuantity ?? 0,
      exchangeOrderId: report.exchangeOrderId || report.orderId,
      averageFillPrice: report.averageFillPrice,
      rejectionReason: report.rejectReason,
      venueUpdatedAt: report.updatedTime ?? report.updatedAt ?? report.time ?? 0
    });
    const { data: settledOrder, error: settledError } = await this.supabase.from("execution_orders")
      .select("id,user_id,account_id,client_order_id,symbol,side,order_type,quantity,filled_quantity,status,reduce_only,origin,strategy_automation_id,strategy_target_binding_id,group_intent_id,mandate_id,created_at")
      .eq("id", order.id)
      .eq("account_id", runtime.account.id)
      .maybeSingle();
    if (settledError) throw settledError;
    if (settledOrder) await this.monitorStrategyTakeProfitProtection(runtime, settledOrder, report);
  }

  async monitorStrategyTakeProfitProtection(runtime, order, report) {
    if (!strategyProtectionLossCandidate(order)) return { monitored: false, reason: "NOT_PROTECTION_LOSS" };
    if (order.account_id !== runtime.account.id || runtime.connection.account_id !== runtime.account.id) {
      throw typedError("STRATEGY_PROTECTION_ACCOUNT_MISMATCH", "A terminal strategy target event did not belong to this persistent connection account.");
    }
    const [{ data: sourceCommands, error: sourceError }, { data: mutationCommands, error: mutationError }] = await Promise.all([
      this.supabase.from("execution_commands")
        .select("id,idempotency_key,command_type,status,payload,created_at,execution_order_id,group_intent_id,follower_plan_id,strategy_automation_id,strategy_target_binding_id,connection_id,user_id")
        .eq("execution_order_id", order.id)
        .eq("command_type", "PLACE_ORDER")
        .order("created_at", { ascending: true })
        .limit(20),
      this.supabase.from("execution_commands")
        .select("id,idempotency_key,command_type,status,payload,created_at,execution_order_id,group_intent_id,follower_plan_id,strategy_automation_id,strategy_target_binding_id,connection_id,user_id")
        .eq("execution_order_id", order.id)
        .in("command_type", ["MODIFY_ORDER", "CANCEL_ORDER"])
        .order("created_at", { ascending: false })
        .limit(100)
    ]);
    if (sourceError) throw sourceError;
    if (mutationError) throw mutationError;
    const linkedCommands = [...(sourceCommands || []), ...(mutationCommands || [])];
    const directTakeProfit = (linkedCommands || []).find((command) => command.command_type === "PLACE_ORDER"
      && !command.group_intent_id
      && !command.follower_plan_id
      && String(command.payload?.action || "").toUpperCase() === "TAKE_PROFIT"
      && command.strategy_automation_id === order.strategy_automation_id
      && command.strategy_target_binding_id === order.strategy_target_binding_id);
    if (directTakeProfit) {
      return this.repairDirectStrategyTakeProfit(runtime, order, report, directTakeProfit, linkedCommands || []);
    }
    if (!order.group_intent_id) return { monitored: false, reason: "NOT_CERTIFIED_TAKE_PROFIT" };
    const { data: groupIntent, error: groupError } = await this.supabase.from("group_trade_intents")
      .select("id,group_id,created_by,symbol,strategy_action,strategy_direction,strategy_automation_id,strategy_target_binding_id,strategy_execution_policy")
      .eq("id", order.group_intent_id)
      .maybeSingle();
    if (groupError) throw groupError;
    if (!groupIntent
      || groupIntent.strategy_action !== "TAKE_PROFIT"
      || groupIntent.strategy_automation_id !== order.strategy_automation_id
      || groupIntent.strategy_target_binding_id !== order.strategy_target_binding_id) {
      return { monitored: false, reason: "NOT_CERTIFIED_TAKE_PROFIT" };
    }
    return this.markGroupStrategyProtectionIncident(runtime, order, report, groupIntent, linkedCommands || []);
  }

  async repairDirectStrategyTakeProfit(runtime, order, report, sourceCommand, linkedCommands) {
    const parentEntryIdempotencyKey = String(sourceCommand.payload?.parentEntryIdempotencyKey || "");
    const [{ data: binding, error: bindingError }, { data: strategy, error: strategyError }, { data: strategyCommands, error: commandsError }, { data: parentCommand, error: parentError }] = await Promise.all([
      this.supabase.from("strategy_target_bindings")
        .select("id,strategy_id,strategy_version,owner_user_id,target_type,connection_id,account_id,market_type,status")
        .eq("id", order.strategy_target_binding_id)
        .maybeSingle(),
      this.supabase.from("strategy_automation_strategies")
        .select("id,owner_user_id,symbol,running_version")
        .eq("id", order.strategy_automation_id)
        .maybeSingle(),
      this.supabase.from("execution_commands")
        .select("id,idempotency_key,command_type,status,payload,created_at,execution_order_id,strategy_automation_id,strategy_target_binding_id")
        .eq("strategy_target_binding_id", order.strategy_target_binding_id)
        .eq("strategy_automation_id", order.strategy_automation_id)
        .eq("command_type", "PLACE_ORDER")
        .order("created_at", { ascending: false })
        .limit(100),
      parentEntryIdempotencyKey
        ? this.supabase.from("execution_commands")
          .select("id,idempotency_key,command_type,status,payload,created_at,execution_order_id,strategy_automation_id,strategy_target_binding_id")
          .eq("idempotency_key", parentEntryIdempotencyKey)
          .eq("strategy_target_binding_id", order.strategy_target_binding_id)
          .maybeSingle()
        : Promise.resolve({ data: null, error: null })
    ]);
    if (bindingError) throw bindingError;
    if (strategyError) throw strategyError;
    if (commandsError) throw commandsError;
    if (parentError) throw parentError;
    const executionEnvironment = normalizeBybitExecutionEnvironment(runtime.connection.execution_environment);
    const expectedOrigin = executionEnvironment === "DEMO" ? "STRATEGY_AUTOMATION_DEMO" : "STRATEGY_AUTOMATION_LIVE";
    const symbol = normalizedSymbol(order.symbol);
    const direction = strategyTakeProfitDirection(sourceCommand, order);
    const ownershipValid = binding
      && strategy
      && binding.target_type === "BROKER_ACCOUNT"
      && binding.connection_id === runtime.connection.id
      && binding.account_id === runtime.account.id
      && binding.owner_user_id === order.user_id
      && binding.strategy_id === strategy.id
      && strategy.owner_user_id === order.user_id
      && normalizedSymbol(strategy.symbol) === symbol
      && sourceCommand.connection_id === runtime.connection.id
      && sourceCommand.user_id === order.user_id
      && order.origin === expectedOrigin;
    if (!ownershipValid || !direction) {
      throw typedError("STRATEGY_PROTECTION_OWNERSHIP_MISMATCH", "Black Cloud refused to repair a terminal target whose strategy, binding, account, symbol, direction, or execution environment was not exact.");
    }
    const relatedCommands = [...(strategyCommands || []), ...(linkedCommands || []), ...(parentCommand ? [parentCommand] : [])];
    const suppression = strategyProtectionRepairSuppression({ sourceCommand, relatedCommands });
    if (suppression) return { monitored: true, repaired: false, reason: suppression };
    if (!parentEntryIdempotencyKey) {
      throw typedError("STRATEGY_PROTECTION_PARENT_REQUIRED", "A terminal take-profit was missing its immutable parent generation and could not be auto-repaired safely.");
    }
    const repairCommand = buildStrategyProtectionRepairCommand({
      order,
      report,
      binding,
      strategy,
      sourceCommand,
      connection: runtime.connection,
      executionEnvironment,
      direction,
      parentEntryIdempotencyKey,
      expectedEntryOrderId: parentCommand?.execution_order_id || null
    });
    if (!repairCommand) return { monitored: true, repaired: false, reason: "NO_RESIDUAL_EXPOSURE_POSSIBLE" };
    const persisted = await persistStrategyProtectionRepairCommand(this.supabase, repairCommand);
    if (!persisted.inserted) return { monitored: true, repaired: true, idempotent: true, commandId: persisted.id || null };
    this.metrics.protectionRepairsQueued += 1;
    await this.repository.audit({
      userId: order.user_id,
      connectionId: runtime.connection.id,
      commandId: persisted.id,
      eventType: "STRATEGY_TP_PROTECTION_REPAIR_QUEUED",
      severity: "CRITICAL",
      purpose: "strategy_take_profit_protection_repair",
      message: "A strategy-owned Bybit take-profit became terminal before fully closing its position. Black Cloud queued a deterministic, generation-guarded reduce-only close-all repair; the execution worker will confirm ownership and no-op if flat or superseded.",
      metadata: {
        strategyId: strategy.id,
        bindingId: binding.id,
        executionOrderId: order.id,
        sourceCommandId: sourceCommand.id,
        expectedEntryOrderId: parentCommand?.execution_order_id || null,
        symbol,
        direction,
        terminalStatus: order.status,
        filledQuantity: Number(order.filled_quantity || 0),
        orderQuantity: Number(order.quantity || 0),
        executionEnvironment,
        venueOrderSubmittedBySupervisor: false
      }
    });
    const { error: strategyAuditError } = await this.supabase.from("strategy_automation_audit_events").insert({
      owner_user_id: order.user_id,
      strategy_id: strategy.id,
      binding_id: binding.id,
      event_type: "STRATEGY_TP_PROTECTION_REPAIR_QUEUED",
      severity: "CRITICAL",
      message: "A terminal Bybit take-profit left possible residual strategy exposure. A deterministic generation-guarded safety-close command was queued for Black Cloud execution.",
      safe_metadata: {
        commandId: persisted.id,
        executionOrderId: order.id,
        expectedEntryOrderId: parentCommand?.execution_order_id || null,
        symbol,
        direction,
        terminalStatus: order.status,
        executionEnvironment,
        venueOrderSubmittedBySupervisor: false
      }
    });
    if (strategyAuditError) throw strategyAuditError;
    return { monitored: true, repaired: true, idempotent: false, commandId: persisted.id };
  }

  async markGroupStrategyProtectionIncident(runtime, order, report, groupIntent, linkedCommands) {
    const sourceCommand = (linkedCommands || []).find((command) => command.command_type === "PLACE_ORDER" && command.group_intent_id === groupIntent.id && command.follower_plan_id)
      || (linkedCommands || []).find((command) => command.command_type === "PLACE_ORDER" && command.follower_plan_id);
    const mutationSuppression = sourceCommand
      ? strategyProtectionRepairSuppression({ sourceCommand, relatedCommands: linkedCommands || [] })
      : null;
    if (mutationSuppression) return { monitored: true, repaired: false, reason: mutationSuppression };
    let plan = null;
    let planError = null;
    if (sourceCommand?.follower_plan_id) {
      const result = await this.supabase.from("follower_execution_plans")
        .select("id,group_intent_id,mandate_id,follower_user_id,broker_connection_id,execution_order_id,execution_status,safe_result")
        .eq("id", sourceCommand.follower_plan_id)
        .eq("broker_connection_id", runtime.connection.id)
        .maybeSingle();
      plan = result.data;
      planError = result.error;
    } else {
      const result = await this.supabase.from("follower_execution_plans")
        .select("id,group_intent_id,mandate_id,follower_user_id,broker_connection_id,execution_order_id,execution_status,safe_result")
        .eq("execution_order_id", order.id)
        .eq("broker_connection_id", runtime.connection.id)
        .maybeSingle();
      plan = result.data;
      planError = result.error;
    }
    if (planError) throw planError;
    const direction = strategyGroupTakeProfitDirection(groupIntent, order);
    const { data: binding, error: bindingError } = await this.supabase.from("strategy_target_bindings")
      .select("id,strategy_id,owner_user_id,target_type,group_id,market_type,strategy_version")
      .eq("id", groupIntent.strategy_target_binding_id)
      .maybeSingle();
    if (bindingError) throw bindingError;
    const ownershipValid = binding
      && binding.target_type === "INVESTMENT_GROUP"
      && binding.strategy_id === groupIntent.strategy_automation_id
      && binding.owner_user_id === groupIntent.created_by
      && binding.group_id === groupIntent.group_id
      && order.origin === "INVESTMENT_GROUP"
      && order.account_id === runtime.account.id
      && plan?.follower_user_id === order.user_id
      && plan?.broker_connection_id === runtime.connection.id
      && plan?.group_intent_id === groupIntent.id
      && plan?.execution_order_id === order.id
      && plan?.mandate_id === order.mandate_id
      && sourceCommand?.connection_id === runtime.connection.id
      && sourceCommand?.user_id === order.user_id
      && sourceCommand?.strategy_automation_id === groupIntent.strategy_automation_id
      && sourceCommand?.strategy_target_binding_id === groupIntent.strategy_target_binding_id;
    if (!ownershipValid || !direction || normalizedSymbol(groupIntent.symbol) !== normalizedSymbol(order.symbol)) {
      throw typedError("STRATEGY_GROUP_PROTECTION_OWNERSHIP_MISMATCH", "A terminal follower target did not match its immutable group strategy direction or symbol.");
    }
    const parentGroupIntentId = String(groupIntent.strategy_execution_policy?.parentGroupIntentId || "");
    let expectedEntryOrderId = null;
    if (parentGroupIntentId && plan?.mandate_id) {
      const { data: parentPlan, error: parentPlanError } = await this.supabase.from("follower_execution_plans")
        .select("execution_order_id")
        .eq("group_intent_id", parentGroupIntentId)
        .eq("mandate_id", plan.mandate_id)
        .maybeSingle();
      if (parentPlanError) throw parentPlanError;
      expectedEntryOrderId = parentPlan?.execution_order_id || null;
    }
    const executionEnvironment = normalizeBybitExecutionEnvironment(runtime.connection.execution_environment);
    const repairCommand = buildGroupStrategyProtectionRepairCommand({
      order,
      report,
      binding,
      groupIntent,
      sourceCommand,
      plan,
      connection: runtime.connection,
      executionEnvironment,
      direction,
      parentGroupIntentId,
      expectedEntryOrderId
    });
    const persisted = repairCommand
      ? await persistStrategyProtectionRepairCommand(this.supabase, repairCommand)
      : { inserted: false, id: null };
    const incidentMarker = {
      executionOrderId: order.id,
      terminalStatus: order.status,
      symbol: normalizedSymbol(order.symbol),
      direction,
      observedAt: venueEventIso(report),
      requiresReconciliation: true,
      requiresManualRepair: !repairCommand,
      automaticRepairAvailable: Boolean(repairCommand),
      repairCommandId: persisted.id || null,
      expectedEntryOrderId
    };
    const alreadyMarked = plan?.safe_result?.takeProfitProtectionIncident?.executionOrderId === order.id
      && plan.safe_result.takeProfitProtectionIncident.terminalStatus === order.status;
    if (alreadyMarked && !persisted.inserted) {
      return { monitored: true, repaired: Boolean(repairCommand), idempotent: true, commandId: persisted.id || null };
    }
    if (plan) {
      const preservesPositiveFill = Number(order.filled_quantity || 0) > 0
        || ["PARTIALLY_FILLED", "FILLED"].includes(String(plan.execution_status || "").toUpperCase());
      const patch = {
        safe_result: { ...(plan.safe_result || {}), takeProfitProtectionIncident: incidentMarker }
      };
      if (!preservesPositiveFill) patch.execution_status = "RECONCILIATION_REQUIRED";
      await updateOrThrow(this.supabase.from("follower_execution_plans").update(patch).eq("id", plan.id));
    }
    this.metrics.groupProtectionIncidents += 1;
    const { error: strategyAuditError } = await this.supabase.from("strategy_automation_audit_events").insert({
      owner_user_id: groupIntent.created_by,
      strategy_id: groupIntent.strategy_automation_id,
      binding_id: groupIntent.strategy_target_binding_id,
      event_type: "STRATEGY_GROUP_TP_PROTECTION_LOST",
      severity: "CRITICAL",
      message: repairCommand
        ? "An Investment Group follower take-profit became terminal with possible residual exposure. Black Cloud queued a deterministic generation-guarded follower safety flatten."
        : "An Investment Group follower take-profit became terminal but its immutable parent generation was unavailable; the follower plan requires reconciliation.",
      safe_metadata: {
        executionOrderId: order.id,
        groupIntentId: groupIntent.id,
        followerPlanId: plan?.id || null,
        connectionId: runtime.connection.id,
        ...incidentMarker
      }
    });
    if (strategyAuditError) throw strategyAuditError;
    await this.repository.audit({
      userId: order.user_id,
      connectionId: runtime.connection.id,
      groupIntentId: groupIntent.id,
      followerPlanId: plan?.id || null,
      commandId: sourceCommand?.id || null,
      eventType: "STRATEGY_GROUP_TP_PROTECTION_LOST",
      severity: "CRITICAL",
      purpose: "strategy_group_take_profit_protection_monitor",
      message: repairCommand
        ? "A follower target lost native take-profit protection. The private-stream supervisor queued durable repair work without directly submitting a broker order."
        : "A follower target lost native take-profit protection and requires operator reconciliation; no direct broker order was submitted by the private-stream supervisor.",
      metadata: { ...incidentMarker, venueOrderSubmittedBySupervisor: false, repairQueued: Boolean(repairCommand) }
    });
    if (persisted.inserted) this.metrics.protectionRepairsQueued += 1;
    return {
      monitored: true,
      repaired: Boolean(repairCommand),
      idempotent: !persisted.inserted,
      commandId: persisted.id || null,
      reason: repairCommand ? "GROUP_FAIL_SAFE_REPAIR_QUEUED" : "GROUP_MANUAL_RECONCILIATION_REQUIRED"
    };
  }

  async applyFillEvent(runtime, fill) {
    if (!fill?.clientOrderId?.startsWith("bt-")) return;
    const { data: order, error } = await this.supabase.from("execution_orders").select("id").eq("account_id", runtime.account.id).eq("client_order_id", fill.clientOrderId).maybeSingle();
    if (error) throw error;
    if (!order) return;
    await this.repository.applyExecutionOrderState({
      orderId: order.id,
      accountId: runtime.account.id,
      status: "partially-filled",
      fillDelta: fill.quantity,
      exchangeOrderId: fill.orderId,
      averageFillPrice: fill.price,
      actualFeeDelta: fill.fee,
      venueUpdatedAt: fill.time ?? 0
    });
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
      // Position ownership is required before any reduce-only TP or reversal is
      // allowed. Attribute both Demo and Mainnet positions, but only when an
      // accepted non-reduce strategy order for the exact live binding, symbol,
      // and direction precedes the reconciled venue position.
      await this.attributeStrategyState(runtime);
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

  async attributeStrategyState(runtime) {
    const { data: binding, error: bindingError } = await this.supabase.from("strategy_target_bindings")
      .select("id,strategy_id")
      .eq("account_id", runtime.account.id)
      .eq("status", "LIVE")
      .maybeSingle();
    if (bindingError) throw bindingError;
    if (!binding) return;
    const { data: strategy, error: strategyError } = await this.supabase.from("strategy_automation_strategies")
      .select("symbol")
      .eq("id", binding.strategy_id)
      .maybeSingle();
    if (strategyError) throw strategyError;
    if (!strategy?.symbol) return;
    const { data: latestStrategyOrder, error: orderError } = await this.supabase.from("execution_orders")
      .select("id,side,status,created_at,strategy_automation_id,strategy_target_binding_id")
      .eq("strategy_target_binding_id", binding.id)
      .eq("symbol", strategy.symbol)
      .eq("reduce_only", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (orderError) throw orderError;
    if (!latestStrategyOrder || latestStrategyOrder.strategy_automation_id !== binding.strategy_id || latestStrategyOrder.strategy_target_binding_id !== binding.id || ["rejected", "cancelled", "canceled", "failed"].includes(String(latestStrategyOrder.status || "").toLowerCase())) return;
    const direction = String(latestStrategyOrder.side || "").toLowerCase() === "sell" ? "short" : "long";
    await updateOrThrow(this.supabase.from("account_positions").update({
      strategy_automation_id: binding.strategy_id,
      strategy_target_binding_id: binding.id
    }).eq("account_id", runtime.account.id).eq("symbol", strategy.symbol).eq("direction", direction).is("strategy_target_binding_id", null).gt("quantity", 0));
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
      reconciliation_status: runtime.reconciling ? "RUNNING" : synchronizationState,
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

export function strategyProtectionLossCandidate(order) {
  const status = String(order?.status || "").trim().toLowerCase().replaceAll("_", "-");
  const quantity = Number(order?.quantity || 0);
  const filledQuantity = Number(order?.filled_quantity ?? order?.filledQuantity ?? 0);
  return Boolean(order?.strategy_automation_id)
    && Boolean(order?.strategy_target_binding_id)
    && order?.reduce_only === true
    && String(order?.order_type || "").toLowerCase() === "limit"
    && ["cancelled", "canceled", "rejected", "failed"].includes(status)
    && Number.isFinite(quantity)
    && quantity > 0
    && Number.isFinite(filledQuantity)
    && filledQuantity >= 0
    && filledQuantity + 1e-12 < quantity;
}

export function strategyProtectionRepairSuppression({ sourceCommand, relatedCommands = [] }) {
  const sourceCreatedAt = Date.parse(sourceCommand?.created_at || "") || 0;
  const parentKey = String(sourceCommand?.payload?.parentEntryIdempotencyKey || "");
  const targetId = String(sourceCommand?.payload?.targetId || "").toUpperCase();
  const direction = String(sourceCommand?.payload?.direction || "").toLowerCase();
  const parentCommand = relatedCommands.find((command) => command.idempotency_key === parentKey);
  const generationCreatedAt = Date.parse(parentCommand?.created_at || "") || sourceCreatedAt;
  for (const command of relatedCommands) {
    if (command.id === sourceCommand?.id) continue;
    const action = String(command.payload?.action || "").toUpperCase();
    const status = String(command.status || "").toUpperCase();
    const commandCreatedAt = Date.parse(command.created_at || "") || 0;
    const acknowledged = Boolean(command.execution_order_id)
      && !["FAILED", "DEAD_LETTER", "CANCELLED"].includes(status);
    if (acknowledged
      && ["ENTRY", "REVERSE"].includes(action)
      && commandCreatedAt > generationCreatedAt) {
      return "SUPERSEDED_POSITION_GENERATION";
    }
    if (acknowledged
      && action === "TAKE_PROFIT"
      && commandCreatedAt > sourceCreatedAt
      && String(command.payload?.parentEntryIdempotencyKey || "") === parentKey
      && String(command.payload?.targetId || "").toUpperCase() === targetId
      && String(command.payload?.direction || "").toLowerCase() === direction
      && command.execution_order_id !== sourceCommand?.execution_order_id) {
      return "SUPERSEDED_TAKE_PROFIT_ORDER";
    }
    if (["MODIFY_ORDER", "CANCEL_ORDER"].includes(command.command_type)
      && command.execution_order_id === sourceCommand?.execution_order_id
      && explicitlyIntentionalProtectionReplacement(command.payload)
      && !["FAILED", "DEAD_LETTER", "CANCELLED"].includes(status)) {
      return "INTENTIONAL_TAKE_PROFIT_REPLACEMENT";
    }
  }
  return null;
}

export function buildStrategyProtectionRepairCommand({
  order,
  report,
  binding,
  strategy,
  sourceCommand,
  connection,
  executionEnvironment,
  direction,
  parentEntryIdempotencyKey,
  expectedEntryOrderId
}) {
  if (!strategyProtectionLossCandidate(order)) return null;
  if (!parentEntryIdempotencyKey) return null;
  const stableIdentity = `strategy-tp-protection-repair:${binding.id}:${parentEntryIdempotencyKey}:${direction}`;
  const idempotencyKey = crypto.createHash("sha256").update(stableIdentity).digest("hex");
  const signalKey = `protection-repair:${parentEntryIdempotencyKey}:${direction}`;
  return {
    command_type: "PLACE_ORDER",
    user_id: order.user_id,
    connection_id: connection.id,
    strategy_automation_id: strategy.id,
    strategy_target_binding_id: binding.id,
    strategy_signal_key: signalKey,
    idempotency_key: idempotencyKey,
    deterministic_client_order_id: `bt-safe-${idempotencyKey.slice(0, 28)}`,
    execution_environment: executionEnvironment,
    payload: {
      action: "TAKE_PROFIT",
      forceProtectionFailSafeFlatten: true,
      symbol: normalizedSymbol(order.symbol),
      marketType: binding.market_type,
      direction,
      positionDirection: direction,
      parentEntryIdempotencyKey,
      expectedEntryOrderId: expectedEntryOrderId || null,
      strategyVersion: binding.strategy_version,
      executionEnvironment,
      protectionRepair: {
        reason: "TERMINAL_TAKE_PROFIT_WITH_RESIDUAL_POSSIBLE",
        executionOrderId: order.id,
        sourceCommandId: sourceCommand.id,
        targetId: String(sourceCommand.payload?.targetId || "").toUpperCase() || null,
        terminalStatus: String(order.status || "").toLowerCase(),
        venueUpdatedAt: Number(report?.updatedTime ?? report?.updatedAt ?? report?.time ?? 0) || null
      }
    },
    status: "QUEUED",
    priority: 5,
    max_attempts: 100
  };
}

export function buildGroupStrategyProtectionRepairCommand({
  order,
  report,
  binding,
  groupIntent,
  sourceCommand,
  plan,
  connection,
  executionEnvironment,
  direction,
  parentGroupIntentId,
  expectedEntryOrderId
}) {
  if (!strategyProtectionLossCandidate(order)
    || !sourceCommand?.id
    || !plan?.id
    || !plan?.mandate_id
    || !parentGroupIntentId) return null;
  const stableIdentity = `strategy-group-tp-protection-repair:${binding.id}:${parentGroupIntentId}:${plan.mandate_id}:${direction}`;
  const idempotencyKey = crypto.createHash("sha256").update(stableIdentity).digest("hex");
  return {
    command_type: "PLACE_ORDER",
    user_id: order.user_id,
    connection_id: connection.id,
    group_intent_id: groupIntent.id,
    follower_plan_id: plan.id,
    strategy_automation_id: groupIntent.strategy_automation_id,
    strategy_target_binding_id: binding.id,
    strategy_signal_key: `protection-repair:${parentGroupIntentId}:${plan.mandate_id}:${direction}`,
    idempotency_key: idempotencyKey,
    deterministic_client_order_id: `bt-safe-${idempotencyKey.slice(0, 28)}`,
    execution_environment: executionEnvironment,
    payload: {
      ...(sourceCommand.payload || {}),
      forceProtectionFailSafeFlatten: true,
      expectedEntryOrderId: expectedEntryOrderId || null,
      protectionRepair: {
        reason: "TERMINAL_TAKE_PROFIT_WITH_RESIDUAL_POSSIBLE",
        executionOrderId: order.id,
        sourceCommandId: sourceCommand.id,
        parentGroupIntentId,
        terminalStatus: String(order.status || "").toLowerCase(),
        venueUpdatedAt: Number(report?.updatedTime ?? report?.updatedAt ?? report?.time ?? 0) || null
      }
    },
    status: "QUEUED",
    priority: 5,
    max_attempts: 100
  };
}

export async function persistStrategyProtectionRepairCommand(supabase, command) {
  const { data, error } = await supabase.from("execution_commands")
    .upsert(command, { onConflict: "idempotency_key", ignoreDuplicates: true })
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (data?.id) return { inserted: true, id: data.id };
  const { data: existing, error: existingError } = await supabase.from("execution_commands")
    .select("id")
    .eq("idempotency_key", command.idempotency_key)
    .maybeSingle();
  if (existingError) throw existingError;
  return { inserted: false, id: existing?.id || null };
}

function explicitlyIntentionalProtectionReplacement(payload = {}) {
  const replacementReason = String(payload.cancellationReason || payload.cancelReason || payload.replacementReason || "").toUpperCase();
  return payload.intentionalProtectionReplacement === true
    || payload.cancelBeforeReplace === true
    || Boolean(payload.replacementExecutionOrderId)
    || Boolean(payload.replacementClientOrderId)
    || /(SUPERSEDE|REPLACE|REPRICE)/.test(replacementReason);
}

function strategyTakeProfitDirection(sourceCommand, order) {
  const direction = String(sourceCommand?.payload?.direction || sourceCommand?.payload?.positionDirection || "").toLowerCase();
  if (!['long', 'short'].includes(direction)) return null;
  const expectedSide = direction === "long" ? "sell" : "buy";
  return String(order?.side || "").toLowerCase() === expectedSide ? direction : null;
}

function strategyGroupTakeProfitDirection(groupIntent, order) {
  const direction = String(groupIntent?.strategy_direction || "").toLowerCase();
  if (!['long', 'short'].includes(direction)) return null;
  const expectedSide = direction === "long" ? "sell" : "buy";
  return String(order?.side || "").toLowerCase() === expectedSide ? direction : null;
}

function normalizedSymbol(value) {
  return String(value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function venueEventIso(report) {
  const milliseconds = Number(report?.updatedTime ?? report?.updatedAt ?? report?.time ?? Date.now());
  return new Date(Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : Date.now()).toISOString();
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
