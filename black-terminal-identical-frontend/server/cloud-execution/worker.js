import {
  findBybitOrderByClientOrderId,
  getBybitInstrumentMetadata,
  getBybitPositions,
  getBybitTicker,
  getBybitWalletSnapshot,
  validateBybitOrderDraft
} from "../exchanges/bybit.js";
import { syncBybitSnapshotAndReconcile } from "../exchanges/bybit-reconciliation.js";
import { calculateFollowerAllocation, evaluateFollowerRisk } from "./allocation-risk.js";
import {
  createDeterministicClientOrderId,
  createExecutionIdempotencyKey,
  hashCanonicalPayload,
  intentSigningPayload,
  runMandateSignatureSelfTest,
  verifyCanonicalSignature
} from "./canonical.js";
import { BlackCloudRepository, sanitizeError } from "./repository.js";
import { BrokerConnectionManager } from "./connection-supervisor.js";
import { validateBlackCloudRuntime } from "./runtime-config.js";
import { createCloudExchangeAdapter } from "./adapters/registry.js";
import { normalizeBybitExecutionEnvironment } from "../exchanges/bybit-endpoints.js";
import { runBrokerCredentialCryptoSelfTest } from "./secret-vault.js";
import { measureBybitClockHealth, WORKER_CLOCK_STATUSES } from "./clock-health.js";
import { calculateCapitalPreview, calculateEffectiveLeverage, normalizeCapitalPolicy } from "../strategy-automation/domain.js";
import {
  calculateStrategyTakeProfitQuantity,
  evaluateStrategyTakeProfitLadder,
  floorStrategyVenueQuantity,
  resolveStrategyTakeProfitPrice,
  settledStrategyEntryQuantity
} from "../strategy-automation/superatr-execution.js";
import fs from "node:fs";

const BLACK_CLOUD_SOFTWARE_VERSION = readPackageVersion();
const MAX_STRATEGY_REVERSAL_CLOSE_LEGS = 4;

export const WORKER_STARTUP_PHASES = Object.freeze({
  PROCESS_STARTING: "PROCESS_STARTING",
  CONFIG_VALIDATING: "CONFIG_VALIDATING",
  CRYPTO_SELF_TEST: "CRYPTO_SELF_TEST",
  DATABASE_CONNECTING: "DATABASE_CONNECTING",
  SCHEMA_VALIDATING: "SCHEMA_VALIDATING",
  LEASE_SUBSYSTEM_READY: "LEASE_SUBSYSTEM_READY",
  QUEUE_READY: "QUEUE_READY",
  WORKER_READY: "WORKER_READY",
  CONFIGURATION_ERROR: "CONFIGURATION_ERROR",
  CRYPTOGRAPHIC_ERROR: "CRYPTOGRAPHIC_ERROR",
  DATABASE_UNAVAILABLE: "DATABASE_UNAVAILABLE",
  SCHEMA_MISMATCH: "SCHEMA_MISMATCH",
  LEASE_UNAVAILABLE: "LEASE_UNAVAILABLE",
  QUEUE_UNAVAILABLE: "QUEUE_UNAVAILABLE",
  CLOCK_UNSAFE: "CLOCK_UNSAFE",
  FATAL: "FATAL"
});

export class BlackCloudExecutionWorker {
  constructor(supabase, options = {}) {
    this.supabase = supabase;
    this.workerId = options.workerId || buildWorkerId();
    this.nodeId = options.nodeId || process.env.BLACK_CLOUD_NODE_ID || null;
    this.pollIntervalMs = options.pollIntervalMs || 1_000;
    this.claimLimit = options.claimLimit || 10;
    this.leaseTtlSeconds = options.leaseTtlSeconds || 30;
    const rawEnvironment = options.executionEnvironment || process.env.BLACK_CLOUD_EXECUTION_ENVIRONMENT || process.env.BYBIT_EXECUTION_ENVIRONMENT || process.env.BLACK_CLOUD_NETWORK;
    const configuredEnvironment = rawEnvironment ? normalizeBybitExecutionEnvironment(rawEnvironment) : null;
    this.repository = new BlackCloudRepository(
      supabase,
      this.workerId,
      configuredEnvironment,
      configuredEnvironment === "MAINNET_LIVE"
    );
    this.connectionSupervisor = new BrokerConnectionManager(supabase, this.repository, {
      leaseTtlSeconds: this.leaseTtlSeconds
    });
    this.running = false;
    this.startedAt = null;
    this.lastTickAt = null;
    this.lastLoopError = null;
    this.timer = null;
    this.inFlight = new Set();
    this.lastReadiness = { ready: false, workerIdentity: Boolean(this.workerId), dependencies: {} };
    this.lastReadinessAt = null;
    this.runtime = null;
    this.startupPhase = WORKER_STARTUP_PHASES.PROCESS_STARTING;
    this.cryptoSelfTest = null;
    this.clockHealth = null;
    this.lastClockCheckAt = null;
    this.lastNodeHeartbeatAt = null;
    this.metricsCounters = {
      commandsClaimed: 0,
      commandsSucceeded: 0,
      commandsFailed: 0,
      leaseContention: 0,
      unknownSubmissionOutcomes: 0,
      fencingRejections: 0,
      ordersSubmitted: 0,
      ordersConfirmed: 0,
      ordersRejected: 0
    };
  }

  assertRuntime() {
    return validateBlackCloudRuntime();
  }

  async start() {
    this.startedAt = new Date().toISOString();
    try {
      this.setStartupPhase(WORKER_STARTUP_PHASES.CONFIG_VALIDATING);
      this.runtime = this.assertRuntime();
      this.nodeId = this.runtime.nodeId;
      this.repository.executionEnvironment = this.runtime.executionEnvironment;
      this.repository.claimGlobalCommands = this.runtime.executionEnvironment === "MAINNET_LIVE";
      this.setStartupPhase(WORKER_STARTUP_PHASES.CRYPTO_SELF_TEST);
      this.cryptoSelfTest = {
        status: "PASS",
        vaultEnvelope: runBrokerCredentialCryptoSelfTest(this.runtime),
        automationMandate: runMandateSignatureSelfTest()
      };
      this.setStartupPhase(WORKER_STARTUP_PHASES.DATABASE_CONNECTING);
      this.lastReadiness = await this.repository.probeReadiness();
      this.lastReadinessAt = new Date().toISOString();
      const dependencies = this.lastReadiness.dependencies || {};
      if (!Object.values(dependencies).some(Boolean)) throw terminalError("DATABASE_UNAVAILABLE", "Black Cloud database is unavailable.");
      if (["credentialVault", "eventInbox", "nodeRegistry", "strategyRuntime"].some((name) => !dependencies[name])) throw terminalError("SCHEMA_MISMATCH", "Black Cloud required schema is unavailable; verify the Phase V Chapter II migrations.");
      this.setStartupPhase(WORKER_STARTUP_PHASES.SCHEMA_VALIDATING);
      if (!this.lastReadiness.dependencies?.leaseSubsystem) throw terminalError("LEASE_UNAVAILABLE", "Black Cloud lease subsystem is unavailable.");
      this.setStartupPhase(WORKER_STARTUP_PHASES.LEASE_SUBSYSTEM_READY);
      if (!this.lastReadiness.dependencies?.queue) throw terminalError("QUEUE_UNAVAILABLE", "Black Cloud durable execution queue is unavailable.");
      this.setStartupPhase(WORKER_STARTUP_PHASES.QUEUE_READY);
      if (!this.lastReadiness.ready) throw terminalError("WORKER_DEPENDENCIES_UNAVAILABLE", "Black Cloud database, vault, schema, lease, or queue readiness failed.");
      this.clockHealth = await measureBybitClockHealth(this.runtime);
      this.lastClockCheckAt = new Date().toISOString();
      this.running = true;
      await this.writeNodeState("STARTING");
      await this.connectionSupervisor.start();
      if (this.clockHealth.status === WORKER_CLOCK_STATUSES.UNSAFE) {
        this.setStartupPhase(WORKER_STARTUP_PHASES.CLOCK_UNSAFE);
        await this.writeNodeState("DEGRADED");
        await this.emitClockUnsafeAudit();
      } else {
        this.setStartupPhase(WORKER_STARTUP_PHASES.WORKER_READY);
        await this.writeNodeState("READY");
      }
      await this.repository.audit({
        eventType: "WORKER_STARTED",
        severity: "INFO",
        purpose: "worker_lifecycle",
        userVisible: false,
        message: "Black Cloud execution worker started.",
        metadata: { nodeId: this.nodeId, workerId: this.workerId, deploymentCommit: this.runtime.deploymentCommit, executionEnvironment: this.runtime.executionEnvironment, endpointProfile: this.runtime.endpointProfile }
      });
      await this.tick();
    } catch (error) {
      this.lastLoopError = sanitizeError(error?.message || error);
      this.setStartupPhase(classifyStartupFailure(error, this.startupPhase));
      await this.writeNodeState("DEGRADED").catch(() => null);
      throw error;
    }
  }

