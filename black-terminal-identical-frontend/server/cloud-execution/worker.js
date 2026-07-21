import {
  findBybitOrderByClientOrderId,
  getBybitInstrumentMetadata,
  getBybitTicker,
  getBybitWalletSnapshot,
  placeBybitOrder,
  validateBybitOrderDraft
} from "../exchanges/bybit.js";
import { syncBybitSnapshotAndReconcile } from "../exchanges/bybit-reconciliation.js";
import { calculateFollowerAllocation, evaluateFollowerRisk } from "./allocation-risk.js";
import {
  createDeterministicClientOrderId,
  createExecutionIdempotencyKey,
  hashCanonicalPayload,
  intentSigningPayload,
  verifyCanonicalSignature
} from "./canonical.js";
import { BlackCloudRepository, sanitizeError } from "./repository.js";
import { BrokerConnectionManager } from "./connection-supervisor.js";
import { validateBlackCloudRuntime } from "./runtime-config.js";

export class BlackCloudExecutionWorker {
  constructor(supabase, options = {}) {
    this.supabase = supabase;
    this.workerId = options.workerId || buildWorkerId();
    this.pollIntervalMs = options.pollIntervalMs || 1_000;
    this.claimLimit = options.claimLimit || 10;
    this.leaseTtlSeconds = options.leaseTtlSeconds || 30;
    this.repository = new BlackCloudRepository(supabase, this.workerId);
    this.connectionSupervisor = new BrokerConnectionManager(supabase, this.repository, {
      leaseTtlSeconds: this.leaseTtlSeconds
    });
    this.running = false;
    this.startedAt = null;
    this.lastTickAt = null;
    this.lastLoopError = null;
    this.timer = null;
    this.inFlight = new Set();
  }

  assertRuntime() {
    return validateBlackCloudRuntime().network;
  }

