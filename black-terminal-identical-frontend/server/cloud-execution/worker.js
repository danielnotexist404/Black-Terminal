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
import {
  resolveBlackScriptCloseQuantity,
  resolveBlackScriptEntryQuantity,
} from "./black-script-sizing.js";
import { runBrokerCredentialCryptoSelfTest } from "./secret-vault.js";
import { measureBybitClockHealth, WORKER_CLOCK_STATUSES } from "./clock-health.js";
import { calculateCapitalPreview, calculateEffectiveLeverage, normalizeCapitalPolicy } from "../strategy-automation/domain.js";
import {
  calculateStrategyTakeProfitQuantity,
  evaluateStrategyTakeProfitLadder,
  floorStrategyVenueQuantity,
  planStrategyTakeProfitProtection,
  reserveStrategyTakeProfits,
  resolveStrategyTakeProfitPrice,
  settledStrategyEntryQuantity
} from "../strategy-automation/superatr-execution.js";
import fs from "node:fs";

const BLACK_CLOUD_SOFTWARE_VERSION = readPackageVersion();
const MAX_STRATEGY_REVERSAL_CLOSE_LEGS = 4;
const STRATEGY_DEPENDENCY_CANCELLATION_REASONS = new Set([
  "PARENT_ENTRY_FAILED",
  "PARENT_ENTRY_UNFILLED",
  "PARENT_GROUP_ENTRY_FAILED",
  "PARENT_GROUP_ENTRY_UNFILLED"
]);
const TERMINAL_FOLLOWER_PLAN_REJECTION_STATUSES = new Set([
  "RISK_REJECTED",
  "CONNECTION_UNHEALTHY",
  "AUTH_EXPIRED",
  "INSUFFICIENT_MARGIN",
  "SYMBOL_NOT_ALLOWED",
  "MANDATE_PAUSED",
  "VENUE_REJECTED",
  "RECONCILIATION_REQUIRED",
  "CANCELLED"
]);

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
      commandsCancelled: 0,
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
      if (["credentialVault", "eventInbox", "nodeRegistry", "strategyRuntime", "atomicOrderState", "reconciliationLiveness"].some((name) => !dependencies[name])) throw terminalError("SCHEMA_MISMATCH", "Black Cloud required schema is unavailable; verify the Phase V Chapter II migrations.");
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
    const strategyFailSafeRecoveryDispatch = command.command_type === "PLACE_ORDER"
      && (command.payload?.forceProtectionFailSafeFlatten === true || command.payload?.failSafeProtectionRecovery?.rescueStarted === true);
    try {
      await this.requireBlackScriptCommandDependencies(command);
      let result;
      if (command.command_type === "EXPAND_GROUP_INTENT") result = await this.expandGroupIntent(command);
      else if (command.command_type === "PLACE_ORDER" && (command.payload?.forceProtectionFailSafeFlatten === true || command.payload?.failSafeProtectionRecovery?.rescueStarted === true)) result = await this.executeStrategyTakeProfitFailSafeRepair(command, fencingToken);
      else if (command.command_type === "PLACE_ORDER" && command.follower_plan_id) result = await this.placeFollowerOrder(command, fencingToken);
      else if (command.command_type === "PLACE_ORDER" && command.strategy_target_binding_id && ["BLACK_SCRIPT_ENTRY", "BLACK_SCRIPT_EXIT"].includes(String(command.payload?.action || "").toUpperCase())) result = await this.placeBlackScriptRestingOrder(command, fencingToken);
      else if (command.command_type === "PLACE_ORDER" && command.strategy_target_binding_id) result = await this.placeStrategyOrder(command, fencingToken);
      else if (command.command_type === "PLACE_ORDER") result = await this.placeFollowerOrder(command, fencingToken);
      else if (command.command_type === "MODIFY_ORDER" && command.strategy_target_binding_id && String(command.payload?.strategyAction || "").toUpperCase() === "BLACK_SCRIPT_ORDER_MODIFY") result = await this.modifyBlackScriptOrder(command, fencingToken);
      else if (command.command_type === "MODIFY_ORDER" && command.strategy_target_binding_id) result = await this.modifyStrategyTakeProfitOrder(command, fencingToken);
      else if (command.command_type === "MODIFY_ORDER") result = await this.executeBrokerMutation(command, fencingToken, "modify");
      else if (command.command_type === "CANCEL_ORDER" && command.strategy_target_binding_id && String(command.payload?.strategyAction || "").toUpperCase() === "BLACK_SCRIPT_ORDER_CANCEL") result = await this.cancelBlackScriptOrder(command, fencingToken);
      else if (command.command_type === "CANCEL_ORDER") result = await this.executeBrokerMutation(command, fencingToken, "cancel");
      else if (command.command_type === "CANCEL_ALL") result = await this.executeBrokerMutation(command, fencingToken, "cancel-all");
      else if (command.command_type === "PLACE_PROTECTION" && command.strategy_target_binding_id) result = await this.placeBlackScriptPositionProtection(command, fencingToken);
      else if (command.command_type === "SYNC_ACCOUNT") result = await this.syncAccount(command);
      else throw terminalError("UNSUPPORTED_COMMAND", `Unsupported Black Cloud command: ${command.command_type}`);

      const dependencyCancellation = strategyDependencyCancellation(result);
      if (dependencyCancellation) {
        const message = strategyDependencyCancellationMessage(dependencyCancellation);
        await this.repository.finishAttempt(attemptId, "FAILED", {
          errorCode: dependencyCancellation,
          errorMessage: message,
          safeDetails: { skipped: true, dependencyCancelled: true, reason: dependencyCancellation }
        });
        await this.repository.finishCommand(command.id, fencingToken, "CANCELLED", {
          errorCode: dependencyCancellation,
          errorMessage: message
        });
        this.metricsCounters.commandsCancelled += 1;
        await this.recordCommandAudits(command, {
          executionEventType: "STRATEGY_DEPENDENCY_CANCELLED",
          strategyEventType: "STRATEGY_EXECUTION_DEPENDENCY_CANCELLED",
          severity: "WARNING",
          purpose: "strategy_command_dependency",
          message,
          metadata: strategyCommandAuditMetadata(command, {
            code: dependencyCancellation,
            commandStatus: "CANCELLED",
            retryable: false,
            ambiguous: false
          })
        });
        await this.refreshBlackScriptTargetSynchronization(command, dependencyCancellation).catch(() => undefined);
        return;
      }

      await this.repository.finishAttempt(attemptId, "SUCCEEDED", {
        venueOrderId: result?.venueOrderId,
        safeDetails: result || {}
      });
      await this.repository.finishCommand(command.id, fencingToken, "SUCCEEDED");
      this.metricsCounters.commandsSucceeded += 1;
      await this.refreshBlackScriptTargetSynchronization(command).catch(() => undefined);
    } catch (error) {
      let effectiveError = error;
      if (!strategyFailSafeRecoveryDispatch) {
        try {
          await this.handleTerminalTakeProfitProtectionFailure(command, fencingToken, error);
        } catch (safetyError) {
          effectiveError = safetyError;
        }
      }
      const classification = classifyExecutionError(effectiveError, command);
      const commandWillRetry = ["RETRY", "SUBMISSION_UNKNOWN", "RECONCILING"].includes(classification.commandStatus);
      this.metricsCounters.commandsFailed += 1;
      if (/fencing|stale worker/i.test(String(effectiveError?.message || effectiveError))) this.metricsCounters.fencingRejections += 1;
      if (command.command_type === "PLACE_ORDER" && !classification.ambiguous && classification.code !== "STRATEGY_REVERSE_WAITING_FOR_FLAT") this.metricsCounters.ordersRejected += 1;
      if (classification.ambiguous) this.metricsCounters.unknownSubmissionOutcomes += 1;
      await this.repository.finishAttempt(attemptId, classification.attemptOutcome, {
        errorCode: classification.code,
        errorMessage: effectiveError?.message,
        safeDetails: { retryable: classification.retryable, ambiguous: classification.ambiguous }
      });
      if (command.follower_plan_id && !commandWillRetry) {
        await this.terminalizeFollowerPlanFailure(command, classification, effectiveError);
      }
      await this.repository.finishCommand(command.id, fencingToken, classification.commandStatus, {
        errorCode: classification.code,
        errorMessage: effectiveError?.message,
        retryAfterSeconds: classification.retryAfterSeconds
      });
      const message = classification.ambiguous
        ? "Order acknowledgement was ambiguous; reconciliation is required before any retry."
        : sanitizeError(effectiveError?.message || "Execution command failed.");
      const mirrorStrategyAudit = !commandWillRetry || Number(command.attempt_count || 0) <= 1;
      await this.recordCommandAudits(command, {
        executionEventType: classification.ambiguous ? "ORDER_SUBMISSION_AMBIGUOUS" : "EXECUTION_COMMAND_FAILED",
        strategyEventType: classification.ambiguous && commandWillRetry
          ? "STRATEGY_EXECUTION_COMMAND_RECONCILING"
          : commandWillRetry
            ? "STRATEGY_EXECUTION_COMMAND_RETRY"
            : "STRATEGY_EXECUTION_COMMAND_FAILED",
        severity: commandWillRetry && !classification.ambiguous ? "WARNING" : "ERROR",
        purpose: "command_execution",
        message,
        metadata: strategyCommandAuditMetadata(command, {
          code: classification.code,
          commandStatus: classification.commandStatus,
          retryable: classification.retryable,
          ambiguous: classification.ambiguous
        }),
        mirrorStrategyAudit
      });
      await this.refreshBlackScriptTargetSynchronization(command, commandWillRetry ? null : classification.code).catch(() => undefined);
    }
  }

  async refreshBlackScriptTargetSynchronization(command, terminalErrorCode = null) {
    if (!command.strategy_target_binding_id || command.payload?.blackScriptRuntimeVersion !== "black-script-v3") return;
    const sourceVersion = String(command.payload?.sourceVersion || "");
    const settingsVersion = String(command.payload?.settingsVersion || "");
    const generationCandleTime = Number(command.payload?.generationCandleTime || 0);
    if (!/^[0-9a-f]{8}$/.test(sourceVersion) || !/^[0-9a-f]{8}$/.test(settingsVersion) || !Number.isFinite(generationCandleTime)) return;
    const state = await oneOrNull(this.supabase.from("strategy_script_target_state")
      .select("binding_id,source_version,settings_version,last_generation_candle_time")
      .eq("binding_id", command.strategy_target_binding_id)
      .maybeSingle());
    if (!state || state.source_version !== sourceVersion || state.settings_version !== settingsVersion
      || Number(state.last_generation_candle_time) !== generationCandleTime) return;
    const generationCommands = await rows(this.supabase.from("execution_commands")
      .select("status,last_error_code")
      .eq("strategy_automation_id", command.strategy_automation_id)
      .eq("strategy_target_binding_id", command.strategy_target_binding_id)
      .contains("payload", { blackScriptRuntimeVersion: "black-script-v3", sourceVersion, settingsVersion, generationCandleTime }));
    const terminalFailure = terminalErrorCode || generationCommands.find((item) => ["FAILED", "DEAD_LETTER", "CANCELLED"].includes(String(item.status || "").toUpperCase()))?.last_error_code;
    const pending = generationCommands.some((item) => !["SUCCEEDED", "FAILED", "DEAD_LETTER", "CANCELLED"].includes(String(item.status || "").toUpperCase()));
    const synchronizationState = terminalFailure ? "DEGRADED" : pending ? "PENDING" : "IN_SYNC";
    await updateOrThrow(this.supabase.from("strategy_script_target_state").update({
      synchronization_state: synchronizationState,
      last_error_code: terminalFailure || null,
      updated_at: new Date().toISOString(),
    }).eq("binding_id", command.strategy_target_binding_id)
      .eq("source_version", sourceVersion)
      .eq("settings_version", settingsVersion)
      .eq("last_generation_candle_time", generationCandleTime));
  }

  async requireBlackScriptCommandDependencies(command) {
    const raw = command.payload?.dependsOnIdempotencyKeys;
    if (command.payload?.blackScriptRuntimeVersion !== "black-script-v3" || !Array.isArray(raw) || raw.length === 0) return;
    const keys = [...new Set(raw.map(String))];
    if (keys.length > 64 || keys.some((key) => !/^[0-9a-f]{64}$/.test(key) || key === command.idempotency_key)) {
      throw terminalError("BLACK_SCRIPT_DEPENDENCY_IDENTITY_INVALID", "The Black Script command dependency manifest is invalid.");
    }
    const dependencies = await rows(this.supabase.from("execution_commands")
      .select("idempotency_key,status,strategy_automation_id,strategy_target_binding_id,connection_id,user_id,last_error_code")
      .in("idempotency_key", keys));
    if (dependencies.length !== keys.length || dependencies.some((dependency) =>
      dependency.strategy_automation_id !== command.strategy_automation_id
      || dependency.strategy_target_binding_id !== command.strategy_target_binding_id
      || dependency.connection_id !== command.connection_id
      || dependency.user_id !== command.user_id)) {
      throw terminalError("BLACK_SCRIPT_DEPENDENCY_OWNERSHIP_MISMATCH", "A Black Script command dependency is missing or belongs to another execution authority.");
    }
    const failed = dependencies.find((dependency) => ["FAILED", "DEAD_LETTER", "CANCELLED"].includes(String(dependency.status || "").toUpperCase()));
    if (failed) {
      throw terminalError("BLACK_SCRIPT_DEPENDENCY_FAILED", `A prerequisite Black Script broker command failed (${failed.last_error_code || "unknown"}).`);
    }
    if (dependencies.some((dependency) => String(dependency.status || "").toUpperCase() !== "SUCCEEDED")) {
      throw retryableError("BLACK_SCRIPT_DEPENDENCY_PENDING", "A prerequisite Black Script broker command is still settling.", 2);
    }
  }

  async terminalizeFollowerPlanFailure(command, classification, error) {
    const status = followerPlanStatusForExecutionFailure(classification.code);
    const current = await oneOrNull(this.supabase.from("follower_execution_plans")
      .select("execution_status,execution_order_id,safe_result")
      .eq("id", command.follower_plan_id)
      .maybeSingle());
    const linkedOrder = current?.execution_order_id ? await oneOrNull(this.supabase.from("execution_orders")
      .select("id,account_id,status,quantity,filled_quantity,exchange_order_id,average_fill_price,rejection_reason,venue_updated_at")
      .eq("id", current.execution_order_id)
      .maybeSingle()) : null;
    const hasPositiveFill = hasPositiveFollowerPlanFill(current, linkedOrder);
    if (hasPositiveFill) {
      if (linkedOrder) {
        await this.repository.applyExecutionOrderState({
          orderId: linkedOrder.id,
          accountId: linkedOrder.account_id,
          status: linkedOrder.status,
          cumulativeFilledQuantity: linkedOrder.filled_quantity,
          exchangeOrderId: linkedOrder.exchange_order_id,
          averageFillPrice: linkedOrder.average_fill_price,
          rejectionReason: linkedOrder.rejection_reason,
          venueUpdatedAt: linkedOrder.venue_updated_at,
          followerPlanId: command.follower_plan_id
        });
      }
      await updateOrThrow(this.supabase.from("follower_execution_plans").update({
        safe_result: {
          ...(current?.safe_result || {}),
          postFillCommandFailure: {
            commandId: command.id,
            code: classification.code,
            commandStatus: classification.commandStatus,
            retryable: false
          },
          failSafeFlattened: String(classification.code || "").includes("FAIL_SAFE_FLATTENED") || current?.safe_result?.failSafeFlattened === true
        }
      }).eq("id", command.follower_plan_id));
      return;
    }
    await updateOrThrow(this.supabase.from("follower_execution_plans").update({
      execution_status: status,
      rejection_reason: sanitizeError(error?.message || "The follower execution command failed."),
      safe_result: {
        ...(current?.safe_result || {}),
        commandId: command.id,
        code: classification.code,
        commandStatus: classification.commandStatus,
        retryable: false
      }
    }).eq("id", command.follower_plan_id));
  }

  async executeStrategyTakeProfitFailSafeRepair(command, fencingToken) {
    const triggerCode = command.payload?.failSafeProtectionRecovery?.triggerCode || "STRATEGY_TP_ORDER_TERMINATED_AT_VENUE";
    const trigger = terminalError(triggerCode, "A strategy take-profit could not maintain protective coverage while its owned position could still be open.");
    const handled = await this.handleTerminalTakeProfitProtectionFailure(command, fencingToken, trigger);
    return handled === false
      ? { skipped: true, reason: "TAKE_PROFIT_REPAIR_POSITION_FLAT_OR_STALE" }
      : handled;
  }

  async handleTerminalTakeProfitProtectionFailure(command, fencingToken, error) {
    const forcedRecovery = command.payload?.forceProtectionFailSafeFlatten === true || command.payload?.failSafeProtectionRecovery?.rescueStarted === true;
    if (command.command_type !== "PLACE_ORDER" || !forcedRecovery && !isTerminalTakeProfitProtectionFailure(error)) return false;
    if (command.follower_plan_id) {
      const [plan, intent, connection] = await Promise.all([
        single(this.supabase.from("follower_execution_plans").select("*").eq("id", command.follower_plan_id)),
        single(this.supabase.from("group_trade_intents").select("*").eq("id", command.group_intent_id)),
        single(this.supabase.from("connectivity_connections").select("*").eq("id", command.connection_id))
      ]);
      if (String(intent.strategy_action || "").toUpperCase() !== "TAKE_PROFIT") return false;
      assertIntentIntegrity(intent);
      const [account, secretReference, mandate] = await Promise.all([
        single(this.supabase.from("exchange_accounts").select("*").eq("id", connection.account_id)),
        single(this.supabase.from("broker_secret_references").select("id,status").eq("connection_id", connection.id).eq("status", "ACTIVE")),
        single(this.supabase.from("group_execution_mandates").select("*").eq("id", plan.mandate_id))
      ]);
      const credentials = await this.repository.readBrokerSecret(secretReference.id, "group_take_profit_fail_safe_flatten");
      const credentialEnvironment = assertWorkerEnvironment(connection, credentials);
      const marketKind = intent.market_type === "SPOT" ? "spot" : "perpetual";
      const category = marketKind === "spot" ? "spot" : "linear";
      const [ticker, venuePositions] = await Promise.all([
        getBybitTicker({ category, symbol: intent.symbol, executionEnvironment: credentialEnvironment, endpointProfile: credentials.endpointProfile }),
        marketKind === "spot" ? Promise.resolve([]) : getBybitPositions(credentials, { category, symbol: intent.symbol, includeEmpty: true })
      ]);
      const direction = String(intent.strategy_direction || "").toLowerCase();
      const position = venuePositions.find((item) => Number(item.quantity) > 0 && item.direction === direction);
      const parentGroupIntentId = String(intent.strategy_execution_policy?.parentGroupIntentId || "");
      const parentPlan = parentGroupIntentId ? await oneOrNull(this.supabase.from("follower_execution_plans")
        .select("execution_order_id")
        .eq("group_intent_id", parentGroupIntentId)
        .eq("mandate_id", plan.mandate_id)
        .maybeSingle()) : null;
      const parentOrder = parentPlan?.execution_order_id ? await oneOrNull(this.supabase.from("execution_orders")
        .select("id,client_order_id,side,reduce_only,status,filled_quantity")
        .eq("id", parentPlan.execution_order_id)
        .maybeSingle()) : null;
      const expectedEntrySide = direction === "short" ? "sell" : "buy";
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
      const latestEntry = matchingEntries.find(isPotentialPositionGeneration);
      if (!parentOrder || parentOrder.reduce_only === true || parentOrder.side !== expectedEntrySide
        || !latestEntry || latestEntry.id !== parentOrder.id
        || command.payload?.expectedEntryOrderId && command.payload.expectedEntryOrderId !== parentOrder.id) return false;
      const priorRecovery = command.payload?.failSafeProtectionRecovery;
      if (!position && !(priorRecovery?.baseClientOrderId && priorRecovery?.rescueStarted === true)) return false;
      if (position) {
        const owned = await oneOrNull(this.supabase.from("account_positions")
          .select("strategy_target_binding_id")
          .eq("account_id", account.id)
          .eq("symbol", intent.symbol)
          .eq("direction", direction)
          .eq("position_idx", Number(position.positionIdx))
          .gt("quantity", 0)
          .maybeSingle());
        if (!owned) throw reconciliationError("STRATEGY_TP_PROTECTION_OWNERSHIP_RECONCILING", "The live follower position is awaiting immutable ownership before Black Cloud may execute its safety flatten.", 2);
        if (owned.strategy_target_binding_id !== intent.strategy_target_binding_id) return false;
      }
      const recovery = await this.persistStrategyFailSafeRecoveryContext(command, {
        baseClientOrderId: priorRecovery?.baseClientOrderId || strategyRootClientOrderId(parentOrder?.client_order_id || command.deterministic_client_order_id),
        positionIdx: Number(position?.positionIdx ?? priorRecovery?.positionIdx ?? 0),
        direction,
        symbol: intent.symbol,
        triggerCode: error?.code || priorRecovery?.triggerCode || "TP_PROTECTION_FAILED",
        rescueStarted: true,
        lastKnownQuantity: Number(position?.quantity ?? priorRecovery?.lastKnownQuantity ?? 0)
      });
      const referencePrice = Number(ticker.markPrice || ticker.lastPrice);
      const persistRescueOrder = ({ venueReport, orderDraft, recovered }) => this.persistAcceptedOrder({
        command,
        plan,
        intent: { ...intent, side: orderDraft.side === "sell" ? "SELL" : "BUY", order_type: "MARKET", reduce_only: true, take_profit: null, stop_loss: null, time_in_force: "IOC", strategy_action: "FAIL_SAFE_FLATTEN" },
        account,
        allocation: { calculatedEquity: 0, calculatedAvailableMargin: 0, allocationPercent: null, targetNotional: recovery.lastKnownQuantity * referencePrice, roundedQuantity: recovery.lastKnownQuantity, estimatedMargin: 0, leverage: 1 },
        venueReport,
        clientOrderId: orderDraft.clientOrderId,
        linkPlan: false,
        recovered
      });
      return this.ensureStrategyFailSafeFlatten({
        command, fencingToken, connection, account, credentials, credentialEnvironment, marketKind, category,
        symbol: intent.symbol, direction, position, positionIdx: recovery.positionIdx, referencePrice,
        ownerUserId: intent.created_by, orderUserId: plan.follower_user_id, strategyId: intent.strategy_automation_id,
        bindingId: intent.strategy_target_binding_id, source: "investment-group-cloud",
        baseClientOrderId: recovery.baseClientOrderId,
        persistRescueOrder,
        authorize: async () => {
          if (String(mandate.status || "").toUpperCase() !== "ACTIVE") throw terminalError("MANDATE_PAUSED", "The Investment Group follower mandate is no longer active.");
          await this.repository.requireAutomationMandate(connection.id, "group");
          if (!account.trading_enabled || account.is_read_only) throw terminalError("ACCOUNT_READ_ONLY", "The venue account is not approved for a safety flatten.");
        },
        reasons: [{ message: sanitizeError(error?.message || error) }],
        triggerCode: recovery.triggerCode,
        flatIsSafe: true
      });
    }

    if (String(command.payload?.action || "").toUpperCase() !== "TAKE_PROFIT" || !command.strategy_target_binding_id) return false;
    const [binding, strategy, connection] = await Promise.all([
      single(this.supabase.from("strategy_target_bindings").select("*").eq("id", command.strategy_target_binding_id)),
      single(this.supabase.from("strategy_automation_strategies").select("*").eq("id", command.strategy_automation_id)),
      single(this.supabase.from("connectivity_connections").select("*").eq("id", command.connection_id))
    ]);
    const [account, secretReference] = await Promise.all([
      single(this.supabase.from("exchange_accounts").select("*").eq("id", connection.account_id)),
      single(this.supabase.from("broker_secret_references").select("id,status").eq("connection_id", connection.id).eq("status", "ACTIVE"))
    ]);
    const credentials = await this.repository.readBrokerSecret(secretReference.id, "strategy_take_profit_fail_safe_flatten");
    const credentialEnvironment = assertWorkerEnvironment(connection, credentials);
    const marketKind = binding.market_type === "SPOT" ? "spot" : "perpetual";
    const category = marketKind === "spot" ? "spot" : "linear";
    const symbol = String(command.payload.symbol || strategy.symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const [ticker, venuePositions] = await Promise.all([
      getBybitTicker({ category, symbol, executionEnvironment: credentialEnvironment, endpointProfile: credentials.endpointProfile }),
      marketKind === "spot" ? Promise.resolve([]) : getBybitPositions(credentials, { category, symbol, includeEmpty: true })
    ]);
    const direction = String(command.payload.direction || "").toLowerCase();
    const position = venuePositions.find((item) => Number(item.quantity) > 0 && item.direction === direction);
    const parentCommand = command.payload.parentEntryIdempotencyKey ? await oneOrNull(this.supabase.from("execution_commands")
      .select("execution_order_id")
      .eq("idempotency_key", command.payload.parentEntryIdempotencyKey)
      .eq("strategy_target_binding_id", binding.id)
      .maybeSingle()) : null;
    const parentOrder = parentCommand?.execution_order_id ? await oneOrNull(this.supabase.from("execution_orders")
      .select("id,client_order_id,side,reduce_only,status,filled_quantity,strategy_target_binding_id")
      .eq("id", parentCommand.execution_order_id)
      .maybeSingle()) : null;
    const expectedEntrySide = direction === "short" ? "sell" : "buy";
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
    const latestEntry = matchingEntries.find(isPotentialPositionGeneration);
    if (!parentOrder || parentOrder.reduce_only === true || parentOrder.side !== expectedEntrySide
      || parentOrder.strategy_target_binding_id !== binding.id || !latestEntry || latestEntry.id !== parentOrder.id
      || command.payload?.expectedEntryOrderId && command.payload.expectedEntryOrderId !== parentOrder.id) return false;
    const priorRecovery = command.payload?.failSafeProtectionRecovery;
    if (!position && !(priorRecovery?.baseClientOrderId && priorRecovery?.rescueStarted === true)) return false;
    if (position) {
      const owned = await oneOrNull(this.supabase.from("account_positions")
        .select("strategy_target_binding_id")
        .eq("account_id", account.id)
        .eq("symbol", symbol)
        .eq("direction", direction)
        .eq("position_idx", Number(position.positionIdx))
        .gt("quantity", 0)
        .maybeSingle());
      if (!owned) throw reconciliationError("STRATEGY_TP_PROTECTION_OWNERSHIP_RECONCILING", "The live strategy position is awaiting immutable ownership before Black Cloud may execute its safety flatten.", 2);
      if (owned.strategy_target_binding_id !== binding.id) return false;
    }
    const recovery = await this.persistStrategyFailSafeRecoveryContext(command, {
      baseClientOrderId: priorRecovery?.baseClientOrderId || strategyRootClientOrderId(parentOrder?.client_order_id || command.deterministic_client_order_id),
      positionIdx: Number(position?.positionIdx ?? priorRecovery?.positionIdx ?? 0),
      direction,
      symbol,
      triggerCode: error?.code || priorRecovery?.triggerCode || "TP_PROTECTION_FAILED",
      rescueStarted: true,
      lastKnownQuantity: Number(position?.quantity ?? priorRecovery?.lastKnownQuantity ?? 0)
    });
    const referencePrice = Number(ticker.markPrice || ticker.lastPrice);
    const source = credentialEnvironment === "DEMO" ? "strategy-automation-demo" : "strategy-automation-mainnet";
    const persistRescueOrder = ({ venueReport, orderDraft, recovered }) => this.persistStrategyAcceptedOrder({
      command, binding, strategy, account, orderDraft: { ...orderDraft, quantity: recovery.lastKnownQuantity }, venueReport, estimatedMargin: 0,
      estimatedNotional: recovery.lastKnownQuantity * referencePrice, recovered, linkCommand: false
    });
    return this.ensureStrategyFailSafeFlatten({
      command, fencingToken, connection, account, credentials, credentialEnvironment, marketKind, category,
      symbol, direction, position, positionIdx: recovery.positionIdx, referencePrice,
      ownerUserId: command.user_id, orderUserId: command.user_id, strategyId: strategy.id, bindingId: binding.id, source,
      baseClientOrderId: recovery.baseClientOrderId,
      persistRescueOrder,
      authorize: async () => {
        await this.repository.requireAutomationMandate(connection.id, "strategy");
        if (!account.trading_enabled || account.is_read_only) throw terminalError("ACCOUNT_READ_ONLY", "The Bybit account is not trade enabled for a safety flatten.");
      },
      reasons: [{ message: sanitizeError(error?.message || error) }],
      triggerCode: recovery.triggerCode,
      flatIsSafe: true
    });
  }

  async persistStrategyFailSafeRecoveryContext(command, context) {
    const recovery = {
      baseClientOrderId: String(context.baseClientOrderId || ""),
      positionIdx: Number(context.positionIdx || 0),
      direction: String(context.direction || "").toLowerCase(),
      symbol: String(context.symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
      triggerCode: String(context.triggerCode || "TP_PROTECTION_FAILED"),
      rescueStarted: context.rescueStarted === true,
      lastKnownQuantity: Number(context.lastKnownQuantity || 0)
    };
    const payload = { ...(command.payload || {}), failSafeProtectionRecovery: recovery };
    await updateOrThrow(this.supabase.from("execution_commands").update({ payload }).eq("id", command.id));
    command.payload = payload;
    return recovery;
  }

  async recordCommandAudits(command, descriptor) {
    const writes = [this.repository.audit({
      userId: command.user_id,
      connectionId: command.connection_id,
      groupIntentId: command.group_intent_id,
      followerPlanId: command.follower_plan_id,
      commandId: command.id,
      eventType: descriptor.executionEventType,
      severity: descriptor.severity,
      purpose: descriptor.purpose,
      message: descriptor.message,
      metadata: descriptor.metadata
    })];
    if (descriptor.mirrorStrategyAudit !== false && command.strategy_automation_id && command.strategy_target_binding_id) {
      writes.push(this.mirrorStrategyCommandAudit(command, descriptor));
    }
    const outcomes = await Promise.allSettled(writes);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        console.error(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "ERROR",
          event: "strategy_command_audit_write_failed",
          nodeId: this.nodeId,
          error: sanitizeError(outcome.reason?.message || outcome.reason)
        }));
      }
    }
  }

  async mirrorStrategyCommandAudit(command, descriptor) {
    const safeMetadata = await this.resolveStrategyCommandAuditMetadata(command, descriptor.metadata);
    const { error } = await this.supabase.from("strategy_automation_audit_events").insert({
      owner_user_id: command.user_id,
      strategy_id: command.strategy_automation_id,
      binding_id: command.strategy_target_binding_id,
      event_type: descriptor.strategyEventType,
      severity: descriptor.severity,
      message: descriptor.message,
      safe_metadata: safeMetadata
    });
    if (error) throw error;
  }

  async resolveStrategyCommandAuditMetadata(command, metadata) {
    const resolved = { ...metadata };
    const missingAction = !resolved.action || resolved.action === "UNKNOWN";
    const missingDirection = !resolved.direction || resolved.direction === "unknown";
    const missingSymbol = !resolved.symbol || resolved.symbol === "UNKNOWN";
    if ((missingAction || missingDirection || missingSymbol) && command.group_intent_id) {
      const { data } = await this.supabase.from("group_trade_intents")
        .select("strategy_action,strategy_direction,symbol")
        .eq("id", command.group_intent_id)
        .maybeSingle();
      if (missingAction && data?.strategy_action) resolved.action = String(data.strategy_action).toUpperCase();
      if (missingDirection && data?.strategy_direction) resolved.direction = String(data.strategy_direction).toLowerCase();
      if (missingSymbol && data?.symbol) resolved.symbol = String(data.symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    }
    if ((!resolved.symbol || resolved.symbol === "UNKNOWN") && command.strategy_automation_id) {
      const { data } = await this.supabase.from("strategy_automation_strategies")
        .select("symbol")
        .eq("id", command.strategy_automation_id)
        .maybeSingle();
      if (data?.symbol) resolved.symbol = String(data.symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    }
    return resolved;
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
      rows(this.supabase.from("account_positions").select("symbol,direction,quantity,position_idx,strategy_target_binding_id,margin,unrealized_pnl").eq("account_id", connection.account_id))
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
    const requireProtectedGroupEntryFill = async (venueOrder) => {
      const finalFill = requireTerminalStrategyEntryFill(venueOrder);
      const configuredTargets = reserveStrategyTakeProfits(intent.strategy_execution_policy?.takeProfits);
      if (!configuredTargets.length) return { finalFill, protectionPlan: null };
      const position = venuePositions.find((item) => Number(item.quantity) > 0 && item.direction === groupDesiredDirection);
      const persistRescueOrder = async ({ venueReport, orderDraft, recovered }) => {
        const rescueIntent = {
          ...intent,
          side: orderDraft.side === "sell" ? "SELL" : "BUY",
          order_type: "MARKET",
          reduce_only: true,
          take_profit: null,
          stop_loss: null,
          time_in_force: "IOC",
          strategy_action: "FAIL_SAFE_FLATTEN"
        };
        const rescueAllocation = {
          calculatedEquity: Number(wallet.accountMetrics?.equityUsd || 0),
          calculatedAvailableMargin: Number(wallet.accountMetrics?.availableBalanceUsd || 0),
          allocationPercent: null,
          targetNotional: Number(position?.quantity || 0) * referencePrice,
          roundedQuantity: Number(position?.quantity || finalFill),
          estimatedMargin: 0,
          leverage: 1
        };
        return this.persistAcceptedOrder({
          command,
          plan,
          intent: rescueIntent,
          account,
          allocation: rescueAllocation,
          venueReport,
          clientOrderId: orderDraft.clientOrderId,
          linkPlan: false,
          recovered
        });
      };
      const failSafeContext = {
        command,
        fencingToken,
        connection,
        account,
        credentials,
        credentialEnvironment,
        marketKind,
        category,
        symbol: intent.symbol,
        direction: groupDesiredDirection,
        position,
        positionIdx: Number(position?.positionIdx ?? venueOrder?.positionIdx ?? groupRecoveryPositionIdx(groupDesiredDirection)),
        referencePrice,
        ownerUserId: intent.created_by,
        orderUserId: plan.follower_user_id,
        strategyId: intent.strategy_automation_id,
        bindingId: intent.strategy_target_binding_id,
        source: "investment-group-cloud",
        persistRescueOrder,
        authorize: async () => {
          if (String(mandate.status || "").toUpperCase() !== "ACTIVE") throw terminalError("MANDATE_PAUSED", "The Investment Group follower mandate is no longer active.");
          await this.repository.requireAutomationMandate(connection.id, "group");
          if (!account.trading_enabled || account.is_read_only) throw terminalError("ACCOUNT_READ_ONLY", "The venue account is not approved for a safety flatten.");
        }
      };
      if (!position) return this.ensureStrategyFailSafeFlatten({ ...failSafeContext, waitingForPositionOnly: true });
      const persistedPosition = positions.find((item) => String(item.symbol || "").toUpperCase() === String(intent.symbol).toUpperCase()
        && Number(item.position_idx) === Number(position.positionIdx)
        && item.direction === position.direction);
      if (!persistedPosition) throw reconciliationError("STRATEGY_POSITION_OWNERSHIP_PENDING", "The follower entry is visible at Bybit but its immutable strategy ownership is still reconciling.", 2);
      if (persistedPosition.strategy_target_binding_id !== intent.strategy_target_binding_id) throw terminalError("STRATEGY_POSITION_OWNERSHIP_REQUIRED", "Black Cloud refused to safety-flatten a follower position attributed to a different strategy target.");
      const resolvedTargets = configuredTargets.map((target) => ({
        ...target,
        price: resolveStrategyTakeProfitPrice({ ...target, direction: groupDesiredDirection }, position)
      }));
      const protectionPlan = planStrategyTakeProfitProtection({
        entryQuantity: finalFill,
        remainingQuantity: finalFill,
        targets: resolvedTargets,
        venue: instrument
      });
      await this.recordStrategyProtectionDecision({ command, plan, protectionPlan, terminalEntryQuantity: finalFill });
      if (protectionPlan.mode === "UNPROTECTABLE") {
        return this.ensureStrategyFailSafeFlatten({ ...failSafeContext, reasons: protectionPlan.reasons });
      }
      return { finalFill, protectionPlan };
    };
    const adoptRecoveredGroupOrder = async (venueOrder, clientOrderId, expected, options = {}) => {
      assertRecoveredVenueOrderShape(venueOrder, expected);
      const recoveredIntent = recoveredGroupIntentFromVenue(intent, venueOrder);
      const allocation = recoveredFollowerAllocation(venueOrder, wallet.accountMetrics, referencePrice);
      const adopted = await this.adoptVenueOrder({ command, plan, intent: recoveredIntent, account, allocation, existingVenueOrder: venueOrder, clientOrderId, linkPlan: options.linkPlan !== false });
      if (options.requireTerminalEntryFill === true) await requireProtectedGroupEntryFill(venueOrder);
      else if (isTerminalUnfilledVenueOrder(venueOrder) && options.allowTerminalUnfilled !== true) throw terminalError("STRATEGY_ORDER_UNFILLED", "Bybit terminated the recovered follower strategy order without a fill.");
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
          }, { requireTerminalEntryFill: true });
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
          }, { allowTerminalUnfilled: true, linkPlan: false });
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
          }, { requireTerminalEntryFill: !recoveredReduceOnly });
        }
      }
    }

    // Recovery above is deliberately allowed after a pause, mandate revocation,
    // read-only transition, or kill switch. A Bybit side effect acknowledged
    // before that control-plane change must still be adopted into the ledger.
    // Every mutable authorization is re-evaluated here before any new order can
    // be submitted.
    if (marketKind === "spot" && intent.strategy_action === "SYNC_DIRECTION"
      && reserveStrategyTakeProfits(intent.strategy_execution_policy?.takeProfits).length) {
      throw terminalError("STRATEGY_SPOT_TP_PROTECTION_UNSUPPORTED", "Spot strategy entries with partial take-profit protection are blocked before submission until balance-owned protective execution is certified.");
    }
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
      const [parentPlan, parentGroupIntent] = await Promise.all([
        oneOrNull(this.supabase.from("follower_execution_plans")
          .select("id,execution_order_id,execution_status,safe_result")
          .eq("group_intent_id", parentGroupIntentId)
          .eq("mandate_id", mandate.id)
          .maybeSingle()),
        oneOrNull(this.supabase.from("group_trade_intents")
          .select("id,strategy_execution_policy")
          .eq("id", parentGroupIntentId)
          .maybeSingle())
      ]);
      if (parentPlan?.safe_result?.failSafeFlattened === true || isTerminalFollowerPlanRejection(parentPlan?.execution_status)) return { skipped: true, reason: "PARENT_GROUP_ENTRY_FAILED" };
      if (!parentPlan?.execution_order_id) {
        throw retryableError("STRATEGY_GROUP_TAKE_PROFIT_WAITING_FOR_PARENT_ENTRY", "The follower parent entry has not completed; this target will retry.", 2);
      }
      const parentOrder = await oneOrNull(this.supabase.from("execution_orders")
        .select("id,client_order_id,side,quantity,reduce_only,status,filled_quantity,group_intent_id,mandate_id,strategy_target_binding_id")
        .eq("id", parentPlan.execution_order_id)
        .maybeSingle());
      const expectedEntrySide = desiredDirection === "short" ? "sell" : "buy";
      const parentConflictResolution = String(parentGroupIntent?.strategy_execution_policy?.conflictResolution || "CLOSE_ONLY").toUpperCase();
      if (parentOrder?.reduce_only === true && parentConflictResolution !== "CLOSE_THEN_REVERSE"
        && isTerminalInternalOrderStatus(parentOrder.status)) {
        return { skipped: true, reason: "PARENT_GROUP_ENTRY_UNFILLED" };
      }
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
      const requestedTargetId = String(intent.strategy_execution_policy?.targetId || "").toUpperCase();
      const frozenProtectionDecision = parentPlan?.safe_result?.takeProfitProtectionDecision;
      if (isAggregatedTargetSuppressed(frozenProtectionDecision, requestedTargetId)) {
        await updateOrThrow(this.supabase.from("follower_execution_plans").update({
          risk_result: "PASSED",
          rejection_reason: null,
          execution_status: "EXECUTED",
          safe_result: {
            ...(plan.safe_result || {}),
            skipped: true,
            reason: "TP_LADDER_AGGREGATED_TO_TP1",
            protectionMode: "AGGREGATED_TP1",
            primaryTargetId: frozenProtectionDecision.primaryTargetId,
            requestedTargetId
          }
        }).eq("id", plan.id).in("execution_status", ["PENDING", "QUEUED"]));
        return { skipped: true, reason: "TP_LADDER_AGGREGATED_TO_TP1" };
      }
      const parentVenueOrder = await findBybitOrderByClientOrderId(credentials, { marketKind, symbol: intent.symbol, clientOrderId: parentOrder.client_order_id });
      const originalEntryQuantity = settledStrategyEntryQuantity(parentVenueOrder);
      if (!originalEntryQuantity) {
        const parentStatus = String(parentVenueOrder?.status || "").toLowerCase();
        if (["cancelled", "canceled", "expired", "rejected", "failed"].includes(parentStatus)) return { skipped: true, reason: "PARENT_GROUP_ENTRY_UNFILLED" };
        throw retryableError("STRATEGY_GROUP_TAKE_PROFIT_WAITING_FOR_PARENT_FILL", "The follower parent IOC entry has not reached a final cumulative fill.", 2);
      }
      const position = venuePositions.find((item) => Number(item.quantity) > 0 && item.direction === desiredDirection);
      if (!position) throw reconciliationError("STRATEGY_GROUP_TAKE_PROFIT_WAITING_FOR_POSITION", "The follower entry is not visible on Bybit yet; the reduce-only take-profit will retry.", 2);
      const owned = await rows(this.supabase.from("account_positions").select("position_idx,direction,strategy_target_binding_id").eq("account_id", account.id).eq("symbol", intent.symbol).gt("quantity", 0));
      const persistedPosition = owned.find((item) => Number(item.position_idx) === Number(position.positionIdx) && item.direction === position.direction);
      if (!persistedPosition) throw reconciliationError("STRATEGY_POSITION_OWNERSHIP_PENDING", "The follower entry is visible at Bybit but its immutable strategy ownership is still reconciling.", 2);
      if (persistedPosition.strategy_target_binding_id !== intent.strategy_target_binding_id) throw terminalError("STRATEGY_POSITION_OWNERSHIP_REQUIRED", "Black Cloud refused to protect a follower position attributed to a different strategy target.");
      const parentTargets = reserveStrategyTakeProfits(parentGroupIntent?.strategy_execution_policy?.takeProfits).map((target) => ({
        ...target,
        price: resolveStrategyTakeProfitPrice({ ...target, direction: desiredDirection }, position)
      }));
      const protectionPlan = parentTargets.length
        ? planStrategyTakeProfitProtection({
          entryQuantity: originalEntryQuantity,
          remainingQuantity: originalEntryQuantity,
          targets: parentTargets,
          venue: instrument
        })
        : null;
      if (protectionPlan?.mode === "UNPROTECTABLE") {
        const persistRescueOrder = ({ venueReport, orderDraft, recovered }) => this.persistAcceptedOrder({
          command,
          plan,
          intent: {
            ...intent,
            side: orderDraft.side === "sell" ? "SELL" : "BUY",
            order_type: "MARKET",
            reduce_only: true,
            take_profit: null,
            stop_loss: null,
            time_in_force: "IOC",
            strategy_action: "FAIL_SAFE_FLATTEN"
          },
          account,
          allocation: {
            calculatedEquity: Number(wallet.accountMetrics?.equityUsd || 0),
            calculatedAvailableMargin: Number(wallet.accountMetrics?.availableBalanceUsd || 0),
            allocationPercent: null,
            targetNotional: Number(position.quantity) * referencePrice,
            roundedQuantity: Number(position.quantity || originalEntryQuantity),
            estimatedMargin: 0,
            leverage: 1
          },
          venueReport,
          clientOrderId: orderDraft.clientOrderId,
          linkPlan: false,
          recovered
        });
        return this.ensureStrategyFailSafeFlatten({
          command,
          fencingToken,
          connection,
          account,
          credentials,
          credentialEnvironment,
          marketKind,
          category,
          symbol: intent.symbol,
          direction: desiredDirection,
          position,
          positionIdx: position.positionIdx,
          referencePrice,
          ownerUserId: intent.created_by,
          orderUserId: plan.follower_user_id,
          strategyId: intent.strategy_automation_id,
          bindingId: intent.strategy_target_binding_id,
          source: "investment-group-cloud",
          baseClientOrderId: strategyRootClientOrderId(parentOrder.client_order_id),
          persistRescueOrder,
          authorize: async () => {
            if (String(mandate.status || "").toUpperCase() !== "ACTIVE") throw terminalError("MANDATE_PAUSED", "The Investment Group follower mandate is no longer active.");
            await this.repository.requireAutomationMandate(connection.id, "group");
            if (!account.trading_enabled || account.is_read_only) throw terminalError("ACCOUNT_READ_ONLY", "The venue account is not approved for a safety flatten.");
          },
          reasons: protectionPlan.reasons
        });
      }
      if (protectionPlan?.mode === "AGGREGATED_TP1" && requestedTargetId !== protectionPlan.primaryTargetId) {
        await updateOrThrow(this.supabase.from("follower_execution_plans").update({
          risk_result: "PASSED",
          rejection_reason: null,
          execution_status: "EXECUTED",
          safe_result: {
            ...(plan.safe_result || {}),
            skipped: true,
            reason: "TP_LADDER_AGGREGATED_TO_TP1",
            protectionMode: "AGGREGATED_TP1",
            primaryTargetId: protectionPlan.primaryTargetId,
            requestedTargetId
          }
        }).eq("id", plan.id).in("execution_status", ["PENDING", "QUEUED"]));
        return { skipped: true, reason: "TP_LADDER_AGGREGATED_TO_TP1" };
      }
      const effectiveTarget = protectionPlan?.mode === "AGGREGATED_TP1"
        ? protectionPlan.target
        : intent.strategy_execution_policy;
      const quantityPercent = protectionPlan?.mode === "AGGREGATED_TP1"
        ? 100
        : Math.max(0.1, Math.min(100, Number(intent.strategy_execution_policy?.quantityPercent || 0)));
      executionIntent.strategy_execution_policy = {
        ...(intent.strategy_execution_policy || {}),
        takeProfitProtectionMode: protectionPlan?.mode || "LEGACY_SINGLE_TARGET"
      };
      executionIntent.side = position.direction === "long" ? "SELL" : "BUY";
      executionIntent.reduce_only = true;
      executionIntent.take_profit = null;
      executionIntent.stop_loss = null;
      executionIntent.limit_price = resolveStrategyTakeProfitPrice({
        ...effectiveTarget,
        targetPrice: effectiveTarget?.price || intent.limit_price,
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

    const strategyEntryOrder = Boolean(intent.strategy_target_binding_id)
      && intent.strategy_action === "SYNC_DIRECTION"
      && executionIntent.reduce_only !== true;
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
      const adopted = await this.adoptVenueOrder({ command, plan, intent: executionIntent, account, allocation, existingVenueOrder, clientOrderId, linkPlan: !strategyReverseClose });
      if (strategyEntryOrder) await requireProtectedGroupEntryFill(existingVenueOrder);
      else if (isTerminalUnfilledVenueOrder(existingVenueOrder)) throw terminalError("STRATEGY_ORDER_UNFILLED", "Bybit terminated the recovered strategy order without a fill.");
      if (strategyReverseClose) throw retryableError("STRATEGY_REVERSE_WAITING_FOR_FLAT", "The existing follower close leg was adopted; waiting for Bybit to confirm the position is flat before entering the reverse leg.", 2);
      return adopted;
    }
    await this.blockAcknowledgedOrderResubmission({
      executionOrderId: command.execution_order_id,
      followerPlanExecutionOrderId: plan.execution_order_id,
      commandId: command.id,
      followerPlanId: strategyReverseClose ? null : plan.id,
      clientOrderId,
      account,
      symbol: intent.symbol,
      orderUserId: plan.follower_user_id,
      bindingId: intent.strategy_target_binding_id || null,
      groupIntentId: intent.id,
      mandateId: plan.mandate_id
    });

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
        const adopted = await this.adoptVenueOrder({ command, plan, intent: executionIntent, account, allocation, existingVenueOrder: recovered, clientOrderId, linkPlan: !strategyReverseClose });
        if (strategyEntryOrder) await requireProtectedGroupEntryFill(recovered);
        else if (isTerminalUnfilledVenueOrder(recovered)) throw terminalError("STRATEGY_ORDER_UNFILLED", "Bybit terminated the recovered follower strategy order without a fill.");
        if (strategyReverseClose) throw retryableError("GROUP_REVERSE_WAITING_FOR_FLAT", "The close leg was recovered; waiting for Bybit to confirm the attributed position is flat before entering the reverse leg.", 2);
        return adopted;
      }
      throw ambiguousError("Bybit submission timed out before acknowledgement. Reconciliation will query the deterministic client order ID.");
    }

    const persisted = await this.persistAcceptedOrder({ command, plan, intent: executionIntent, account, allocation, venueReport, clientOrderId, linkPlan: !strategyReverseClose });
    if (strategyEntryOrder) await requireProtectedGroupEntryFill(venueReport);
    else if (isTerminalUnfilledVenueOrder(venueReport)) throw terminalError("STRATEGY_ORDER_UNFILLED", "Bybit terminated the follower strategy order without a fill.");
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
    const requireProtectedEntryFill = async (venueOrder) => {
      const finalFill = requireTerminalStrategyEntryFill(venueOrder);
      const configuredTargets = reserveStrategyTakeProfits(payload.takeProfits);
      if (!configuredTargets.length) return { finalFill, protectionPlan: null };
      const position = openPositions.find((item) => item.direction === desiredDirection);
      const persistRescueOrder = ({ venueReport, orderDraft, recovered }) => this.persistStrategyAcceptedOrder({
        command,
        binding,
        strategy,
        account,
        orderDraft: { ...orderDraft, quantity: Number(position?.quantity || finalFill) },
        venueReport,
        estimatedMargin: 0,
        estimatedNotional: Number(position?.quantity || 0) * referencePrice,
        recovered,
        linkCommand: false
      });
      const failSafeContext = {
        command,
        fencingToken,
        connection,
        account,
        credentials,
        credentialEnvironment,
        marketKind,
        category,
        symbol,
        direction: desiredDirection,
        position,
        positionIdx: Number(position?.positionIdx ?? venueOrder?.positionIdx ?? recoveryPositionIdx(desiredDirection)),
        referencePrice,
        ownerUserId: command.user_id,
        strategyId: strategy.id,
        bindingId: binding.id,
        persistRescueOrder,
        authorize: async () => {
          await this.repository.requireAutomationMandate(connection.id, "strategy");
          if (!account.trading_enabled || account.is_read_only) throw terminalError("ACCOUNT_READ_ONLY", "The Bybit account is not trade enabled for a safety flatten.");
        }
      };
      if (!position) return this.ensureStrategyFailSafeFlatten({ ...failSafeContext, waitingForPositionOnly: true });
      const persistedPosition = persistedPositions.find((item) => Number(item.position_idx) === Number(position.positionIdx) && item.direction === position.direction);
      if (!persistedPosition) throw reconciliationError("STRATEGY_POSITION_OWNERSHIP_PENDING", "The entry is visible at Bybit but its immutable strategy ownership is still reconciling.", 2);
      if (persistedPosition.strategy_target_binding_id !== binding.id) throw terminalError("STRATEGY_POSITION_OWNERSHIP_REQUIRED", "Black Cloud refused to safety-flatten a Bybit position attributed to a different strategy target.");
      const resolvedTargets = configuredTargets.map((target) => ({
        ...target,
        price: resolveStrategyTakeProfitPrice({ ...target, direction: desiredDirection }, position)
      }));
      const protectionPlan = planStrategyTakeProfitProtection({
        entryQuantity: finalFill,
        remainingQuantity: finalFill,
        targets: resolvedTargets,
        venue: instrument
      });
      await this.recordStrategyProtectionDecision({ command, protectionPlan, terminalEntryQuantity: finalFill });
      if (protectionPlan.mode === "UNPROTECTABLE") {
        return this.ensureStrategyFailSafeFlatten({ ...failSafeContext, reasons: protectionPlan.reasons });
      }
      return { finalFill, protectionPlan };
    };
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
      if (options.requireTerminalEntryFill === true) await requireProtectedEntryFill(venueOrder);
      else if (isTerminalUnfilledVenueOrder(venueOrder) && options.allowTerminalUnfilled !== true) throw terminalError("STRATEGY_ORDER_UNFILLED", "Bybit terminated the recovered strategy order without a fill.");
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
        }, { requireTerminalEntryFill: true });
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
        }, { requireTerminalEntryFill: !isReduce && requestedAction === "ENTRY" });
      }
    }

    // Everything above this line is deterministic reconciliation only. Once no
    // matching venue order exists, every mutable authorization and risk gate is
    // re-evaluated before a new Bybit side effect may be created.
    if (marketKind === "spot" && ["ENTRY", "REVERSE"].includes(requestedAction)
      && reserveStrategyTakeProfits(payload.takeProfits).length) {
      throw terminalError("STRATEGY_SPOT_TP_PROTECTION_UNSUPPORTED", "Spot strategy entries with partial take-profit protection are blocked before submission until balance-owned protective execution is certified.");
    }
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
    let takeProfitProtectionMode = null;
    if (takeProfitOrder) {
      const parentEntryIdempotencyKey = String(payload.parentEntryIdempotencyKey || "");
      if (!parentEntryIdempotencyKey) throw terminalError("STRATEGY_TAKE_PROFIT_PARENT_REQUIRED", "A strategy target without an immutable parent entry is unsafe and cannot be submitted.");
      const parentCommand = await oneOrNull(this.supabase.from("execution_commands")
        .select("id,status,execution_order_id,payload,created_at")
        .eq("idempotency_key", parentEntryIdempotencyKey)
        .eq("strategy_target_binding_id", binding.id)
        .maybeSingle());
      if (parentCommand && ["FAILED", "REJECTED", "CANCELLED", "DEAD_LETTER"].includes(String(parentCommand.status || "").toUpperCase())) {
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
      const requestedTargetId = String(payload.targetId || "").toUpperCase();
      if (isAggregatedTargetSuppressed(parentCommand.payload?.takeProfitProtectionDecision, requestedTargetId)) {
        return { skipped: true, reason: "TP_LADDER_AGGREGATED_TO_TP1" };
      }
      const parentVenueOrder = await findBybitOrderByClientOrderId(credentials, { marketKind, symbol, clientOrderId: parentOrder.client_order_id });
      const originalEntryQuantity = settledStrategyEntryQuantity(parentVenueOrder);
      if (!originalEntryQuantity) {
        const parentStatus = String(parentVenueOrder?.status || "").toLowerCase();
        if (["cancelled", "canceled", "expired", "rejected", "failed"].includes(parentStatus)) return { skipped: true, reason: "PARENT_ENTRY_UNFILLED" };
        throw retryableError("STRATEGY_TAKE_PROFIT_WAITING_FOR_PARENT_FILL", "The parent IOC entry has not reached a final cumulative fill; target sizing will retry without using a reduced remainder.", 2);
      }
      const position = openPositions.find((item) => item.direction === desiredDirection);
      if (!position) throw reconciliationError("STRATEGY_TAKE_PROFIT_WAITING_FOR_POSITION", "The entry is not visible on Bybit yet; the reduce-only take-profit will retry after reconciliation.", 2);
      const persistedPosition = persistedPositions.find((item) => Number(item.position_idx) === Number(position.positionIdx) && item.direction === position.direction);
      if (!persistedPosition) throw reconciliationError("STRATEGY_POSITION_OWNERSHIP_PENDING", "The entry is visible at Bybit but its immutable strategy ownership is still reconciling.", 2);
      if (persistedPosition.strategy_target_binding_id !== binding.id) throw terminalError("STRATEGY_POSITION_OWNERSHIP_REQUIRED", "Black Cloud refused to protect a Bybit position attributed to a different strategy target.");
      const parentTargets = reserveStrategyTakeProfits(parentCommand.payload?.takeProfits).map((target) => ({
        ...target,
        price: resolveStrategyTakeProfitPrice({ ...target, direction: desiredDirection }, position)
      }));
      const protectionPlan = parentTargets.length
        ? planStrategyTakeProfitProtection({
          entryQuantity: originalEntryQuantity,
          remainingQuantity: originalEntryQuantity,
          targets: parentTargets,
          venue: instrument
        })
        : null;
      if (protectionPlan?.mode === "UNPROTECTABLE") {
        const persistRescueOrder = ({ venueReport, orderDraft, recovered }) => this.persistStrategyAcceptedOrder({
          command,
          binding,
          strategy,
          account,
          orderDraft: { ...orderDraft, quantity: Number(position.quantity || originalEntryQuantity) },
          venueReport,
          estimatedMargin: 0,
          estimatedNotional: Number(position.quantity) * referencePrice,
          recovered,
          linkCommand: false
        });
        return this.ensureStrategyFailSafeFlatten({
          command,
          fencingToken,
          connection,
          account,
          credentials,
          credentialEnvironment,
          marketKind,
          category,
          symbol,
          direction: desiredDirection,
          position,
          positionIdx: position.positionIdx,
          referencePrice,
          ownerUserId: command.user_id,
          orderUserId: command.user_id,
          strategyId: strategy.id,
          bindingId: binding.id,
          source,
          baseClientOrderId: strategyRootClientOrderId(parentOrder.client_order_id),
          persistRescueOrder,
          authorize: async () => {
            await this.repository.requireAutomationMandate(connection.id, "strategy");
            if (!account.trading_enabled || account.is_read_only) throw terminalError("ACCOUNT_READ_ONLY", "The Bybit account is not trade enabled for a safety flatten.");
          },
          reasons: protectionPlan.reasons
        });
      }
      if (protectionPlan?.mode === "AGGREGATED_TP1" && requestedTargetId !== protectionPlan.primaryTargetId) {
        return { skipped: true, reason: "TP_LADDER_AGGREGATED_TO_TP1" };
      }
      const effectiveTarget = protectionPlan?.mode === "AGGREGATED_TP1" ? protectionPlan.target : payload;
      takeProfitProtectionMode = protectionPlan?.mode || "LEGACY_SINGLE_TARGET";
      const percentage = protectionPlan?.mode === "AGGREGATED_TP1"
        ? 100
        : Math.max(0.1, Math.min(100, Number(payload.quantityPercent || 0)));
      side = position.direction === "long" ? "sell" : "buy";
      quantity = calculateStrategyTakeProfitQuantity(originalEntryQuantity, percentage, position.quantity);
      reduceOnly = true;
      positionIdx = position.positionIdx;
      takeProfitLimitPrice = resolveStrategyTakeProfitPrice(effectiveTarget, position);
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
      quantity = resolveBlackScriptCloseQuantity({ payload, positionQuantity: position.quantity });
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
      quantity = resolveBlackScriptEntryQuantity({
        payload,
        policy,
        preview,
        equity: wallet.accountMetrics.equityUsd,
        referencePrice,
      });
      const maxPositionNotional = preview.allocatedStrategyCapital * policy.maximumPositionPercent / 100 * effectiveLeverage;
      const maxExposureNotional = preview.allocatedStrategyCapital * policy.maximumExposurePercent / 100 * effectiveLeverage;
      const mandateCap = Number(automationMandate.max_order_notional || Number.POSITIVE_INFINITY);
      const accountCap = Number(riskControl?.max_position_usd || Number.POSITIVE_INFINITY);
      const availableNotional = binding.market_type === "SPOT"
        ? wallet.accountMetrics.availableBalanceUsd
        : wallet.accountMetrics.availableBalanceUsd * effectiveLeverage;
      estimatedNotional = Math.min(quantity * referencePrice, maxPositionNotional, maxExposureNotional, mandateCap, accountCap, availableNotional);
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
    if (takeProfitProtectionMode) orderDraft.takeProfitProtectionMode = takeProfitProtectionMode;
    if (!reduceOnly && orderDraft.orderType === "market" && Number(payload.slippageTicks) > 0) {
      orderDraft.slippageToleranceTicks = Math.max(1, Math.min(10_000, Math.floor(Number(payload.slippageTicks))));
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
      if (!orderDraft.reduceOnly && orderDraft.orderType === "market") await requireProtectedEntryFill(existingVenueOrder);
      else if (isTerminalUnfilledVenueOrder(existingVenueOrder)) throw terminalError("STRATEGY_ORDER_UNFILLED", "Bybit terminated the recovered strategy order without a fill.");
      if (reversingClose) throw retryableError("STRATEGY_REVERSE_WAITING_FOR_FLAT", "The close leg was acknowledged; waiting for Bybit to confirm the position is flat before entering the reverse leg.", 2);
      return persisted;
    }
    await this.blockAcknowledgedOrderResubmission({
      executionOrderId: command.execution_order_id,
      commandId: command.id,
      clientOrderId: orderDraft.clientOrderId,
      account,
      symbol,
      orderUserId: command.user_id,
      bindingId: binding.id
    });

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
        if (!orderDraft.reduceOnly && orderDraft.orderType === "market") await requireProtectedEntryFill(recovered);
        else if (isTerminalUnfilledVenueOrder(recovered)) throw terminalError("STRATEGY_ORDER_UNFILLED", "Bybit terminated the recovered strategy order without a fill.");
        if (reversingClose) throw retryableError("STRATEGY_REVERSE_WAITING_FOR_FLAT", "The close leg was recovered; waiting for Bybit to confirm the position is flat before entering the reverse leg.", 2);
        return persisted;
      }
      throw ambiguousError("Bybit submission timed out before acknowledgement. Reconciliation will query the deterministic client order ID.");
    }
    const persisted = await this.persistStrategyAcceptedOrder({ command, binding, strategy, account, orderDraft, venueReport, estimatedMargin, estimatedNotional, recovered: false });
    if (!orderDraft.reduceOnly && orderDraft.orderType === "market") await requireProtectedEntryFill(venueReport);
    else if (isTerminalUnfilledVenueOrder(venueReport)) throw terminalError("STRATEGY_ORDER_UNFILLED", "Bybit terminated the strategy order without a fill.");
    if (reversingClose) throw retryableError("STRATEGY_REVERSE_WAITING_FOR_FLAT", "The close leg was acknowledged; waiting for Bybit to confirm the position is flat before entering the reverse leg.", 2);
    return persisted;
  }

  async placeBlackScriptRestingOrder(command, fencingToken) {
    const requestedAction = String(command.payload?.action || "").toUpperCase();
    const entryIntent = requestedAction === "BLACK_SCRIPT_ENTRY";
    const exitIntent = requestedAction === "BLACK_SCRIPT_EXIT";
    if (!entryIntent && !exitIntent) throw terminalError("BLACK_SCRIPT_ORDER_ACTION_INVALID", "The Black Script order action is invalid.");
    const [binding, strategy, connection, capabilities] = await Promise.all([
      single(this.supabase.from("strategy_target_bindings").select("*").eq("id", command.strategy_target_binding_id)),
      single(this.supabase.from("strategy_automation_strategies").select("*").eq("id", command.strategy_automation_id)),
      single(this.supabase.from("connectivity_connections").select("*").eq("id", command.connection_id)),
      single(this.supabase.from("broker_connection_capabilities").select("*").eq("connection_id", command.connection_id)),
    ]);
    if (strategy.runtime_kind !== "python-script" || binding.strategy_id !== strategy.id || binding.connection_id !== connection.id
      || binding.owner_user_id !== command.user_id || !binding.account_id || connection.account_id !== binding.account_id) {
      throw terminalError("BLACK_SCRIPT_ORDER_OWNERSHIP_MISMATCH", "The Black Script order does not match its immutable strategy target authority.");
    }
    if (binding.target_type !== "BROKER_ACCOUNT" || connection.provider !== "bybit") throw terminalError("PROVIDER_UNSUPPORTED", "Pinned Black Script orders currently require a direct Bybit target.");
    if (binding.status !== "LIVE" || Number(binding.strategy_version) !== Number(strategy.running_version)) throw terminalError("STRATEGY_VERSION_NOT_RUNNING", "The Black Script target is not armed on this running version.");
    if (connection.control_state !== "ACTIVE" || connection.execution_readiness !== "READY") throw terminalError("CONNECTION_NOT_READY", "The Bybit connection is not ready for Black Script execution.");
    const orderType = String(command.payload.orderType || "").toLowerCase();
    if (orderType === "limit" && !capabilities.can_place_limit_orders) throw terminalError("BROKER_CAPABILITY_REJECTED", "The broker capability set does not permit limit orders.");
    if (["stop-market", "stop-limit"].includes(orderType) && !capabilities.can_place_stop_orders) throw terminalError("BROKER_CAPABILITY_REJECTED", "The broker capability set does not permit stop orders.");
    if (orderType === "market" && !capabilities.can_place_market_orders) throw terminalError("BROKER_CAPABILITY_REJECTED", "The broker capability set does not permit market orders.");
    const [account, secretReference, riskControl, latestSnapshot] = await Promise.all([
      single(this.supabase.from("exchange_accounts").select("*").eq("id", binding.account_id)),
      single(this.supabase.from("broker_secret_references").select("id,status").eq("connection_id", connection.id).eq("status", "ACTIVE")),
      oneOrNull(this.supabase.from("account_risk_controls").select("*").eq("account_id", binding.account_id).maybeSingle()),
      oneOrNull(this.supabase.from("strategy_target_snapshots").select("snapshot").eq("binding_id", binding.id).maybeSingle()),
    ]);
    const mandate = await this.repository.requireAutomationMandate(connection.id, "strategy");
    if (!account.trading_enabled || account.is_read_only) throw terminalError("ACCOUNT_READ_ONLY", "The Bybit account is not trade enabled.");
    if (riskControl?.emergency_stop) throw terminalError("ACCOUNT_EMERGENCY_STOP", "The account emergency stop is active.");
    const credentials = await this.repository.readBrokerSecret(secretReference.id, entryIntent ? "black_script_entry_order" : "black_script_exit_order");
    const executionEnvironment = assertWorkerEnvironment(connection, credentials);
    const environmentEnabled = executionEnvironment === "DEMO"
      ? process.env.STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED === "true"
      : process.env.STRATEGY_AUTOMATION_LIVE_EXECUTION_ENABLED === "true" && process.env.STRATEGY_AUTOMATION_LIVE_EXECUTION_CERTIFIED === "true";
    if (!environmentEnabled || process.env.BLACK_CLOUD_GLOBAL_EXECUTION_KILL_SWITCH === "true") throw terminalError("STRATEGY_ENVIRONMENT_DISABLED", `Black Script execution is disabled for ${executionEnvironment}.`);
    const symbol = String(command.payload.symbol || strategy.symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (symbol !== String(strategy.symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase()) throw terminalError("STRATEGY_SYMBOL_MISMATCH", "The Black Script order symbol does not match its strategy.");
    const marketKind = binding.market_type === "SPOT" ? "spot" : "perpetual";
    const category = marketKind === "spot" ? "spot" : "linear";
    const [wallet, metadataRows, ticker, venuePositions] = await Promise.all([
      getBybitWalletSnapshot(credentials),
      getBybitInstrumentMetadata({ category, symbol, executionEnvironment, endpointProfile: credentials.endpointProfile }),
      getBybitTicker({ category, symbol, executionEnvironment, endpointProfile: credentials.endpointProfile }),
      marketKind === "spot" ? Promise.resolve([]) : getBybitPositions(credentials, { category, symbol, includeEmpty: true }),
    ]);
    const instrument = metadataRows[0];
    if (!instrument || String(instrument.tradingStatus).toLowerCase() !== "trading") throw terminalError("MARKET_UNAVAILABLE", `${symbol} is not currently tradable.`);
    const referencePrice = Number(ticker.markPrice || ticker.lastPrice);
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) throw terminalError("REFERENCE_PRICE_REQUIRED", "A current Bybit price is required.");
    const openPositions = venuePositions.filter((position) => Number(position.quantity) > 0 && position.direction !== "flat");
    const direction = String(command.payload.direction || "").toLowerCase();
    if (!["long", "short"].includes(direction)) throw terminalError("BLACK_SCRIPT_DIRECTION_INVALID", "The Black Script order direction is invalid.");
    const hedgeMode = venuePositions.some((item) => item.positionIdx === 1 || item.positionIdx === 2);
    const positionIdxFor = (sideDirection) => hedgeMode ? (sideDirection === "long" ? 1 : 2) : 0;
    const policy = normalizeCapitalPolicy(policyFromStrategyBinding(binding), binding.market_type, { allowZeroAllocation: false });
    const leverageCaps = { targetMaximum: policy.maximumLeverage, accountRiskCap: riskControl?.max_leverage, emsRiskCap: mandate.max_leverage, providerCap: instrument.leverageLimits?.max };
    const effectiveLeverage = binding.market_type === "SPOT" ? 1 : calculateEffectiveLeverage({
      requested: nullablePositive(command.payload.requestedLeverage) || (direction === "long" ? policy.requestedLongLeverage : policy.requestedShortLeverage) || policy.requestedLeverage,
      ...leverageCaps,
    });
    let quantity;
    let estimatedNotional;
    let estimatedMargin;
    let side;
    let positionIdx;
    if (entryIntent) {
      if (openPositions.length) return { skipped: true, reason: "VENUE_POSITION_ALREADY_OPEN" };
      const drawdown = Number(latestSnapshot?.snapshot?.currentDrawdownPercent || 0);
      if (policy.maximumDrawdown > 0 && drawdown >= policy.maximumDrawdown) throw terminalError("STRATEGY_MAX_DRAWDOWN", "The strategy target reached its maximum drawdown.");
      const preview = calculateCapitalPreview({ equity: wallet.accountMetrics.equityUsd, availableBalance: wallet.accountMetrics.availableBalanceUsd, policy: { ...policy, requestedLeverage: effectiveLeverage }, marketType: binding.market_type, caps: leverageCaps });
      const policyQuantity = policy.tradeAmountMode === "FIXED_QUANTITY" ? policy.tradeAmountValue : preview.estimatedNotional / referencePrice;
      const explicitQuantity = nullablePositive(command.payload.quantity);
      const explicitPercent = nullablePositive(command.payload.quantityPercent);
      const requestedQuantity = explicitQuantity || (explicitPercent ? wallet.accountMetrics.equityUsd * explicitPercent / 100 / referencePrice : policyQuantity);
      const maxPositionNotional = preview.allocatedStrategyCapital * policy.maximumPositionPercent / 100 * effectiveLeverage;
      const maxExposureNotional = preview.allocatedStrategyCapital * policy.maximumExposurePercent / 100 * effectiveLeverage;
      estimatedNotional = Math.min(requestedQuantity * referencePrice, maxPositionNotional, maxExposureNotional, Number(mandate.max_order_notional || Number.POSITIVE_INFINITY), Number(riskControl?.max_position_usd || Number.POSITIVE_INFINITY));
      quantity = estimatedNotional / referencePrice;
      estimatedMargin = binding.market_type === "SPOT" ? estimatedNotional : estimatedNotional / effectiveLeverage;
      side = direction === "short" ? "sell" : "buy";
      positionIdx = positionIdxFor(direction);
    } else {
      const position = openPositions.find((item) => item.direction === direction);
      if (!position) return { skipped: true, reason: "POSITION_ALREADY_FLAT" };
      const persisted = await oneOrNull(this.supabase.from("account_positions")
        .select("strategy_target_binding_id,position_idx,direction,quantity")
        .eq("account_id", account.id).eq("symbol", symbol).eq("position_idx", position.positionIdx).maybeSingle());
      if (!persisted || persisted.strategy_target_binding_id !== binding.id || persisted.direction !== direction) throw retryableError("STRATEGY_POSITION_OWNERSHIP_PENDING", "The exact strategy-owned position must reconcile before an exit order can be placed.", 2);
      const expectedEntrySide = direction === "long" ? "buy" : "sell";
      const latestEntries = await rows(this.supabase.from("execution_orders")
        .select("id,filled_quantity,quantity,status")
        .eq("account_id", account.id).eq("strategy_target_binding_id", binding.id).eq("symbol", symbol)
        .eq("side", expectedEntrySide).eq("reduce_only", false).order("created_at", { ascending: false }).limit(20));
      const latestEntry = latestEntries.find(isPotentialPositionGeneration);
      if (!latestEntry) throw retryableError("BLACK_SCRIPT_PARENT_ENTRY_PENDING", "The matching strategy entry generation has not reconciled yet.", 2);
      const originalQuantity = nullablePositive(latestEntry.filled_quantity) || nullablePositive(latestEntry.quantity) || Number(position.quantity);
      const explicitQuantity = nullablePositive(command.payload.quantity);
      const percentage = nullablePositive(command.payload.quantityPercent);
      quantity = Math.min(Number(position.quantity), explicitQuantity || (percentage ? originalQuantity * percentage / 100 : Number(position.quantity)));
      estimatedNotional = quantity * referencePrice;
      estimatedMargin = 0;
      side = direction === "long" ? "sell" : "buy";
      positionIdx = position.positionIdx;
    }
    quantity = floorStrategyVenueQuantity(quantity, instrument);
    if (!Number.isFinite(quantity) || quantity <= 0) throw terminalError("STRATEGY_QUANTITY_BELOW_VENUE_STEP", "The Black Script order quantity is zero after applying the Bybit step size.");
    const stopPrice = nullablePositive(command.payload.stopPrice);
    const limitPrice = nullablePositive(command.payload.limitPrice);
    if (["stop-market", "stop-limit"].includes(orderType) && !stopPrice) throw terminalError("BLACK_SCRIPT_STOP_PRICE_REQUIRED", "A conditional Black Script order requires a stop price.");
    if (["limit", "stop-limit"].includes(orderType) && !limitPrice) throw terminalError("BLACK_SCRIPT_LIMIT_PRICE_REQUIRED", "A Black Script limit order requires a limit price.");
    const normalizedOrderType = ["limit", "stop-limit"].includes(orderType) ? "limit" : orderType === "market" ? "market" : "stop-market";
    const orderDraft = {
      accountId: account.id,
      symbol,
      marketKind,
      side,
      orderType: normalizedOrderType,
      quantity,
      quantityMode: "quantity",
      referencePrice,
      limitPrice: limitPrice || undefined,
      stopPrice: stopPrice || undefined,
      leverage: effectiveLeverage,
      marginMode: String(policy.marginMode || "CROSS").toLowerCase(),
      reduceOnly: exitIntent,
      positionIdx,
      timeInForce: normalizedOrderType === "market" ? "ioc" : "gtc",
      clientOrderId: command.deterministic_client_order_id,
      source: executionEnvironment === "DEMO" ? "strategy-automation-demo" : "strategy-automation-mainnet",
    };
    const validation = await validateBybitOrderDraft(credentials, orderDraft);
    if (!validation.ok) throw terminalError("VENUE_VALIDATION_REJECTED", validation.reasons.join(" "));
    orderDraft.quantity = validation.normalized.quantity;
    const existingVenueOrder = await findBybitOrderByClientOrderId(credentials, { marketKind, symbol, clientOrderId: orderDraft.clientOrderId });
    if (existingVenueOrder) {
      assertRecoveredVenueOrderShape(existingVenueOrder, { category, symbol, side, reduceOnly: exitIntent, positionIdx, orderType: normalizedOrderType === "stop-market" ? "market" : normalizedOrderType });
      return this.persistStrategyAcceptedOrder({ command, binding, strategy, account, orderDraft, venueReport: existingVenueOrder, estimatedMargin, estimatedNotional, recovered: true });
    }
    await this.blockAcknowledgedOrderResubmission({ executionOrderId: command.execution_order_id, commandId: command.id, clientOrderId: orderDraft.clientOrderId, account, symbol, orderUserId: command.user_id, bindingId: binding.id });
    await this.repository.assertFencingToken(connection.id, fencingToken);
    this.assertSubmissionClockSafe();
    const adapter = createCloudExchangeAdapter("bybit", { credentials, executionEnvironment, endpointProfile: credentials.endpointProfile || connection.endpoint_profile || "GLOBAL", connectionId: connection.id });
    if (entryIntent && binding.market_type !== "SPOT") {
      const longLeverage = calculateEffectiveLeverage({ requested: policy.requestedLongLeverage || policy.requestedLeverage, ...leverageCaps });
      const shortLeverage = calculateEffectiveLeverage({ requested: policy.requestedShortLeverage || policy.requestedLeverage, ...leverageCaps });
      await adapter.configureLeverage(hedgeMode ? { category, symbol, buyLeverage: longLeverage, sellLeverage: shortLeverage } : { category, symbol, leverage: effectiveLeverage });
    }
    const venueReport = await adapter.placeOrder(orderDraft, validation);
    return this.persistStrategyAcceptedOrder({ command, binding, strategy, account, orderDraft, venueReport, estimatedMargin, estimatedNotional, recovered: false });
  }

  async blockAcknowledgedOrderResubmission({ executionOrderId, followerPlanExecutionOrderId = null, commandId = null, followerPlanId = null, clientOrderId, account, symbol, orderUserId, bindingId = null, groupIntentId = null, mandateId = null }) {
    const candidateOrder = await oneOrNull(this.supabase.from("execution_orders")
      .select("id,user_id,account_id,client_order_id,symbol,strategy_target_binding_id,group_intent_id,mandate_id")
      .eq("user_id", orderUserId)
      .eq("account_id", account.id)
      .eq("client_order_id", clientOrderId)
      .maybeSingle());
    if (candidateOrder) {
      assertAcknowledgedOrderOwnership(candidateOrder, { account, symbol, orderUserId, bindingId, groupIntentId, mandateId });
      if (commandId && executionOrderId !== candidateOrder.id) {
        let commandLinkUpdate = this.supabase.from("execution_commands").update({ execution_order_id: candidateOrder.id }).eq("id", commandId);
        commandLinkUpdate = executionOrderId ? commandLinkUpdate.eq("execution_order_id", executionOrderId) : commandLinkUpdate.is("execution_order_id", null);
        await updateOrThrow(commandLinkUpdate);
        const repairedCommand = await oneOrNull(this.supabase.from("execution_commands").select("execution_order_id").eq("id", commandId).maybeSingle());
        if (repairedCommand?.execution_order_id !== candidateOrder.id) {
          throw reconciliationError("STRATEGY_ACKNOWLEDGED_ORDER_COMMAND_LINK_REPAIR_PENDING", "The durable order acknowledgement exists, but the command link changed concurrently. Black Cloud will reconcile the immutable link without resubmitting.", 2);
        }
      }
      if (followerPlanId && followerPlanExecutionOrderId !== candidateOrder.id) {
        let planLinkUpdate = this.supabase.from("follower_execution_plans").update({ execution_order_id: candidateOrder.id }).eq("id", followerPlanId);
        planLinkUpdate = followerPlanExecutionOrderId ? planLinkUpdate.eq("execution_order_id", followerPlanExecutionOrderId) : planLinkUpdate.is("execution_order_id", null);
        await updateOrThrow(planLinkUpdate);
        const repairedPlan = await oneOrNull(this.supabase.from("follower_execution_plans").select("execution_order_id").eq("id", followerPlanId).maybeSingle());
        if (repairedPlan?.execution_order_id !== candidateOrder.id) {
          throw reconciliationError("STRATEGY_ACKNOWLEDGED_ORDER_PLAN_LINK_REPAIR_PENDING", "The durable follower entry acknowledgement exists, but its plan link changed concurrently. Black Cloud will reconcile the immutable link without resubmitting.", 2);
        }
      }
      throw reconciliationError("STRATEGY_ACKNOWLEDGED_ORDER_RECONCILING", "Black Cloud found a durable OMS acknowledgement for the deterministic order identity while the temporary Bybit lookup returned no order. Resubmission is blocked and any missing parent link was restored.", 2);
    }
    const linkedOrderId = executionOrderId || followerPlanExecutionOrderId;
    if (!linkedOrderId) return;
    const linkedOrder = await oneOrNull(this.supabase.from("execution_orders")
      .select("id,user_id,account_id,client_order_id,symbol,strategy_target_binding_id,group_intent_id,mandate_id")
      .eq("id", linkedOrderId)
      .maybeSingle());
    if (!linkedOrder) {
      throw reconciliationError("STRATEGY_ACKNOWLEDGED_ORDER_LINK_MISSING", "A durable order acknowledgement link exists, but its OMS order row is unavailable. Black Cloud will reconcile without resubmitting.", 2);
    }
    if (String(linkedOrder.client_order_id || "") !== String(clientOrderId || "")) return;
    assertAcknowledgedOrderOwnership(linkedOrder, { account, symbol, orderUserId, bindingId, groupIntentId, mandateId });
    throw reconciliationError("STRATEGY_ACKNOWLEDGED_ORDER_RECONCILING", "The venue lookup temporarily returned no order after Black Cloud durably recorded its acknowledgement. Resubmission is blocked while deterministic reconciliation continues.", 2);
  }

  async recordStrategyProtectionDecision({ command, plan = null, protectionPlan, terminalEntryQuantity }) {
    const decision = {
      mode: protectionPlan?.mode || "NONE",
      primaryTargetId: protectionPlan?.primaryTargetId || null,
      terminalEntryQuantity: Number(terminalEntryQuantity || 0),
      basis: "TERMINAL_ENTRY_FILL"
    };
    if (plan?.id) {
      const current = await oneOrNull(this.supabase.from("follower_execution_plans").select("safe_result").eq("id", plan.id).maybeSingle());
      await updateOrThrow(this.supabase.from("follower_execution_plans").update({
        safe_result: { ...(current?.safe_result || {}), takeProfitProtectionDecision: decision }
      }).eq("id", plan.id));
      return decision;
    }
    await updateOrThrow(this.supabase.from("execution_commands").update({
      payload: { ...(command.payload || {}), takeProfitProtectionDecision: decision }
    }).eq("id", command.id));
    return decision;
  }

  async ensureStrategyFailSafeFlatten({
    command,
    fencingToken,
    connection,
    account,
    credentials,
    credentialEnvironment,
    marketKind,
    category,
    symbol,
    direction,
    position,
    positionIdx,
    referencePrice,
    ownerUserId,
    orderUserId = ownerUserId,
    strategyId,
    bindingId,
    source = "strategy-automation-mainnet",
    baseClientOrderId = command.deterministic_client_order_id,
    persistRescueOrder,
    authorize,
    reasons = [],
    waitingForPositionOnly = false,
    triggerCode = "STRATEGY_PARTIAL_FILL_UNPROTECTABLE",
    flatIsSafe = false
  }) {
    if (marketKind === "spot") throw terminalError("STRATEGY_FAIL_SAFE_FLATTEN_UNSUPPORTED", "The certified zero-quantity close-all contract is available only for Bybit derivatives positions.");
    const positionOpen = Boolean(position && Number(position.quantity) > 0);
    let terminalRescueSeen = false;
    for (let legNumber = 1; legNumber <= MAX_STRATEGY_REVERSAL_CLOSE_LEGS; legNumber += 1) {
      const leg = legNumber === 1 ? "f" : `f${legNumber}`;
      const clientOrderId = deterministicStrategyLegId(baseClientOrderId, leg);
      const expected = {
        category,
        symbol,
        side: direction === "long" ? "sell" : "buy",
        reduceOnly: true,
        closeOnTrigger: true,
        positionIdx: Number(positionIdx),
        orderType: "market"
      };
      const orderDraft = {
        accountId: account.id,
        symbol,
        marketKind,
        side: expected.side,
        orderType: "market",
        quantity: 0,
        quantityMode: "quantity",
        referencePrice,
        leverage: 1,
        marginMode: "cross",
        reduceOnly: true,
        closeOnTrigger: true,
        positionIdx: expected.positionIdx,
        timeInForce: "ioc",
        clientOrderId,
        source,
        failSafeFlatten: true
      };
      const recovered = await findBybitOrderByClientOrderId(credentials, { marketKind, symbol, clientOrderId }).catch((error) => {
        throw reconciliationError("STRATEGY_FAIL_SAFE_FLATTEN_LOOKUP_RETRY", sanitizeError(error?.message || "The safety-flatten order lookup failed temporarily."), 2);
      });
      if (recovered) {
        try {
          assertRecoveredVenueOrderShape(recovered, expected);
        } catch (error) {
          throw reconciliationError("STRATEGY_FAIL_SAFE_FLATTEN_ORDER_MISMATCH", sanitizeError(error?.message || error), 30);
        }
        const persisted = await persistRescueOrder({ venueReport: recovered, orderDraft, recovered: true });
        if (persisted.created) await this.emitStrategyFailSafeAudit({
          ownerUserId, strategyId, bindingId, commandId: command.id, symbol, direction, clientOrderId,
          eventType: "STRATEGY_FAIL_SAFE_FLATTEN_SUBMITTED", severity: "CRITICAL",
          message: "Protective target coverage could not be established for an owned strategy position; Black Cloud submitted a deterministic reduce-only close-all safety order.",
          metadata: { leg, recovered: true, reasonCount: reasons.length, executionEnvironment: credentialEnvironment, triggerCode }
        });
        if (!isTerminalVenueOrder(recovered)) {
          throw reconciliationError("STRATEGY_FAIL_SAFE_FLATTEN_RECONCILING", "The deterministic reduce-only safety flatten is acknowledged and still settling; the parent entry remains non-terminal.", 2);
        }
        terminalRescueSeen = true;
        if (!positionOpen) {
          await this.emitStrategyFailSafeAudit({
            ownerUserId, strategyId, bindingId, commandId: command.id, symbol, direction, clientOrderId,
            eventType: "STRATEGY_FAIL_SAFE_FLATTEN_CONFIRMED", severity: "ERROR",
            message: "Bybit confirmed the deterministic safety-flatten order and the owned strategy position is flat. The affected protection command can now terminalize safely.",
            metadata: { leg, executionEnvironment: credentialEnvironment, triggerCode }
          });
          const completionCode = triggerCode === "STRATEGY_PARTIAL_FILL_UNPROTECTABLE"
            ? "STRATEGY_ENTRY_FAIL_SAFE_FLATTENED"
            : "STRATEGY_TP_PROTECTION_FAIL_SAFE_FLATTENED";
          throw terminalError(completionCode, "Protective target coverage could not be established, so Black Cloud closed the owned position and confirmed it flat before terminalizing the affected command.");
        }
        if (!isTerminalInternalOrderStatus(persisted.priorStatus)) {
          throw reconciliationError("STRATEGY_FAIL_SAFE_FLATTEN_REFRESHING_POSITION", "A terminal safety-flatten order was newly reconciled. Black Cloud will fetch a fresh Bybit position snapshot before deciding whether a residual close-all leg is required.", 2);
        }
        continue;
      }

      const localOrder = await oneOrNull(this.supabase.from("execution_orders")
        .select("id,user_id,account_id,client_order_id,symbol,strategy_target_binding_id")
        .eq("user_id", orderUserId)
        .eq("account_id", account.id)
        .eq("client_order_id", clientOrderId)
        .maybeSingle());
      if (localOrder) {
        if (String(localOrder.symbol || "").toUpperCase() !== String(symbol).toUpperCase()
          || localOrder.strategy_target_binding_id !== bindingId) {
          throw terminalError("STRATEGY_FAIL_SAFE_FLATTEN_OWNERSHIP_MISMATCH", "The deterministic safety-flatten order identity belongs to another symbol or strategy target.");
        }
        throw reconciliationError("STRATEGY_FAIL_SAFE_FLATTEN_ACKNOWLEDGED_RECONCILING", "Black Cloud has a durable safety-flatten acknowledgement but the temporary Bybit lookup returned no order. Resubmission is blocked.", 2);
      }
      if (!positionOpen) {
        if (flatIsSafe) {
          await this.emitStrategyFailSafeAudit({
            ownerUserId, strategyId, bindingId, commandId: command.id, symbol, direction, clientOrderId,
            eventType: "STRATEGY_TP_PROTECTION_POSITION_FLAT", severity: "ERROR",
            message: "Bybit reports the affected owned strategy position flat; no additional safety-close submission is required.",
            metadata: { leg, executionEnvironment: credentialEnvironment, triggerCode }
          });
          throw terminalError("STRATEGY_TP_PROTECTION_POSITION_FLAT", "The affected strategy position is flat, so the failed protection command can terminalize without another broker side effect.");
        }
        throw reconciliationError("STRATEGY_ENTRY_WAITING_FOR_POSITION", terminalRescueSeen
          ? "A terminal safety-flatten order was observed; waiting for a fresh Bybit position snapshot to confirm flat."
          : "The terminal IOC fill is confirmed; waiting for its Bybit position before certifying TP protection or initiating the safety flatten.", 2);
      }
      if (waitingForPositionOnly && !terminalRescueSeen) {
        throw reconciliationError("STRATEGY_ENTRY_WAITING_FOR_POSITION", "The terminal IOC fill is confirmed; waiting for its Bybit position before certifying TP protection.", 2);
      }
      try {
        await authorize();
        await this.repository.assertFencingToken(connection.id, fencingToken);
        this.assertSubmissionClockSafe();
      } catch (error) {
        if (error?.reconciling === true) throw error;
        throw reconciliationError("STRATEGY_FAIL_SAFE_FLATTEN_CONTROL_BLOCKED", sanitizeError(error?.message || error), 30);
      }
      const validation = await validateBybitOrderDraft(credentials, orderDraft);
      if (!validation.ok) throw reconciliationError("STRATEGY_FAIL_SAFE_FLATTEN_VALIDATION_REJECTED", validation.reasons.join(" "), 30);
      const adapter = createCloudExchangeAdapter(connection.provider, {
        credentials,
        executionEnvironment: credentialEnvironment,
        endpointProfile: credentials.endpointProfile || connection.endpoint_profile || "GLOBAL",
        connectionId: connection.id
      });
      let venueReport;
      let recoveredAfterAmbiguous = false;
      try {
        venueReport = await adapter.placeOrder(orderDraft, validation);
        this.metricsCounters.ordersSubmitted += 1;
      } catch (error) {
        if (!isAmbiguousTransportError(error)) {
          throw reconciliationError("STRATEGY_FAIL_SAFE_FLATTEN_VENUE_REJECTED", sanitizeError(error?.message || error), 30);
        }
        venueReport = await findBybitOrderByClientOrderId(credentials, { marketKind, symbol, clientOrderId }).catch(() => null);
        if (!venueReport) throw ambiguousError("The safety-flatten submission timed out before acknowledgement. Reconciliation will query its deterministic client order ID without resubmitting an acknowledged order.");
        recoveredAfterAmbiguous = true;
        try {
          assertRecoveredVenueOrderShape(venueReport, expected);
        } catch (error) {
          throw reconciliationError("STRATEGY_FAIL_SAFE_FLATTEN_ORDER_MISMATCH", sanitizeError(error?.message || error), 30);
        }
      }
      const persisted = await persistRescueOrder({ venueReport, orderDraft, recovered: recoveredAfterAmbiguous });
      if (persisted.created) await this.emitStrategyFailSafeAudit({
        ownerUserId, strategyId, bindingId, commandId: command.id, symbol, direction, clientOrderId,
        eventType: "STRATEGY_FAIL_SAFE_FLATTEN_SUBMITTED", severity: "CRITICAL",
        message: "Protective target coverage could not be established for an owned strategy position; Black Cloud submitted a deterministic reduce-only close-all safety order.",
        metadata: { leg, recovered: recoveredAfterAmbiguous, reasonCount: reasons.length, executionEnvironment: credentialEnvironment, triggerCode }
      });
      throw reconciliationError("STRATEGY_FAIL_SAFE_FLATTEN_RECONCILING", "The deterministic reduce-only safety flatten was acknowledged; the parent entry remains non-terminal until a fresh Bybit position snapshot confirms flat.", 2);
    }
    throw reconciliationError("STRATEGY_FAIL_SAFE_FLATTEN_RESIDUAL", "Four deterministic close-all safety legs completed but Bybit still reports owned residual exposure. The parent entry remains reconciling and requires an operator incident review.", 30);
  }

  async emitStrategyFailSafeAudit({ ownerUserId, strategyId, bindingId, commandId, symbol, direction, clientOrderId, eventType, severity, message, metadata = {} }) {
    const { error } = await this.supabase.from("strategy_automation_audit_events").insert({
      owner_user_id: ownerUserId,
      strategy_id: strategyId,
      binding_id: bindingId,
      event_type: eventType,
      severity,
      message,
      safe_metadata: { commandId, symbol, direction, clientOrderId, ...metadata }
    });
    if (error) throw error;
  }

  async persistStrategyAcceptedOrder({ command, binding, strategy, account, orderDraft, venueReport, estimatedMargin, estimatedNotional, recovered, linkCommand = true }) {
    const venueOrderId = venueReport.exchangeOrderId || venueReport.orderId;
    const simulatedFunds = orderDraft.source === "strategy-automation-demo";
    const { data: existing, error: existingError } = await this.supabase.from("execution_orders").select("id,status").eq("user_id", command.user_id).eq("account_id", account.id).eq("client_order_id", orderDraft.clientOrderId).maybeSingle();
    if (existingError) throw existingError;
    let orderId = existing?.id;
    let created = false;
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
        stop_price: orderDraft.stopPrice || null,
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
      created = true;
      if (orderDraft.takeProfitProtectionMode === "AGGREGATED_TP1") {
        const { error: warningError } = await this.supabase.from("strategy_automation_audit_events").insert({
          owner_user_id: command.user_id,
          strategy_id: strategy.id,
          binding_id: binding.id,
          event_type: "STRATEGY_TP_LADDER_AGGREGATED",
          severity: "WARNING",
          message: "The terminal IOC fill was too small for every independent TP leg; Black Cloud protected the full owned remainder with aggregate TP1.",
          safe_metadata: { commandId: command.id, symbol: orderDraft.symbol, protectionMode: "AGGREGATED_TP1", simulatedFunds }
        });
        if (warningError) throw warningError;
      }
    }
    await this.repository.applyExecutionOrderState({
      orderId,
      accountId: account.id,
      status: venueReport.status,
      cumulativeFilledQuantity: venueReport.filledQuantity ?? venueReport.filled_quantity ?? 0,
      exchangeOrderId: venueOrderId,
      averageFillPrice: venueReport.averageFillPrice ?? venueReport.average_fill_price,
      rejectionReason: venueReport.rejectReason ?? venueReport.rejection_reason,
      venueUpdatedAt: venueReport.updatedTime ?? venueReport.updatedAt ?? venueReport.rawVersion ?? 0
    });
    if (linkCommand) await updateOrThrow(this.supabase.from("execution_commands").update({ execution_order_id: orderId }).eq("id", command.id));
    await this.repository.audit({
      userId: command.user_id,
      connectionId: command.connection_id,
      commandId: command.id,
      eventType: recovered ? "STRATEGY_ORDER_RECONCILED" : "STRATEGY_ORDER_ACKNOWLEDGED",
      purpose: simulatedFunds ? "strategy_demo_order_execution" : "strategy_mainnet_order_execution",
      message: recovered ? "An existing Bybit strategy order was adopted by deterministic client order ID." : "A Bybit strategy order was acknowledged.",
      metadata: { strategyId: strategy.id, bindingId: binding.id, symbol: orderDraft.symbol, reduceOnly: orderDraft.reduceOnly, simulatedFunds, venueOrderId, takeProfitProtectionMode: orderDraft.takeProfitProtectionMode || null }
    });
    this.metricsCounters.ordersConfirmed += 1;
    return { venueOrderId, orderId, recovered, created, priorStatus: existing?.status || null, simulatedFunds, takeProfitProtectionMode: orderDraft.takeProfitProtectionMode || null };
  }

  async adoptVenueOrder({ command, plan, intent, account, allocation, existingVenueOrder, clientOrderId, linkPlan = true }) {
    const venueReport = {
      exchangeOrderId: existingVenueOrder.exchangeOrderId || existingVenueOrder.orderId,
      clientOrderId: existingVenueOrder.clientOrderId,
      status: existingVenueOrder.status,
      filledQuantity: Number(existingVenueOrder.filledQuantity || 0),
      averageFillPrice: existingVenueOrder.averageFillPrice,
      rejectReason: existingVenueOrder.rejectReason,
      updatedTime: existingVenueOrder.updatedTime ?? existingVenueOrder.updatedAt ?? existingVenueOrder.rawVersion,
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
    return this.persistAcceptedOrder({ command, plan, intent, account, allocation, venueReport, clientOrderId, linkPlan });
  }

  async persistAcceptedOrder({ command, plan, intent, account, allocation, venueReport, clientOrderId, linkPlan = true }) {
    const actualClientOrderId = clientOrderId || venueReport.clientOrderId || command.deterministic_client_order_id;
    const { data: existing, error: existingError } = await this.supabase.from("execution_orders").select("id,status").eq("user_id", plan.follower_user_id).eq("account_id", account.id).eq("client_order_id", actualClientOrderId).maybeSingle();
    if (existingError) throw existingError;
    let orderId = existing?.id;
    let created = false;
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
      created = true;
      if (intent.strategy_execution_policy?.takeProfitProtectionMode === "AGGREGATED_TP1" && intent.strategy_target_binding_id) {
        const { error: warningError } = await this.supabase.from("strategy_automation_audit_events").insert({
          owner_user_id: intent.created_by,
          strategy_id: intent.strategy_automation_id,
          binding_id: intent.strategy_target_binding_id,
          event_type: "STRATEGY_TP_LADDER_AGGREGATED",
          severity: "WARNING",
          message: "The terminal follower IOC fill was too small for every independent TP leg; Black Cloud protected the full owned remainder with aggregate TP1.",
          safe_metadata: { commandId: command.id, groupIntentId: intent.id, followerPlanId: plan.id, symbol: intent.symbol, protectionMode: "AGGREGATED_TP1" }
        });
        if (warningError) throw warningError;
      }
    }
    await this.repository.applyExecutionOrderState({
      orderId,
      accountId: account.id,
      status: venueReport.status,
      cumulativeFilledQuantity: venueReport.filledQuantity ?? venueReport.filled_quantity ?? 0,
      exchangeOrderId: venueReport.exchangeOrderId || venueReport.orderId,
      averageFillPrice: venueReport.averageFillPrice ?? venueReport.average_fill_price,
      rejectionReason: venueReport.rejectReason ?? venueReport.rejection_reason,
      venueUpdatedAt: venueReport.updatedTime ?? venueReport.updatedAt ?? venueReport.rawVersion ?? 0,
      followerPlanId: linkPlan ? plan.id : null
    });
    if (linkPlan) {
      await updateOrThrow(this.supabase.from("follower_execution_plans").update({
        safe_result: {
          venueOrderId: venueReport.exchangeOrderId,
          clientOrderId: actualClientOrderId,
          takeProfitProtectionMode: intent.strategy_execution_policy?.takeProfitProtectionMode || null
        }
      }).eq("id", plan.id).eq("execution_order_id", orderId));
      await updateOrThrow(this.supabase.from("execution_commands").update({ execution_order_id: orderId }).eq("id", command.id));
    }
    await this.repository.audit({
      userId: plan.follower_user_id,
      connectionId: plan.broker_connection_id,
      groupIntentId: intent.id,
      followerPlanId: plan.id,
      commandId: command.id,
      eventType: "VENUE_ACKNOWLEDGED",
      message: "Investment Group order was acknowledged by Bybit while under Black Cloud control.",
      metadata: { venueOrderId: venueReport.exchangeOrderId, orderId, takeProfitProtectionMode: intent.strategy_execution_policy?.takeProfitProtectionMode || null }
    });
    this.metricsCounters.ordersConfirmed += 1;
    return { venueOrderId: venueReport.exchangeOrderId, orderId, recovered: Boolean(venueReport.recoveredByReconciliation), created, priorStatus: existing?.status || null, takeProfitProtectionMode: intent.strategy_execution_policy?.takeProfitProtectionMode || null };
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

  async resolveBlackScriptOrderMutation(command, operation) {
    const expectedAction = operation === "modify" ? "BLACK_SCRIPT_ORDER_MODIFY" : "BLACK_SCRIPT_ORDER_CANCEL";
    if (String(command.payload?.strategyAction || "").toUpperCase() !== expectedAction) {
      throw terminalError("BLACK_SCRIPT_ORDER_MUTATION_INVALID", `The Black Script ${operation} command is invalid.`);
    }
    const parentPlaceIdempotencyKey = String(command.payload?.parentPlaceIdempotencyKey || "");
    if (!/^[0-9a-f]{64}$/.test(parentPlaceIdempotencyKey)) {
      throw terminalError("BLACK_SCRIPT_PARENT_ORDER_IDENTITY_INVALID", "The original Black Script order identity is missing or invalid.");
    }
    const [binding, strategy, connection, capabilities, parent] = await Promise.all([
      single(this.supabase.from("strategy_target_bindings").select("*").eq("id", command.strategy_target_binding_id)),
      single(this.supabase.from("strategy_automation_strategies").select("*").eq("id", command.strategy_automation_id)),
      single(this.supabase.from("connectivity_connections").select("*").eq("id", command.connection_id)),
      single(this.supabase.from("broker_connection_capabilities").select("*").eq("connection_id", command.connection_id)),
      oneOrNull(this.supabase.from("execution_commands").select("*").eq("idempotency_key", parentPlaceIdempotencyKey).maybeSingle()),
    ]);
    if (strategy.runtime_kind !== "python-script" || binding.strategy_id !== strategy.id
      || binding.connection_id !== connection.id || binding.owner_user_id !== command.user_id
      || connection.user_id !== command.user_id || connection.account_id !== binding.account_id
      || binding.target_type !== "BROKER_ACCOUNT" || connection.provider !== "bybit") {
      throw terminalError("BLACK_SCRIPT_ORDER_MUTATION_OWNERSHIP_MISMATCH", "The Black Script mutation does not match its immutable strategy, target, account and connection authority.");
    }
    if (!parent || parent.command_type !== "PLACE_ORDER"
      || parent.strategy_automation_id !== strategy.id
      || parent.strategy_target_binding_id !== binding.id
      || parent.connection_id !== connection.id
      || parent.user_id !== command.user_id
      || !["BLACK_SCRIPT_ENTRY", "BLACK_SCRIPT_EXIT"].includes(String(parent.payload?.action || "").toUpperCase())) {
      throw terminalError("BLACK_SCRIPT_PARENT_ORDER_OWNERSHIP_MISMATCH", "The original order handle is not an owned Black Script order for this target.");
    }
    if (!parent.execution_order_id) {
      if (["FAILED", "DEAD_LETTER", "CANCELLED"].includes(String(parent.status || "").toUpperCase())) {
        throw terminalError("BLACK_SCRIPT_PARENT_ORDER_TERMINAL", "The original Black Script order never reached a mutable broker order.");
      }
      throw reconciliationError("BLACK_SCRIPT_PARENT_ORDER_PENDING", "The original Black Script order is still waiting for its durable Bybit acknowledgement.", 2);
    }
    const order = await single(this.supabase.from("execution_orders").select("*").eq("id", parent.execution_order_id));
    if (order.strategy_automation_id !== strategy.id || order.strategy_target_binding_id !== binding.id
      || order.account_id !== binding.account_id || order.user_id !== command.user_id
      || order.client_order_id !== parent.deterministic_client_order_id) {
      throw terminalError("BLACK_SCRIPT_ACKNOWLEDGED_ORDER_OWNERSHIP_MISMATCH", "The acknowledged order does not match the original deterministic Black Script identity.");
    }
    if (command.execution_order_id && command.execution_order_id !== order.id) {
      throw terminalError("BLACK_SCRIPT_MUTATION_ORDER_LINK_MISMATCH", "The mutation command is linked to a different execution order.");
    }
    if (!command.execution_order_id) {
      await updateOrThrow(this.supabase.from("execution_commands").update({ execution_order_id: order.id }).eq("id", command.id).is("execution_order_id", null));
      command.execution_order_id = order.id;
    }
    if (isTerminalInternalOrderStatus(order.status)) {
      return { skipped: true, reason: "BLACK_SCRIPT_ORDER_ALREADY_TERMINAL", order };
    }
    if (binding.status !== "LIVE" || Number(binding.strategy_version) !== Number(strategy.running_version)) {
      throw terminalError("STRATEGY_VERSION_NOT_RUNNING", "The Black Script order mutation belongs to an inactive target or version.");
    }
    if (connection.control_state !== "ACTIVE" || connection.execution_readiness !== "READY") {
      throw terminalError("CONNECTION_NOT_READY", "The Bybit connection is not ready for a Black Script order mutation.");
    }
    if ((operation === "modify" && capabilities.can_modify_orders !== true)
      || (operation === "cancel" && capabilities.can_cancel_orders !== true)
      || capabilities.can_withdraw || capabilities.can_transfer) {
      throw terminalError("BROKER_CAPABILITY_REJECTED", `The broker capability set does not permit this Black Script ${operation}.`);
    }
    const [account, secretReference] = await Promise.all([
      single(this.supabase.from("exchange_accounts").select("*").eq("id", binding.account_id)),
      single(this.supabase.from("broker_secret_references").select("id,status").eq("connection_id", connection.id).eq("status", "ACTIVE")),
    ]);
    if (!account.trading_enabled || account.is_read_only) throw terminalError("ACCOUNT_READ_ONLY", "The Bybit account is not trade enabled.");
    await this.repository.requireAutomationMandate(connection.id, operation);
    const credentials = await this.repository.readBrokerSecret(secretReference.id, `black_script_order_${operation}`);
    const executionEnvironment = assertWorkerEnvironment(connection, credentials);
    const environmentEnabled = executionEnvironment === "DEMO"
      ? process.env.STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED === "true"
      : process.env.STRATEGY_AUTOMATION_LIVE_EXECUTION_ENABLED === "true" && process.env.STRATEGY_AUTOMATION_LIVE_EXECUTION_CERTIFIED === "true";
    if (!environmentEnabled || process.env.BLACK_CLOUD_GLOBAL_EXECUTION_KILL_SWITCH === "true") {
      throw terminalError("STRATEGY_ENVIRONMENT_DISABLED", `Black Script order mutation is disabled for ${executionEnvironment}.`);
    }
    const request = command.payload?.request || {};
    const symbol = String(request.symbol || order.symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (!symbol || symbol !== String(strategy.symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase() || symbol !== String(order.symbol || "").toUpperCase()) {
      throw terminalError("BLACK_SCRIPT_MUTATION_SYMBOL_MISMATCH", "The mutation symbol does not match its strategy and acknowledged order.");
    }
    const marketKind = String(request.marketKind || (binding.market_type === "SPOT" ? "spot" : "perpetual")).toLowerCase() === "spot" ? "spot" : "perpetual";
    const category = marketKind === "spot" ? "spot" : "linear";
    const venueOrder = await findBybitOrderByClientOrderId(credentials, { marketKind, symbol, clientOrderId: order.client_order_id });
    if (!venueOrder) {
      throw reconciliationError("BLACK_SCRIPT_VENUE_ORDER_RECONCILING", "The acknowledged Black Script order is temporarily absent from Bybit order lookup; mutation will retry without changing another order.", 2);
    }
    const expectedOrderType = String(order.order_type || "").toLowerCase() === "stop-market" ? "market" : String(order.order_type || "").toLowerCase() === "stop-limit" ? "limit" : String(order.order_type || "").toLowerCase();
    assertRecoveredVenueOrderShape(venueOrder, {
      category,
      symbol,
      side: order.side,
      reduceOnly: order.reduce_only,
      positionIdx: venueOrder.positionIdx,
      orderType: expectedOrderType,
    });
    if (isTerminalVenueOrder(venueOrder)) {
      await updateOrThrow(this.supabase.from("execution_orders").update({
        status: normalizeInternalStatus(venueOrder.status),
        filled_quantity: Number(venueOrder.filledQuantity || 0),
      }).eq("id", order.id));
      return { skipped: true, reason: "BLACK_SCRIPT_ORDER_TERMINAL_AT_VENUE", order, venueOrder };
    }
    const adapter = createCloudExchangeAdapter("bybit", {
      credentials,
      executionEnvironment,
      endpointProfile: credentials.endpointProfile || connection.endpoint_profile || "GLOBAL",
      connectionId: connection.id,
    });
    return { binding, strategy, connection, account, capabilities, credentials, executionEnvironment, request, symbol, marketKind, category, order, venueOrder, adapter };
  }

  async modifyBlackScriptOrder(command, fencingToken) {
    const context = await this.resolveBlackScriptOrderMutation(command, "modify");
    if (context.skipped) return context;
    const { connection, credentials, request, symbol, marketKind, category, order, venueOrder, adapter } = context;
    const newer = await rows(this.supabase.from("execution_commands").select("id")
      .eq("execution_order_id", order.id).eq("command_type", "MODIFY_ORDER")
      .gt("created_at", command.created_at).neq("status", "CANCELLED").limit(1));
    if (newer.length) return { skipped: true, reason: "BLACK_SCRIPT_ORDER_MODIFY_SUPERSEDED" };
    const instrumentRows = await getBybitInstrumentMetadata({
      category,
      symbol,
      executionEnvironment: context.executionEnvironment,
      endpointProfile: credentials.endpointProfile || connection.endpoint_profile,
    });
    const instrument = instrumentRows[0];
    if (!instrument || !(Number(instrument.tickSize) > 0) || !(Number(instrument.quantityStep) > 0)) {
      throw terminalError("BLACK_SCRIPT_MUTATION_INSTRUMENT_UNAVAILABLE", "Bybit instrument precision is required before amending a Black Script order.");
    }
    const requestedQuantity = nullablePositive(request.quantity);
    const requestedPercent = nullablePositive(request.quantityPercent);
    const priorPercent = nullablePositive(request.previousQuantityPercent);
    let quantity = requestedQuantity;
    if (!quantity && requestedPercent && priorPercent) quantity = Number(order.quantity) * requestedPercent / priorPercent;
    if (!quantity && requestedPercent && order.reduce_only) {
      const positions = await getBybitPositions(credentials, { category, symbol, includeEmpty: true });
      const direction = String(command.payload?.direction || "").toLowerCase();
      const position = positions.find((item) => item.direction === direction && Number(item.quantity) > 0);
      quantity = position ? Number(position.quantity) * requestedPercent / 100 : undefined;
    }
    if (quantity) quantity = floorStrategyVenueQuantity(quantity, instrument);
    const limitPrice = nullablePositive(request.limitPrice);
    const stopPrice = nullablePositive(request.stopPrice);
    const patch = {
      marketKind,
      symbol,
      clientOrderId: order.client_order_id,
      ...(quantity ? { quantity } : {}),
      ...(limitPrice ? { limitPrice: alignVenueStep(limitPrice, Number(instrument.tickSize)) } : {}),
      ...(stopPrice ? { stopPrice: alignVenueStep(stopPrice, Number(instrument.tickSize)) } : {}),
    };
    if (!patch.quantity && !patch.limitPrice && !patch.stopPrice) {
      throw terminalError("BLACK_SCRIPT_ORDER_MODIFY_EMPTY", "The Black Script amendment contains no quantity, limit or trigger change.");
    }
    await this.repository.assertFencingToken(connection.id, fencingToken);
    this.assertSubmissionClockSafe();
    try {
      await adapter.modifyOrder(patch);
    } catch (error) {
      if (!isAmbiguousTransportError(error)) throw error;
    }
    const confirmed = await findBybitOrderByClientOrderId(credentials, { marketKind, symbol, clientOrderId: order.client_order_id });
    if (!confirmed) throw reconciliationError("BLACK_SCRIPT_ORDER_MODIFY_RECONCILING", "Bybit accepted or ambiguously received the amendment; exact order state is still reconciling.", 2);
    assertRecoveredVenueOrderShape(confirmed, {
      category,
      symbol,
      side: venueOrder.side,
      reduceOnly: venueOrder.reduceOnly,
      positionIdx: venueOrder.positionIdx,
      orderType: venueOrder.orderType,
    });
    if (patch.limitPrice && !venuePricesEqual(confirmed.price, patch.limitPrice, Number(instrument.tickSize))) {
      throw reconciliationError("BLACK_SCRIPT_LIMIT_AMEND_UNCONFIRMED", "Bybit has not yet confirmed the requested Black Script limit price.", 2);
    }
    if (patch.stopPrice && !venuePricesEqual(confirmed.triggerPrice, patch.stopPrice, Number(instrument.tickSize))) {
      throw reconciliationError("BLACK_SCRIPT_TRIGGER_AMEND_UNCONFIRMED", "Bybit has not yet confirmed the requested Black Script trigger price.", 2);
    }
    if (patch.quantity && Math.abs(Number(confirmed.quantity || 0) - patch.quantity) > Number(instrument.quantityStep) / 2 + 1e-12) {
      throw reconciliationError("BLACK_SCRIPT_QUANTITY_AMEND_UNCONFIRMED", "Bybit has not yet confirmed the requested Black Script order quantity.", 2);
    }
    await updateOrThrow(this.supabase.from("execution_orders").update({
      ...(patch.quantity ? { quantity: patch.quantity } : {}),
      ...(patch.limitPrice ? { limit_price: patch.limitPrice } : {}),
      ...(patch.stopPrice ? { stop_price: patch.stopPrice } : {}),
      status: normalizeInternalStatus(confirmed.status),
      filled_quantity: Number(confirmed.filledQuantity || 0),
    }).eq("id", order.id));
    return { amended: true, venueOrderId: confirmed.orderId, orderId: order.id };
  }

  async cancelBlackScriptOrder(command, fencingToken) {
    const context = await this.resolveBlackScriptOrderMutation(command, "cancel");
    if (context.skipped) return context;
    const { connection, credentials, symbol, marketKind, order, adapter } = context;
    await this.repository.assertFencingToken(connection.id, fencingToken);
    try {
      await adapter.cancelOrder({ marketKind, symbol, clientOrderId: order.client_order_id });
    } catch (error) {
      if (!isAmbiguousTransportError(error)) throw error;
    }
    const confirmed = await findBybitOrderByClientOrderId(credentials, { marketKind, symbol, clientOrderId: order.client_order_id });
    if (!confirmed || !isTerminalVenueOrder(confirmed)) {
      throw reconciliationError("BLACK_SCRIPT_ORDER_CANCEL_RECONCILING", "The deterministic Black Script cancellation is not terminal at Bybit yet.", 2);
    }
    await updateOrThrow(this.supabase.from("execution_orders").update({
      status: normalizeInternalStatus(confirmed.status),
      filled_quantity: Number(confirmed.filledQuantity || 0),
    }).eq("id", order.id));
    return { cancelled: true, venueOrderId: confirmed.orderId, orderId: order.id, filledQuantity: Number(confirmed.filledQuantity || 0) };
  }

  async placeBlackScriptPositionProtection(command, fencingToken) {
    if (String(command.payload?.strategyAction || "").toUpperCase() !== "BLACK_SCRIPT_POSITION_PROTECTION") {
      throw terminalError("STRATEGY_PROTECTION_INVALID", "Only a pinned Black Script protection intent may use this command path.");
    }
    const [binding, strategy, connection, account, capabilities] = await Promise.all([
      single(this.supabase.from("strategy_target_bindings").select("*").eq("id", command.strategy_target_binding_id)),
      single(this.supabase.from("strategy_automation_strategies").select("*").eq("id", command.strategy_automation_id)),
      single(this.supabase.from("connectivity_connections").select("*").eq("id", command.connection_id)),
      single(this.supabase.from("exchange_accounts").select("*").eq("id", command.payload?.accountId)),
      single(this.supabase.from("broker_connection_capabilities").select("*").eq("connection_id", command.connection_id)),
    ]);
    if (strategy.runtime_kind !== "python-script" || binding.strategy_id !== strategy.id || binding.connection_id !== connection.id
      || binding.account_id !== account.id || connection.account_id !== account.id || binding.owner_user_id !== command.user_id) {
      throw terminalError("STRATEGY_PROTECTION_OWNERSHIP_MISMATCH", "Black Script protection ownership does not match its strategy target and account.");
    }
    if (binding.market_type !== "FUTURES" || connection.provider !== "bybit") {
      throw terminalError("STRATEGY_PROTECTION_PROVIDER_UNSUPPORTED", "Black Script native trailing protection currently requires Bybit futures.");
    }
    if (binding.status !== "LIVE" || connection.control_state !== "ACTIVE" || connection.execution_readiness !== "READY") {
      throw terminalError("STRATEGY_TARGET_NOT_LIVE", "The strategy target is not ready for position protection.");
    }
    if (!capabilities.can_place_stop_orders) throw terminalError("BROKER_CAPABILITY_REJECTED", "The broker capability set does not permit stop protection.");
    await this.repository.requireAutomationMandate(connection.id, "strategy");
    if (!account.trading_enabled || account.is_read_only) throw terminalError("ACCOUNT_READ_ONLY", "The Bybit account is not trade enabled.");
    const secretReference = await single(this.supabase.from("broker_secret_references").select("id,status").eq("connection_id", connection.id).eq("status", "ACTIVE"));
    const credentials = await this.repository.readBrokerSecret(secretReference.id, "strategy_position_protection");
    const executionEnvironment = assertWorkerEnvironment(connection, credentials);
    const environmentEnabled = executionEnvironment === "DEMO"
      ? process.env.STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED === "true"
      : process.env.STRATEGY_AUTOMATION_LIVE_EXECUTION_ENABLED === "true" && process.env.STRATEGY_AUTOMATION_LIVE_EXECUTION_CERTIFIED === "true";
    if (!environmentEnabled || process.env.BLACK_CLOUD_GLOBAL_EXECUTION_KILL_SWITCH === "true") {
      throw terminalError("STRATEGY_ENVIRONMENT_DISABLED", `Strategy protection is disabled for ${executionEnvironment}.`);
    }
    const direction = String(command.payload.direction || "").toLowerCase();
    const symbol = String(command.payload.symbol || strategy.symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const adapter = createCloudExchangeAdapter("bybit", {
      credentials,
      executionEnvironment,
      endpointProfile: credentials.endpointProfile || connection.endpoint_profile || "GLOBAL",
      connectionId: connection.id,
    });
    const positions = await adapter.fetchPositions({ category: "linear", symbol, includeEmpty: true });
    const position = positions.find((item) => item.direction === direction && Number(item.quantity) > 0);
    if (!position) return { skipped: true, reason: "POSITION_ALREADY_FLAT" };
    const persisted = await oneOrNull(this.supabase.from("account_positions")
      .select("strategy_target_binding_id,position_idx,direction,quantity")
      .eq("account_id", account.id).eq("symbol", symbol).eq("position_idx", position.positionIdx).maybeSingle());
    if (!persisted || persisted.strategy_target_binding_id !== binding.id || persisted.direction !== direction) {
      throw retryableError("STRATEGY_POSITION_OWNERSHIP_PENDING", "The exact strategy-owned position must reconcile before protection can change.", 2);
    }
    const cancelTrailingStop = command.payload.cancelTrailingStop === true;
    const trailingDistance = cancelTrailingStop ? 0 : nullablePositive(command.payload.trailingDistance);
    const trailingActivationPrice = nullablePositive(command.payload.trailingActivationPrice);
    const stopLoss = command.payload.cancelStopLoss === true ? 0 : nullablePositive(command.payload.stopLoss);
    if (trailingDistance === undefined && stopLoss === undefined) throw terminalError("STRATEGY_PROTECTION_EMPTY", "A stop-loss or trailing distance is required.");
    await this.repository.assertFencingToken(connection.id, fencingToken);
    this.assertSubmissionClockSafe();
    const result = await adapter.setPositionProtection({
      marketKind: "perpetual",
      category: "linear",
      symbol,
      positionIdx: position.positionIdx,
      tpslMode: "full",
      ...(stopLoss !== undefined ? { stopLoss } : {}),
      ...(trailingDistance !== undefined ? { trailingStop: trailingDistance, ...(trailingDistance > 0 ? { trailingActivationPrice } : {}) } : {}),
      slTriggerBy: "last",
    });
    const after = (await adapter.fetchPositions({ category: "linear", symbol, includeEmpty: true }))
      .find((item) => item.direction === direction && Number(item.positionIdx) === Number(position.positionIdx));
    if (!after || Number(after.quantity) <= 0) return { skipped: true, reason: "POSITION_CLOSED_DURING_PROTECTION" };
    if (trailingDistance !== undefined && Math.abs(Number(after.trailingStop || 0) - trailingDistance) > 1e-8) {
      throw reconciliationError("STRATEGY_TRAILING_PROTECTION_UNCONFIRMED", "Bybit did not confirm the requested trailing distance.", 2);
    }
    if (stopLoss !== undefined && Math.abs(Number(after.stopLoss || 0) - stopLoss) > 1e-8) {
      throw reconciliationError("STRATEGY_STOP_PROTECTION_UNCONFIRMED", "Bybit did not confirm the requested stop loss.", 2);
    }
    return { protected: true, direction, positionIdx: position.positionIdx, trailingDistance, trailingActivationPrice, stopLoss, idempotentNoop: result.idempotentNoop === true };
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

    const marketKind = String(command.payload?.request?.marketKind || "perpetual").toLowerCase() === "spot" ? "spot" : "perpetual";
    const category = marketKind === "spot" ? "spot" : "linear";
    const symbol = String(command.payload?.request?.symbol || order.symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const expectedEntryOrderId = String(command.payload?.expectedEntryOrderId || "");
    const expectedEntrySide = String(command.payload?.direction || "").toLowerCase() === "short" ? "sell" : "buy";
    const [expectedEntryOrder, matchingEntries] = await Promise.all([
      expectedEntryOrderId ? oneOrNull(this.supabase.from("execution_orders")
        .select("id,account_id,symbol,side,reduce_only,status,filled_quantity,strategy_automation_id,strategy_target_binding_id")
        .eq("id", expectedEntryOrderId)
        .maybeSingle()) : Promise.resolve(null),
      rows(this.supabase.from("execution_orders")
        .select("id,account_id,symbol,side,reduce_only,status,filled_quantity,strategy_automation_id,strategy_target_binding_id")
        .eq("account_id", connection.account_id)
        .eq("strategy_target_binding_id", binding.id)
        .eq("symbol", symbol)
        .eq("side", expectedEntrySide)
        .eq("reduce_only", false)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(20))
    ]);
    if (!isCurrentStrategyEntryGeneration(expectedEntryOrderId, expectedEntryOrder, matchingEntries, {
      accountId: connection.account_id,
      strategyId: strategy.id,
      bindingId: binding.id,
      symbol,
      side: expectedEntrySide
    })) {
      return { skipped: true, reason: "TAKE_PROFIT_REPRICE_STALE_GENERATION" };
    }

    const secretReference = await single(this.supabase.from("broker_secret_references")
      .select("id")
      .eq("connection_id", connection.id)
      .eq("status", "ACTIVE"));
    const credentials = await this.repository.readBrokerSecret(secretReference.id, "strategy_take_profit_reprice");
    assertWorkerEnvironment(connection, credentials);
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
        venue_updated_at: Number(venueOrder.updatedTime || Date.now()),
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

function normalizeInternalStatus(status) {
  if (status === "filled") return "filled";
  if (status === "partially-filled") return "partially-filled";
  if (["cancelled", "canceled", "expired"].includes(status)) return "cancelled";
  if (["rejected", "failed"].includes(status)) return "rejected";
  return "accepted";
}

function isTerminalInternalOrderStatus(status) {
  return ["filled", "cancelled", "rejected"].includes(String(status || "").toLowerCase());
}

function classifyExecutionError(error, command) {
  const code = error?.code || "EXECUTION_FAILED";
  const ambiguous = error?.ambiguous === true;
  const reconciling = error?.reconciling === true;
  const retryable = ambiguous || error?.retryable === true || isRetryableTransportError(error);
  const exhausted = Number(command.attempt_count) >= Number(command.max_attempts);
  return {
    code,
    ambiguous,
    retryable,
    retryAfterSeconds: error?.retryAfterSeconds || Math.min(60, 2 ** Math.min(6, Number(command.attempt_count))),
    attemptOutcome: ambiguous ? "SUBMISSION_UNKNOWN" : retryable ? "RETRY" : "FAILED",
    commandStatus: reconciling ? "RECONCILING" : ambiguous ? "SUBMISSION_UNKNOWN" : exhausted ? "DEAD_LETTER" : retryable ? "RETRY" : "FAILED"
  };
}

export function isTerminalTakeProfitProtectionFailure(error) {
  if (!error || error.retryable === true || error.ambiguous === true || error.reconciling === true) return false;
  if (isAmbiguousTransportError(error) || isRetryableTransportError(error)) return false;
  const code = String(error.code || "").toUpperCase();
  if (new Set([
    "VENUE_VALIDATION_REJECTED",
    "BYBIT_ORDER_VALIDATION_FAILED",
    "STRATEGY_TAKE_PROFIT_PRICE_INVALID",
    "STRATEGY_QUANTITY_BELOW_VENUE_STEP",
    "STRATEGY_PARTIAL_FILL_UNPROTECTABLE",
    "STRATEGY_TP_LADDER_BELOW_VENUE_MINIMUM",
    "STRATEGY_ORDER_UNFILLED",
    "STRATEGY_TP_ORDER_TERMINATED_AT_VENUE"
  ]).has(code)) return true;
  const venueCode = Number(error?.bybit?.retCode);
  const terminalVenueRejection = String(error?.bybitEndpoint || "") === "/v5/order/create"
    && Number.isFinite(venueCode)
    && ![10000, 10003, 10004, 10005, 10006, 10010, 10016].includes(venueCode)
    && ![401, 403, 408, 429, 500, 502, 503, 504].includes(Number(error?.bybitHttpStatus || error?.statusCode));
  return terminalVenueRejection || (Number(error?.statusCode) === 400 && /(?:BYBIT|BROKER|ORDER|VENUE)/.test(code));
}

export function followerPlanStatusForExecutionFailure(code) {
  const normalized = String(code || "").toUpperCase();
  if (normalized.includes("MANDATE")) return "MANDATE_PAUSED";
  if (normalized.includes("AUTH")) return "AUTH_EXPIRED";
  if (normalized.includes("MARGIN")) return "INSUFFICIENT_MARGIN";
  if (normalized.includes("SYMBOL")) return "SYMBOL_NOT_ALLOWED";
  if (normalized.includes("CONNECTION") || normalized.includes("WORKER_ENVIRONMENT")) return "CONNECTION_UNHEALTHY";
  if (normalized.includes("RECONCIL") || normalized.includes("FAIL_SAFE")) return "RECONCILIATION_REQUIRED";
  if (normalized.includes("CANCEL")) return "CANCELLED";
  if (normalized.includes("RISK")) return "RISK_REJECTED";
  return "VENUE_REJECTED";
}

export function hasPositiveFollowerPlanFill(plan, order) {
  return ["FILLED", "PARTIALLY_FILLED"].includes(String(plan?.execution_status || "").toUpperCase())
    || Number(order?.filled_quantity || 0) > 0;
}

export function isAggregatedTargetSuppressed(decision, requestedTargetId) {
  const mode = String(decision?.mode || "").toUpperCase();
  const primaryTargetId = String(decision?.primaryTargetId || "").toUpperCase();
  const requested = String(requestedTargetId || "").toUpperCase();
  return mode === "AGGREGATED_TP1" && Boolean(primaryTargetId) && Boolean(requested) && requested !== primaryTargetId;
}

export function assertAcknowledgedOrderOwnership(order, { account, symbol, orderUserId, bindingId = null, groupIntentId = null, mandateId = null }) {
  const ownershipMismatch = order.account_id !== account.id
    || order.user_id !== orderUserId
    || String(order.symbol || "").toUpperCase() !== String(symbol || "").toUpperCase()
    || (bindingId && order.strategy_target_binding_id !== bindingId)
    || (groupIntentId && order.group_intent_id !== groupIntentId)
    || (mandateId && order.mandate_id !== mandateId);
  if (ownershipMismatch) throw terminalError("STRATEGY_ACKNOWLEDGED_ORDER_OWNERSHIP_MISMATCH", "The durable order acknowledgement belongs to a different user, account, symbol, strategy target, group intent, or mandate.");
  return true;
}

export function strategyDependencyCancellation(result) {
  if (result?.skipped !== true) return null;
  const reason = String(result?.reason || "").toUpperCase();
  return STRATEGY_DEPENDENCY_CANCELLATION_REASONS.has(reason) ? reason : null;
}

export function isTerminalFollowerPlanRejection(status) {
  return TERMINAL_FOLLOWER_PLAN_REJECTION_STATUSES.has(String(status || "").toUpperCase());
}

export function strategyDependencyCancellationMessage(reason) {
  const normalized = String(reason || "").toUpperCase();
  if (normalized === "PARENT_ENTRY_UNFILLED" || normalized === "PARENT_GROUP_ENTRY_UNFILLED") {
    return "Strategy child command was cancelled because its parent entry completed without an executable fill.";
  }
  return "Strategy child command was cancelled because its parent entry command failed or was cancelled.";
}

export function strategyCommandAuditMetadata(command, outcome = {}) {
  const payload = command?.payload || {};
  const request = payload.request || {};
  return {
    code: String(outcome.code || "EXECUTION_FAILED"),
    commandStatus: String(outcome.commandStatus || "FAILED"),
    commandType: String(command?.command_type || "UNKNOWN"),
    action: String(payload.action || payload.strategyAction || "UNKNOWN").toUpperCase(),
    direction: String(payload.direction || payload.positionDirection || "UNKNOWN").toLowerCase(),
    symbol: String(payload.symbol || request.symbol || "UNKNOWN").replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
    targetId: payload.targetId ? String(payload.targetId).toUpperCase() : null,
    retryable: outcome.retryable === true,
    ambiguous: outcome.ambiguous === true
  };
}

function isRetryableTransportError(error) {
  return /timeout|timed out|timing out|econnreset|econnrefused|fetch failed|rate limit|temporar|service unavailable|502|503|504/i.test(String(error?.message || error));
}

export function isAmbiguousTransportError(error) {
  return /timeout|timed out|timing out|econnreset|socket hang up|fetch failed|502|503|504/i.test(String(error?.message || error));
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

function reconciliationError(code, message, retryAfterSeconds) {
  const error = retryableError(code, message, retryAfterSeconds);
  error.reconciling = true;
  return error;
}

function deterministicStrategyLegId(baseId, leg) {
  const safeBase = String(baseId || "bt-strategy").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 33);
  return `${safeBase}-${leg}`.slice(0, 36);
}

function strategyRootClientOrderId(clientOrderId) {
  return String(clientOrderId || "").replace(/-(?:e|c\d*)$/i, "");
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
  const closeOnTriggerMismatch = expected?.closeOnTrigger !== undefined && Boolean(order?.closeOnTrigger) !== Boolean(expected.closeOnTrigger);
  if (actualSide !== expectedSide
    || Boolean(order?.reduceOnly) !== Boolean(expected?.reduceOnly)
    || (expectedSymbol && actualSymbol !== expectedSymbol)
    || (expectedCategory && actualCategory !== expectedCategory)
    || (expectedType && actualType !== expectedType)
    || positionMismatch
    || closeOnTriggerMismatch) {
    throw terminalError("STRATEGY_RECOVERY_ORDER_MISMATCH", "The deterministic Bybit order identity exists with an unexpected symbol, category, side, type, position index, or reduce-only contract, including close-on-trigger state.");
  }
}

export function isTerminalUnfilledVenueOrder(order) {
  const status = String(order?.status || "").toLowerCase();
  const terminal = ["cancelled", "canceled", "expired", "rejected", "failed"].includes(status);
  return terminal && !(Number(order?.filledQuantity ?? order?.filled_quantity ?? 0) > 0);
}

export function requireTerminalStrategyEntryFill(order) {
  const filledQuantity = settledStrategyEntryQuantity(order);
  if (filledQuantity) return filledQuantity;
  if (isTerminalVenueOrder(order)) {
    throw terminalError("STRATEGY_ENTRY_UNFILLED", "Bybit terminated the strategy entry without a fill.");
  }
  throw retryableError("STRATEGY_ENTRY_WAITING_FOR_FINAL_FILL", "Bybit acknowledged the IOC entry; waiting for its final cumulative fill.", 2);
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

export function isCurrentStrategyEntryGeneration(expectedEntryOrderId, expectedEntryOrder, matchingEntries, context) {
  if (!expectedEntryOrderId || !expectedEntryOrder) return false;
  const exactOwnership = String(expectedEntryOrder.id) === String(expectedEntryOrderId)
    && expectedEntryOrder.account_id === context.accountId
    && expectedEntryOrder.strategy_automation_id === context.strategyId
    && expectedEntryOrder.strategy_target_binding_id === context.bindingId
    && String(expectedEntryOrder.symbol || "").toUpperCase() === String(context.symbol || "").toUpperCase()
    && String(expectedEntryOrder.side || "").toLowerCase() === String(context.side || "").toLowerCase()
    && expectedEntryOrder.reduce_only !== true
    && isPotentialPositionGeneration(expectedEntryOrder);
  if (!exactOwnership) return false;
  const latest = (matchingEntries || []).find(isPotentialPositionGeneration);
  return Boolean(latest && String(latest.id) === String(expectedEntryOrderId));
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
