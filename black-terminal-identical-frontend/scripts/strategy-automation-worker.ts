import crypto from "node:crypto";
import { getSupabaseAdmin } from "../server/portfolio-api.js";
import {
  calculateCapitalPreview,
  calculateEffectiveLeverage,
  normalizeCapitalPolicy,
} from "../server/strategy-automation/domain.js";
import { createStrategySignals, superAtrTakeProfitPlan } from "../src/modules/strategy-lab/adapters/signalAdapter.ts";
import {
  hashCanonicalPayload,
  intentSigningPayload,
  signCanonicalPayload,
} from "../server/cloud-execution/canonical.js";
import type { Candle } from "../src/chart-engine/types.ts";

type JsonRow = Record<string, any>;

const supabase = getSupabaseAdmin();
const workerId = `strategy-paper-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const intervalMs = boundedInteger(
  process.env.STRATEGY_AUTOMATION_TICK_MS,
  15_000,
  5_000,
  300_000,
);
const maxPerTick = boundedInteger(
  process.env.STRATEGY_AUTOMATION_MAX_PER_TICK,
  100,
  1,
  1_000,
);
const concurrency = boundedInteger(
  process.env.STRATEGY_AUTOMATION_CONCURRENCY,
  4,
  1,
  16,
);
const leaseSeconds = Math.max(
  15,
  Math.min(300, Math.ceil(intervalMs / 1000) * 3),
);
const paperEnabled = process.env.STRATEGY_AUTOMATION_PAPER_ENABLED !== "false";
const liveExecutionEnabled =
  process.env.STRATEGY_AUTOMATION_LIVE_EXECUTION_ENABLED === "true" &&
  process.env.STRATEGY_AUTOMATION_LIVE_EXECUTION_CERTIFIED === "true" &&
  process.env.BLACK_CLOUD_GLOBAL_EXECUTION_KILL_SWITCH !== "true";
const demoExecutionEnabled =
  process.env.STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED === "true" &&
  process.env.BYBIT_DEMO_ENABLED === "true" &&
  process.env.BLACK_CLOUD_GLOBAL_EXECUTION_KILL_SWITCH !== "true";
const groupExecutionEnabled =
  process.env.STRATEGY_AUTOMATION_GROUP_EXECUTION_ENABLED === "true" &&
  process.env.INVESTMENT_GROUP_EXECUTION_ENABLED === "true" &&
  process.env.BLACK_CLOUD_GLOBAL_EXECUTION_KILL_SWITCH !== "true";
let running = true;
let ticking = false;

console.log(
  JSON.stringify({
    level: "info",
    event: "strategy_automation_worker_started",
    workerId,
    paperEnabled,
    demoExecutionEnabled,
    liveExecutionEnabled,
    groupExecutionEnabled,
    intervalMs,
  }),
);

for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    running = false;
  });

while (running) {
  const started = Date.now();
  await tick().catch((error) =>
    console.error(
      JSON.stringify({
        level: "error",
        event: "strategy_automation_tick_failed",
        code: safeCode(error),
      }),
    ),
  );
  const wait = Math.max(500, intervalMs - (Date.now() - started));
  await delay(wait);
}

console.log(
  JSON.stringify({
    level: "info",
    event: "strategy_automation_worker_stopped",
    workerId,
  }),
);

async function tick() {
  if (ticking || (!paperEnabled && !demoExecutionEnabled && !liveExecutionEnabled && !groupExecutionEnabled)) return;
  ticking = true;
  try {
    const { data: strategies, error } = await supabase
      .from("strategy_automation_strategies")
      .select("*")
      .in("status", ["PAPER_ACTIVE", "LIVE_READY", "LIVE_ACTIVE"])
      .is("archived_at", null)
      .order("updated_at")
      .limit(maxPerTick);
    if (error) throw error;
    await mapWithConcurrency(
      strategies || [],
      concurrency,
      async (strategy) => {
        if (!running) return;
        const { data: claimed, error: claimError } = await supabase.rpc(
          "black_core_claim_strategy_runtime",
          {
            p_strategy_id: strategy.id,
            p_owner_user_id: strategy.owner_user_id,
            p_worker_id: workerId,
            p_lease_seconds: leaseSeconds,
          },
        );
        if (claimError) throw claimError;
        if (claimed === true)
          await processStrategy(strategy).catch((error) =>
            markFailure(strategy, error),
          );
      },
    );
  } finally {
    ticking = false;
  }
}

async function processStrategy(strategy: JsonRow) {
  // Never execute a published-but-not-started version. running_version is set
  // only by the explicit, audited version-start transition.
  const runningVersion = Number(strategy.running_version ?? 0);
  if (!Number.isInteger(runningVersion) || runningVersion < 1)
    return heartbeat(strategy, "PAUSED", "NO_RUNNING_VERSION");
  const { data: version, error: versionError } = await supabase
    .from("strategy_automation_versions")
    .select("version,definition")
    .eq("strategy_id", strategy.id)
    .eq("owner_user_id", strategy.owner_user_id)
    .eq("version", runningVersion)
    .maybeSingle();
  if (versionError) throw versionError;
  if (!version?.definition)
    return heartbeat(strategy, "DEGRADED", "RUNNING_VERSION_UNAVAILABLE");
  const runningDefinition = version.definition;
  strategy = {
    ...strategy,
    current_version: runningVersion,
    runtime_kind: runningDefinition.runtimeKind,
    symbol: runningDefinition.symbol,
    timeframe: runningDefinition.timeframe,
    market_type: runningDefinition.marketType,
    exchange: runningDefinition.exchange || "bybit",
    definition: runningDefinition,
  };
  if (isBcrdaDefinition(runningDefinition)) {
    return heartbeat(strategy, "DEGRADED", "BC_RDA_SIGNAL_INTEGRITY_BLOCKED");
  }
  const { data: paper, error: paperError } = await supabase
    .from("strategy_paper_accounts")
    .select("*")
    .eq("strategy_id", strategy.id)
    .eq("strategy_version", strategy.current_version)
    .eq("owner_user_id", strategy.owner_user_id)
    .maybeSingle();
  if (paperError) throw paperError;
  const { data: targetBindings, error: bindingError } = await supabase
    .from("strategy_target_bindings")
    .select("*")
    .eq("strategy_id", strategy.id)
    .eq("strategy_version", strategy.current_version)
    .eq("owner_user_id", strategy.owner_user_id)
    .eq("status", "LIVE");
  if (bindingError) throw bindingError;
  const activePaper = paperEnabled && paper?.status === "ACTIVE" ? paper : null;
  const brokerBindings = (targetBindings || []).filter((binding) => binding.target_type === "BROKER_ACCOUNT");
  const groupBindings = groupExecutionEnabled
    ? (targetBindings || []).filter((binding) => binding.target_type === "INVESTMENT_GROUP")
    : [];
  const activeBrokerBindings = (demoExecutionEnabled || liveExecutionEnabled) ? brokerBindings : [];
  if (!activePaper && activeBrokerBindings.length === 0 && groupBindings.length === 0)
    return heartbeat(strategy, "PAUSED", null);
  if (
    !["builtin-ema-cross", "builtin-adaptive-swing", "builtin-superatr-seven-step"].includes(
      strategy.runtime_kind,
    )
  ) {
    return heartbeat(
      strategy,
      "DEGRADED",
      "RUNTIME_REQUIRES_CERTIFIED_ADAPTER",
    );
  }
  if (String(strategy.exchange).toLowerCase() !== "bybit")
    return heartbeat(strategy, "DEGRADED", "PROVIDER_ADAPTER_UNAVAILABLE");

  const marketWindow = await fetchBybitCandleWindow(
    strategy.symbol,
    strategy.timeframe,
    strategy.market_type,
  );
  const candles = marketWindow.closed;
  const candle = candles.at(-1);
  if (!candle)
    return heartbeat(strategy, "DEGRADED", "MARKET_DATA_UNAVAILABLE");
  const { data: runtime, error: runtimeError } = await supabase
    .from("strategy_automation_runtime_state")
    .select("*")
    .eq("strategy_id", strategy.id)
    .maybeSingle();
  if (runtimeError) throw runtimeError;
  const candleAt = new Date(
    candle.time * 1000 + timeframeMilliseconds(strategy.timeframe),
  ).toISOString();
  if (
    runtime?.last_closed_candle_at &&
    Date.parse(runtime.last_closed_candle_at) >= Date.parse(candleAt)
  ) {
    return heartbeat(strategy, "LIVE", null);
  }

  const { data: position, error: positionError } = activePaper
    ? await supabase.from("strategy_paper_positions").select("*").eq("paper_account_id", activePaper.id).is("closed_at", null).maybeSingle()
    : { data: null, error: null };
  if (positionError) throw positionError;
  let signalKey: string | null = null;
  let signalAt: string | null = null;
  const signals = createStrategySignals(
    strategy.runtime_kind,
    candles,
    strategy.symbol,
    strategy.definition?.settings || {},
  );
  const signal = [...signals]
    .reverse()
    .find((item) => item.entry && Number(item.timestamp) === candle.time);
  let closeResult: { closed: boolean; reason: string | null } = { closed: false, reason: null };
  const nextTickReference = marketWindow.current?.time === candle.time + timeframeMilliseconds(strategy.timeframe) / 1000
    ? marketWindow.current.open
    : candle.close;
  if (position) closeResult = await managePaperPosition(strategy, activePaper, position, candles, candle, signal || null, nextTickReference);
  if (signal) {
    signalKey = `${strategy.id}:${strategy.current_version}:${strategy.symbol}:${strategy.timeframe}:${candle.time}:${signal.direction}`;
    signalAt = candleAt;
    const reverseAfterOpposite = closeResult.closed && closeResult.reason === "OPPOSITE_SIGNAL" && strategy.definition?.execution?.perpetualSignalReversalEnabled === true;
    if (activePaper && (!position || reverseAfterOpposite)) {
      await openPaperPosition(
        strategy,
        activePaper,
        candles,
        candle,
        signal,
        signalKey,
        nextTickReference,
      );
    }
    for (const binding of activeBrokerBindings) {
      await enqueueBrokerStrategySignal(strategy, binding, signal, signalKey);
    }
    for (const binding of groupBindings) {
      await enqueueGroupStrategySignal(strategy, binding, signal, signalKey);
    }
  }
  if (activePaper && position && closeResult.closed && closeResult.reason === "STOP_LOSS" && strategy.definition?.execution?.stopReversalEnabled === true) {
    await openPaperRevengePosition(strategy, activePaper, position, candles, candle);
  }

  const { error: updateError } = await supabase
    .from("strategy_automation_runtime_state")
    .upsert(
      {
        strategy_id: strategy.id,
        owner_user_id: strategy.owner_user_id,
        runtime_state: "LIVE",
        running_version: strategy.current_version,
        state_version: Number(runtime?.state_version || 0) + 1,
        last_closed_candle_at: candleAt,
        last_signal_key: signalKey || runtime?.last_signal_key || null,
        last_signal_at: signalAt || runtime?.last_signal_at || null,
        last_heartbeat_at: new Date().toISOString(),
        worker_id: workerId,
        lease_owner: workerId,
        lease_expires_at: new Date(
          Date.now() + leaseSeconds * 1000,
        ).toISOString(),
        safe_error_code: null,
      },
      { onConflict: "strategy_id" },
    );
  if (updateError) throw updateError;
}

function isBcrdaDefinition(definition: JsonRow) {
  const indicatorId = String(definition?.indicator?.indicatorId || "").toLowerCase();
  const indicatorName = String(definition?.indicator?.name || "").toLowerCase();
  return indicatorId === "black-core-dda-pro" || indicatorId.includes("ddapro") || indicatorName.includes("bc-rda") || indicatorName.includes("risk distribution analysis");
}

async function enqueueBrokerStrategySignal(
  strategy: JsonRow,
  binding: JsonRow,
  signal: JsonRow,
  signalKey: string,
) {
  if (!binding.connection_id || !binding.account_id) return;
  const { data: connection, error: connectionError } = await supabase
    .from("connectivity_connections")
    .select("id,execution_environment,health_status,credential_state,worker_state,synchronization_state,execution_readiness,control_state")
    .eq("id", binding.connection_id)
    .eq("user_id", strategy.owner_user_id)
    .maybeSingle();
  if (connectionError) throw connectionError;
  const executionEnvironment = String(connection?.execution_environment || "");
  const environmentEnabled = executionEnvironment === "DEMO" ? demoExecutionEnabled : executionEnvironment === "MAINNET_LIVE" ? liveExecutionEnabled : false;
  if (!connection || !environmentEnabled || !["CONNECTED_CLOUD", "CONNECTED_HYBRID"].includes(connection.health_status) || connection.credential_state !== "AUTHENTICATED" || connection.worker_state !== "LIVE" || connection.synchronization_state !== "SYNCHRONIZED" || connection.execution_readiness !== "READY" || connection.control_state !== "ACTIVE") {
    await auditBrokerSignalBlocked(strategy, binding, signalKey, "BROKER_CONNECTION_NOT_READY", executionEnvironment);
    return;
  }
  const { data: positions, error: positionError } = await supabase
    .from("account_positions")
    .select("direction,quantity,position_idx,strategy_target_binding_id,updated_at")
    .eq("account_id", binding.account_id)
    .eq("symbol", strategy.symbol)
    .gt("quantity", 0);
  if (positionError) throw positionError;
  const open = (positions || []).filter((item) => item.direction === "long" || item.direction === "short");
  const unowned = open.find((item) => item.strategy_target_binding_id !== binding.id);
  if (unowned) {
    await auditBrokerSignalBlocked(strategy, binding, signalKey, "ACCOUNT_SYMBOL_OCCUPIED_BY_UNOWNED_POSITION", executionEnvironment);
    return;
  }
  const owned = open.filter((item) => item.strategy_target_binding_id === binding.id);
  const sameDirection = owned.some((item) => item.direction === signal.direction);
  const opposite = owned.find((item) => item.direction !== signal.direction);
  if (sameDirection) return;
  const perpetualReversal = strategy.definition?.execution?.perpetualSignalReversalEnabled === true;
  const conflictResolution = perpetualReversal
    ? "CLOSE_THEN_REVERSE"
    : String(strategy.definition?.execution?.conflictResolution || "CLOSE_ONLY").toUpperCase();
  if (opposite && conflictResolution === "IGNORE") {
    await auditBrokerSignalBlocked(strategy, binding, signalKey, "OPPOSITE_SIGNAL_IGNORED_BY_POLICY", executionEnvironment);
    return;
  }
  const action = opposite ? (conflictResolution === "CLOSE_ONLY" ? "CLOSE" : "REVERSE") : "ENTRY";
  const commandSignalKey = `${signalKey}:${binding.id}:${action.toLowerCase()}`;
  const idempotencyKey = crypto.createHash("sha256").update(commandSignalKey).digest("hex");
  const deterministicClientOrderId = `bt-str-${idempotencyKey.slice(0, 28)}`;
  const { error } = await supabase.from("execution_commands").upsert({
    command_type: "PLACE_ORDER",
    user_id: strategy.owner_user_id,
    connection_id: binding.connection_id,
    strategy_automation_id: strategy.id,
    strategy_target_binding_id: binding.id,
    strategy_signal_key: commandSignalKey,
    idempotency_key: idempotencyKey,
    deterministic_client_order_id: deterministicClientOrderId,
    payload: {
      action,
      symbol: strategy.symbol,
      marketType: strategy.market_type,
      direction: signal.direction,
      positionDirection: opposite?.direction || null,
      stopLoss: signal.stopLoss || null,
      takeProfit: signal.takeProfit || null,
      takeProfits: Array.isArray(signal.takeProfits) ? signal.takeProfits : [],
      requestedLeverage: sideSpecificLeverage(strategy.definition, signal.direction, binding),
      slippageTicks: Number(strategy.definition?.execution?.slippageTicks || 0),
      candleTime: signal.timestamp,
      strategyVersion: strategy.current_version,
      executionEnvironment,
      simulatedFunds: executionEnvironment === "DEMO"
    },
    status: "QUEUED",
    priority: action === "CLOSE" ? 20 : 50
  }, { onConflict: "idempotency_key", ignoreDuplicates: true });
  if (error) throw error;
  if (action === "ENTRY" && Array.isArray(signal.takeProfits)) {
    for (const [index, target] of signal.takeProfits.slice(0, 7).entries()) {
      const targetId = String(target?.id || `TP${index + 1}`).toUpperCase();
      const targetSignalKey = `${signalKey}:${binding.id}:${targetId.toLowerCase()}`;
      const targetIdempotencyKey = crypto.createHash("sha256").update(targetSignalKey).digest("hex");
      const { error: targetError } = await supabase.from("execution_commands").upsert({
        command_type: "PLACE_ORDER",
        user_id: strategy.owner_user_id,
        connection_id: binding.connection_id,
        strategy_automation_id: strategy.id,
        strategy_target_binding_id: binding.id,
        strategy_signal_key: targetSignalKey,
        idempotency_key: targetIdempotencyKey,
        deterministic_client_order_id: `bt-tp-${targetIdempotencyKey.slice(0, 29)}`,
        payload: {
          action: "TAKE_PROFIT",
          symbol: strategy.symbol,
          marketType: strategy.market_type,
          direction: signal.direction,
          positionDirection: signal.direction,
          targetId,
          targetPrice: Number(target?.price),
          quantityPercent: Number(target?.quantityPercent),
          candleTime: signal.timestamp,
          strategyVersion: strategy.current_version,
          executionEnvironment,
          simulatedFunds: executionEnvironment === "DEMO",
        },
        status: "QUEUED",
        priority: 70 + index,
      }, { onConflict: "idempotency_key", ignoreDuplicates: true });
      if (targetError) throw targetError;
    }
  }
  await supabase.from("strategy_automation_audit_events").insert({
    owner_user_id: strategy.owner_user_id,
    strategy_id: strategy.id,
    binding_id: binding.id,
    event_type: executionEnvironment === "DEMO" ? "STRATEGY_DEMO_ORDER_QUEUED" : "STRATEGY_MAINNET_ORDER_QUEUED",
    severity: "INFO",
    message: `A confirmed closed-candle signal queued an idempotent Bybit ${executionEnvironment === "DEMO" ? "Demo" : "Mainnet"} order command.`,
    safe_metadata: { signalKey, action, symbol: strategy.symbol, direction: signal.direction, executionEnvironment, simulatedFunds: executionEnvironment === "DEMO" }
  });
}

async function auditBrokerSignalBlocked(strategy: JsonRow, binding: JsonRow, signalKey: string, reason: string, executionEnvironment: string) {
  await supabase.from("strategy_automation_audit_events").insert({
    owner_user_id: strategy.owner_user_id,
    strategy_id: strategy.id,
    binding_id: binding.id,
    event_type: "STRATEGY_BROKER_SIGNAL_BLOCKED",
    severity: "WARNING",
    message: "A strategy signal was blocked before broker submission.",
    safe_metadata: { signalKey, reason, executionEnvironment, simulatedFunds: executionEnvironment === "DEMO" }
  });
}

async function enqueueGroupStrategySignal(
  strategy: JsonRow,
  binding: JsonRow,
  signal: JsonRow,
  signalKey: string,
) {
  if (!binding.group_id || !groupExecutionEnabled) return;
  const { data: group, error: groupError } = await supabase
    .from("investment_groups")
    .select("id,owner_user_id,status")
    .eq("id", binding.group_id)
    .maybeSingle();
  if (groupError) throw groupError;
  if (!group || group.owner_user_id !== strategy.owner_user_id || group.status !== "active") {
    await auditGroupSignalBlocked(strategy, binding, signalKey, "GROUP_NOT_ACTIVE_OR_OWNED");
    return;
  }
  const { count, error: mandateError } = await supabase
    .from("group_execution_mandates")
    .select("id", { count: "exact", head: true })
    .eq("group_id", binding.group_id)
    .eq("status", "ACTIVE");
  if (mandateError) throw mandateError;
  if (!Number(count || 0)) {
    await auditGroupSignalBlocked(strategy, binding, signalKey, "NO_ACTIVE_GROUP_MANDATES");
    return;
  }

  const clientIntentId = `strategy:${hashCanonicalPayload({ signalKey, bindingId: binding.id }).slice(0, 48)}`;
  const idempotencyKey = hashCanonicalPayload({ groupId: binding.group_id, clientIntentId });
  const now = new Date();
  const expiresAt = new Date(now.getTime() + Math.max(60_000, timeframeMilliseconds(strategy.timeframe))).toISOString();
  const policy = normalizeCapitalPolicy(bindingPolicy(binding), binding.market_type, { allowZeroAllocation: false });
  const row: JsonRow = {
    id: crypto.randomUUID(),
    group_id: binding.group_id,
    strategy_automation_id: strategy.id,
    strategy_target_binding_id: binding.id,
    created_by: strategy.owner_user_id,
    client_intent_id: clientIntentId,
    symbol: String(strategy.symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
    market_type: binding.market_type === "SPOT" ? "SPOT" : "PERPETUAL",
    side: signal.direction === "short" ? "SELL" : "BUY",
    order_type: "MARKET",
    quantity_model: "MANDATE_ALLOCATION",
    quantity_value: 1,
    leverage: binding.market_type === "SPOT" ? null : sideSpecificLeverage(strategy.definition, signal.direction, binding),
    margin_mode: binding.market_type === "SPOT" ? null : String(policy.marginMode || "CROSS").toUpperCase(),
    time_in_force: "IOC",
    reduce_only: false,
    take_profit: nullablePositiveValue(signal.takeProfit),
    stop_loss: nullablePositiveValue(signal.stopLoss),
    valid_from: now.toISOString(),
    expires_at: expiresAt,
    status: "QUEUED",
    intent_version: 1,
    mandate_policy_version: 1,
    idempotency_key: idempotencyKey,
    strategy_action: "SYNC_DIRECTION",
    strategy_direction: signal.direction,
    strategy_execution_policy: {
      conflictResolution: strategy.definition?.execution?.perpetualSignalReversalEnabled === true
        ? "CLOSE_THEN_REVERSE"
        : String(strategy.definition?.execution?.conflictResolution || "CLOSE_ONLY").toUpperCase(),
      stopReversalEnabled: strategy.definition?.execution?.stopReversalEnabled === true,
      strategyVersion: strategy.current_version,
      candleTime: signal.timestamp,
      takeProfits: Array.isArray(signal.takeProfits) ? signal.takeProfits : [],
      requestedLeverage: sideSpecificLeverage(strategy.definition, signal.direction, binding),
      slippageTicks: Number(strategy.definition?.execution?.slippageTicks || 0),
    },
  };
  const envelope = intentSigningPayload(row);
  row.canonical_hash = hashCanonicalPayload(envelope);
  row.service_signature = signCanonicalPayload(envelope);
  const { data: intent, error: intentError } = await supabase
    .from("group_trade_intents")
    .upsert(row, { onConflict: "group_id,client_intent_id", ignoreDuplicates: true })
    .select("id")
    .maybeSingle();
  if (intentError) throw intentError;
  const intentId = intent?.id || (await existingGroupIntent(binding.group_id, clientIntentId));
  if (!intentId) return;
  const { error: versionError } = await supabase.from("group_trade_intent_versions").upsert({
    group_intent_id: intentId,
    version: 1,
    canonical_payload: envelope,
    canonical_hash: row.canonical_hash,
    service_signature: row.service_signature,
    created_by: strategy.owner_user_id,
  }, { onConflict: "group_intent_id,version", ignoreDuplicates: true });
  if (versionError) throw versionError;
  const { error: commandError } = await supabase.from("execution_commands").upsert({
    command_type: "EXPAND_GROUP_INTENT",
    group_intent_id: intentId,
    strategy_automation_id: strategy.id,
    strategy_target_binding_id: binding.id,
    strategy_signal_key: `${signalKey}:${binding.id}:group`,
    idempotency_key: `expand:${idempotencyKey}`,
    payload: { groupIntentId: intentId },
    status: "QUEUED",
    priority: 20,
  }, { onConflict: "idempotency_key", ignoreDuplicates: true });
  if (commandError) throw commandError;
  if (Array.isArray(signal.takeProfits)) {
    for (const [index, target] of signal.takeProfits.slice(0, 7).entries()) {
      const targetId = String(target?.id || `TP${index + 1}`).toUpperCase();
      const targetClientIntentId = `strategy:${hashCanonicalPayload({ signalKey, bindingId: binding.id, targetId }).slice(0, 48)}`;
      const targetIdempotencyKey = hashCanonicalPayload({ groupId: binding.group_id, clientIntentId: targetClientIntentId });
      const targetRow: JsonRow = {
        ...row,
        id: crypto.randomUUID(),
        client_intent_id: targetClientIntentId,
        side: signal.direction === "short" ? "BUY" : "SELL",
        order_type: "LIMIT",
        limit_price: Number(target?.price),
        leverage: null,
        reduce_only: true,
        take_profit: null,
        stop_loss: null,
        strategy_action: "TAKE_PROFIT",
        strategy_execution_policy: { strategyVersion: strategy.current_version, candleTime: signal.timestamp, targetId, quantityPercent: Number(target?.quantityPercent) },
        idempotency_key: targetIdempotencyKey,
      };
      const targetEnvelope = intentSigningPayload(targetRow);
      targetRow.canonical_hash = hashCanonicalPayload(targetEnvelope);
      targetRow.service_signature = signCanonicalPayload(targetEnvelope);
      const { data: targetIntent, error: targetIntentError } = await supabase.from("group_trade_intents").upsert(targetRow, { onConflict: "group_id,client_intent_id", ignoreDuplicates: true }).select("id").maybeSingle();
      if (targetIntentError) throw targetIntentError;
      const targetIntentId = targetIntent?.id || (await existingGroupIntent(binding.group_id, targetClientIntentId));
      if (!targetIntentId) continue;
      const { error: targetVersionError } = await supabase.from("group_trade_intent_versions").upsert({ group_intent_id: targetIntentId, version: 1, canonical_payload: targetEnvelope, canonical_hash: targetRow.canonical_hash, service_signature: targetRow.service_signature, created_by: strategy.owner_user_id }, { onConflict: "group_intent_id,version", ignoreDuplicates: true });
      if (targetVersionError) throw targetVersionError;
      const { error: targetCommandError } = await supabase.from("execution_commands").upsert({ command_type: "EXPAND_GROUP_INTENT", group_intent_id: targetIntentId, strategy_automation_id: strategy.id, strategy_target_binding_id: binding.id, strategy_signal_key: `${signalKey}:${binding.id}:group:${targetId.toLowerCase()}`, idempotency_key: `expand:${targetIdempotencyKey}`, payload: { groupIntentId: targetIntentId }, status: "QUEUED", priority: 40 + index }, { onConflict: "idempotency_key", ignoreDuplicates: true });
      if (targetCommandError) throw targetCommandError;
    }
  }
  await supabase.from("strategy_automation_audit_events").insert({
    owner_user_id: strategy.owner_user_id,
    strategy_id: strategy.id,
    binding_id: binding.id,
    event_type: "STRATEGY_GROUP_INTENT_QUEUED",
    severity: "INFO",
    message: "A confirmed closed-candle signal queued one signed, idempotent Investment Group intent.",
    safe_metadata: { signalKey, groupId: binding.group_id, symbol: row.symbol, direction: signal.direction, authorizedMandates: Number(count || 0) },
  });
}

async function existingGroupIntent(groupId: string, clientIntentId: string) {
  const { data, error } = await supabase.from("group_trade_intents").select("id").eq("group_id", groupId).eq("client_intent_id", clientIntentId).maybeSingle();
  if (error) throw error;
  return data?.id || null;
}

async function auditGroupSignalBlocked(strategy: JsonRow, binding: JsonRow, signalKey: string, reason: string) {
  await supabase.from("strategy_automation_audit_events").insert({
    owner_user_id: strategy.owner_user_id,
    strategy_id: strategy.id,
    binding_id: binding.id,
    event_type: "STRATEGY_GROUP_SIGNAL_BLOCKED",
    severity: "WARNING",
    message: "A strategy signal was blocked before Investment Group fanout.",
    safe_metadata: { signalKey, reason },
  });
}

function bindingPolicy(binding: JsonRow) {
  return {
    strategyAllocationMode: binding.strategy_allocation_mode,
    strategyAllocationValue: binding.strategy_allocation_value,
    tradeAmountMode: binding.trade_amount_mode,
    tradeAmountValue: binding.trade_amount_value,
    requestedLeverage: binding.requested_leverage,
    requestedLongLeverage: binding.requested_long_leverage ?? binding.requested_leverage,
    requestedShortLeverage: binding.requested_short_leverage ?? binding.requested_leverage,
    maximumLeverage: binding.maximum_leverage,
    maximumPositionPercent: binding.maximum_position_percent,
    maximumExposurePercent: binding.maximum_exposure_percent,
    maximumDailyLoss: binding.maximum_daily_loss,
    maximumDrawdown: binding.maximum_drawdown,
    maximumPositions: binding.maximum_positions,
    slippageBps: binding.slippage_bps,
    marginMode: binding.margin_mode,
  };
}

function nullablePositiveValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function sideSpecificLeverage(definition: JsonRow, direction: unknown, target: JsonRow) {
  const execution = definition?.execution || {};
  const policy = target?.capital_policy || target?.capitalPolicy || {};
  const short = String(direction).toLowerCase() === "short";
  const targetSelected = short
    ? target?.requested_short_leverage ?? policy.requestedShortLeverage
    : target?.requested_long_leverage ?? policy.requestedLongLeverage;
  const definitionSelected = short ? execution.shortLeverage : execution.longLeverage;
  const fallback = target?.requested_leverage ?? policy.requestedLeverage ?? definitionSelected ?? 1;
  const leverage = Number(targetSelected ?? fallback);
  return Number.isFinite(leverage) && leverage >= 1 ? Math.min(1_000, leverage) : 1;
}

async function openPaperPosition(
  strategy: JsonRow,
  paper: JsonRow,
  candles: Candle[],
  candle: Candle,
  signal: JsonRow,
  signalKey: string,
  marketReferencePrice = candle.close,
) {
  const policy = normalizeCapitalPolicy(
    paper.capital_policy,
    paper.market_type,
    { allowZeroAllocation: false },
  );
  if (
    Number(paper.maximum_drawdown_percent || 0) >= policy.maximumDrawdown &&
    policy.maximumDrawdown > 0
  )
    return auditBlocked(strategy, signalKey, "MAXIMUM_DRAWDOWN");
  const startOfDay = new Date(candle.time * 1000);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { data: todayTrades, error: tradeError } = await supabase
    .from("strategy_automation_trades")
    .select("net_pnl")
    .eq("paper_account_id", paper.id)
    .eq("mode", "PAPER")
    .gte("closed_at", startOfDay.toISOString());
  if (tradeError) throw tradeError;
  const dailyPnl = (todayTrades || []).reduce(
    (sum, row) => sum + Number(row.net_pnl || 0),
    0,
  );
  if (policy.maximumDailyLoss > 0 && dailyPnl <= -policy.maximumDailyLoss)
    return auditBlocked(strategy, signalKey, "MAXIMUM_DAILY_LOSS");

  const leverage =
    paper.market_type === "SPOT"
      ? 1
      : calculateEffectiveLeverage({
          requested: sideSpecificLeverage(strategy.definition, signal.direction, paper) || policy.requestedLeverage,
          targetMaximum: policy.maximumLeverage,
        });
  const preview = calculateCapitalPreview({
    equity: Number(paper.demo_equity) + Number(paper.unrealized_pnl || 0),
    availableBalance: Number(paper.available_balance),
    policy: { ...policy, requestedLeverage: leverage },
    marketType: paper.market_type,
  });
  const slippage = Math.max(0, Number(policy.slippageBps || 0)) / 10_000;
  const entryPrice =
    marketReferencePrice * (signal.direction === "long" ? 1 + slippage : 1 - slippage);
  const feeRate = boundedNumber(
    strategy.definition?.execution?.feeRate,
    0.0006,
    0,
    0.02,
  );
  let quantity =
    policy.tradeAmountMode === "FIXED_QUANTITY"
      ? policy.tradeAmountValue
      : preview.estimatedNotional / Math.max(entryPrice, 1e-12);
  if (policy.tradeAmountMode === "RISK_PERCENT") {
    const stopDistance = signal.stopLoss
      ? Math.abs(entryPrice - Number(signal.stopLoss))
      : entryPrice * 0.01;
    const roundTripFrictionPerUnit = entryPrice * (feeRate * 2 + slippage * 2);
    quantity =
      stopDistance > 0
        ? preview.entryCapital / (stopDistance + roundTripFrictionPerUnit)
        : 0;
  }
  if (policy.tradeAmountMode === "VOLATILITY_TARGET") {
    const atr = averageTrueRange(candles, 14);
    const stopDistance = signal.stopLoss
      ? Math.abs(entryPrice - Number(signal.stopLoss))
      : 0;
    const unitRisk =
      Math.max(atr, stopDistance, entryPrice * 0.001) +
      entryPrice * (feeRate * 2 + slippage * 2);
    quantity = preview.entryCapital / unitRisk;
  }
  const maximumPositionNotional =
    ((preview.allocatedStrategyCapital * policy.maximumPositionPercent) / 100) *
    leverage;
  const maximumExposureNotional =
    ((preview.allocatedStrategyCapital * policy.maximumExposurePercent) / 100) *
    leverage;
  const maximumSpotNotional =
    paper.market_type === "SPOT"
      ? Number(preview.maximumBaseAssetExposure || 0)
      : Number.POSITIVE_INFINITY;
  quantity = Math.min(
    quantity,
    maximumPositionNotional / Math.max(entryPrice, 1e-12),
    maximumExposureNotional / Math.max(entryPrice, 1e-12),
    maximumSpotNotional / Math.max(entryPrice, 1e-12),
  );
  const notional = quantity * entryPrice;
  const margin = paper.market_type === "SPOT" ? notional : notional / leverage;
  const entryFee = String(strategy.definition?.execution?.commissionMode || "PERCENT") === "USDT_PER_ORDER"
    ? boundedNumber(strategy.definition?.execution?.commissionValue, 0, 0, 1_000_000)
    : notional * feeRate;
  if (
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    margin + entryFee > Number(paper.available_balance)
  )
    return auditBlocked(strategy, signalKey, "INSUFFICIENT_PAPER_CAPITAL");
  const maintenance = boundedNumber(
    strategy.definition?.execution?.maintenanceMarginRate,
    0.005,
    0,
    0.2,
  );
  const liquidationPrice =
    paper.market_type === "SPOT"
      ? null
      : signal.direction === "long"
        ? Math.max(0, entryPrice * (1 - 1 / leverage + maintenance))
        : entryPrice * (1 + 1 / leverage - maintenance);
  const { data, error } = await supabase.rpc("black_core_paper_open_position", {
    p_paper_account_id: paper.id,
    p_strategy_id: strategy.id,
    p_owner_user_id: strategy.owner_user_id,
    p_signal_key: signalKey,
    p_symbol: strategy.symbol,
    p_side: signal.direction === "long" ? "LONG" : "SHORT",
    p_quantity: quantity,
    p_entry_price: entryPrice,
    p_leverage: leverage,
    p_margin_used: margin,
    p_liquidation_price: liquidationPrice,
    p_stop_loss: signal.stopLoss || null,
    p_take_profit: null,
    p_entry_fee: entryFee,
    p_opened_at: new Date(
      candle.time * 1000 + timeframeMilliseconds(strategy.timeframe),
    ).toISOString(),
  });
  if (error) throw error;
  if (data === true) {
    const { error: planError } = await supabase.from("strategy_paper_positions").update({
      initial_quantity: quantity,
      // Pine creates/updates the seven strategy.exit orders only after the
      // entry fill is visible to the following strategy calculation.
      take_profit_plan: [],
      filled_take_profit_ids: [],
    }).eq("paper_account_id", paper.id).eq("signal_key", signalKey).is("closed_at", null);
    if (planError) throw planError;
  }
  return data === true;
}

async function managePaperPosition(
  strategy: JsonRow,
  paper: JsonRow,
  position: JsonRow,
  candles: Candle[],
  candle: Candle,
  signal: JsonRow | null,
  nextTickReference: number,
) {
  const candleClosedAt =
    candle.time * 1000 + timeframeMilliseconds(strategy.timeframe);
  if (candleClosedAt <= Date.parse(position.opened_at)) return { closed: false, reason: null };
  const direction = position.side === "LONG" ? 1 : -1;
  const unrealized =
    (candle.close - Number(position.entry_price)) *
    Number(position.quantity) *
    direction;
  const { error: markError } = await supabase.rpc(
    "black_core_paper_mark_position",
    {
      p_position_id: position.id,
      p_owner_user_id: strategy.owner_user_id,
      p_mark_price: candle.close,
      p_unrealized_pnl: unrealized,
    },
  );
  if (markError) throw markError;
  const partialResult = await fillPaperTakeProfitPlan(strategy, paper, position, candle, candleClosedAt);
  if (partialResult.closed) return partialResult;
  if (partialResult.filled) {
    await refreshPaperTakeProfitPlan(strategy, paper, position, candles);
    return { closed: false, reason: partialResult.reason };
  }
  let reason: string | null = null;
  let reference = candle.close;
  if (
    position.liquidation_price &&
    (position.side === "LONG"
      ? candle.low <= Number(position.liquidation_price)
      : candle.high >= Number(position.liquidation_price))
  ) {
    reason = "LIQUIDATION";
    reference = Number(position.liquidation_price);
  } else if (
    position.stop_loss &&
    (position.side === "LONG"
      ? candle.low <= Number(position.stop_loss)
      : candle.high >= Number(position.stop_loss))
  ) {
    reason = "STOP_LOSS";
    reference = Number(position.stop_loss);
  } else if (
    position.take_profit &&
    (position.side === "LONG"
      ? candle.high >= Number(position.take_profit)
      : candle.low <= Number(position.take_profit))
  ) {
    reason = "TAKE_PROFIT";
    reference = Number(position.take_profit);
  }
  if (!reason && signal && ((position.side === "LONG" && signal.direction === "short") || (position.side === "SHORT" && signal.direction === "long"))) {
    const conflictResolution = strategy.definition?.execution?.perpetualSignalReversalEnabled === true
      ? "CLOSE_THEN_REVERSE"
      : String(strategy.definition?.execution?.conflictResolution || "CLOSE_ONLY").toUpperCase();
    if (conflictResolution !== "IGNORE") {
      reason = "OPPOSITE_SIGNAL";
      reference = nextTickReference;
    }
  }
  if (!reason) {
    await refreshPaperTakeProfitPlan(strategy, paper, position, candles);
    return { closed: false, reason: null };
  }
  const policy = normalizeCapitalPolicy(
    paper.capital_policy,
    paper.market_type,
    { allowZeroAllocation: false },
  );
  const slippage = Math.max(0, Number(policy.slippageBps || 0)) / 10_000;
  const exitPrice =
    reference * (position.side === "LONG" ? 1 - slippage : 1 + slippage);
  const notional = Math.abs(exitPrice * Number(position.quantity));
  const exitFee = String(strategy.definition?.execution?.commissionMode || "PERCENT") === "USDT_PER_ORDER"
    ? boundedNumber(strategy.definition?.execution?.commissionValue, 0, 0, 1_000_000)
    : notional * boundedNumber(strategy.definition?.execution?.feeRate, 0.0006, 0, 0.02);
  const days =
    Math.max(0, candle.time * 1000 - Date.parse(position.opened_at)) /
    86_400_000;
  const funding =
    Math.abs(Number(position.entry_price) * Number(position.quantity)) *
    boundedNumber(
      strategy.definition?.execution?.fundingRatePerDay,
      0,
      -0.1,
      0.1,
    ) *
    days;
  const exitSignalKey = `${position.signal_key}:exit:${candle.time}:${reason}`;
  const { data, error } = await supabase.rpc(
    "black_core_paper_close_position",
    {
      p_position_id: position.id,
      p_owner_user_id: strategy.owner_user_id,
      p_exit_price: exitPrice,
      p_exit_fee: exitFee,
      p_funding: funding,
      p_exit_reason: reason,
      p_exit_signal_key: exitSignalKey,
      p_closed_at: new Date(candleClosedAt).toISOString(),
    },
  );
  if (error) throw error;
  return { closed: data === true, reason: data === true ? reason : null };
}

async function fillPaperTakeProfitPlan(strategy: JsonRow, paper: JsonRow, position: JsonRow, candle: Candle, candleClosedAt: number) {
  const plan = Array.isArray(position.take_profit_plan) ? position.take_profit_plan : [];
  if (!plan.length) return { filled: false, closed: false, reason: null as string | null };
  const filled = new Set(Array.isArray(position.filled_take_profit_ids) ? position.filled_take_profit_ids.map(String) : []);
  const initialQuantity = Math.max(Number(position.initial_quantity || position.quantity), Number(position.quantity));
  let remaining = Number(position.quantity);
  let anyFilled = false;
  let lastReason: string | null = null;
  const policy = normalizeCapitalPolicy(paper.capital_policy, paper.market_type, { allowZeroAllocation: false });
  const slippage = Math.max(0, Number(policy.slippageBps || 0)) / 10_000;
  const feeRate = boundedNumber(strategy.definition?.execution?.feeRate, 0.0006, 0, 0.02);
  for (const [index, target] of plan.entries()) {
    const id = String(target?.id || `TP${index + 1}`).slice(0, 16);
    const targetPrice = Number(target?.price);
    if (filled.has(id) || !Number.isFinite(targetPrice) || targetPrice <= 0 || remaining <= 0) continue;
    const reached = position.side === "LONG" ? candle.high >= targetPrice : candle.low <= targetPrice;
    if (!reached) continue;
    const requested = initialQuantity * Math.max(0.1, Math.min(100, Number(target?.quantityPercent || 0))) / 100;
    const quantity = Math.min(remaining, requested);
    if (quantity <= 0) continue;
    const exitPrice = targetPrice * (position.side === "LONG" ? 1 - slippage : 1 + slippage);
    const exitFee = String(strategy.definition?.execution?.commissionMode || "PERCENT") === "USDT_PER_ORDER"
      ? boundedNumber(strategy.definition?.execution?.commissionValue, 0, 0, 1_000_000)
      : Math.abs(exitPrice * quantity) * feeRate;
    const reason = id.toUpperCase().startsWith("TP") ? id.toUpperCase() : `TP${index + 1}`;
    const signalKey = `${position.signal_key}:exit:${candle.time}:${reason}`;
    const { data, error } = await supabase.rpc("black_core_paper_partial_close_position", {
      p_position_id: position.id,
      p_owner_user_id: strategy.owner_user_id,
      p_exit_price: exitPrice,
      p_exit_quantity: quantity,
      p_exit_fee: exitFee,
      p_funding: 0,
      p_exit_reason: reason,
      p_exit_signal_key: signalKey,
      p_take_profit_id: id,
      p_closed_at: new Date(candleClosedAt).toISOString(),
    });
    if (error) throw error;
    if (data === true) {
      anyFilled = true;
      filled.add(id);
      remaining = Math.max(0, remaining - quantity);
      lastReason = reason;
    }
  }
  position.filled_take_profit_ids = [...filled];
  position.quantity = remaining;
  return { filled: anyFilled, closed: remaining <= 1e-12, reason: lastReason };
}

async function refreshPaperTakeProfitPlan(strategy: JsonRow, paper: JsonRow, position: JsonRow, candles: Candle[]) {
  if (strategy.runtime_kind !== "builtin-superatr-seven-step") return;
  const direction = position.side === "LONG" ? "long" : "short";
  const targets = superAtrTakeProfitPlan(
    candles,
    direction,
    Number(position.entry_price),
    strategy.definition?.settings || {},
  );
  const filled = new Set(Array.isArray(position.filled_take_profit_ids) ? position.filled_take_profit_ids.map(String) : []);
  const plan = targets.filter((target) => !filled.has(target.id));
  const { error } = await supabase.from("strategy_paper_positions").update({
    take_profit_plan: plan,
  }).eq("id", position.id).eq("paper_account_id", paper.id).is("closed_at", null);
  if (error) throw error;
}

async function openPaperRevengePosition(strategy: JsonRow, paper: JsonRow, stoppedPosition: JsonRow, candles: Candle[], candle: Candle) {
  const execution = strategy.definition?.execution || {};
  const maximumChain = boundedInteger(execution.maximumReversalChain, 1, 1, 5);
  const chainDepth = (String(stoppedPosition.signal_key).match(/:revenge:/g) || []).length;
  if (chainDepth >= maximumChain) return auditBlocked(strategy, stoppedPosition.signal_key, "MAXIMUM_REVERSAL_CHAIN");
  const startOfDay = new Date(candle.time * 1000);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count, error: countError } = await supabase.from("strategy_automation_audit_events").select("id", { count: "exact", head: true }).eq("strategy_id", strategy.id).eq("event_type", "PAPER_REVENGE_REVERSAL_FILLED").gte("created_at", startOfDay.toISOString());
  if (countError) throw countError;
  const maximumPerDay = boundedInteger(execution.maximumReversalsPerDay, 2, 1, 20);
  if (Number(count || 0) >= maximumPerDay) return auditBlocked(strategy, stoppedPosition.signal_key, "MAXIMUM_REVERSALS_PER_DAY");
  const maximumConsecutiveLosses = boundedInteger(execution.maximumConsecutiveLosses, 3, 1, 100);
  const { data: recentTrades, error: tradeError } = await supabase.from("strategy_automation_trades")
    .select("net_pnl")
    .eq("paper_account_id", paper.id)
    .eq("mode", "PAPER")
    .order("closed_at", { ascending: false })
    .limit(maximumConsecutiveLosses);
  if (tradeError) throw tradeError;
  const consecutiveLosses = (recentTrades || []).findIndex((trade) => Number(trade.net_pnl || 0) >= 0);
  const lossCount = consecutiveLosses === -1 ? (recentTrades || []).length : consecutiveLosses;
  if (lossCount >= maximumConsecutiveLosses) return auditBlocked(strategy, stoppedPosition.signal_key, "MAXIMUM_CONSECUTIVE_LOSSES");
  const cooldownBars = boundedInteger(execution.reversalCooldownBars, 0, 0, 10_000);
  if (cooldownBars > 0) return auditBlocked(strategy, stoppedPosition.signal_key, "REVERSAL_COOLDOWN_ACTIVE");
  const direction = stoppedPosition.side === "LONG" ? "short" : "long";
  const signalKey = `${stoppedPosition.signal_key}:revenge:${candle.time}:${direction}`;
  const priorRiskDistance = stoppedPosition.stop_loss
    ? Math.abs(Number(stoppedPosition.entry_price) - Number(stoppedPosition.stop_loss))
    : Number(stoppedPosition.entry_price) * 0.01;
  const stopLoss = direction === "long"
    ? Math.max(0, candle.close - priorRiskDistance)
    : candle.close + priorRiskDistance;
  const opened = await openPaperPosition(strategy, paper, candles, candle, { timestamp: candle.time, symbol: strategy.symbol, direction, entry: true, stopLoss, signalName: "Stop-Loss Revenge Reversal" }, signalKey);
  if (opened) await supabase.from("strategy_automation_audit_events").insert({ owner_user_id: strategy.owner_user_id, strategy_id: strategy.id, event_type: "PAPER_REVENGE_REVERSAL_FILLED", severity: "WARNING", message: "A bounded stop-loss reversal opened after the prior position was authoritatively closed.", safe_metadata: { priorPositionId: stoppedPosition.id, signalKey, chainDepth: chainDepth + 1 } });
  return opened;
}

async function auditBlocked(
  strategy: JsonRow,
  signalKey: string,
  reason: string,
) {
  await supabase.from("strategy_automation_audit_events").insert({
    owner_user_id: strategy.owner_user_id,
    strategy_id: strategy.id,
    event_type: "PAPER_ENTRY_RISK_BLOCKED",
    severity: "WARNING",
    message: "A paper entry was blocked by its capital and risk policy.",
    safe_metadata: { signalKey, reason },
  });
  return false;
}

async function heartbeat(
  strategy: JsonRow,
  state: string,
  safeErrorCode: string | null,
) {
  const { data: current } = await supabase
    .from("strategy_automation_runtime_state")
    .select("state_version")
    .eq("strategy_id", strategy.id)
    .maybeSingle();
  const { error } = await supabase
    .from("strategy_automation_runtime_state")
    .upsert(
      {
        strategy_id: strategy.id,
        owner_user_id: strategy.owner_user_id,
        runtime_state: state,
        running_version: strategy.current_version,
        state_version: Number(current?.state_version || 0) + 1,
        last_heartbeat_at: new Date().toISOString(),
        worker_id: workerId,
        lease_owner: workerId,
        lease_expires_at: new Date(
          Date.now() + leaseSeconds * 1000,
        ).toISOString(),
        safe_error_code: safeErrorCode,
      },
      { onConflict: "strategy_id" },
    );
  if (error) throw error;
}

async function markFailure(strategy: JsonRow, error: unknown) {
  const code = safeCode(error);
  console.error(
    JSON.stringify({
      level: "error",
      event: "strategy_automation_strategy_failed",
      strategyId: strategy.id,
      code,
    }),
  );
  await heartbeat(strategy, "ERROR", code).catch(() => undefined);
}

async function fetchBybitCandleWindow(
  symbol: string,
  timeframe: string,
  marketType: string,
): Promise<{ closed: Candle[]; current: Candle | null }> {
  const interval = bybitInterval(timeframe);
  const category = marketType === "SPOT" ? "spot" : "linear";
  const url = new URL("https://api.bybit.com/v5/market/kline");
  url.searchParams.set("category", category);
  url.searchParams.set(
    "symbol",
    String(symbol)
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase(),
  );
  url.searchParams.set("interval", interval.value);
  url.searchParams.set("limit", "500");
  const response = await fetch(url, {
    signal: AbortSignal.timeout(8_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok)
    throw Object.assign(new Error("Bybit public candle request failed."), {
      code: `MARKET_DATA_HTTP_${response.status}`,
    });
  const payload = await response.json();
  if (Number(payload.retCode) !== 0 || !Array.isArray(payload.result?.list))
    throw Object.assign(
      new Error("Bybit public candle payload was rejected."),
      { code: "MARKET_DATA_PAYLOAD_INVALID" },
    );
  const now = Date.now();
  const candles = payload.result.list
    .map((row: string[]) => ({
      time: Math.floor(Number(row[0]) / 1000),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }))
    .filter((candle: Candle) => Number.isFinite(candle.close))
    .sort((a: Candle, b: Candle) => a.time - b.time);
  return {
    closed: candles.filter((candle: Candle) => candle.time * 1000 + interval.milliseconds <= now),
    current: candles.find((candle: Candle) => candle.time * 1000 <= now && candle.time * 1000 + interval.milliseconds > now) || null,
  };
}

function bybitInterval(timeframe: string) {
  const normalized = String(timeframe).trim();
  const direct: Record<string, [string, number]> = {
    "1m": ["1", 60_000],
    "3m": ["3", 180_000],
    "5m": ["5", 300_000],
    "15m": ["15", 900_000],
    "30m": ["30", 1_800_000],
    "1h": ["60", 3_600_000],
    "2h": ["120", 7_200_000],
    "4h": ["240", 14_400_000],
    "6h": ["360", 21_600_000],
    "12h": ["720", 43_200_000],
    "1d": ["D", 86_400_000],
    "1D": ["D", 86_400_000],
    "1w": ["W", 604_800_000],
    "1W": ["W", 604_800_000],
    "1M": ["M", 2_419_200_000],
  };
  const match = direct[normalized];
  if (!match)
    throw Object.assign(new Error("Unsupported paper runtime timeframe."), {
      code: "TIMEFRAME_UNSUPPORTED",
    });
  return { value: match[0], milliseconds: match[1] };
}

function timeframeMilliseconds(timeframe: string) {
  return bybitInterval(timeframe).milliseconds;
}

function averageTrueRange(candles: Candle[], length: number) {
  if (candles.length < 2) return 0;
  const start = Math.max(1, candles.length - Math.max(2, length));
  let total = 0;
  let count = 0;
  for (let index = start; index < candles.length; index += 1) {
    const candle = candles[index];
    const previousClose = candles[index - 1].close;
    total += Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
    count += 1;
  }
  return count ? total / count : 0;
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
) {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        await task(items[index]);
      }
    },
  );
  await Promise.all(workers);
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function safeCode(error: unknown) {
  const raw = String(
    (error as any)?.code || (error as any)?.name || "STRATEGY_RUNTIME_FAILURE",
  )
    .toUpperCase()
    .replace(/[^A-Z0-9_:-]/g, "_");
  return raw.slice(0, 100);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