  async start() {
    const network = this.assertRuntime();
    this.running = true;
    this.startedAt = new Date().toISOString();
    await this.repository.audit({
      eventType: "WORKER_STARTED",
      severity: "INFO",
      purpose: "worker_lifecycle",
      userVisible: false,
      message: "Black Cloud execution worker started.",
      metadata: { workerId: this.workerId, network }
    });
    await this.connectionSupervisor.start();
    await this.tick();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.inFlight]);
    await this.connectionSupervisor.stop();
    await this.repository.audit({
      eventType: "WORKER_STOPPED",
      severity: "INFO",
      purpose: "worker_lifecycle",
      userVisible: false,
      message: "Black Cloud execution worker drained and stopped.",
      metadata: { workerId: this.workerId }
    });
  }

  async tick() {
    if (!this.running) return;
    try {
      this.lastTickAt = new Date().toISOString();
      this.lastLoopError = null;
      const commands = await this.repository.claimCommands(this.claimLimit);
      for (const command of commands || []) {
        const task = this.processCommand(command).finally(() => this.inFlight.delete(task));
        this.inFlight.add(task);
      }
      await Promise.allSettled([...this.inFlight]);
    } catch (error) {
      this.lastLoopError = sanitizeError(error?.message || error);
      console.error("[black-cloud-worker-loop]", sanitizeError(error?.message || error));
    } finally {
      if (this.running) this.timer = setTimeout(() => void this.tick(), this.pollIntervalMs);
    }
  }

  diagnostics() {
    return {
      workerId: this.workerId,
      running: this.running,
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
      lastLoopError: this.lastLoopError,
      inFlightCommands: this.inFlight.size,
      supervisedConnections: this.connectionSupervisor.connections.size,
      network: process.env.BLACK_CLOUD_NETWORK || "testnet"
    };
  }

  async processCommand(command) {
    const lease = await this.repository.acquireLease(command.connection_id, this.leaseTtlSeconds);
    if (!lease) {
      await this.releaseForRetry(command, 2, "LEASE_BUSY", "Another worker owns this execution boundary.");
      return;
    }

    const fencingToken = Number(lease.fencing_token);
    const attemptId = await this.repository.startAttempt(command, fencingToken);
    try {
      let result;
      if (command.command_type === "EXPAND_GROUP_INTENT") result = await this.expandGroupIntent(command);
      else if (command.command_type === "PLACE_ORDER") result = await this.placeFollowerOrder(command);
      else if (command.command_type === "SYNC_ACCOUNT") result = await this.syncAccount(command);
      else throw terminalError("UNSUPPORTED_COMMAND", `Unsupported Black Cloud command: ${command.command_type}`);

      await this.repository.finishAttempt(attemptId, "SUCCEEDED", {
        venueOrderId: result?.venueOrderId,
        safeDetails: result || {}
      });
      await this.repository.finishCommand(command.id, fencingToken, "SUCCEEDED");
    } catch (error) {
      const classification = classifyExecutionError(error, command);
      await this.repository.finishAttempt(attemptId, classification.attemptOutcome, {
        errorCode: classification.code,
        errorMessage: error?.message,
        safeDetails: { retryable: classification.retryable, ambiguous: classification.ambiguous }
      });
      await this.repository.finishCommand(command.id, fencingToken, classification.commandStatus, {
        errorCode: classification.code,
        errorMessage: error?.message,
        retryAfterSeconds: classification.retryAfterSeconds
      });
      await this.repository.audit({
        userId: command.user_id,
        connectionId: command.connection_id,
        groupIntentId: command.group_intent_id,
        followerPlanId: command.follower_plan_id,
        commandId: command.id,
        eventType: classification.ambiguous ? "ORDER_SUBMISSION_AMBIGUOUS" : "EXECUTION_COMMAND_FAILED",
        severity: classification.ambiguous ? "ERROR" : classification.retryable ? "WARNING" : "ERROR",
        purpose: "command_execution",
        message: classification.ambiguous
          ? "Order acknowledgement was ambiguous; reconciliation is required before any retry."
          : sanitizeError(error?.message || "Execution command failed."),
        metadata: { code: classification.code, retryable: classification.retryable }
      });
    }
  }

  async expandGroupIntent(command) {
    const intent = await single(this.supabase.from("group_trade_intents").select("*").eq("id", command.group_intent_id));
    assertIntentIntegrity(intent);
    const now = Date.now();
    if (Date.parse(intent.expires_at) <= now) throw terminalError("INTENT_EXPIRED", "Group intent expired before delivery.");
    if (Date.parse(intent.valid_from) > now) throw retryableError("INTENT_NOT_ACTIVE", "Group intent is not active yet.", 5);

    const { data: mandates, error } = await this.supabase
      .from("group_execution_mandates")
      .select("*")
      .eq("group_id", intent.group_id)
      .eq("status", "ACTIVE");
    if (error) throw error;

    let queued = 0;
    for (const mandate of mandates || []) {
      const idempotencyKey = createExecutionIdempotencyKey({
        groupIntentId: intent.id,
        mandateId: mandate.id,
        connectionId: mandate.broker_connection_id,
        intentVersion: intent.intent_version,
        executionLeg: "primary"
      });
      const plan = await upsertSingle(this.supabase.from("follower_execution_plans"), {
        group_intent_id: intent.id,
        mandate_id: mandate.id,
        follower_user_id: mandate.follower_user_id,
        broker_connection_id: mandate.broker_connection_id,
        idempotency_key: idempotencyKey,
        execution_status: "QUEUED"
      }, "group_intent_id,mandate_id");
      const clientOrderId = createDeterministicClientOrderId({ idempotencyKey, leg: "primary" });
      const { error: commandError } = await this.supabase.from("execution_commands").upsert({
        command_type: "PLACE_ORDER",
        user_id: mandate.follower_user_id,
        connection_id: mandate.broker_connection_id,
        group_intent_id: intent.id,
        follower_plan_id: plan.id,
        idempotency_key: idempotencyKey,
        deterministic_client_order_id: clientOrderId,
        payload: { intentId: intent.id, mandateId: mandate.id, executionLeg: "primary" },
        status: "QUEUED"
      }, { onConflict: "idempotency_key", ignoreDuplicates: true });
      if (commandError) throw commandError;
      queued += 1;
    }

    await updateOrThrow(this.supabase.from("group_trade_intents").update({
      status: queued > 0 ? "PROCESSING" : "REJECTED"
    }).eq("id", intent.id));
    await this.repository.audit({
      groupId: intent.group_id,
      groupIntentId: intent.id,
      commandId: command.id,
      eventType: "FOLLOWER_PLANS_CREATED",
      message: queued > 0 ? "Follower execution plans were created server-side." : "No active cloud mandates were eligible.",
      metadata: { eligibleMandates: queued }
    });
    return { queuedPlans: queued };
  }

  async placeFollowerOrder(command) {
    if (process.env.BYBIT_CLOUD_EXECUTION_ENABLED !== "true") throw terminalError("BYBIT_CLOUD_DISABLED", "Bybit Cloud execution is disabled.");
    const [plan, intent, mandate, connection, capabilities] = await Promise.all([
      single(this.supabase.from("follower_execution_plans").select("*").eq("id", command.follower_plan_id)),
      single(this.supabase.from("group_trade_intents").select("*").eq("id", command.group_intent_id)),
      single(this.supabase.from("group_execution_mandates").select("*").eq("id", command.payload.mandateId)),
      single(this.supabase.from("connectivity_connections").select("*").eq("id", command.connection_id)),
      single(this.supabase.from("broker_connection_capabilities").select("*").eq("connection_id", command.connection_id))
    ]);
    assertIntentIntegrity(intent);
    if (connection.provider !== "bybit") throw terminalError("PROVIDER_UNSUPPORTED", `${connection.provider} has no certified Black Cloud worker adapter.`);
    if (!connection.account_id) throw terminalError("ACCOUNT_REFERENCE_MISSING", "Cloud connection is not linked to an exchange account.");

    const [account, secretReference, positions] = await Promise.all([
      single(this.supabase.from("exchange_accounts").select("*").eq("id", connection.account_id)),
      single(this.supabase.from("broker_secret_references").select("id,status").eq("connection_id", connection.id).eq("status", "ACTIVE")),
      rows(this.supabase.from("account_positions").select("margin,unrealized_pnl").eq("account_id", connection.account_id))
    ]);
    if (!account.trading_enabled || account.is_read_only) throw terminalError("ACCOUNT_READ_ONLY", "The venue account is not approved for trading.");

    const credentials = await this.repository.readBrokerSecret(secretReference.id, "group_order_execution");
    const workerNetwork = process.env.BLACK_CLOUD_NETWORK || "testnet";
    if ((credentials.network || "mainnet") !== workerNetwork) throw terminalError("WORKER_NETWORK_MISMATCH", "Credential network does not match this worker's isolated venue network.");
    const marketKind = intent.market_type === "SPOT" ? "spot" : "perpetual";
    const category = marketKind === "spot" ? "spot" : "linear";
    const [wallet, metadataRows, ticker] = await Promise.all([
      getBybitWalletSnapshot(credentials),
      getBybitInstrumentMetadata({ category, symbol: intent.symbol, network: credentials.network }),
      getBybitTicker({ category, symbol: intent.symbol, network: credentials.network })
    ]);
    const instrument = metadataRows[0];
    if (!instrument || String(instrument.tradingStatus).toLowerCase() !== "trading") {
      throw terminalError("MARKET_UNAVAILABLE", `${intent.symbol} is not currently tradable.`);
    }
    const referencePrice = Number(intent.limit_price || intent.stop_price || ticker.markPrice || ticker.lastPrice);
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
      throw terminalError("REFERENCE_PRICE_REQUIRED", "A current server-side reference price is required for follower allocation.");
    }
    const currentExposure = positions.reduce((sum, row) => sum + Math.abs(Number(row.margin || 0)), 0);
    const dailyPnl = positions.reduce((sum, row) => sum + Number(row.unrealized_pnl || 0), 0);
    const allocation = calculateFollowerAllocation({
      intent,
      mandate,
      account: wallet.accountMetrics,
      instrument,
      referencePrice,
      currentExposure
    });
    const risk = evaluateFollowerRisk({
      intent,
      mandate,
      connection,
      capabilities,
      allocation,
      currentExposure,
      dailyPnl
    });
    await updateOrThrow(this.supabase.from("follower_execution_plans").update({
      calculated_equity: allocation.calculatedEquity,
      calculated_available_margin: allocation.calculatedAvailableMargin,
      allocation_percent: allocation.allocationPercent,
      target_notional: allocation.targetNotional,
      rounded_quantity: allocation.roundedQuantity,
      estimated_margin: allocation.estimatedMargin,
      estimated_fee: allocation.targetNotional * 0.0006,
      risk_result: risk.status,
      rejection_reason: risk.reasons.join(" ") || null,
      execution_status: risk.status === "PASSED" ? "QUEUED" : mapRiskStatus(risk.codes),
      safe_result: { riskCodes: risk.codes, constrained: allocation.constrained }
    }).eq("id", plan.id));
    if (risk.status !== "PASSED") throw terminalError(risk.codes[0] || "RISK_REJECTED", risk.reasons.join(" "));

    await this.repository.audit({
      userId: plan.follower_user_id, connectionId: connection.id, groupIntentId: intent.id,
      followerPlanId: plan.id, commandId: command.id, eventType: "ORDER_SUBMITTED",
      purpose: "group_order_execution", message: "A risk-approved follower order was submitted to the certified broker adapter.",
      metadata: { symbol: intent.symbol, orderType: intent.order_type, reduceOnly: intent.reduce_only }
    });

    const clientOrderId = command.deterministic_client_order_id;
    const existingVenueOrder = await findBybitOrderByClientOrderId(credentials, {
      marketKind,
      symbol: intent.symbol,
      clientOrderId
    });
    if (existingVenueOrder) return this.adoptVenueOrder({ command, plan, intent, account, allocation, existingVenueOrder });

    const orderDraft = {
      symbol: intent.symbol,
      marketKind,
      side: ["SELL", "SHORT"].includes(intent.side) ? "sell" : "buy",
      orderType: String(intent.order_type).toLowerCase().replaceAll("_", "-"),
      quantity: allocation.roundedQuantity,
      quantityMode: "quantity",
      referencePrice,
      limitPrice: intent.limit_price,
      stopPrice: intent.stop_price,
      takeProfit: intent.take_profit,
      stopLoss: intent.stop_loss,
      leverage: allocation.leverage,
      marginMode: String(intent.margin_mode || "CROSS").toLowerCase(),
      timeInForce: String(intent.time_in_force || "GTC").toLowerCase(),
      reduceOnly: intent.reduce_only,
      clientOrderId,
      source: "investment-group-cloud"
    };
    const venueValidation = await validateBybitOrderDraft(credentials, orderDraft);
    if (!venueValidation.ok) throw terminalError("VENUE_VALIDATION_REJECTED", venueValidation.reasons.join(" "));

    let venueReport;
    try {
      venueReport = await placeBybitOrder(credentials, orderDraft, venueValidation);
    } catch (error) {
      if (!isAmbiguousTransportError(error)) throw error;
      const recovered = await findBybitOrderByClientOrderId(credentials, { marketKind, symbol: intent.symbol, clientOrderId }).catch(() => null);
      if (recovered) return this.adoptVenueOrder({ command, plan, intent, account, allocation, existingVenueOrder: recovered });
      throw ambiguousError("Bybit submission timed out before acknowledgement. Reconciliation will query the deterministic client order ID.");
    }

    return this.persistAcceptedOrder({ command, plan, intent, account, allocation, venueReport });
  }

  async adoptVenueOrder({ command, plan, intent, account, allocation, existingVenueOrder }) {
    const venueReport = {
      exchangeOrderId: existingVenueOrder.exchangeOrderId || existingVenueOrder.orderId,
      clientOrderId: existingVenueOrder.clientOrderId,
      status: existingVenueOrder.status,
      recoveredByReconciliation: true
    };
    await this.repository.audit({
      userId: plan.follower_user_id,
      connectionId: plan.broker_connection_id,
      groupIntentId: intent.id,
      followerPlanId: plan.id,
      commandId: command.id,
      eventType: "AMBIGUOUS_SUBMISSION_RECONCILED",
      message: "An existing venue order was adopted by deterministic client order ID.",
      metadata: { venueOrderId: venueReport.exchangeOrderId }
    });
    return this.persistAcceptedOrder({ command, plan, intent, account, allocation, venueReport });
  }

  async persistAcceptedOrder({ command, plan, intent, account, allocation, venueReport }) {
    const { data: existing } = await this.supabase.from("execution_orders").select("id,status").eq("client_order_id", command.deterministic_client_order_id).maybeSingle();
    let orderId = existing?.id;
    if (!orderId) {
      const order = await insertSingle(this.supabase.from("execution_orders"), {
        user_id: plan.follower_user_id,
        account_id: account.id,
        exchange: "bybit",
        symbol: intent.symbol,
        side: ["SELL", "SHORT"].includes(intent.side) ? "sell" : "buy",
        order_type: String(intent.order_type).toLowerCase().replaceAll("_", "-"),
        quantity: allocation.roundedQuantity,
        quantity_mode: "quantity",
        limit_price: intent.limit_price,
        stop_price: intent.stop_price,
        take_profit: intent.take_profit,
        stop_loss: intent.stop_loss,
        post_only: intent.time_in_force === "POST_ONLY",
        reduce_only: intent.reduce_only,
        time_in_force: String(intent.time_in_force || "GTC").toLowerCase(),
        status: normalizeInternalStatus(venueReport.status),
        exchange_order_id: venueReport.exchangeOrderId,
        client_order_id: command.deterministic_client_order_id,
        origin: "INVESTMENT_GROUP",
        group_intent_id: intent.id,
        mandate_id: plan.mandate_id,
        filled_quantity: 0,
        estimated_fees: allocation.targetNotional * 0.0006,
        estimated_margin: allocation.estimatedMargin,
        estimated_slippage: 0,
        risk_check_status: "approved",
        risk_check_reasons: []
      });
      orderId = order.id;
    }
    await updateOrThrow(this.supabase.from("follower_execution_plans").update({
      execution_order_id: orderId,
      execution_status: normalizePlanStatus(venueReport.status),
      safe_result: { venueOrderId: venueReport.exchangeOrderId, clientOrderId: command.deterministic_client_order_id }
    }).eq("id", plan.id));
    await this.repository.audit({
      userId: plan.follower_user_id,
      connectionId: plan.broker_connection_id,
      groupIntentId: intent.id,
      followerPlanId: plan.id,
      commandId: command.id,
      eventType: "VENUE_ACKNOWLEDGED",
      message: "Investment Group order was acknowledged by Bybit while under Black Cloud control.",
      metadata: { venueOrderId: venueReport.exchangeOrderId, orderId }
    });
    return { venueOrderId: venueReport.exchangeOrderId, orderId, recovered: Boolean(venueReport.recoveredByReconciliation) };
  }

  async syncAccount(command) {
    const connection = await single(this.supabase.from("connectivity_connections").select("*").eq("id", command.connection_id));
    if (connection.provider !== "bybit" || !connection.account_id) throw terminalError("SYNC_UNSUPPORTED", "Only linked Bybit cloud connections are currently supported.");
    const [account, secretReference] = await Promise.all([
      single(this.supabase.from("exchange_accounts").select("*").eq("id", connection.account_id)),
      single(this.supabase.from("broker_secret_references").select("id").eq("connection_id", connection.id).eq("status", "ACTIVE"))
    ]);
    const credentials = await this.repository.readBrokerSecret(secretReference.id, "account_reconciliation");
    const result = await syncBybitSnapshotAndReconcile(this.supabase, account.user_id, account, credentials, {
      symbol: command.payload.symbol || "BTCUSDT",
      marketKind: command.payload.marketKind || "perpetual",
      network: credentials.network || connection.metadata?.network || "mainnet"
    });
    await updateOrThrow(this.supabase.from("connectivity_connections").update({
      health_status: "CONNECTED_CLOUD",
      lifecycle_status: "HEALTHY",
      last_reconciled_at: result.syncedAt,
      last_error_code: null
    }).eq("id", connection.id));
    return { reconciled: true, externalStateChanged: result.externalStateChanged, latencyMs: result.latencyMs };
  }

  async releaseForRetry(command, delay, code, message) {
    await this.supabase.from("execution_commands").update({
      status: "RETRY",
      available_at: new Date(Date.now() + delay * 1_000).toISOString(),
      locked_by: null,
      locked_until: null,
      last_error_code: code,
      last_error_message: message
    }).eq("id", command.id).eq("locked_by", this.workerId);
  }
}