  async stop() {
    this.running = false;
    this.setStartupPhase("DRAINING");
    await this.writeNodeState("DRAINING").catch(() => null);
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
      metadata: { nodeId: this.nodeId, workerId: this.workerId }
    });
    await this.writeNodeState("OFFLINE").catch(() => null);
  }

  async tick() {
    if (!this.running) return;
    try {
      this.lastTickAt = new Date().toISOString();
      this.lastLoopError = null;
      if (!this.lastClockCheckAt || Date.now() - Date.parse(this.lastClockCheckAt) > 30_000) await this.refreshClockHealth();
      const commands = this.isClockSafe() ? await this.repository.claimCommands(this.claimLimit) : [];
      this.metricsCounters.commandsClaimed += (commands || []).length;
      for (const command of commands || []) {
        const task = this.processCommand(command).finally(() => this.inFlight.delete(task));
        this.inFlight.add(task);
      }
      await Promise.allSettled([...this.inFlight]);
      if (!this.lastReadinessAt || Date.now() - Date.parse(this.lastReadinessAt) > 10_000) {
        this.lastReadiness = await this.repository.probeReadiness();
        this.lastReadinessAt = new Date().toISOString();
      }
      if (!this.lastNodeHeartbeatAt || Date.now() - Date.parse(this.lastNodeHeartbeatAt) >= this.runtime.nodeHeartbeatIntervalMs) {
        await this.writeNodeState(this.isClockSafe() ? "READY" : "DEGRADED");
      }
    } catch (error) {
      this.lastLoopError = sanitizeError(error?.message || error);
      console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "ERROR", event: "worker_loop_failed", nodeId: this.nodeId, workerInstanceId: this.workerId, error: sanitizeError(error?.message || error) }));
    } finally {
      if (this.running) this.timer = setTimeout(() => void this.tick(), this.pollIntervalMs);
    }
  }

  diagnostics() {
    const operationalReady = this.running && this.lastReadiness?.ready === true && this.cryptoSelfTest?.status === "PASS" && this.isClockSafe() && this.startupPhase === WORKER_STARTUP_PHASES.WORKER_READY && !this.lastLoopError;
    return {
      nodeId: this.nodeId,
      workerId: this.workerId,
      running: this.running,
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
      lastLoopError: this.lastLoopError,
      inFlightCommands: this.inFlight.size,
      supervisedConnections: this.connectionSupervisor.connections.size,
      executionEnvironment: process.env.BLACK_CLOUD_EXECUTION_ENVIRONMENT || process.env.BYBIT_EXECUTION_ENVIRONMENT || null,
      endpointProfile: process.env.BYBIT_ENDPOINT_PROFILE || "GLOBAL",
      deploymentCommit: this.runtime?.deploymentCommit || process.env.BLACK_CLOUD_DEPLOYMENT_COMMIT || null,
      imageDigest: this.runtime?.imageDigest || process.env.BLACK_CLOUD_IMAGE_DIGEST || null,
      startupPhase: this.startupPhase,
      clockHealth: this.clockHealth,
      cryptoSelfTest: this.cryptoSelfTest,
      lastNodeHeartbeatAt: this.lastNodeHeartbeatAt,
      operationalReady,
      readiness: this.lastReadiness,
      lastReadinessAt: this.lastReadinessAt,
      connectionMetrics: this.connectionSupervisor.diagnostics(),
      counters: { ...this.metricsCounters }
    };
  }

  async readiness() {
    this.lastReadiness = await this.repository.probeReadiness();
    this.lastReadinessAt = new Date().toISOString();
    const tickFresh = this.lastTickAt && Date.now() - Date.parse(this.lastTickAt) <= Math.max(15_000, this.pollIntervalMs * 5);
    const cryptoReady = this.cryptoSelfTest?.status === "PASS";
    const clockSafe = this.isClockSafe();
    const draining = this.startupPhase === "DRAINING";
    return { ...this.lastReadiness, ready: this.running && tickFresh && !this.lastLoopError && this.lastReadiness.ready && cryptoReady && clockSafe && !draining, tickFresh, cryptoReady, clockSafe, startupPhase: this.startupPhase };
  }

  async processCommand(command) {
    if (command.command_type === "PLACE_ORDER") this.assertSubmissionClockSafe();
    const lease = await this.repository.acquireLease(command.connection_id, this.leaseTtlSeconds);
    if (!lease) {
      this.metricsCounters.leaseContention += 1;
      await this.repository.releaseLeaseContention(command.id, 2);
      return;
    }

    const fencingToken = Number(lease.fencing_token);
    const attemptId = await this.repository.startAttempt(command, fencingToken);
    try {
      let result;
      if (command.command_type === "EXPAND_GROUP_INTENT") result = await this.expandGroupIntent(command);
      else if (command.command_type === "PLACE_ORDER" && command.strategy_target_binding_id) result = await this.placeStrategyOrder(command, fencingToken);
      else if (command.command_type === "PLACE_ORDER") result = await this.placeFollowerOrder(command, fencingToken);
      else if (command.command_type === "MODIFY_ORDER" && command.strategy_target_binding_id) result = await this.modifyStrategyTakeProfitOrder(command, fencingToken);
      else if (command.command_type === "MODIFY_ORDER") result = await this.executeBrokerMutation(command, fencingToken, "modify");
      else if (command.command_type === "CANCEL_ORDER") result = await this.executeBrokerMutation(command, fencingToken, "cancel");
      else if (command.command_type === "CANCEL_ALL") result = await this.executeBrokerMutation(command, fencingToken, "cancel-all");
      else if (command.command_type === "SYNC_ACCOUNT") result = await this.syncAccount(command);
      else throw terminalError("UNSUPPORTED_COMMAND", `Unsupported Black Cloud command: ${command.command_type}`);

      await this.repository.finishAttempt(attemptId, "SUCCEEDED", {
        venueOrderId: result?.venueOrderId,
        safeDetails: result || {}
      });
      await this.repository.finishCommand(command.id, fencingToken, "SUCCEEDED");
      this.metricsCounters.commandsSucceeded += 1;
    } catch (error) {
      const classification = classifyExecutionError(error, command);
      this.metricsCounters.commandsFailed += 1;
      if (/fencing|stale worker/i.test(String(error?.message || error))) this.metricsCounters.fencingRejections += 1;
      if (command.command_type === "PLACE_ORDER" && !classification.ambiguous && classification.code !== "STRATEGY_REVERSE_WAITING_FOR_FLAT") this.metricsCounters.ordersRejected += 1;
      if (classification.ambiguous) this.metricsCounters.unknownSubmissionOutcomes += 1;
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
        strategy_automation_id: intent.strategy_automation_id || null,
        strategy_target_binding_id: intent.strategy_target_binding_id || null,
        strategy_signal_key: intent.strategy_target_binding_id ? `${intent.client_intent_id}:${mandate.id}` : null,
        idempotency_key: idempotencyKey,
        deterministic_client_order_id: clientOrderId,
        payload: { intentId: intent.id, mandateId: mandate.id, executionLeg: "primary" },
        status: "QUEUED",
        max_attempts: intent.strategy_target_binding_id ? 100 : 8
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

  async placeFollowerOrder(command, fencingToken) {
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

    const credentials = await this.repository.readBrokerSecret(secretReference.id, "group_order_execution");
    const credentialEnvironment = normalizeBybitExecutionEnvironment(credentials.executionEnvironment || credentials.network);
    const workerEnvironment = normalizeBybitExecutionEnvironment(process.env.BLACK_CLOUD_EXECUTION_ENVIRONMENT || process.env.BYBIT_EXECUTION_ENVIRONMENT || process.env.BLACK_CLOUD_NETWORK);
    if (credentialEnvironment !== workerEnvironment) throw terminalError("WORKER_ENVIRONMENT_MISMATCH", "Credential environment does not match this worker's isolated venue environment.");
    if (normalizeBybitExecutionEnvironment(connection.execution_environment) !== credentialEnvironment) throw terminalError("CONNECTION_ENVIRONMENT_MISMATCH", "Connection and credential execution environments differ.");
    const marketKind = intent.market_type === "SPOT" ? "spot" : "perpetual";
    const category = marketKind === "spot" ? "spot" : "linear";
    const [wallet, metadataRows, ticker, venuePositions] = await Promise.all([
      getBybitWalletSnapshot(credentials),
      getBybitInstrumentMetadata({ category, symbol: intent.symbol, executionEnvironment: credentialEnvironment, endpointProfile: credentials.endpointProfile }),
      getBybitTicker({ category, symbol: intent.symbol, executionEnvironment: credentialEnvironment, endpointProfile: credentials.endpointProfile }),
      marketKind === "spot" ? Promise.resolve([]) : getBybitPositions(credentials, { category, symbol: intent.symbol, includeEmpty: true })
    ]);
    const instrument = metadataRows[0];
    if (!instrument || String(instrument.tradingStatus).toLowerCase() !== "trading") {
      throw terminalError("MARKET_UNAVAILABLE", `${intent.symbol} is not currently tradable.`);
    }
    let referencePrice = Number(intent.limit_price || intent.stop_price || ticker.markPrice || ticker.lastPrice);
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
      throw terminalError("REFERENCE_PRICE_REQUIRED", "A current server-side reference price is required for follower allocation.");
    }
    const groupDesiredDirection = String(intent.strategy_direction || "").toLowerCase();
    const groupRecoveryPositionIdx = (direction) => venuePositions.some((item) => item.positionIdx === 1 || item.positionIdx === 2)
      ? (direction === "long" ? 1 : 2)
      : 0;
    const adoptRecoveredGroupOrder = async (venueOrder, clientOrderId, expected, options = {}) => {
      assertRecoveredVenueOrderShape(venueOrder, expected);
      const recoveredIntent = recoveredGroupIntentFromVenue(intent, venueOrder);
      const allocation = recoveredFollowerAllocation(venueOrder, wallet.accountMetrics, referencePrice);
      const adopted = await this.adoptVenueOrder({ command, plan, intent: recoveredIntent, account, allocation, existingVenueOrder: venueOrder, clientOrderId });
      if (isTerminalUnfilledVenueOrder(venueOrder) && options.allowTerminalUnfilled !== true) throw terminalError("STRATEGY_ORDER_UNFILLED", "Bybit terminated the recovered follower strategy order without a fill.");
      return adopted;
    };
    let recoveredGroupReverseClose = null;
    let groupReverseCloseLeg = "c";
    if (intent.strategy_action === "TAKE_PROFIT") {
      const recoveredTarget = await findBybitOrderByClientOrderId(credentials, { marketKind, symbol: intent.symbol, clientOrderId: command.deterministic_client_order_id });
      if (recoveredTarget) {
        return adoptRecoveredGroupOrder(recoveredTarget, command.deterministic_client_order_id, {
          category,
          symbol: intent.symbol,
          side: groupDesiredDirection === "long" ? "sell" : "buy",
          reduceOnly: true,
          positionIdx: groupRecoveryPositionIdx(groupDesiredDirection),
          orderType: "limit",
        });
      }
    } else if (intent.strategy_action === "SYNC_DIRECTION") {
      const conflictResolution = String(intent.strategy_execution_policy?.conflictResolution || "CLOSE_ONLY").toUpperCase();
      const reverse = conflictResolution === "CLOSE_THEN_REVERSE";
      if (reverse) {
        const entryClientOrderId = deterministicStrategyLegId(command.deterministic_client_order_id, "e");
        const recoveredEntry = await findBybitOrderByClientOrderId(credentials, { marketKind, symbol: intent.symbol, clientOrderId: entryClientOrderId });
        if (recoveredEntry) {
          return adoptRecoveredGroupOrder(recoveredEntry, entryClientOrderId, {
            category,
            symbol: intent.symbol,
            side: groupDesiredDirection === "short" ? "sell" : "buy",
            reduceOnly: false,
            positionIdx: groupRecoveryPositionIdx(groupDesiredDirection),
            orderType: "market",
          });
        }
        const closeDirection = groupDesiredDirection === "long" ? "short" : "long";
        const closeStillOpen = venuePositions.some((position) => Number(position.quantity) > 0 && position.direction === closeDirection);
        for (let legNumber = 1; legNumber <= MAX_STRATEGY_REVERSAL_CLOSE_LEGS; legNumber += 1) {
          const leg = reversalCloseLegName(legNumber);
          const closeClientOrderId = deterministicStrategyLegId(command.deterministic_client_order_id, leg);
          const recoveredCloseLeg = await findBybitOrderByClientOrderId(credentials, { marketKind, symbol: intent.symbol, clientOrderId: closeClientOrderId });
          if (!recoveredCloseLeg) {
            groupReverseCloseLeg = leg;
            recoveredGroupReverseClose = null;
            break;
          }
          recoveredGroupReverseClose = recoveredCloseLeg;
          await adoptRecoveredGroupOrder(recoveredCloseLeg, closeClientOrderId, {
            category,
            symbol: intent.symbol,
            side: groupDesiredDirection === "short" ? "sell" : "buy",
            reduceOnly: true,
            positionIdx: groupRecoveryPositionIdx(closeDirection),
            orderType: "market",
          }, { allowTerminalUnfilled: true });
          if (!isTerminalVenueOrder(recoveredCloseLeg)) {
            throw retryableError("STRATEGY_REVERSE_WAITING_FOR_FLAT", "The recovered follower close leg is still settling; the reverse entry remains blocked until Bybit confirms the prior position is flat.", 2);
          }
          if (!closeStillOpen) break;
          if (legNumber === MAX_STRATEGY_REVERSAL_CLOSE_LEGS) {
            throw terminalError("STRATEGY_REVERSE_RESIDUAL_CLOSE_EXHAUSTED", "Four deterministic follower close legs completed but Bybit still reports residual exposure. Reverse entry remains blocked for manual reconciliation.");
          }
          groupReverseCloseLeg = reversalCloseLegName(legNumber + 1);
          recoveredGroupReverseClose = null;
        }
      } else {
        const recoveredPrimary = await findBybitOrderByClientOrderId(credentials, { marketKind, symbol: intent.symbol, clientOrderId: command.deterministic_client_order_id });
        if (recoveredPrimary) {
          const recoveredReduceOnly = Boolean(recoveredPrimary.reduceOnly);
          const recoveredDirection = recoveredReduceOnly
            ? (groupDesiredDirection === "long" ? "short" : "long")
            : groupDesiredDirection;
          return adoptRecoveredGroupOrder(recoveredPrimary, command.deterministic_client_order_id, {
            category,
            symbol: intent.symbol,
            side: groupDesiredDirection === "short" ? "sell" : "buy",
            reduceOnly: recoveredReduceOnly,
            positionIdx: groupRecoveryPositionIdx(recoveredDirection),
            orderType: "market",
          });
        }
      }
    }

    // Recovery above is deliberately allowed after a pause, mandate revocation,
    // read-only transition, or kill switch. A Bybit side effect acknowledged
    // before that control-plane change must still be adopted into the ledger.
    // Every mutable authorization is re-evaluated here before any new order can
    // be submitted.
    this.assertSubmissionClockSafe();
    if (process.env.INVESTMENT_GROUP_EXECUTION_ENABLED !== "true") throw terminalError("INVESTMENT_GROUP_EXECUTION_DISABLED", "Investment Group execution is disabled on this worker.");
    if (process.env.BYBIT_CLOUD_EXECUTION_ENABLED !== "true") throw terminalError("BYBIT_CLOUD_DISABLED", "Bybit Cloud execution is disabled.");
    const automationMandate = await this.repository.requireAutomationMandate(connection.id, "group");
    if (normalizeBybitExecutionEnvironment(automationMandate.execution_environment) !== credentialEnvironment) throw terminalError("MANDATE_ENVIRONMENT_MISMATCH", "Automation mandate cannot execute in a different broker environment.");
    if (!account.trading_enabled || account.is_read_only) throw terminalError("ACCOUNT_READ_ONLY", "The venue account is not approved for trading.");

    const currentExposure = positions.reduce((sum, row) => sum + Math.abs(Number(row.margin || 0)), 0);
    const dailyPnl = positions.reduce((sum, row) => sum + Number(row.unrealized_pnl || 0), 0);
    const executionIntent = { ...intent };
    let strategyReverseClose = false;
    let strategyReverseIntent = false;
    let strategyPositionIdx = 0;
    let strategyCloseQuantity = null;
    if (intent.strategy_action === "TAKE_PROFIT" && intent.strategy_target_binding_id) {
      const desiredDirection = String(intent.strategy_direction || "").toLowerCase();
      const parentGroupIntentId = String(intent.strategy_execution_policy?.parentGroupIntentId || "");
      if (!parentGroupIntentId) throw terminalError("STRATEGY_GROUP_TAKE_PROFIT_PARENT_REQUIRED", "A follower target without an immutable parent direction intent is unsafe.");
      const parentPlan = await oneOrNull(this.supabase.from("follower_execution_plans")
        .select("id,execution_order_id,execution_status")
        .eq("group_intent_id", parentGroupIntentId)
        .eq("mandate_id", mandate.id)
        .maybeSingle());
      if (!parentPlan?.execution_order_id) {
        if (["REJECTED", "FAILED", "CANCELLED"].includes(String(parentPlan?.execution_status || "").toUpperCase())) return { skipped: true, reason: "PARENT_GROUP_ENTRY_FAILED" };
        throw retryableError("STRATEGY_GROUP_TAKE_PROFIT_WAITING_FOR_PARENT_ENTRY", "The follower parent entry has not completed; this target will retry.", 2);
      }
      const parentOrder = await oneOrNull(this.supabase.from("execution_orders")
        .select("id,client_order_id,side,quantity,reduce_only,group_intent_id,mandate_id,strategy_target_binding_id")
        .eq("id", parentPlan.execution_order_id)
        .maybeSingle());
      const expectedEntrySide = desiredDirection === "short" ? "sell" : "buy";
      if (!parentOrder || parentOrder.reduce_only === true || parentOrder.group_intent_id !== parentGroupIntentId || parentOrder.mandate_id !== mandate.id || parentOrder.strategy_target_binding_id !== intent.strategy_target_binding_id || parentOrder.side !== expectedEntrySide) {
        throw retryableError("STRATEGY_GROUP_TAKE_PROFIT_WAITING_FOR_PARENT_ENTRY", "The follower reversal is still on its close leg; this target will not attach to the old position.", 2);
      }
      const matchingEntries = await rows(this.supabase.from("execution_orders")
        .select("id,status,filled_quantity")
        .eq("account_id", account.id)
        .eq("strategy_target_binding_id", intent.strategy_target_binding_id)
        .eq("symbol", intent.symbol)
        .eq("side", expectedEntrySide)
        .eq("reduce_only", false)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(20));
      const latestMatchingEntry = matchingEntries.find(isPotentialPositionGeneration);
      if (!latestMatchingEntry || latestMatchingEntry.id !== parentOrder.id) {
        return { skipped: true, reason: "STALE_STRATEGY_TP_GENERATION" };
      }
      const parentVenueOrder = await findBybitOrderByClientOrderId(credentials, { marketKind, symbol: intent.symbol, clientOrderId: parentOrder.client_order_id });
      const originalEntryQuantity = settledStrategyEntryQuantity(parentVenueOrder);
      if (!originalEntryQuantity) {
        const parentStatus = String(parentVenueOrder?.status || "").toLowerCase();
        if (["cancelled", "canceled", "expired", "rejected", "failed"].includes(parentStatus)) return { skipped: true, reason: "PARENT_GROUP_ENTRY_UNFILLED" };
        throw retryableError("STRATEGY_GROUP_TAKE_PROFIT_WAITING_FOR_PARENT_FILL", "The follower parent IOC entry has not reached a final cumulative fill.", 2);
      }
      const position = venuePositions.find((item) => Number(item.quantity) > 0 && item.direction === desiredDirection);
      if (!position) throw retryableError("STRATEGY_GROUP_TAKE_PROFIT_WAITING_FOR_POSITION", "The follower entry is not visible on Bybit yet; the reduce-only take-profit will retry.", 2);
      const owned = await rows(this.supabase.from("account_positions").select("position_idx,direction,strategy_target_binding_id").eq("account_id", account.id).eq("symbol", intent.symbol).gt("quantity", 0));
      const persistedPosition = owned.find((item) => Number(item.position_idx) === Number(position.positionIdx) && item.direction === position.direction);
      if (!persistedPosition) throw retryableError("STRATEGY_POSITION_OWNERSHIP_PENDING", "The follower entry is visible at Bybit but its immutable strategy ownership is still reconciling.", 2);
      if (persistedPosition.strategy_target_binding_id !== intent.strategy_target_binding_id) throw terminalError("STRATEGY_POSITION_OWNERSHIP_REQUIRED", "Black Cloud refused to protect a follower position attributed to a different strategy target.");
      const quantityPercent = Math.max(0.1, Math.min(100, Number(intent.strategy_execution_policy?.quantityPercent || 0)));
      executionIntent.side = position.direction === "long" ? "SELL" : "BUY";
      executionIntent.reduce_only = true;
      executionIntent.take_profit = null;
      executionIntent.stop_loss = null;
      executionIntent.limit_price = resolveStrategyTakeProfitPrice({
        ...intent.strategy_execution_policy,
        targetPrice: intent.limit_price,
        direction: desiredDirection,
      }, position);
      if (!executionIntent.limit_price) throw terminalError("STRATEGY_TAKE_PROFIT_PRICE_INVALID", "The strategy take-profit formula did not resolve to a positive venue price.");
      referencePrice = executionIntent.limit_price;
      strategyPositionIdx = Number(position.positionIdx || 0);
      strategyCloseQuantity = calculateStrategyTakeProfitQuantity(originalEntryQuantity, quantityPercent, Number(position.quantity));
    }
    if (intent.strategy_action === "SYNC_DIRECTION" && intent.strategy_target_binding_id) {
      const desiredDirection = String(intent.strategy_direction || "").toLowerCase();
      const openVenuePositions = venuePositions.filter((position) => Number(position.quantity) > 0 && position.direction !== "flat");
      const same = openVenuePositions.find((position) => position.direction === desiredDirection);
      const opposite = openVenuePositions.find((position) => position.direction !== desiredDirection);
      const conflictResolution = String(intent.strategy_execution_policy?.conflictResolution || "CLOSE_ONLY").toUpperCase();
      strategyReverseIntent = conflictResolution === "CLOSE_THEN_REVERSE";
      if (same && !opposite) return { skipped: true, reason: "DESIRED_GROUP_POSITION_ALREADY_OPEN" };
      if (same && opposite) throw terminalError("STRATEGY_GROUP_HEDGE_STATE_AMBIGUOUS", "The follower account has both hedge legs open and requires manual reconciliation.");
      if (opposite) {
        const owned = await rows(this.supabase.from("account_positions")
          .select("position_idx,direction,strategy_target_binding_id")
          .eq("account_id", account.id)
          .eq("symbol", intent.symbol)
          .gt("quantity", 0));
        const persistedPosition = owned.find((position) => Number(position.position_idx) === Number(opposite.positionIdx) && position.direction === opposite.direction);
        if (!persistedPosition) throw retryableError("STRATEGY_POSITION_OWNERSHIP_PENDING", "The follower position is visible at Bybit but its immutable strategy ownership is still reconciling.", 2);
        if (persistedPosition.strategy_target_binding_id !== intent.strategy_target_binding_id) throw terminalError("STRATEGY_POSITION_OWNERSHIP_REQUIRED", "Black Cloud refused to change a follower position attributed to a different strategy target.");
        if (conflictResolution === "IGNORE") return { skipped: true, reason: "OPPOSITE_GROUP_SIGNAL_IGNORED" };
        if (conflictResolution === "CLOSE_THEN_REVERSE" && mandate.allow_position_reversal !== true) throw terminalError("GROUP_REVERSAL_NOT_AUTHORIZED", "The follower mandate does not authorize position reversal.");
        executionIntent.side = opposite.direction === "long" ? "SELL" : "BUY";
        executionIntent.reduce_only = true;
        executionIntent.take_profit = null;
        executionIntent.stop_loss = null;
        strategyPositionIdx = Number(opposite.positionIdx || 0);
        strategyCloseQuantity = Number(opposite.quantity);
        strategyReverseClose = conflictResolution === "CLOSE_THEN_REVERSE";
      }
    }
    const allocation = calculateFollowerAllocation({
      intent: executionIntent,
      mandate,
      account: wallet.accountMetrics,
      instrument,
      referencePrice,
      currentExposure
    });
    if (strategyCloseQuantity) {
      const alignedStrategyCloseQuantity = floorStrategyVenueQuantity(strategyCloseQuantity, instrument);
      if (!alignedStrategyCloseQuantity) throw terminalError("STRATEGY_QUANTITY_BELOW_VENUE_STEP", "No executable strategy close quantity remains after applying the Bybit quantity step.");
      allocation.roundedQuantity = alignedStrategyCloseQuantity;
      allocation.targetNotional = alignedStrategyCloseQuantity * referencePrice;
      allocation.estimatedMargin = Number(venuePositions.find((position) => Number(position.positionIdx) === strategyPositionIdx)?.margin || 0);
      allocation.belowMinimumQuantity = false;
      allocation.belowMinimumNotional = false;
    }
    if (intent.strategy_action === "SYNC_DIRECTION" && executionIntent.reduce_only !== true && Array.isArray(intent.strategy_execution_policy?.takeProfits) && intent.strategy_execution_policy.takeProfits.length) {
      const ladder = evaluateStrategyTakeProfitLadder({
        entryQuantity: allocation.roundedQuantity,
        targets: intent.strategy_execution_policy.takeProfits,
        venue: instrument
      });
      if (!ladder.ok) throw terminalError("STRATEGY_TP_LADDER_BELOW_VENUE_MINIMUM", summarizeTakeProfitLadderFailure(ladder));
    }
    const risk = evaluateFollowerRisk({
      intent: executionIntent,
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
      metadata: { symbol: intent.symbol, orderType: intent.order_type, reduceOnly: executionIntent.reduce_only }
    });

    const clientOrderId = strategyReverseClose
      ? deterministicStrategyLegId(command.deterministic_client_order_id, groupReverseCloseLeg)
      : strategyReverseIntent
        ? deterministicStrategyLegId(command.deterministic_client_order_id, "e")
        : command.deterministic_client_order_id;
    const existingVenueOrder = await findBybitOrderByClientOrderId(credentials, {
      marketKind,
      symbol: intent.symbol,
      clientOrderId
    });
    if (existingVenueOrder) {
      const adopted = await this.adoptVenueOrder({ command, plan, intent: executionIntent, account, allocation, existingVenueOrder, clientOrderId });
      if (isTerminalUnfilledVenueOrder(existingVenueOrder)) throw terminalError("STRATEGY_ENTRY_UNFILLED", "Bybit terminated the recovered strategy order without a fill.");
      if (strategyReverseClose) throw retryableError("STRATEGY_REVERSE_WAITING_FOR_FLAT", "The existing follower close leg was adopted; waiting for Bybit to confirm the position is flat before entering the reverse leg.", 2);
      return adopted;
    }

    const orderDraft = {
      symbol: intent.symbol,
      marketKind,
      side: ["SELL", "SHORT"].includes(executionIntent.side) ? "sell" : "buy",
      orderType: String(intent.order_type).toLowerCase().replaceAll("_", "-"),
      quantity: allocation.roundedQuantity,
      quantityMode: "quantity",
      referencePrice,
      limitPrice: executionIntent.limit_price,
      stopPrice: intent.stop_price,
      takeProfit: executionIntent.take_profit,
      stopLoss: executionIntent.stop_loss,
      leverage: allocation.leverage,
      marginMode: String(intent.margin_mode || "CROSS").toLowerCase(),
      timeInForce: String(intent.time_in_force || "GTC").toLowerCase(),
      reduceOnly: executionIntent.reduce_only,
      positionIdx: strategyPositionIdx,
      clientOrderId,
      source: "investment-group-cloud"
    };
    if (intent.strategy_action === "TAKE_PROFIT" && Number(instrument.tickSize) > 0) orderDraft.limitPrice = alignVenueStep(orderDraft.limitPrice, Number(instrument.tickSize));
    const venueValidation = await validateBybitOrderDraft(credentials, orderDraft);
    if (!venueValidation.ok) throw terminalError("VENUE_VALIDATION_REJECTED", venueValidation.reasons.join(" "));

    let venueReport;
    try {
      if (automationMandate.max_order_notional && allocation.targetNotional > Number(automationMandate.max_order_notional)) {
        throw terminalError("AUTOMATION_MANDATE_RISK_REJECTED", "Order notional exceeds the broker automation mandate.");
      }
      await this.repository.assertFencingToken(connection.id, fencingToken);
      this.assertSubmissionClockSafe();
      const adapter = createCloudExchangeAdapter(connection.provider, {
        credentials,
        executionEnvironment: credentialEnvironment,
        endpointProfile: credentials.endpointProfile || connection.endpoint_profile || "GLOBAL",
        connectionId: connection.id
      });
      if (marketKind !== "spot" && !orderDraft.reduceOnly) {
        await adapter.configureLeverage({ category, symbol: intent.symbol, leverage: allocation.leverage });
      }
      venueReport = await adapter.placeOrder(orderDraft, venueValidation);
      this.metricsCounters.ordersSubmitted += 1;
    } catch (error) {
      if (!isAmbiguousTransportError(error)) throw error;
      const recovered = await findBybitOrderByClientOrderId(credentials, { marketKind, symbol: intent.symbol, clientOrderId }).catch(() => null);
      if (recovered) {
        const adopted = await this.adoptVenueOrder({ command, plan, intent: executionIntent, account, allocation, existingVenueOrder: recovered, clientOrderId });
        if (strategyReverseClose) throw retryableError("GROUP_REVERSE_WAITING_FOR_FLAT", "The close leg was recovered; waiting for Bybit to confirm the attributed position is flat before entering the reverse leg.", 2);
        return adopted;
      }
      throw ambiguousError("Bybit submission timed out before acknowledgement. Reconciliation will query the deterministic client order ID.");
    }

    const persisted = await this.persistAcceptedOrder({ command, plan, intent: executionIntent, account, allocation, venueReport, clientOrderId });
    if (strategyReverseClose) throw retryableError("STRATEGY_REVERSE_WAITING_FOR_FLAT", "The follower close leg was acknowledged; waiting for Bybit to confirm the position is flat before entering the reverse leg.", 2);
    return persisted;
  }

  async placeStrategyOrder(command, fencingToken) {
    const [binding, strategy, connection, capabilities] = await Promise.all([
      single(this.supabase.from("strategy_target_bindings").select("*").eq("id", command.strategy_target_binding_id)),
      single(this.supabase.from("strategy_automation_strategies").select("*").eq("id", command.strategy_automation_id)),
      single(this.supabase.from("connectivity_connections").select("*").eq("id", command.connection_id)),
      single(this.supabase.from("broker_connection_capabilities").select("*").eq("connection_id", command.connection_id))
    ]);
    if (binding.strategy_id !== strategy.id || binding.connection_id !== connection.id || binding.owner_user_id !== command.user_id) {
      throw terminalError("STRATEGY_COMMAND_OWNERSHIP_MISMATCH", "Strategy command ownership or binding identity does not match.");
    }
    if (binding.target_type !== "BROKER_ACCOUNT") throw terminalError("STRATEGY_TARGET_INVALID", "The Strategy Lab command does not belong to a broker-account target.");
    if (connection.provider !== "bybit" || !connection.account_id) throw terminalError("PROVIDER_UNSUPPORTED", "Only a linked Bybit account is supported.");
    const connectionEnvironment = normalizeBybitExecutionEnvironment(connection.execution_environment);
    const [account, secretReference, riskControl, latestSnapshot] = await Promise.all([
      single(this.supabase.from("exchange_accounts").select("*").eq("id", connection.account_id)),
      single(this.supabase.from("broker_secret_references").select("id,status").eq("connection_id", connection.id).eq("status", "ACTIVE")),
      oneOrNull(this.supabase.from("account_risk_controls").select("*").eq("account_id", connection.account_id).maybeSingle()),
      oneOrNull(this.supabase.from("strategy_target_snapshots").select("snapshot").eq("binding_id", binding.id).maybeSingle())
    ]);
    const credentials = await this.repository.readBrokerSecret(secretReference.id, connectionEnvironment === "DEMO" ? "strategy_demo_order_execution" : "strategy_mainnet_order_execution");
    const credentialEnvironment = assertWorkerEnvironment(connection, credentials);
    if (credentialEnvironment !== connectionEnvironment || account.execution_environment !== connectionEnvironment) {
      throw terminalError("STRATEGY_ENVIRONMENT_MISMATCH", "Strategy Lab execution cannot cross broker environments.");
    }

    const payload = command.payload || {};
    const symbol = String(payload.symbol || strategy.symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (!symbol || symbol !== String(strategy.symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase()) throw terminalError("STRATEGY_SYMBOL_MISMATCH", "The command symbol does not match the running strategy.");
    const marketKind = binding.market_type === "SPOT" ? "spot" : "perpetual";
    const category = marketKind === "spot" ? "spot" : "linear";
    const [wallet, metadataRows, ticker, venuePositions] = await Promise.all([
      getBybitWalletSnapshot(credentials),
      getBybitInstrumentMetadata({ category, symbol, executionEnvironment: credentialEnvironment, endpointProfile: credentials.endpointProfile }),
      getBybitTicker({ category, symbol, executionEnvironment: credentialEnvironment, endpointProfile: credentials.endpointProfile }),
      marketKind === "spot" ? Promise.resolve([]) : getBybitPositions(credentials, { category, symbol, includeEmpty: true })
    ]);
    const instrument = metadataRows[0];
    if (!instrument || String(instrument.tradingStatus).toLowerCase() !== "trading") throw terminalError("MARKET_UNAVAILABLE", `${symbol} is not currently tradable.`);
    const referencePrice = Number(ticker.markPrice || ticker.lastPrice);
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) throw terminalError("REFERENCE_PRICE_REQUIRED", "A current server-side Bybit price is required.");

    const openPositions = venuePositions.filter((position) => position.quantity > 0 && position.direction !== "flat");
    const persistedPositions = await rows(this.supabase.from("account_positions")
      .select("direction,quantity,position_idx,strategy_target_binding_id,updated_at")
      .eq("account_id", account.id)
      .eq("symbol", symbol)
      .gt("quantity", 0));
    const currentAccountPnl = openPositions.reduce((sum, position) => sum + Number(position.unrealizedPnl || 0), 0);
    const requestedAction = String(payload.action || "ENTRY").toUpperCase();
    const desiredDirection = String(payload.direction || "").toLowerCase();
    const sameDirectionPosition = openPositions.find((item) => item.direction === desiredDirection);
    const oppositeDirectionPositions = openPositions.filter((item) => item.direction !== desiredDirection);
    const simulatedFunds = credentialEnvironment === "DEMO";
    const source = simulatedFunds ? "strategy-automation-demo" : "strategy-automation-mainnet";
    const recoveryPositionIdx = (direction) => venuePositions.some((item) => item.positionIdx === 1 || item.positionIdx === 2)
      ? (direction === "long" ? 1 : 2)
      : 0;
    const adoptRecoveredOrder = async (venueOrder, clientOrderId, expected, options = {}) => {
      assertRecoveredVenueOrderShape(venueOrder, expected);
      const orderDraft = recoveredStrategyOrderDraft(venueOrder, {
        accountId: account.id,
        symbol,
        marketKind,
        clientOrderId,
        source,
        referencePrice,
      });
      const recoveredNotional = orderDraft.quantity * Number(venueOrder.averageFillPrice || venueOrder.price || referencePrice);
      const persisted = await this.persistStrategyAcceptedOrder({
        command,
        binding,
        strategy,
        account,
        orderDraft,
        venueReport: venueOrder,
        estimatedMargin: orderDraft.reduceOnly ? 0 : recoveredNotional,
        estimatedNotional: recoveredNotional,
        recovered: true,
      });
      if (isTerminalUnfilledVenueOrder(venueOrder) && options.allowTerminalUnfilled !== true) throw terminalError("STRATEGY_ORDER_UNFILLED", "Bybit terminated the recovered strategy order without a fill.");
      return persisted;
    };

    let recoveredReverseClose = null;
    let reverseCloseLeg = "c";
    if (requestedAction === "REVERSE") {
      const entryClientOrderId = deterministicStrategyLegId(command.deterministic_client_order_id, "e");
      const recoveredEntry = await findBybitOrderByClientOrderId(credentials, { marketKind, symbol, clientOrderId: entryClientOrderId });
      if (recoveredEntry) {
        return adoptRecoveredOrder(recoveredEntry, entryClientOrderId, {
          category,
          symbol,
          side: desiredDirection === "short" ? "sell" : "buy",
          reduceOnly: false,
          positionIdx: recoveryPositionIdx(desiredDirection),
          orderType: "market",
        });
      }
      const closeDirection = String(payload.positionDirection || oppositeDirectionPositions[0]?.direction || "").toLowerCase();
      const closeStillOpen = openPositions.some((position) => position.direction === closeDirection && Number(position.quantity) > 0);
      for (let legNumber = 1; legNumber <= MAX_STRATEGY_REVERSAL_CLOSE_LEGS; legNumber += 1) {
        const leg = reversalCloseLegName(legNumber);
        const closeClientOrderId = deterministicStrategyLegId(command.deterministic_client_order_id, leg);
        const recoveredCloseLeg = await findBybitOrderByClientOrderId(credentials, { marketKind, symbol, clientOrderId: closeClientOrderId });
        if (!recoveredCloseLeg) {
          reverseCloseLeg = leg;
          recoveredReverseClose = null;
          break;
        }
        recoveredReverseClose = recoveredCloseLeg;
        await adoptRecoveredOrder(recoveredCloseLeg, closeClientOrderId, {
          category,
          symbol,
          side: closeDirection === "long" ? "sell" : "buy",
          reduceOnly: true,
          positionIdx: recoveryPositionIdx(closeDirection),
          orderType: "market",
        }, { allowTerminalUnfilled: true });
        if (!isTerminalVenueOrder(recoveredCloseLeg)) {
          throw retryableError("STRATEGY_REVERSE_WAITING_FOR_FLAT", "The recovered close leg is still settling; the reverse entry remains blocked until Bybit confirms the prior position is flat.", 2);
        }
        if (!closeStillOpen) break;
        if (legNumber === MAX_STRATEGY_REVERSAL_CLOSE_LEGS) {
          throw terminalError("STRATEGY_REVERSE_RESIDUAL_CLOSE_EXHAUSTED", "Four deterministic reduce-only close legs completed but Bybit still reports residual exposure. Reverse entry remains blocked for manual reconciliation.");
        }
        reverseCloseLeg = reversalCloseLegName(legNumber + 1);
        recoveredReverseClose = null;
      }
    } else {
      const clientOrderId = command.deterministic_client_order_id;
      const recoveredOrder = await findBybitOrderByClientOrderId(credentials, { marketKind, symbol, clientOrderId });
      if (recoveredOrder) {
        const closeDirection = String(payload.positionDirection || "").toLowerCase();
        const isReduce = requestedAction === "TAKE_PROFIT" || requestedAction === "CLOSE";
        const expectedDirection = isReduce ? (closeDirection || desiredDirection) : desiredDirection;
        return adoptRecoveredOrder(recoveredOrder, clientOrderId, {
          category,
          symbol,
          side: isReduce
            ? (expectedDirection === "long" ? "sell" : "buy")
            : (desiredDirection === "short" ? "sell" : "buy"),
          reduceOnly: isReduce,
          positionIdx: recoveryPositionIdx(expectedDirection),
          orderType: requestedAction === "TAKE_PROFIT" ? "limit" : "market",
        });
      }
    }

    // Everything above this line is deterministic reconciliation only. Once no
    // matching venue order exists, every mutable authorization and risk gate is
    // re-evaluated before a new Bybit side effect may be created.
    this.assertSubmissionClockSafe();
    if (process.env.BYBIT_CLOUD_EXECUTION_ENABLED !== "true" || process.env.BLACK_CLOUD_GLOBAL_EXECUTION_KILL_SWITCH === "true") {
      throw terminalError("BYBIT_STRATEGY_DISABLED", "Bybit strategy execution is disabled.");
    }
    if (binding.status !== "LIVE") throw terminalError("STRATEGY_TARGET_NOT_LIVE", "The Strategy Lab target is not armed.");
    if (Number(binding.strategy_version) !== Number(strategy.running_version)) throw terminalError("STRATEGY_VERSION_NOT_RUNNING", "The armed target does not match the running strategy version.");
    const environmentEnabled = connectionEnvironment === "DEMO"
      ? process.env.STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED === "true"
      : process.env.STRATEGY_AUTOMATION_LIVE_EXECUTION_ENABLED === "true" && process.env.STRATEGY_AUTOMATION_LIVE_EXECUTION_CERTIFIED === "true";
    if (!environmentEnabled) throw terminalError("STRATEGY_ENVIRONMENT_DISABLED", `Strategy execution is disabled for ${connectionEnvironment}.`);
    if (connection.control_state !== "ACTIVE" || connection.execution_readiness !== "READY") throw terminalError("CONNECTION_NOT_READY", "The Bybit connection is not ready for strategy execution.");
    if (!capabilities.can_place_market_orders || capabilities.can_withdraw || capabilities.can_transfer) {
      throw terminalError("BROKER_CAPABILITY_REJECTED", "The broker capability set is not safe for strategy execution.");
    }
    const automationMandate = await this.repository.requireAutomationMandate(connection.id, "strategy");
    if (automationMandate.execution_environment !== connectionEnvironment) throw terminalError("STRATEGY_ENVIRONMENT_MISMATCH", "The broker automation mandate belongs to a different execution environment.");
    if (!account.trading_enabled || account.is_read_only) throw terminalError("ACCOUNT_READ_ONLY", "The Bybit account is not trade enabled.");
    if (riskControl?.emergency_stop) throw terminalError("ACCOUNT_EMERGENCY_STOP", "The account emergency stop is active.");
    if (!mandateListAllows(automationMandate.allowed_strategies, strategy.id)) {
      throw terminalError("MANDATE_STRATEGY_REJECTED", "The automation mandate does not permit this strategy.");
    }
    if (!mandateListAllows(automationMandate.allowed_symbols, symbol)) {
      throw terminalError("MANDATE_SYMBOL_REJECTED", "The automation mandate does not permit this symbol.");
    }

    const reversingClose = requestedAction === "REVERSE" && oppositeDirectionPositions.length > 0;
    const strategyExecutionClientOrderId = requestedAction === "REVERSE"
      ? deterministicStrategyLegId(command.deterministic_client_order_id, reversingClose ? reverseCloseLeg : "e")
      : command.deterministic_client_order_id;
    if (requestedAction === "REVERSE" && sameDirectionPosition && oppositeDirectionPositions.length === 0 && !recoveredReverseClose) {
      return { skipped: true, reason: "DESIRED_POSITION_ALREADY_OPEN", simulatedFunds: credentialEnvironment === "DEMO" };
    }
    if (requestedAction === "REVERSE" && sameDirectionPosition && oppositeDirectionPositions.length > 0) {
      throw terminalError("STRATEGY_HEDGE_STATE_AMBIGUOUS", "The Bybit account has both hedge legs open; automated reversal is blocked until the account is reconciled manually.");
    }
    const takeProfitOrder = requestedAction === "TAKE_PROFIT";
    const action = requestedAction === "REVERSE" ? (reversingClose ? "CLOSE" : "ENTRY") : requestedAction;
    let side;
    let quantity;
    let reduceOnly = false;
    let positionIdx = 0;
    let policy;
    let effectiveLeverage = 1;
    let leverageConfiguration = null;
    let estimatedMargin = 0;
    let estimatedNotional = 0;
    let takeProfitLimitPrice = null;
    if (takeProfitOrder) {
      const parentEntryIdempotencyKey = String(payload.parentEntryIdempotencyKey || "");
      if (!parentEntryIdempotencyKey) throw terminalError("STRATEGY_TAKE_PROFIT_PARENT_REQUIRED", "A strategy target without an immutable parent entry is unsafe and cannot be submitted.");
      const parentCommand = await oneOrNull(this.supabase.from("execution_commands")
        .select("id,status,execution_order_id,created_at")
        .eq("idempotency_key", parentEntryIdempotencyKey)
        .eq("strategy_target_binding_id", binding.id)
        .maybeSingle());
      if (parentCommand && ["FAILED", "REJECTED", "CANCELLED"].includes(String(parentCommand.status || "").toUpperCase())) {
        return { skipped: true, reason: "PARENT_ENTRY_FAILED" };
      }
      if (!parentCommand || parentCommand.status !== "SUCCEEDED" || !parentCommand.execution_order_id) {
        throw retryableError("STRATEGY_TAKE_PROFIT_WAITING_FOR_PARENT_ENTRY", "The exact parent entry has not completed; the reduce-only target will retry without binding to another position.", 2);
      }
      const parentOrder = await oneOrNull(this.supabase.from("execution_orders")
        .select("id,client_order_id,side,quantity,reduce_only,strategy_target_binding_id")
        .eq("id", parentCommand.execution_order_id)
        .maybeSingle());
      const expectedEntrySide = desiredDirection === "short" ? "sell" : "buy";
      if (!parentOrder || parentOrder.reduce_only === true || parentOrder.strategy_target_binding_id !== binding.id || parentOrder.side !== expectedEntrySide) {
        throw terminalError("STRATEGY_TAKE_PROFIT_PARENT_MISMATCH", "The target parent is not the matching non-reduce strategy entry.");
      }
      const matchingEntries = await rows(this.supabase.from("execution_orders")
        .select("id,status,filled_quantity")
        .eq("account_id", account.id)
        .eq("strategy_target_binding_id", binding.id)
        .eq("symbol", symbol)
        .eq("side", expectedEntrySide)
        .eq("reduce_only", false)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(20));
      const latestMatchingEntry = matchingEntries.find(isPotentialPositionGeneration);
      if (!latestMatchingEntry || latestMatchingEntry.id !== parentOrder.id) {
        return { skipped: true, reason: "STALE_STRATEGY_TP_GENERATION" };
      }
      const parentVenueOrder = await findBybitOrderByClientOrderId(credentials, { marketKind, symbol, clientOrderId: parentOrder.client_order_id });
      const originalEntryQuantity = settledStrategyEntryQuantity(parentVenueOrder);
      if (!originalEntryQuantity) {
        const parentStatus = String(parentVenueOrder?.status || "").toLowerCase();
        if (["cancelled", "canceled", "expired", "rejected", "failed"].includes(parentStatus)) return { skipped: true, reason: "PARENT_ENTRY_UNFILLED" };
        throw retryableError("STRATEGY_TAKE_PROFIT_WAITING_FOR_PARENT_FILL", "The parent IOC entry has not reached a final cumulative fill; target sizing will retry without using a reduced remainder.", 2);
      }
      const position = openPositions.find((item) => item.direction === desiredDirection);
      if (!position) throw retryableError("STRATEGY_TAKE_PROFIT_WAITING_FOR_POSITION", "The entry is not visible on Bybit yet; the reduce-only take-profit will retry after reconciliation.", 2);
      const persistedPosition = persistedPositions.find((item) => Number(item.position_idx) === Number(position.positionIdx) && item.direction === position.direction);
      if (!persistedPosition) throw retryableError("STRATEGY_POSITION_OWNERSHIP_PENDING", "The entry is visible at Bybit but its immutable strategy ownership is still reconciling.", 2);
      if (persistedPosition.strategy_target_binding_id !== binding.id) throw terminalError("STRATEGY_POSITION_OWNERSHIP_REQUIRED", "Black Cloud refused to protect a Bybit position attributed to a different strategy target.");
      const percentage = Math.max(0.1, Math.min(100, Number(payload.quantityPercent || 0)));
      side = position.direction === "long" ? "sell" : "buy";
      quantity = calculateStrategyTakeProfitQuantity(originalEntryQuantity, percentage, position.quantity);
      reduceOnly = true;
      positionIdx = position.positionIdx;
      takeProfitLimitPrice = resolveStrategyTakeProfitPrice(payload, position);
      if (!takeProfitLimitPrice) throw terminalError("STRATEGY_TAKE_PROFIT_PRICE_INVALID", "The strategy take-profit formula did not resolve to a positive venue price.");
      estimatedNotional = Math.abs(quantity * referencePrice);
      estimatedMargin = 0;
    } else if (action === "CLOSE") {
      const requestedDirection = reversingClose ? oppositeDirectionPositions[0]?.direction : String(payload.positionDirection || "").toLowerCase();
      const position = openPositions.find((item) => !requestedDirection || item.direction === requestedDirection);
      if (!position) return { skipped: true, reason: "POSITION_ALREADY_FLAT" };
      const persistedPosition = persistedPositions.find((item) => Number(item.position_idx) === Number(position.positionIdx) && item.direction === position.direction);
      if (!persistedPosition) throw retryableError("STRATEGY_POSITION_OWNERSHIP_PENDING", "The Bybit position is awaiting immutable strategy ownership reconciliation before it can be closed.", 2);
      if (persistedPosition.strategy_target_binding_id !== binding.id) throw terminalError("STRATEGY_POSITION_OWNERSHIP_REQUIRED", "Black Cloud refused to close a Bybit position attributed to a different strategy target.");
      side = position.direction === "long" ? "sell" : "buy";
      quantity = position.quantity;
      reduceOnly = true;
      positionIdx = position.positionIdx;
      estimatedNotional = Math.abs(quantity * referencePrice);
      estimatedMargin = Number(position.margin || 0);
    } else if (action === "ENTRY") {
      if (openPositions.length) return { skipped: true, reason: "VENUE_POSITION_ALREADY_OPEN" };
      policy = normalizeCapitalPolicy(policyFromStrategyBinding(binding), binding.market_type, { allowZeroAllocation: false });
      const drawdown = Number(latestSnapshot?.snapshot?.currentDrawdownPercent || 0);
      if (policy.maximumDrawdown > 0 && drawdown >= policy.maximumDrawdown) throw terminalError("STRATEGY_MAX_DRAWDOWN", "The strategy target reached its maximum drawdown.");
      const dailyLossLimit = Math.min(
        policy.maximumDailyLoss,
        nullablePositive(automationMandate.max_daily_loss) || Number.POSITIVE_INFINITY,
        nullablePositive(riskControl?.max_daily_loss_usd) || Number.POSITIVE_INFINITY
      );
      if (Number.isFinite(dailyLossLimit) && currentAccountPnl <= -dailyLossLimit) {
        throw terminalError("STRATEGY_MAX_DAILY_LOSS", "The Bybit account reached the configured daily-loss ceiling.");
      }
      const leverageCaps = {
        targetMaximum: policy.maximumLeverage,
        accountRiskCap: riskControl?.max_leverage,
        emsRiskCap: automationMandate.max_leverage,
        providerCap: instrument.leverageLimits?.max
      };
      effectiveLeverage = binding.market_type === "SPOT" ? 1 : calculateEffectiveLeverage({
        requested: nullablePositive(payload.requestedLeverage) || policy.requestedLeverage,
        ...leverageCaps
      });
      if (binding.market_type !== "SPOT") {
        const hedgeMode = venuePositions.some((item) => item.positionIdx === 1 || item.positionIdx === 2);
        const longLeverage = calculateEffectiveLeverage({ requested: policy.requestedLongLeverage || policy.requestedLeverage, ...leverageCaps });
        const shortLeverage = calculateEffectiveLeverage({ requested: policy.requestedShortLeverage || policy.requestedLeverage, ...leverageCaps });
        leverageConfiguration = hedgeMode
          ? { category, symbol, buyLeverage: longLeverage, sellLeverage: shortLeverage }
          : { category, symbol, leverage: effectiveLeverage };
      }
      const preview = calculateCapitalPreview({
        equity: wallet.accountMetrics.equityUsd,
        availableBalance: wallet.accountMetrics.availableBalanceUsd,
        policy: { ...policy, requestedLeverage: effectiveLeverage },
        marketType: binding.market_type,
        caps: { accountRiskCap: riskControl?.max_leverage, emsRiskCap: automationMandate.max_leverage, providerCap: instrument.leverageLimits?.max }
      });
      quantity = policy.tradeAmountMode === "FIXED_QUANTITY" ? policy.tradeAmountValue : preview.estimatedNotional / referencePrice;
      const maxPositionNotional = preview.allocatedStrategyCapital * policy.maximumPositionPercent / 100 * effectiveLeverage;
      const maxExposureNotional = preview.allocatedStrategyCapital * policy.maximumExposurePercent / 100 * effectiveLeverage;
      const mandateCap = Number(automationMandate.max_order_notional || Number.POSITIVE_INFINITY);
      const accountCap = Number(riskControl?.max_position_usd || Number.POSITIVE_INFINITY);
      estimatedNotional = Math.min(quantity * referencePrice, maxPositionNotional, maxExposureNotional, mandateCap, accountCap);
      quantity = estimatedNotional / referencePrice;
      estimatedMargin = binding.market_type === "SPOT" ? estimatedNotional : estimatedNotional / effectiveLeverage;
      side = String(payload.direction).toLowerCase() === "short" ? "sell" : "buy";
      const hedgeMode = venuePositions.some((item) => item.positionIdx === 1 || item.positionIdx === 2);
      positionIdx = hedgeMode ? (side === "buy" ? 1 : 2) : 0;
    } else {
      throw terminalError("STRATEGY_ACTION_INVALID", "Unsupported Strategy Lab order action.");
    }
    quantity = floorStrategyVenueQuantity(quantity, instrument);
    if (!Number.isFinite(quantity) || quantity <= 0) throw terminalError("STRATEGY_QUANTITY_BELOW_VENUE_STEP", "The risk-bounded strategy quantity is zero after applying the Bybit quantity step.");
    if (action === "ENTRY" && Array.isArray(payload.takeProfits) && payload.takeProfits.length) {
      const ladder = evaluateStrategyTakeProfitLadder({ entryQuantity: quantity, targets: payload.takeProfits, venue: instrument });
      if (!ladder.ok) throw terminalError("STRATEGY_TP_LADDER_BELOW_VENUE_MINIMUM", summarizeTakeProfitLadderFailure(ladder));
    }

    const orderDraft = {
      accountId: account.id,
      symbol,
      marketKind,
      side,
      orderType: takeProfitOrder ? "limit" : "market",
      quantity,
      quantityMode: "quantity",
      referencePrice,
      limitPrice: takeProfitOrder ? takeProfitLimitPrice : undefined,
      takeProfit: reduceOnly || Array.isArray(payload.takeProfits) && payload.takeProfits.length ? undefined : nullablePositive(payload.takeProfit),
      stopLoss: reduceOnly ? undefined : nullablePositive(payload.stopLoss),
      leverage: effectiveLeverage,
      marginMode: String(policy?.marginMode || "CROSS").toLowerCase(),
      reduceOnly,
      positionIdx,
      timeInForce: takeProfitOrder ? "gtc" : "ioc",
      clientOrderId: strategyExecutionClientOrderId,
      source
    };
    if (!reduceOnly && orderDraft.orderType === "market" && Number(payload.slippageTicks) > 0 && Number(instrument.tickSize) > 0) {
      orderDraft.slippageTolerancePercent = Math.max(0.01, Math.min(10, Number(payload.slippageTicks) * Number(instrument.tickSize) / referencePrice * 100));
    }
    if (takeProfitOrder && Number(instrument.tickSize) > 0) orderDraft.limitPrice = alignVenueStep(orderDraft.limitPrice, Number(instrument.tickSize));
    const venueValidation = await validateBybitOrderDraft(credentials, orderDraft);
    if (!venueValidation.ok) throw terminalError("VENUE_VALIDATION_REJECTED", venueValidation.reasons.join(" "));
    orderDraft.quantity = venueValidation.normalized.quantity;
    estimatedNotional = orderDraft.quantity * referencePrice;
    if (!reduceOnly) estimatedMargin = binding.market_type === "SPOT" ? estimatedNotional : estimatedNotional / effectiveLeverage;
    const existingVenueOrder = await findBybitOrderByClientOrderId(credentials, { marketKind, symbol, clientOrderId: orderDraft.clientOrderId });
    if (existingVenueOrder) {
      const persisted = await this.persistStrategyAcceptedOrder({ command, binding, strategy, account, orderDraft, venueReport: existingVenueOrder, estimatedMargin, estimatedNotional, recovered: true });
      if (isTerminalUnfilledVenueOrder(existingVenueOrder)) throw terminalError("STRATEGY_ENTRY_UNFILLED", "Bybit terminated the recovered strategy order without a fill.");
      if (reversingClose) throw retryableError("STRATEGY_REVERSE_WAITING_FOR_FLAT", "The close leg was acknowledged; waiting for Bybit to confirm the position is flat before entering the reverse leg.", 2);
      return persisted;
    }

    let venueReport;
    try {
      await this.repository.assertFencingToken(connection.id, fencingToken);
      this.assertSubmissionClockSafe();
      const adapter = createCloudExchangeAdapter("bybit", { credentials, executionEnvironment: credentialEnvironment, endpointProfile: credentials.endpointProfile || "GLOBAL", connectionId: connection.id });
      if (!reduceOnly && leverageConfiguration) await adapter.configureLeverage(leverageConfiguration);
      venueReport = await adapter.placeOrder(orderDraft, venueValidation);
      this.metricsCounters.ordersSubmitted += 1;
    } catch (error) {
      if (!isAmbiguousTransportError(error)) throw error;
      const recovered = await findBybitOrderByClientOrderId(credentials, { marketKind, symbol, clientOrderId: orderDraft.clientOrderId }).catch(() => null);
      if (recovered) {
        const persisted = await this.persistStrategyAcceptedOrder({ command, binding, strategy, account, orderDraft, venueReport: recovered, estimatedMargin, estimatedNotional, recovered: true });
        if (reversingClose) throw retryableError("STRATEGY_REVERSE_WAITING_FOR_FLAT", "The close leg was recovered; waiting for Bybit to confirm the position is flat before entering the reverse leg.", 2);
        return persisted;
      }
      throw ambiguousError("Bybit submission timed out before acknowledgement. Reconciliation will query the deterministic client order ID.");
    }
    const persisted = await this.persistStrategyAcceptedOrder({ command, binding, strategy, account, orderDraft, venueReport, estimatedMargin, estimatedNotional, recovered: false });
    if (reversingClose) throw retryableError("STRATEGY_REVERSE_WAITING_FOR_FLAT", "The close leg was acknowledged; waiting for Bybit to confirm the position is flat before entering the reverse leg.", 2);
    return persisted;
  }

  async persistStrategyAcceptedOrder({ command, binding, strategy, account, orderDraft, venueReport, estimatedMargin, estimatedNotional, recovered }) {
    const venueOrderId = venueReport.exchangeOrderId || venueReport.orderId;
    const simulatedFunds = orderDraft.source === "strategy-automation-demo";
    const { data: existing, error: existingError } = await this.supabase.from("execution_orders").select("id").eq("client_order_id", orderDraft.clientOrderId).maybeSingle();
    if (existingError) throw existingError;
    let orderId = existing?.id;
    if (!orderId) {
      const order = await insertSingle(this.supabase.from("execution_orders"), {
        user_id: command.user_id,
        account_id: account.id,
        exchange: "bybit",
        symbol: orderDraft.symbol,
        side: orderDraft.side,
        order_type: orderDraft.orderType,
        quantity: orderDraft.quantity,
        quantity_mode: "quantity",
        limit_price: orderDraft.limitPrice || null,
        take_profit: orderDraft.takeProfit || null,
        stop_loss: orderDraft.stopLoss || null,
        reduce_only: orderDraft.reduceOnly,
        time_in_force: orderDraft.timeInForce,
        status: normalizeInternalStatus(venueReport.status),
        exchange_order_id: venueOrderId,
        client_order_id: orderDraft.clientOrderId,
        origin: simulatedFunds ? "STRATEGY_AUTOMATION_DEMO" : "STRATEGY_AUTOMATION_LIVE",
        strategy_automation_id: strategy.id,
        strategy_target_binding_id: binding.id,
        filled_quantity: Number(venueReport.filledQuantity ?? venueReport.filled_quantity ?? 0),
        estimated_fees: estimatedNotional * 0.0006,
        estimated_margin: estimatedMargin,
        estimated_slippage: 0,
        risk_check_status: "approved",
        risk_check_reasons: []
      });
      orderId = order.id;
    }
    await updateOrThrow(this.supabase.from("execution_commands").update({ execution_order_id: orderId }).eq("id", command.id));
    await this.repository.audit({
      userId: command.user_id,
      connectionId: command.connection_id,
      commandId: command.id,
      eventType: recovered ? "STRATEGY_ORDER_RECONCILED" : "STRATEGY_ORDER_ACKNOWLEDGED",
      purpose: simulatedFunds ? "strategy_demo_order_execution" : "strategy_mainnet_order_execution",
      message: recovered ? "An existing Bybit strategy order was adopted by deterministic client order ID." : "A Bybit strategy order was acknowledged.",
      metadata: { strategyId: strategy.id, bindingId: binding.id, symbol: orderDraft.symbol, reduceOnly: orderDraft.reduceOnly, simulatedFunds, venueOrderId }
    });
    this.metricsCounters.ordersConfirmed += 1;
    return { venueOrderId, orderId, recovered, simulatedFunds };
  }

  async adoptVenueOrder({ command, plan, intent, account, allocation, existingVenueOrder, clientOrderId }) {
    const venueReport = {
      exchangeOrderId: existingVenueOrder.exchangeOrderId || existingVenueOrder.orderId,
      clientOrderId: existingVenueOrder.clientOrderId,
      status: existingVenueOrder.status,
      filledQuantity: Number(existingVenueOrder.filledQuantity || 0),
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
    return this.persistAcceptedOrder({ command, plan, intent, account, allocation, venueReport, clientOrderId });
  }

  async persistAcceptedOrder({ command, plan, intent, account, allocation, venueReport, clientOrderId }) {
    const actualClientOrderId = clientOrderId || venueReport.clientOrderId || command.deterministic_client_order_id;
    const { data: existing } = await this.supabase.from("execution_orders").select("id,status").eq("client_order_id", actualClientOrderId).maybeSingle();
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
        client_order_id: actualClientOrderId,
        origin: "INVESTMENT_GROUP",
        group_intent_id: intent.id,
        mandate_id: plan.mandate_id,
        strategy_automation_id: intent.strategy_automation_id || null,
        strategy_target_binding_id: intent.strategy_target_binding_id || null,
        filled_quantity: Number(venueReport.filledQuantity ?? venueReport.filled_quantity ?? 0),
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
      safe_result: { venueOrderId: venueReport.exchangeOrderId, clientOrderId: actualClientOrderId }
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
    this.metricsCounters.ordersConfirmed += 1;
    return { venueOrderId: venueReport.exchangeOrderId, orderId, recovered: Boolean(venueReport.recoveredByReconciliation) };
  }

  async syncAccount(command) {
    const connection = await single(this.supabase.from("connectivity_connections").select("*").eq("id", command.connection_id));
    if (connection.provider !== "bybit" || !connection.account_id) throw terminalError("SYNC_UNSUPPORTED", "Only linked Bybit cloud connections are currently supported.");
    await this.repository.requireAutomationMandate(connection.id, "read");
    const [account, secretReference] = await Promise.all([
      single(this.supabase.from("exchange_accounts").select("*").eq("id", connection.account_id)),
      single(this.supabase.from("broker_secret_references").select("id").eq("connection_id", connection.id).eq("status", "ACTIVE"))
    ]);
    const credentials = await this.repository.readBrokerSecret(secretReference.id, "account_reconciliation");
    assertWorkerEnvironment(connection, credentials);
    const result = await syncBybitSnapshotAndReconcile(this.supabase, account.user_id, account, credentials, {
      symbol: command.payload.symbol || "BTCUSDT",
      marketKind: command.payload.marketKind || "perpetual",
      network: credentials.network,
      executionEnvironment: credentials.executionEnvironment || connection.execution_environment,
      endpointProfile: credentials.endpointProfile || connection.endpoint_profile
    });
    await updateOrThrow(this.supabase.from("connectivity_connections").update({
      health_status: "CONNECTED_CLOUD",
      lifecycle_status: "HEALTHY",
      worker_state: "LIVE",
      synchronization_state: "SYNCHRONIZED",
      execution_readiness: connection.control_state === "ACTIVE" ? "READY" : "PAUSED",
      last_reconciled_at: result.syncedAt,
      last_position_sync_at: result.syncedAt,
      degradation_reasons: [],
      last_error_code: null
    }).eq("id", connection.id));
    return { reconciled: true, externalStateChanged: result.externalStateChanged, latencyMs: result.latencyMs };
  }

  async executeBrokerMutation(command, fencingToken, operation) {
    const connection = await single(this.supabase.from("connectivity_connections").select("*").eq("id", command.connection_id));
    if (connection.control_state !== "ACTIVE" && operation === "modify") throw terminalError("CONNECTION_NOT_ACTIVE", "Order modification is blocked while execution is paused.");
    const scope = operation === "modify" ? "modify" : "cancel";
    await this.repository.requireAutomationMandate(connection.id, scope);
    const secretReference = await single(this.supabase.from("broker_secret_references").select("id").eq("connection_id", connection.id).eq("status", "ACTIVE"));
    const credentials = await this.repository.readBrokerSecret(secretReference.id, `broker_${operation}`);
    assertWorkerEnvironment(connection, credentials);
    const executionEnvironment = credentials.executionEnvironment || connection.execution_environment || connection.metadata?.executionEnvironment;
    const adapter = createCloudExchangeAdapter(connection.provider, {
      credentials,
      executionEnvironment,
      endpointProfile: credentials.endpointProfile || connection.endpoint_profile || "GLOBAL",
      connectionId: connection.id
    });
    await this.repository.assertFencingToken(connection.id, fencingToken);
    if (operation === "modify") return adapter.modifyOrder(command.payload.request || command.payload);
    if (operation === "cancel") return adapter.cancelOrder(command.payload.request || command.payload);
    return adapter.cancelAll(command.payload.request || command.payload);
  }

  async modifyStrategyTakeProfitOrder(command, fencingToken) {
    if (String(command.payload?.strategyAction || "").toUpperCase() !== "TAKE_PROFIT_REPRICE") {
      throw terminalError("STRATEGY_ORDER_MUTATION_INVALID", "Only a certified take-profit reprice may use a strategy-owned modify command.");
    }
    const [binding, strategy, connection, capabilities, order] = await Promise.all([
      single(this.supabase.from("strategy_target_bindings").select("*").eq("id", command.strategy_target_binding_id)),
      single(this.supabase.from("strategy_automation_strategies").select("*").eq("id", command.strategy_automation_id)),
      single(this.supabase.from("connectivity_connections").select("*").eq("id", command.connection_id)),
      single(this.supabase.from("broker_connection_capabilities").select("*").eq("connection_id", command.connection_id)),
      single(this.supabase.from("execution_orders").select("*").eq("id", command.execution_order_id)),
    ]);
    if (binding.strategy_id !== strategy.id || order.strategy_target_binding_id !== binding.id || order.strategy_automation_id !== strategy.id) {
      throw terminalError("STRATEGY_ORDER_MUTATION_OWNERSHIP_MISMATCH", "The take-profit order is not owned by the requested strategy generation.");
    }
    if (order.account_id !== connection.account_id || order.client_order_id !== command.payload?.request?.clientOrderId) {
      throw terminalError("STRATEGY_ORDER_MUTATION_ACCOUNT_MISMATCH", "The take-profit mutation does not match its immutable broker account or client order ID.");
    }
    if (order.reduce_only !== true) throw terminalError("STRATEGY_ORDER_MUTATION_REDUCE_ONLY_REQUIRED", "Black Cloud refused to amend a non-reduce strategy order through the take-profit path.");
    if (!["pending", "accepted", "working", "partially-filled"].includes(String(order.status || "").toLowerCase())) {
      return { skipped: true, reason: "TAKE_PROFIT_ORDER_ALREADY_TERMINAL" };
    }
    const { data: newerCommands, error: newerError } = await this.supabase.from("execution_commands")
      .select("id")
      .eq("execution_order_id", order.id)
      .eq("command_type", "MODIFY_ORDER")
      .gt("created_at", command.created_at)
      .neq("status", "CANCELLED")
      .limit(1);
    if (newerError) throw newerError;
    if (newerCommands?.length) return { skipped: true, reason: "TAKE_PROFIT_REPRICE_SUPERSEDED" };

    const secretReference = await single(this.supabase.from("broker_secret_references")
      .select("id")
      .eq("connection_id", connection.id)
      .eq("status", "ACTIVE"));
    const credentials = await this.repository.readBrokerSecret(secretReference.id, "strategy_take_profit_reprice");
    assertWorkerEnvironment(connection, credentials);
    const marketKind = String(command.payload?.request?.marketKind || "perpetual").toLowerCase() === "spot" ? "spot" : "perpetual";
    const category = marketKind === "spot" ? "spot" : "linear";
    const symbol = String(command.payload?.request?.symbol || order.symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const [instrumentRows, venueOrder] = await Promise.all([
      getBybitInstrumentMetadata({ category, symbol, executionEnvironment: credentials.executionEnvironment || connection.execution_environment, endpointProfile: credentials.endpointProfile || connection.endpoint_profile }),
      findBybitOrderByClientOrderId(credentials, { marketKind, symbol, clientOrderId: order.client_order_id }),
    ]);
    const instrument = instrumentRows[0];
    if (!instrument || !(Number(instrument.tickSize) > 0)) throw terminalError("STRATEGY_TP_REPRICE_TICK_SIZE_REQUIRED", "The venue tick size is unavailable for a safe take-profit amendment.");
    if (!venueOrder) throw retryableError("STRATEGY_TP_REPRICE_WAITING_FOR_ORDER", "The working take-profit is not visible at Bybit yet; repricing will retry after reconciliation.", 2);
    assertRecoveredVenueOrderShape(venueOrder, {
      category,
      symbol,
      side: String(command.payload?.direction || "").toLowerCase() === "long" ? "sell" : "buy",
      reduceOnly: true,
      positionIdx: Number(venueOrder.positionIdx || 0),
      orderType: "limit",
    });
    if (isTerminalVenueOrder(venueOrder)) {
      await updateOrThrow(this.supabase.from("execution_orders").update({
        status: normalizeInternalStatus(venueOrder.status),
        filled_quantity: Number(venueOrder.filledQuantity || 0),
      }).eq("id", order.id));
      return { skipped: true, reason: "TAKE_PROFIT_ORDER_TERMINAL_AT_VENUE" };
    }
    const desiredPrice = alignVenueStep(Number(command.payload?.desiredPrice || command.payload?.request?.limitPrice), Number(instrument.tickSize));
    if (!(desiredPrice > 0)) throw terminalError("STRATEGY_TP_REPRICE_PRICE_INVALID", "The confirmed-bar take-profit amendment did not resolve to a positive venue price.");
    if (venuePricesEqual(venueOrder.price, desiredPrice, Number(instrument.tickSize))) {
      await updateOrThrow(this.supabase.from("execution_orders").update({
        limit_price: desiredPrice,
        venue_updated_at: new Date(Number(venueOrder.updatedTime || Date.now())).toISOString(),
      }).eq("id", order.id));
      await this.repository.audit({
        userId: command.user_id,
        connectionId: connection.id,
        groupIntentId: command.group_intent_id,
        followerPlanId: command.follower_plan_id,
        commandId: command.id,
        eventType: "STRATEGY_TAKE_PROFIT_REPRICE_CONFIRMED",
        purpose: "strategy_take_profit_reprice",
        message: "Bybit confirmed the latest closed-candle SuperATR take-profit price.",
        metadata: { strategyId: strategy.id, bindingId: binding.id, targetId: command.payload?.targetId, symbol, desiredPrice, sourceCandleTime: command.payload?.sourceCandleTime }
      });
      return { amended: true, confirmed: true, venueOrderId: venueOrder.orderId, desiredPrice };
    }

    this.assertSubmissionClockSafe();
    if (binding.status !== "LIVE") throw terminalError("STRATEGY_TARGET_NOT_LIVE", "The Strategy Lab target is not armed for take-profit repricing.");
    if (Number(binding.strategy_version) !== Number(strategy.running_version) || Number(command.payload?.strategyVersion) !== Number(strategy.running_version)) {
      throw terminalError("STRATEGY_VERSION_NOT_RUNNING", "The take-profit amendment belongs to an inactive strategy version.");
    }
    if (connection.control_state !== "ACTIVE" || connection.execution_readiness !== "READY") throw terminalError("CONNECTION_NOT_READY", "The Bybit connection is not ready for take-profit repricing.");
    if (capabilities.can_modify_orders !== true || capabilities.can_withdraw || capabilities.can_transfer) {
      throw terminalError("BROKER_CAPABILITY_REJECTED", "The broker capability set does not permit a safe strategy take-profit amendment.");
    }
    const environmentEnabled = normalizeBybitExecutionEnvironment(connection.execution_environment) === "DEMO"
      ? process.env.STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED === "true"
      : process.env.STRATEGY_AUTOMATION_LIVE_EXECUTION_ENABLED === "true" && process.env.STRATEGY_AUTOMATION_LIVE_EXECUTION_CERTIFIED === "true";
    if (!environmentEnabled || process.env.BLACK_CLOUD_GLOBAL_EXECUTION_KILL_SWITCH === "true") {
      throw terminalError("STRATEGY_ENVIRONMENT_DISABLED", "Strategy take-profit repricing is disabled for this execution environment.");
    }
    await this.repository.requireAutomationMandate(connection.id, "modify");
    const ownedPositions = await rows(this.supabase.from("account_positions")
      .select("direction,strategy_target_binding_id,quantity")
      .eq("account_id", connection.account_id)
      .eq("symbol", symbol)
      .eq("direction", String(command.payload?.direction || "").toLowerCase())
      .gt("quantity", 0));
    if (!ownedPositions.some((position) => position.strategy_target_binding_id === binding.id)) {
      return { skipped: true, reason: "TAKE_PROFIT_POSITION_ALREADY_FLAT" };
    }
    await this.repository.assertFencingToken(connection.id, fencingToken);
    const adapter = createCloudExchangeAdapter(connection.provider, {
      credentials,
      executionEnvironment: credentials.executionEnvironment || connection.execution_environment,
      endpointProfile: credentials.endpointProfile || connection.endpoint_profile || "GLOBAL",
      connectionId: connection.id,
    });
    try {
      await adapter.modifyOrder({ marketKind, symbol, clientOrderId: order.client_order_id, limitPrice: desiredPrice });
    } catch (error) {
      if (!isAmbiguousTransportError(error)) throw error;
      throw ambiguousError("Bybit take-profit amendment acknowledgement was ambiguous. The deterministic order ID will be reconciled before retry.");
    }
    throw retryableError("STRATEGY_TP_REPRICE_WAITING_FOR_CONFIRMATION", "Bybit accepted the take-profit amendment; the worker will confirm the asynchronous venue state before completing it.", 1);
  }

  async releaseForRetry(command, delay, code, message) {
    await updateOrThrow(this.supabase.from("execution_commands").update({
      status: "RETRY",
      available_at: new Date(Date.now() + delay * 1_000).toISOString(),
      locked_by: null,
      locked_until: null,
      last_error_code: code,
      last_error_message: message
    }).eq("id", command.id).eq("locked_by", this.workerId));
  }

  setStartupPhase(phase) {
    this.startupPhase = phase;
  }

  isClockSafe() {
    return Boolean(this.clockHealth) && this.clockHealth.status !== WORKER_CLOCK_STATUSES.UNSAFE;
  }

  assertSubmissionClockSafe() {
    if (!this.isClockSafe()) throw terminalError("CLOCK_UNSAFE", "New broker submissions are blocked because worker clock health is unsafe.");
  }

  async refreshClockHealth() {
    const previous = this.clockHealth?.status;
    this.clockHealth = await measureBybitClockHealth(this.runtime);
    this.lastClockCheckAt = new Date().toISOString();
    if (this.clockHealth.status === WORKER_CLOCK_STATUSES.UNSAFE) {
      this.setStartupPhase(WORKER_STARTUP_PHASES.CLOCK_UNSAFE);
      if (previous !== WORKER_CLOCK_STATUSES.UNSAFE) await this.emitClockUnsafeAudit();
    } else if (this.startupPhase === WORKER_STARTUP_PHASES.CLOCK_UNSAFE) {
      this.setStartupPhase(WORKER_STARTUP_PHASES.WORKER_READY);
    }
    return this.clockHealth;
  }

  async emitClockUnsafeAudit() {
    await this.repository.audit({
      eventType: "WORKER_CLOCK_UNSAFE",
      severity: "CRITICAL",
      purpose: "clock_health",
      userVisible: false,
      message: "New broker submissions were blocked because the worker clock reference is unavailable or outside the configured drift boundary.",
      metadata: { nodeId: this.nodeId, workerId: this.workerId, clockHealth: this.clockHealth }
    }).catch(() => null);
  }

  async writeNodeState(status) {
    if (!this.runtime || !this.nodeId) return;
    const connections = this.connectionSupervisor.diagnostics();
    const telemetry = await this.repository.getNodeTelemetry().catch(() => ({
      queueDepth: this.lastReadiness?.queueDepth || 0,
      oldestQueueAgeMs: this.lastReadiness?.oldestQueueAgeMs || 0,
      activeStrategyCount: this.lastReadiness?.activeStrategyCount || 0
    }));
    await this.repository.writeNodeHeartbeat({
      nodeId: this.nodeId,
      deploymentEnvironment: this.runtime.deploymentEnvironment,
      region: this.runtime.region,
      hostname: process.env.BLACK_CLOUD_HOSTNAME || "redacted-existing-vps",
      deploymentCommit: this.runtime.deploymentCommit,
      imageDigest: this.runtime.imageDigest,
      softwareVersion: BLACK_CLOUD_SOFTWARE_VERSION,
      nodeVersion: process.version,
      workerInstanceId: this.workerId,
      executionEnvironment: this.runtime.executionEnvironment,
      status,
      startupPhase: this.startupPhase,
      startedAt: this.startedAt,
      clockHealth: this.clockHealth,
      cryptoSelfTest: this.cryptoSelfTest,
      activeConnectionCount: connections.activeConnections,
      readyConnectionCount: connections.readyConnections,
      degradedConnectionCount: connections.degradedConnections,
      ...telemetry,
      safeMetadata: { endpointProfile: this.runtime.endpointProfile, strategyRuntimeEnabled: process.env.BLACK_CLOUD_STRATEGY_RUNTIME_ENABLED === "true" }
    });
    this.lastNodeHeartbeatAt = new Date().toISOString();
  }
}

function assertWorkerEnvironment(connection, credentials) {
  const credentialEnvironment = normalizeBybitExecutionEnvironment(credentials.executionEnvironment || credentials.network);
  const connectionEnvironment = normalizeBybitExecutionEnvironment(connection.execution_environment || connection.metadata?.executionEnvironment);
  const workerEnvironment = normalizeBybitExecutionEnvironment(process.env.BLACK_CLOUD_EXECUTION_ENVIRONMENT || process.env.BYBIT_EXECUTION_ENVIRONMENT || process.env.BLACK_CLOUD_NETWORK);
  if (credentialEnvironment !== connectionEnvironment) throw terminalError("CONNECTION_ENVIRONMENT_MISMATCH", "Connection and credential execution environments differ.");
  if (credentialEnvironment !== workerEnvironment) throw terminalError("WORKER_ENVIRONMENT_MISMATCH", "Credential environment does not match this worker's isolated venue environment.");
  return credentialEnvironment;
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
  if (["cancelled", "canceled", "expired"].includes(status)) return "cancelled";
  if (["rejected", "failed"].includes(status)) return "rejected";
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

function deterministicStrategyLegId(baseId, leg) {
  const safeBase = String(baseId || "bt-strategy").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 33);
  return `${safeBase}-${leg}`.slice(0, 36);
}

export function reversalCloseLegName(number) {
  const normalized = Math.max(1, Math.min(MAX_STRATEGY_REVERSAL_CLOSE_LEGS, Math.floor(Number(number) || 1)));
  return normalized === 1 ? "c" : `c${normalized}`;
}

export function venuePricesEqual(left, right, tickSize) {
  const first = Number(left);
  const second = Number(right);
  const tick = Number(tickSize);
  if (![first, second, tick].every(Number.isFinite) || tick <= 0) return false;
  return Math.abs(first - second) < tick / 2 + 1e-12;
}

function ambiguousError(message) {
  const error = terminalError("SUBMISSION_UNKNOWN", message);
  error.ambiguous = true;
  error.retryable = true;
  return error;
}

function buildWorkerId() {
  return `${process.env.BLACK_CLOUD_NODE_ID || "unregistered-node"}:${Date.now().toString(36)}:${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
}

function classifyStartupFailure(error, currentPhase) {
  if (error?.code === "BLACK_CLOUD_RUNTIME_INVALID" || currentPhase === WORKER_STARTUP_PHASES.CONFIG_VALIDATING) return WORKER_STARTUP_PHASES.CONFIGURATION_ERROR;
  if (currentPhase === WORKER_STARTUP_PHASES.CRYPTO_SELF_TEST) return WORKER_STARTUP_PHASES.CRYPTOGRAPHIC_ERROR;
  if (error?.code === "SCHEMA_MISMATCH") return WORKER_STARTUP_PHASES.SCHEMA_MISMATCH;
  if (error?.code === "LEASE_UNAVAILABLE") return WORKER_STARTUP_PHASES.LEASE_UNAVAILABLE;
  if (error?.code === "QUEUE_UNAVAILABLE") return WORKER_STARTUP_PHASES.QUEUE_UNAVAILABLE;
  if ([WORKER_STARTUP_PHASES.DATABASE_CONNECTING, WORKER_STARTUP_PHASES.SCHEMA_VALIDATING].includes(currentPhase)) return WORKER_STARTUP_PHASES.DATABASE_UNAVAILABLE;
  return WORKER_STARTUP_PHASES.FATAL;
}

function readPackageVersion() {
  try { return JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version || "unknown"; }
  catch { return "unknown"; }
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

async function oneOrNull(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data || null;
}

function policyFromStrategyBinding(row) {
  return {
    strategyAllocationMode: row.strategy_allocation_mode,
    strategyAllocationValue: Number(row.strategy_allocation_value),
    tradeAmountMode: row.trade_amount_mode,
    tradeAmountValue: Number(row.trade_amount_value),
    requestedLeverage: row.requested_leverage == null ? undefined : Number(row.requested_leverage),
    requestedLongLeverage: row.requested_long_leverage == null ? (row.requested_leverage == null ? undefined : Number(row.requested_leverage)) : Number(row.requested_long_leverage),
    requestedShortLeverage: row.requested_short_leverage == null ? (row.requested_leverage == null ? undefined : Number(row.requested_leverage)) : Number(row.requested_short_leverage),
    maximumLeverage: row.maximum_leverage == null ? undefined : Number(row.maximum_leverage),
    maximumPositionPercent: Number(row.maximum_position_percent),
    maximumExposurePercent: Number(row.maximum_exposure_percent),
    maximumDailyLoss: Number(row.maximum_daily_loss),
    maximumDrawdown: Number(row.maximum_drawdown),
    maximumPositions: Number(row.maximum_positions),
    slippageBps: Number(row.slippage_bps),
    marginMode: row.margin_mode || undefined,
    quoteAssetReservePercent: row.quote_asset_reserve_percent == null ? undefined : Number(row.quote_asset_reserve_percent),
    maximumBaseAssetExposurePercent: row.maximum_base_asset_exposure_percent == null ? undefined : Number(row.maximum_base_asset_exposure_percent)
  };
}

function nullablePositive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function alignVenueStep(value, step) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isFinite(step) || step <= 0) return parsed;
  const precision = Math.max(0, Math.min(12, String(step).includes("e-") ? Number(String(step).split("e-")[1]) : (String(step).split(".")[1] || "").length));
  return Number((Math.round(parsed / step) * step).toFixed(precision));
}

export function assertRecoveredVenueOrderShape(order, expected) {
  const actualSide = String(order?.side || "").toLowerCase();
  const expectedSide = String(expected?.side || "").toLowerCase();
  const actualSymbol = String(order?.symbol || "").toUpperCase();
  const expectedSymbol = String(expected?.symbol || "").toUpperCase();
  const actualCategory = String(order?.category || "").toLowerCase();
  const expectedCategory = String(expected?.category || "").toLowerCase();
  const actualType = String(order?.orderType || order?.type || "").toLowerCase();
  const expectedType = String(expected?.orderType || "").toLowerCase();
  const positionMismatch = expected?.positionIdx !== undefined && Number(order?.positionIdx || 0) !== Number(expected.positionIdx);
  if (actualSide !== expectedSide
    || Boolean(order?.reduceOnly) !== Boolean(expected?.reduceOnly)
    || (expectedSymbol && actualSymbol !== expectedSymbol)
    || (expectedCategory && actualCategory !== expectedCategory)
    || (expectedType && actualType !== expectedType)
    || positionMismatch) {
    throw terminalError("STRATEGY_RECOVERY_ORDER_MISMATCH", "The deterministic Bybit order identity exists with an unexpected symbol, category, side, type, position index, or reduce-only contract.");
  }
}

export function isTerminalUnfilledVenueOrder(order) {
  const status = String(order?.status || "").toLowerCase();
  const terminal = ["cancelled", "canceled", "expired", "rejected", "failed"].includes(status);
  return terminal && !(Number(order?.filledQuantity ?? order?.filled_quantity ?? 0) > 0);
}

export function isTerminalVenueOrder(order) {
  return ["filled", "cancelled", "canceled", "expired", "rejected", "failed"].includes(String(order?.status || "").toLowerCase());
}

export function mandateListAllows(values, requestedValue) {
  if (!Array.isArray(values) || values.length === 0) return true;
  const requested = String(requestedValue || "").trim().toUpperCase();
  return values.some((value) => {
    const normalized = String(value || "").trim().toUpperCase();
    return normalized === "*" || normalized === requested;
  });
}

export function recoveredStrategyOrderDraft(order, defaults) {
  const quantity = Number(order?.quantity || order?.filledQuantity || 0);
  if (!Number.isFinite(quantity) || quantity <= 0) throw terminalError("STRATEGY_RECOVERY_QUANTITY_INVALID", "The recovered Bybit order has no positive immutable quantity.");
  return {
    accountId: defaults.accountId,
    symbol: String(order?.symbol || defaults.symbol || "").toUpperCase(),
    marketKind: defaults.marketKind,
    side: String(order?.side || "").toLowerCase(),
    orderType: String(order?.orderType || order?.type || "market").toLowerCase(),
    quantity,
    quantityMode: "quantity",
    referencePrice: Number(defaults.referencePrice || order?.averageFillPrice || order?.price || 0),
    limitPrice: Number(order?.price || 0) || undefined,
    takeProfit: undefined,
    stopLoss: undefined,
    leverage: 1,
    marginMode: "cross",
    reduceOnly: Boolean(order?.reduceOnly),
    positionIdx: Number(order?.positionIdx || 0),
    timeInForce: String(order?.timeInForce || (String(order?.orderType || order?.type || "").toLowerCase() === "limit" ? "gtc" : "ioc")).toLowerCase(),
    clientOrderId: defaults.clientOrderId,
    source: defaults.source,
  };
}

export function recoveredFollowerAllocation(order, accountMetrics = {}, fallbackPrice = 0) {
  const roundedQuantity = Number(order?.quantity || order?.filledQuantity || 0);
  const price = Number(order?.averageFillPrice || order?.price || fallbackPrice || 0);
  if (!Number.isFinite(roundedQuantity) || roundedQuantity <= 0 || !Number.isFinite(price) || price <= 0) {
    throw terminalError("STRATEGY_RECOVERY_ALLOCATION_INVALID", "The recovered follower order has no positive immutable quantity or reference price.");
  }
  const targetNotional = roundedQuantity * price;
  return {
    calculatedEquity: Number(accountMetrics?.equityUsd ?? accountMetrics?.totalEquityUsd ?? 0),
    calculatedAvailableMargin: Number(accountMetrics?.availableMarginUsd ?? accountMetrics?.availableBalanceUsd ?? 0),
    allocationPercent: null,
    requestedNotional: targetNotional,
    targetNotional,
    roundedQuantity,
    estimatedMargin: Boolean(order?.reduceOnly) ? 0 : targetNotional,
    leverage: 1,
    price,
    minimumQuantity: 0,
    minimumNotional: 0,
    quantityStep: 0,
    belowMinimumQuantity: false,
    belowMinimumNotional: false,
    constrained: false,
  };
}

export function recoveredGroupIntentFromVenue(intent, order) {
  return {
    ...intent,
    side: String(order?.side || "").toLowerCase() === "sell" ? "SELL" : "BUY",
    order_type: String(order?.orderType || order?.type || "market").toUpperCase().replaceAll("-", "_"),
    limit_price: Number(order?.price || 0) || null,
    stop_price: null,
    take_profit: null,
    stop_loss: null,
    reduce_only: Boolean(order?.reduceOnly),
    time_in_force: String(order?.timeInForce || "GTC").toUpperCase(),
  };
}

export function isPotentialPositionGeneration(order) {
  const status = String(order?.status || "").toLowerCase();
  return ["accepted", "submitted", "working", "partially-filled", "filled"].includes(status)
    || Number(order?.filled_quantity ?? order?.filledQuantity ?? 0) > 0;
}

export function summarizeTakeProfitLadderFailure(ladder) {
  const details = (Array.isArray(ladder?.reasons) ? ladder.reasons : [])
    .slice(0, 3)
    .map((reason) => `${reason.targetId ? `${reason.targetId}: ` : ""}${reason.message}`)
    .join(" ");
  return details || "The configured partial take-profit ladder cannot satisfy the current Bybit quantity and notional minimums.";
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