function assertIntentIntegrity(intent) {
  const payload = intentSigningPayload(intent);
  const hash = hashCanonicalPayload(payload);
  if (hash !== intent.canonical_hash) throw terminalError("INTENT_HASH_MISMATCH", "Group intent payload hash does not match its signed envelope.");
  if (!verifyCanonicalSignature(payload, intent.service_signature)) throw terminalError("INTENT_SIGNATURE_INVALID", "Group intent service signature is invalid.");
}

function mapRiskStatus(codes) {
  if (codes.includes("CONNECTION_UNHEALTHY") || codes.includes("CONNECTION_NOT_CLOUD")) return "CONNECTION_UNHEALTHY";
  if (codes.includes("SYMBOL_NOT_ALLOWED")) return "SYMBOL_NOT_ALLOWED";
  if (codes.includes("MANDATE_PAUSED")) return "MANDATE_PAUSED";
  if (codes.includes("INSUFFICIENT_MARGIN")) return "INSUFFICIENT_MARGIN";
  return "RISK_REJECTED";
}

function normalizePlanStatus(status) {
  if (status === "filled") return "FILLED";
  if (status === "partially-filled") return "PARTIALLY_FILLED";
  return "WORKING";
}

function normalizeInternalStatus(status) {
  if (status === "filled") return "filled";
  if (status === "partially-filled") return "partially-filled";
  return "accepted";
}

function classifyExecutionError(error, command) {
  const code = error?.code || "EXECUTION_FAILED";
  const ambiguous = error?.ambiguous === true;
  const retryable = ambiguous || error?.retryable === true || isRetryableTransportError(error);
  const exhausted = Number(command.attempt_count) >= Number(command.max_attempts);
  return {
    code,
    ambiguous,
    retryable,
    retryAfterSeconds: error?.retryAfterSeconds || Math.min(60, 2 ** Math.min(6, Number(command.attempt_count))),
    attemptOutcome: ambiguous ? "SUBMISSION_UNKNOWN" : retryable ? "RETRY" : "FAILED",
    commandStatus: exhausted ? "DEAD_LETTER" : ambiguous ? "SUBMISSION_UNKNOWN" : retryable ? "RETRY" : "FAILED"
  };
}

function isRetryableTransportError(error) {
  return /timeout|timed out|econnreset|econnrefused|fetch failed|rate limit|temporar|service unavailable|502|503|504/i.test(String(error?.message || error));
}

function isAmbiguousTransportError(error) {
  return /timeout|timed out|econnreset|socket hang up|fetch failed|502|503|504/i.test(String(error?.message || error));
}

function terminalError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function retryableError(code, message, retryAfterSeconds) {
  const error = terminalError(code, message);
  error.retryable = true;
  error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

function ambiguousError(message) {
  const error = terminalError("SUBMISSION_UNKNOWN", message);
  error.ambiguous = true;
  error.retryable = true;
  return error;
}

function buildWorkerId() {
  return `${process.env.BLACK_CLOUD_WORKER_REGION || "local"}:${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
}

async function rows(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function single(query) {
  const { data, error } = await query.single();
  if (error || !data) throw error || new Error("Required Black Cloud record was not found.");
  return data;
}

async function insertSingle(query, payload) {
  const { data, error } = await query.insert(payload).select("*").single();
  if (error) throw error;
  return data;
}

async function upsertSingle(query, payload, onConflict) {
  const { data, error } = await query.upsert(payload, { onConflict }).select("*").single();
  if (error) throw error;
  return data;
}

async function updateOrThrow(query) {
  const { error } = await query;
  if (error) throw error;
}
