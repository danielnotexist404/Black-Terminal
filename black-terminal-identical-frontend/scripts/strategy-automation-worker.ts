import crypto from "node:crypto";
import { getSupabaseAdmin } from "../server/portfolio-api.js";
import {
  calculateCapitalPreview,
  calculateEffectiveLeverage,
  normalizeCapitalPolicy,
} from "../server/strategy-automation/domain.js";
import {
  createStrategySignals,
  positionAwareStrategyEntries,
  superAtrRequiredSeedBars,
  superAtrTakeProfitPlan,
} from "../src/modules/strategy-lab/adapters/signalAdapter.ts";
import {
  hashCanonicalPayload,
  intentSigningPayload,
  signCanonicalPayload,
} from "../server/cloud-execution/canonical.js";
import {
  reserveStrategyTakeProfits,
  shouldQueueStrategyTakeProfits,
} from "../server/strategy-automation/superatr-execution.js";
import {
  blackScriptOwnedSourceVersion,
  evaluateBlackScriptCloudRuntime,
  isBlackScriptV3CloudEligibleSource,
  type BlackScriptCloudCheckpoint,
} from "../src/modules/strategy-lab/adapters/blackScriptCloudRuntime.ts";
import {
  buildBlackScriptBrokerPlan,
  buildBlackScriptTargetCommandManifest,
  assertBlackScriptExpectedTargetFills,
  settleBlackScriptTargetMarketActions,
  type BlackScriptBrokerOrderHandle,
  type BlackScriptTargetCommandManifest,
} from "../src/modules/strategy-lab/adapters/blackScriptBrokerPlanner.ts";
import { readStrategyControlPanel } from "../src/modules/strategy-lab/execution-desk/strategyControlPanelModel.ts";
import { strategyMagnifierTimeframe } from "../src/modules/strategy-lab/adapters/marketDataAdapter.ts";
import { normalizeUserScripts } from "../src/scripts/userScriptLibrary.ts";
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
const ACTIVE_EXECUTION_ORDER_STATUSES = ["pending", "accepted", "working", "partially-filled"];
const MAX_STRATEGY_GENERATION_RECOVERY_MS = 7 * 24 * 60 * 60 * 1000;
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
    !["builtin-ema-cross", "builtin-adaptive-swing", "builtin-superatr-seven-step", "python-script"].includes(
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
  if (strategy.runtime_kind === "python-script") {
    return processBlackScriptStrategy({
      strategy,
      runtime,
      activePaper,
      activeBrokerBindings,
      groupBindings,
      marketWindow,
    });
  }
  const candleAt = new Date(
    candleCloseTimeMs(candle.time, strategy.timeframe),
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
  // Pine evaluates the setup on every bar, but strategy.entry with
  // pyramiding=1 ignores a same-direction call while that virtual position is
  // already open. Reconstruct those position transitions before looking at the
  // current bar; otherwise a newly armed flat broker can receive a duplicate
  // mid-trend entry that TradingView correctly suppresses.
  const transitions = positionAwareStrategyEntries(
    signals,
    Number(strategy.definition?.execution?.pyramiding || 1),
  );
  // The checkpoint is advanced only after every target generation is durable.
  // If the worker dies before the atomic enqueue RPC, the next candle may have
  // advanced; replay the latest transition after the prior checkpoint instead
  // of considering only the newest candle and silently losing that signal.
  const candidateSignal = latestUnprocessedStrategyTransition(
    transitions,
    runtime,
    candle.time,
    strategy.timeframe,
  );
  // A rolling 1,000-bar seed can forget the virtual Pine position that began
  // before the window and reconstruct a same-direction transition inside the
  // new window. The durable last signal is the authoritative virtual side: a
  // catch-up transition is executable only when it changes that side. This
  // also makes a restart after an atomic enqueue idempotent at strategy level.
  const persistedDirection = strategyDirectionFromSignalKey(runtime?.last_signal_key);
  const signal = candidateSignal && candidateSignal.direction !== persistedDirection
    ? candidateSignal
    : undefined;
  let closeResult: { closed: boolean; reason: string | null } = { closed: false, reason: null };
  const nextTickReference = marketWindow.current?.time === nextCandleOpenTimeSeconds(candle.time, strategy.timeframe)
    ? marketWindow.current.open
    : candle.close;
  if (position) closeResult = await managePaperPosition(strategy, activePaper, position, candles, candle, signal || null, nextTickReference);
  if (signal) {
    const signalCandleTime = Number(signal.timestamp);
    signalKey = `${strategy.id}:${strategy.current_version}:${strategy.symbol}:${strategy.timeframe}:${signalCandleTime}:${signal.direction}`;
    signalAt = new Date(candleCloseTimeMs(signalCandleTime, strategy.timeframe)).toISOString();
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
  if (strategy.runtime_kind === "builtin-superatr-seven-step") {
    for (const binding of activeBrokerBindings) {
      await enqueueBrokerTakeProfitReprices(strategy, binding, candles, candle);
    }
    for (const binding of groupBindings) {
      await enqueueGroupTakeProfitReprices(strategy, binding, candles, candle);
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
        pine_checkpoint: strategy.runtime_kind === "builtin-superatr-seven-step"
          ? buildSuperAtrCheckpoint(strategy, runtime, candles, candle, transitions)
          : runtime?.pine_checkpoint || {},
        source_sha256: strategySourceFingerprint(strategy),
        settings_sha256: hashCanonicalPayload(strategy.definition),
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

async function loadOrPinBlackScriptArtifact(strategy: JsonRow) {
  const indicatorId = String(strategy.definition?.indicator?.indicatorId || "");
  if (!indicatorId.startsWith("custom:")) {
    throw Object.assign(new Error("A headless Black Script strategy requires an owned custom source identity."), {
      code: "BLACK_SCRIPT_OWNED_SOURCE_REQUIRED",
    });
  }
  const scriptId = indicatorId.slice("custom:".length);
  const expectedVersion = String(strategy.definition?.indicator?.version || "");
  if (!/^[0-9a-f]{8}$/.test(expectedVersion)) {
    throw Object.assign(new Error("The published Black Script source version is invalid."), {
      code: "BLACK_SCRIPT_SOURCE_VERSION_INVALID",
    });
  }
  const { data: pinned, error: pinnedError } = await supabase
    .from("strategy_script_artifacts")
    .select("script_id,runtime_version,source_version,source_sha256,source")
    .eq("strategy_id", strategy.id)
    .eq("strategy_version", strategy.current_version)
    .maybeSingle();
  if (pinnedError) throw pinnedError;
  if (pinned) {
    const sha256 = crypto.createHash("sha256").update(String(pinned.source)).digest("hex");
    if (pinned.script_id !== scriptId
      || pinned.runtime_version !== "black-script-v3"
      || pinned.source_version !== expectedVersion
      || blackScriptOwnedSourceVersion(String(pinned.source)) !== expectedVersion
      || pinned.source_sha256 !== sha256) {
      throw Object.assign(new Error("The immutable Black Script artifact failed its source identity check."), {
        code: "BLACK_SCRIPT_ARTIFACT_INTEGRITY_FAILED",
      });
    }
    return { ...pinned, source: String(pinned.source) };
  }

  const { data: profile, error: profileError } = await supabase
    .from("bt_users")
    .select("scripts")
    .eq("auth_user_id", strategy.owner_user_id)
    .maybeSingle();
  if (profileError) throw profileError;
  const sourceRow = normalizeUserScripts(profile?.scripts).find((row) => row.id === scriptId && row.kind === "strategy");
  if (!sourceRow) {
    throw Object.assign(new Error("The exact owned Black Script source is unavailable for pinning."), {
      code: "BLACK_SCRIPT_SOURCE_UNAVAILABLE",
    });
  }
  const sourceVersion = blackScriptOwnedSourceVersion(sourceRow.source);
  if (sourceVersion !== expectedVersion) {
    throw Object.assign(new Error("The owned script changed after this strategy version was published."), {
      code: "BLACK_SCRIPT_SOURCE_VERSION_MISMATCH",
    });
  }
  const sourceSha256 = crypto.createHash("sha256").update(sourceRow.source).digest("hex");
  const artifact = {
    strategy_id: strategy.id,
    strategy_version: strategy.current_version,
    owner_user_id: strategy.owner_user_id,
    script_id: scriptId,
    runtime_version: "black-script-v3",
    source_version: sourceVersion,
    source_sha256: sourceSha256,
    source: sourceRow.source,
  };
  const { error: pinError } = await supabase.from("strategy_script_artifacts").insert(artifact);
  if (pinError) throw pinError;
  return {
    script_id: scriptId,
    runtime_version: "black-script-v3",
    source_version: sourceVersion,
    source_sha256: sourceSha256,
    source: sourceRow.source,
  };
}

function blackScriptInputValues(settings: JsonRow) {
  return Object.fromEntries(Object.entries(settings || {}).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))) as Record<string, string | number | boolean>;
}

async function processBlackScriptStrategy({
  strategy,
  runtime,
  activePaper,
  activeBrokerBindings,
  groupBindings,
  marketWindow,
}: JsonRow) {
  const candle = marketWindow.closed.at(-1) as Candle | undefined;
  if (!candle) return heartbeat(strategy, "DEGRADED", "MARKET_DATA_UNAVAILABLE");
  const candleAt = new Date(candleCloseTimeMs(candle.time, strategy.timeframe)).toISOString();
  if (runtime?.last_closed_candle_at && Date.parse(runtime.last_closed_candle_at) >= Date.parse(candleAt)) {
    return heartbeat(strategy, "LIVE", null);
  }
  const artifact = await loadOrPinBlackScriptArtifact(strategy);
  const panel = readStrategyControlPanel(strategy.definition);
  if (panel.properties.pyramiding !== 1) {
    throw Object.assign(new Error("Black Cloud direct-broker execution currently requires pyramiding=1 so one deterministic virtual position maps to one venue position."), {
      code: "BLACK_SCRIPT_PYRAMIDING_NOT_CERTIFIED",
    });
  }
  if (activeBrokerBindings.some((binding: JsonRow) => binding.market_type !== "FUTURES")) {
    throw Object.assign(new Error("Black Script v3 direct-broker execution is currently certified for futures targets only."), {
      code: "BLACK_SCRIPT_SPOT_EXECUTION_NOT_CERTIFIED",
    });
  }
  const intrabars = panel.properties.barDetailization === "HIGH_LOWER_TIMEFRAME"
    ? await fetchBybitBlackScriptIntrabars({
      symbol: strategy.symbol,
      timeframe: strategy.timeframe,
      marketType: strategy.market_type,
      closedCandles: marketWindow.closed,
      checkpoint: runtime?.pine_checkpoint,
    })
    : undefined;
  const inputValues = blackScriptInputValues(strategy.definition?.settings || {});
  if (!isBlackScriptV3CloudEligibleSource(artifact.source, inputValues)) {
    throw Object.assign(new Error("The immutable Black Script source uses features that are not certified for headless execution."), {
      code: "BLACK_SCRIPT_RUNTIME_NOT_CERTIFIED",
    });
  }
  const checkpoint = runtime?.pine_checkpoint?.runtimeVersion === "black-script-v3"
    ? runtime.pine_checkpoint as BlackScriptCloudCheckpoint
    : null;
  const evaluation = evaluateBlackScriptCloudRuntime({
    source: artifact.source,
    expectedSourceVersion: artifact.source_version,
    settings: inputValues,
    closedCandles: marketWindow.closed,
    currentCandle: marketWindow.current,
    checkpoint,
    intrabars,
    runtimeConfig: {
      initialCapital: panel.properties.initialCapital,
      defaultQuantityMode: panel.properties.orderSizeMode === "FIXED_QUANTITY"
        ? "fixed"
        : panel.properties.orderSizeMode === "FIXED_USDT" ? "cash" : "percent_of_equity",
      defaultQuantityValue: panel.properties.orderSizeValue,
      commissionMode: panel.properties.commissionMode === "USDT_PER_ORDER" ? "cash_per_order" : "percent",
      commissionValue: panel.properties.commissionValue,
      slippageTicks: panel.properties.slippageTicks,
      tickSize: Number(strategy.definition?.execution?.tickSize || 0.01),
      pyramiding: panel.properties.pyramiding,
      processOrdersOnClose: panel.properties.executionDelay === "NONE",
      historicalFillMode: panel.properties.barDetailization === "CLOSED_BAR" ? "conservative" : "tradingview",
      useBarMagnifier: panel.properties.barDetailization === "HIGH_LOWER_TIMEFRAME",
    },
  });
  if (groupBindings.length) {
    return heartbeat(strategy, "DEGRADED", "BLACK_SCRIPT_GROUP_EXECUTION_PENDING");
  }
  const tickSize = Number(strategy.definition?.execution?.tickSize || 0.01);
  const plan = buildBlackScriptBrokerPlan({
    evaluation,
    previousCheckpoint: checkpoint,
    tickSize,
  });
  evaluation.checkpoint.brokerOrderFingerprints = plan.brokerOrderFingerprints;
  // Broker handles are per account and must never leak into the shared
  // strategy checkpoint. They live in strategy_script_target_state.
  evaluation.checkpoint.brokerOrderHandles = {};
  const targetManifests = await buildBlackScriptTargetManifests({
    strategy,
    evaluation,
    bindings: activeBrokerBindings,
    tickSize,
  });
  const { data: committed, error: commitError } = await supabase.rpc(
    "black_cloud_commit_script_generation_v1",
    {
      p_strategy_id: strategy.id,
      p_owner_user_id: strategy.owner_user_id,
      p_worker_id: workerId,
      p_expected_state_version: Number(runtime?.state_version || 0),
      p_running_version: strategy.current_version,
      p_last_closed_candle_at: candleAt,
      p_checkpoint: evaluation.checkpoint,
      p_source_sha256: artifact.source_sha256,
      p_settings_sha256: hashCanonicalPayload(strategy.definition),
      p_target_manifests: targetManifests,
    },
  );
  if (commitError) throw commitError;
  const expectedCommands = targetManifests.reduce((sum, manifest) => sum + manifest.commands.length, 0);
  if (Number(committed) !== expectedCommands) {
    throw Object.assign(new Error("The atomic Black Script generation did not persist its complete command manifest."), {
      code: "BLACK_SCRIPT_GENERATION_COMMIT_INCOMPLETE",
    });
  }
  if (evaluation.marketActions.length || evaluation.desiredOrders.length || evaluation.retiredOrderKeys.length) {
    await supabase.from("strategy_automation_audit_events").insert({
      owner_user_id: strategy.owner_user_id,
      strategy_id: strategy.id,
      event_type: "BLACK_SCRIPT_CLOUD_GENERATION_COMMITTED",
      severity: "INFO",
      message: "Black Cloud atomically committed a pinned confirmed-candle Black Script generation and every direct-broker OMS command.",
      safe_metadata: {
        sourceVersion: evaluation.sourceVersion,
        candleTime: evaluation.latestClosedCandleTime,
        targetCount: targetManifests.length,
        commandCount: expectedCommands,
        marketActionCount: evaluation.marketActions.length,
        desiredOrderCount: evaluation.desiredOrders.length,
        expectedOrderFillCount: evaluation.expectedOrderFills.length,
      },
    });
  }
  return undefined;
}

async function buildBlackScriptTargetManifests({
  strategy,
  evaluation,
  bindings,
  tickSize,
}: JsonRow): Promise<BlackScriptTargetCommandManifest[]> {
  if (!bindings.length) return [];
  const bindingIds = bindings.map((binding: JsonRow) => binding.id);
  const connectionIds = bindings.map((binding: JsonRow) => binding.connection_id).filter(Boolean);
  const accountIds = bindings.map((binding: JsonRow) => binding.account_id).filter(Boolean);
  const [
    { data: targetStates, error: stateError },
    { data: connections, error: connectionError },
    { data: positions, error: positionError },
  ] = await Promise.all([
    supabase.from("strategy_script_target_state").select("*").in("binding_id", bindingIds),
    supabase.from("connectivity_connections")
      .select("id,user_id,account_id,execution_environment,health_status,credential_state,worker_state,synchronization_state,execution_readiness,control_state")
      .in("id", connectionIds),
    supabase.from("account_positions")
      .select("account_id,strategy_target_binding_id,direction,quantity")
      .in("account_id", accountIds)
      .eq("symbol", strategy.symbol)
      .gt("quantity", 0),
  ]);
  if (stateError) throw stateError;
  if (connectionError) throw connectionError;
  if (positionError) throw positionError;
  const stateByBinding = new Map((targetStates || []).map((row) => [String(row.binding_id), row]));
  const connectionById = new Map((connections || []).map((row) => [String(row.id), row]));
  const priorPlaceKeys = [...new Set((targetStates || []).flatMap((state) =>
    Object.values(state.broker_order_handles && typeof state.broker_order_handles === "object" ? state.broker_order_handles : {})
      .filter((handle: any) => handle?.commandType === "PLACE_ORDER" && typeof handle.placeIdempotencyKey === "string")
      .map((handle: any) => handle.placeIdempotencyKey)))];
  const { data: placeCommands, error: commandError } = priorPlaceKeys.length
    ? await supabase.from("execution_commands")
      .select("idempotency_key,status,execution_order_id,strategy_target_binding_id")
      .eq("strategy_automation_id", strategy.id)
      .in("idempotency_key", priorPlaceKeys)
    : { data: [], error: null };
  if (commandError) throw commandError;
  const executionOrderIds = [...new Set((placeCommands || []).map((row) => row.execution_order_id).filter(Boolean))];
  const { data: acknowledgedOrders, error: acknowledgedError } = executionOrderIds.length
    ? await supabase.from("execution_orders")
      .select("id,status,quantity,filled_quantity,strategy_target_binding_id")
      .in("id", executionOrderIds)
    : { data: [], error: null };
  if (acknowledgedError) throw acknowledgedError;
  const manifests: BlackScriptTargetCommandManifest[] = [];
  for (const binding of bindings as JsonRow[]) {
    const connection = connectionById.get(String(binding.connection_id));
    const executionEnvironment = String(connection?.execution_environment || "");
    const environmentEnabled = executionEnvironment === "DEMO"
      ? demoExecutionEnabled
      : executionEnvironment === "MAINNET_LIVE" ? liveExecutionEnabled : false;
    if (!connection || connection.user_id !== strategy.owner_user_id
      || connection.account_id !== binding.account_id
      || !environmentEnabled
      || !["CONNECTED_CLOUD", "CONNECTED_HYBRID"].includes(connection.health_status)
      || connection.credential_state !== "AUTHENTICATED"
      || connection.worker_state !== "LIVE"
      || connection.synchronization_state !== "SYNCHRONIZED"
      || connection.execution_readiness !== "READY"
      || connection.control_state !== "ACTIVE") {
      await auditBrokerSignalBlocked(
        strategy,
        binding,
        `black-script:${evaluation.latestClosedCandleTime}:${binding.id}`,
        "BROKER_CONNECTION_NOT_READY",
        executionEnvironment,
      );
      throw Object.assign(new Error("Every armed Black Script target must be synchronized before committing the next shared generation."), {
        code: "BLACK_SCRIPT_TARGET_NOT_READY",
      });
    }
    const prior = stateByBinding.get(String(binding.id));
    if (prior && (Number(prior.strategy_version) !== Number(strategy.current_version)
      || prior.source_version !== evaluation.sourceVersion
      || prior.settings_version !== evaluation.settingsVersion)) {
      const priorHandles = prior.broker_order_handles && typeof prior.broker_order_handles === "object"
        ? Object.keys(prior.broker_order_handles)
        : [];
      if (priorHandles.length) {
        throw Object.assign(new Error("A prior Black Script version still owns broker orders on this target."), {
          code: "BLACK_SCRIPT_PRIOR_VERSION_ORDERS_REQUIRE_CANCEL",
        });
      }
    }
    const storedPriorHandles = prior?.broker_order_handles && typeof prior.broker_order_handles === "object"
      ? prior.broker_order_handles as Record<string, BlackScriptBrokerOrderHandle>
      : {};
    const hasOwnedPosition = (positions || []).some((position) =>
      position.account_id === binding.account_id
      && position.strategy_target_binding_id === binding.id
      && Number(position.quantity) > 0);
    const ownedPositions = (positions || []).filter((position) =>
      position.account_id === binding.account_id
      && position.strategy_target_binding_id === binding.id
      && Number(position.quantity) > 0)
      .map((position) => ({ direction: position.direction, quantity: Number(position.quantity) }));
    const targetCommands = (placeCommands || []).filter((command) => command.strategy_target_binding_id === binding.id);
    const targetOrderIds = new Set(targetCommands.map((command) => command.execution_order_id).filter(Boolean));
    const targetFillState = {
      commandsByIdempotencyKey: Object.fromEntries(targetCommands.map((command) => [command.idempotency_key, {
        status: command.status,
        executionOrderId: command.execution_order_id,
      }])),
      ordersById: Object.fromEntries((acknowledgedOrders || [])
        .filter((order) => targetOrderIds.has(order.id) && order.strategy_target_binding_id === binding.id)
        .map((order) => [order.id, {
          status: order.status,
          quantity: Number(order.quantity || 0),
          filledQuantity: Number(order.filled_quantity || 0),
        }])),
      ownedPositions,
    };
    assertBlackScriptExpectedTargetFills({
      evaluation,
      priorHandles: storedPriorHandles,
      state: targetFillState,
    });
    const priorHandles = settleBlackScriptTargetMarketActions({
      priorHandles: storedPriorHandles,
      state: targetFillState,
    });
    const opensPositionThisGeneration = evaluation.marketActions.some((action: JsonRow) => ["ENTRY", "REVERSE"].includes(action.action));
    // A newly attached flat account begins following at the next entry. It
    // must not receive orphaned reduce-only exits belonging to the strategy's
    // pre-attachment virtual position.
    const targetEvaluation = !prior && !hasOwnedPosition && !opensPositionThisGeneration
      ? {
        ...evaluation,
        desiredOrders: evaluation.desiredOrders.filter((order: JsonRow) => order.action === "entry"),
      }
      : evaluation;
    const targetPreviousCheckpoint = prior
      ? {
        ...evaluation.checkpoint,
        brokerOrderFingerprints: prior.desired_order_fingerprints && typeof prior.desired_order_fingerprints === "object"
          ? prior.desired_order_fingerprints
          : {},
      }
      : null;
    const targetPlan = buildBlackScriptBrokerPlan({
      evaluation: targetEvaluation,
      previousCheckpoint: targetPreviousCheckpoint,
      tickSize: Number(tickSize),
    });
    if (hasOwnedPosition || opensPositionThisGeneration) {
      const allDesired = buildBlackScriptBrokerPlan({
        evaluation: targetEvaluation,
        previousCheckpoint: null,
        tickSize: Number(tickSize),
      });
      const currentCreateKeys = new Set(targetPlan.createOrders.map((order) => order.key));
      for (const order of allDesired.createOrders) {
        if (!priorHandles[order.key] && !currentCreateKeys.has(order.key)) {
          targetPlan.createOrders.push(order);
          currentCreateKeys.add(order.key);
        }
      }
      const currentProtectionKeys = new Set(targetPlan.setProtections.map((item) => item.key));
      for (const protection of allDesired.setProtections) {
        if (!priorHandles[protection.key] && !currentProtectionKeys.has(protection.key)) {
          targetPlan.setProtections.push(protection);
          currentProtectionKeys.add(protection.key);
        }
      }
      targetPlan.modifyOrders = targetPlan.modifyOrders.filter((order) => priorHandles[order.key]);
    } else {
      targetPlan.modifyOrders = targetPlan.modifyOrders.filter((order) => priorHandles[order.key]);
    }
    const manifest = buildBlackScriptTargetCommandManifest({
      strategyId: strategy.id,
      strategyVersion: strategy.current_version,
      ownerUserId: strategy.owner_user_id,
      bindingId: binding.id,
      connectionId: binding.connection_id,
      accountId: binding.account_id,
      symbol: strategy.symbol,
      marketType: binding.market_type === "SPOT" ? "SPOT" : "FUTURES",
      executionEnvironment: executionEnvironment as "DEMO" | "MAINNET_LIVE",
      requestedLongLeverage: sideSpecificLeverage(strategy.definition, "long", binding),
      requestedShortLeverage: sideSpecificLeverage(strategy.definition, "short", binding),
      evaluation: targetEvaluation,
      plan: targetPlan,
      priorHandles,
      digest: (value) => crypto.createHash("sha256").update(value).digest("hex"),
    });
    if (targetEvaluation !== evaluation) {
      manifest.desiredOrderFingerprints = { ...evaluation.checkpoint.brokerOrderFingerprints };
    }
    manifests.push(manifest);
  }
  return manifests;
}

function strategyDirectionFromSignalKey(value: unknown): "long" | "short" | null {
  const match = String(value || "").match(/:(long|short)$/i);
  return match ? match[1]!.toLowerCase() as "long" | "short" : null;
}

function latestUnprocessedStrategyTransition(
  transitions: JsonRow[],
  runtime: JsonRow | null,
  latestClosedCandleTime: number,
  timeframe: string,
) {
  const checkpointCandleTime = runtimeCheckpointCandleTime(runtime, timeframe);
  return [...transitions].reverse().find((item) => {
    const transitionTime = Number(item?.timestamp);
    if (!item?.entry || !Number.isFinite(transitionTime) || transitionTime > latestClosedCandleTime) return false;
    // A brand-new runtime starts at the latest closed bar; it must not replay
    // an arbitrary historical position transition merely because seed data was
    // fetched. Catch-up is enabled only after a durable runtime checkpoint.
    return checkpointCandleTime === null
      ? transitionTime === latestClosedCandleTime
      : transitionTime > checkpointCandleTime;
  });
}

function runtimeCheckpointCandleTime(runtime: JsonRow | null, timeframe: string) {
  const closedAt = Date.parse(String(runtime?.last_closed_candle_at || ""));
  // Version activation clears last_closed_candle_at. Older activation RPCs did
  // not know about pine_checkpoint, so an orphaned checkpoint from the prior
  // version must never trigger historical execution for the new version.
  if (!Number.isFinite(closedAt)) return null;
  const derived = previousCandleOpenTimeSeconds(closedAt, timeframe);
  const explicit = Number(runtime?.pine_checkpoint?.lastClosedCandleTime);
  return Number.isFinite(explicit) && explicit > 0
    ? Math.max(explicit, derived)
    : derived;
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
  if (!binding.connection_id || !binding.account_id) return false;
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
    return false;
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
    return false;
  }
  const owned = open.filter((item) => item.strategy_target_binding_id === binding.id);
  const sameDirection = owned.some((item) => item.direction === signal.direction);
  const opposite = owned.find((item) => item.direction !== signal.direction);
  const explicitAction = ["ENTRY", "CLOSE", "REVERSE"].includes(String(signal.explicitAction || "").toUpperCase())
    ? String(signal.explicitAction).toUpperCase()
    : null;
  let action: string;
  let positionDirection: string | null = opposite?.direction || null;
  if (explicitAction === "CLOSE") {
    const closing = owned.find((item) => item.direction === String(signal.positionDirection || signal.direction).toLowerCase());
    if (!closing) return true;
    action = "CLOSE";
    positionDirection = closing.direction;
  } else if (explicitAction === "REVERSE") {
    if (sameDirection && !opposite) return true;
    if (!opposite) {
      await auditBrokerSignalBlocked(strategy, binding, signalKey, "BLACK_SCRIPT_REVERSE_POSITION_MISSING", executionEnvironment);
      return false;
    }
    action = "REVERSE";
    positionDirection = opposite.direction;
  } else if (explicitAction === "ENTRY") {
    if (sameDirection) return true;
    if (opposite) {
      await auditBrokerSignalBlocked(strategy, binding, signalKey, "BLACK_SCRIPT_ENTRY_POSITION_CONFLICT", executionEnvironment);
      return false;
    }
    action = "ENTRY";
  } else {
    if (sameDirection) return true;
    const perpetualReversal = strategy.definition?.execution?.perpetualSignalReversalEnabled === true;
    const conflictResolution = perpetualReversal
      ? "CLOSE_THEN_REVERSE"
      : String(strategy.definition?.execution?.conflictResolution || "CLOSE_ONLY").toUpperCase();
    if (opposite && conflictResolution === "IGNORE") {
      await auditBrokerSignalBlocked(strategy, binding, signalKey, "OPPOSITE_SIGNAL_IGNORED_BY_POLICY", executionEnvironment);
      return false;
    }
    action = opposite ? (conflictResolution === "CLOSE_ONLY" ? "CLOSE" : "REVERSE") : "ENTRY";
  }
  const takeProfitPlan = reserveStrategyTakeProfits(signal.takeProfits);
  if (binding.market_type === "SPOT" && shouldQueueStrategyTakeProfits(action) && takeProfitPlan.length) {
    await auditBrokerSignalBlocked(strategy, binding, signalKey, "SPOT_TP_PROTECTION_UNCERTIFIED", executionEnvironment);
    return false;
  }
  const commandSignalKey = `${signalKey}:${binding.id}:${action.toLowerCase()}`;
  const idempotencyKey = crypto.createHash("sha256").update(commandSignalKey).digest("hex");
  const deterministicClientOrderId = `bt-str-${idempotencyKey.slice(0, 28)}`;
  const parentCommand = {
    commandType: "PLACE_ORDER",
    userId: strategy.owner_user_id,
    connectionId: binding.connection_id,
    groupIntentId: null,
    strategySignalKey: commandSignalKey,
    idempotencyKey,
    deterministicClientOrderId,
    payload: {
      action,
      symbol: strategy.symbol,
      marketType: strategy.market_type,
      direction: signal.direction,
      positionDirection,
      closeQuantity: Number(signal.quantity) > 0 ? Number(signal.quantity) : null,
      stopLoss: signal.stopLoss || null,
      takeProfit: signal.takeProfit || null,
      takeProfits: takeProfitPlan,
      requestedLeverage: sideSpecificLeverage(strategy.definition, signal.direction, binding),
      slippageTicks: Number(strategy.definition?.execution?.slippageTicks || 0),
      candleTime: signal.timestamp,
      strategyVersion: strategy.current_version,
      executionEnvironment,
      simulatedFunds: executionEnvironment === "DEMO"
    },
    priority: action === "CLOSE" ? 20 : 50,
    maxAttempts: action === "ENTRY" || action === "REVERSE" ? 100 : 8,
  };
  const childCommands: JsonRow[] = [];
  if (shouldQueueStrategyTakeProfits(action)) {
    for (const [index, target] of takeProfitPlan.slice(0, 7).entries()) {
      const targetId = String(target?.id || `TP${index + 1}`).toUpperCase();
      const targetActionKey = `${idempotencyKey}:TAKE_PROFIT:${targetId}`;
      const targetIdempotencyKey = crypto.createHash("sha256").update(targetActionKey).digest("hex");
      childCommands.push({
        commandType: "PLACE_ORDER",
        userId: strategy.owner_user_id,
        connectionId: binding.connection_id,
        groupIntentId: null,
        strategySignalKey: `${commandSignalKey}:${targetId.toLowerCase()}`,
        idempotencyKey: targetIdempotencyKey,
        deterministicClientOrderId: `bt-tp-${targetIdempotencyKey.slice(0, 29)}`,
        payload: {
          action: "TAKE_PROFIT",
          symbol: strategy.symbol,
          marketType: strategy.market_type,
          direction: signal.direction,
          positionDirection: signal.direction,
          targetId,
          targetPrice: Number(target?.price),
          targetBasis: target?.basis || null,
          targetValue: Number(target?.value),
          targetAtrValue: Number(target?.atrValue),
          quantityPercent: Number(target?.quantityPercent),
          parentEntryIdempotencyKey: idempotencyKey,
          parentStrategySignalKey: commandSignalKey,
          candleTime: signal.timestamp,
          strategyVersion: strategy.current_version,
          executionEnvironment,
          simulatedFunds: executionEnvironment === "DEMO",
        },
        priority: 70 + index,
        maxAttempts: 100,
      });
    }
  }
  await enqueueStrategyGeneration(strategy.id, binding.id, parentCommand, childCommands);
  await supabase.from("strategy_automation_audit_events").insert({
    owner_user_id: strategy.owner_user_id,
    strategy_id: strategy.id,
    binding_id: binding.id,
    event_type: executionEnvironment === "DEMO" ? "STRATEGY_DEMO_ORDER_QUEUED" : "STRATEGY_MAINNET_ORDER_QUEUED",
    severity: "INFO",
    message: `A confirmed closed-candle signal queued an idempotent Bybit ${executionEnvironment === "DEMO" ? "Demo" : "Mainnet"} order command.`,
    safe_metadata: { signalKey, action, symbol: strategy.symbol, direction: signal.direction, executionEnvironment, simulatedFunds: executionEnvironment === "DEMO" }
  });
  return {
    durable: true,
    parentIdempotencyKey: idempotencyKey,
    takeProfitHandles: Object.fromEntries(takeProfitPlan.map((target, index) => {
      const targetId = String(target?.id || `TP${index + 1}`).toUpperCase();
      const targetKey = `${idempotencyKey}:TAKE_PROFIT:${targetId}`;
      return [String(target?.logicalOrderKey || targetId), crypto.createHash("sha256").update(targetKey).digest("hex")];
    })),
  };
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
  const expiresAt = new Date(now.getTime() + strategyGenerationRecoveryWindowMs(strategy.timeframe)).toISOString();
  const policy = normalizeCapitalPolicy(bindingPolicy(binding), binding.market_type, { allowZeroAllocation: false });
  const takeProfitPlan = reserveStrategyTakeProfits(signal.takeProfits);
  if (binding.market_type === "SPOT" && takeProfitPlan.length) {
    await auditGroupSignalBlocked(strategy, binding, signalKey, "SPOT_TP_PROTECTION_UNCERTIFIED");
    return;
  }
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
      takeProfits: takeProfitPlan,
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
  if (!intentId) throw new Error("The signed strategy parent intent could not be recovered after its idempotent insert.");
  const { error: versionError } = await supabase.from("group_trade_intent_versions").upsert({
    group_intent_id: intentId,
    version: 1,
    canonical_payload: envelope,
    canonical_hash: row.canonical_hash,
    service_signature: row.service_signature,
    created_by: strategy.owner_user_id,
  }, { onConflict: "group_intent_id,version", ignoreDuplicates: true });
  if (versionError) throw versionError;
  const parentCommandIdempotencyKey = `expand:${idempotencyKey}`;
  const parentCommand = {
    commandType: "EXPAND_GROUP_INTENT",
    userId: null,
    connectionId: null,
    groupIntentId: intentId,
    strategySignalKey: `${signalKey}:${binding.id}:group`,
    idempotencyKey: parentCommandIdempotencyKey,
    deterministicClientOrderId: null,
    payload: { groupIntentId: intentId },
    priority: 20,
    maxAttempts: 100,
  };
  const childCommands: JsonRow[] = [];
  if (takeProfitPlan.length) {
    for (const [index, target] of takeProfitPlan.slice(0, 7).entries()) {
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
        strategy_execution_policy: {
          strategyVersion: strategy.current_version,
          candleTime: signal.timestamp,
          parentGroupIntentId: intentId,
          targetId,
          targetBasis: target?.basis || null,
          targetValue: Number(target?.value),
          targetAtrValue: Number(target?.atrValue),
          quantityPercent: Number(target?.quantityPercent),
        },
        idempotency_key: targetIdempotencyKey,
      };
      const targetEnvelope = intentSigningPayload(targetRow);
      targetRow.canonical_hash = hashCanonicalPayload(targetEnvelope);
      targetRow.service_signature = signCanonicalPayload(targetEnvelope);
      const { data: targetIntent, error: targetIntentError } = await supabase.from("group_trade_intents").upsert(targetRow, { onConflict: "group_id,client_intent_id", ignoreDuplicates: true }).select("id").maybeSingle();
      if (targetIntentError) throw targetIntentError;
      const targetIntentId = targetIntent?.id || (await existingGroupIntent(binding.group_id, targetClientIntentId));
      if (!targetIntentId) throw new Error("The signed strategy TP intent could not be recovered after its idempotent insert.");
      const { error: targetVersionError } = await supabase.from("group_trade_intent_versions").upsert({ group_intent_id: targetIntentId, version: 1, canonical_payload: targetEnvelope, canonical_hash: targetRow.canonical_hash, service_signature: targetRow.service_signature, created_by: strategy.owner_user_id }, { onConflict: "group_intent_id,version", ignoreDuplicates: true });
      if (targetVersionError) throw targetVersionError;
      const targetCommandIdempotencyKey = `expand:${targetIdempotencyKey}`;
      childCommands.push({
        commandType: "EXPAND_GROUP_INTENT",
        userId: null,
        connectionId: null,
        groupIntentId: targetIntentId,
        strategySignalKey: `${signalKey}:${binding.id}:group:${targetId.toLowerCase()}`,
        idempotencyKey: targetCommandIdempotencyKey,
        deterministicClientOrderId: null,
        payload: { groupIntentId: targetIntentId },
        priority: 40 + index,
        maxAttempts: 100,
      });
    }
  }
  await enqueueStrategyGeneration(strategy.id, binding.id, parentCommand, childCommands);
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

async function enqueueBrokerTakeProfitReprices(
  strategy: JsonRow,
  binding: JsonRow,
  candles: Candle[],
  candle: Candle,
) {
  if (!binding.connection_id || !binding.account_id || strategy.market_type === "SPOT") return;
  const [{ data: positions, error: positionError }, { data: orders, error: orderError }, { data: entries, error: entryError }] = await Promise.all([
    supabase.from("account_positions")
      .select("account_id,direction,quantity,average_price,position_idx,strategy_target_binding_id")
      .eq("account_id", binding.account_id)
      .eq("strategy_target_binding_id", binding.id)
      .eq("symbol", strategy.symbol)
      .gt("quantity", 0),
    supabase.from("execution_orders")
      .select("id,user_id,account_id,client_order_id,limit_price,status,created_at")
      .eq("strategy_target_binding_id", binding.id)
      .eq("symbol", strategy.symbol)
      .eq("reduce_only", true)
      .in("status", ACTIVE_EXECUTION_ORDER_STATUSES)
      .order("created_at", { ascending: false })
      .limit(32),
    supabase.from("execution_orders")
      .select("id,side,status,filled_quantity,created_at")
      .eq("strategy_target_binding_id", binding.id)
      .eq("symbol", strategy.symbol)
      .eq("reduce_only", false)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  if (positionError) throw positionError;
  if (orderError) throw orderError;
  if (entryError) throw entryError;
  if (!positions?.length || !orders?.length) return;

  const orderIds = orders.map((order) => order.id);
  const { data: targetCommands, error: targetCommandError } = await supabase.from("execution_commands")
    .select("execution_order_id,payload,created_at")
    .eq("strategy_target_binding_id", binding.id)
    .eq("command_type", "PLACE_ORDER")
    .in("execution_order_id", orderIds)
    .order("created_at", { ascending: false });
  if (targetCommandError) throw targetCommandError;
  const parentKeys = [...new Set((targetCommands || [])
    .map((command) => String(command.payload?.parentEntryIdempotencyKey || ""))
    .filter(Boolean))];
  if (!parentKeys.length) return;
  const { data: parentCommands, error: parentError } = await supabase.from("execution_commands")
    .select("idempotency_key,execution_order_id,status")
    .in("idempotency_key", parentKeys);
  if (parentError) throw parentError;

  const orderById = new Map(orders.map((order) => [String(order.id), order]));
  const targetCommandByOrder = new Map<string, JsonRow>();
  for (const command of targetCommands || []) {
    const orderId = String(command.execution_order_id || "");
    if (orderId && !targetCommandByOrder.has(orderId)) targetCommandByOrder.set(orderId, command);
  }
  const parentByKey = new Map((parentCommands || []).map((command) => [String(command.idempotency_key), command]));

  for (const position of positions) {
    const direction = String(position.direction || "").toLowerCase();
    if (direction !== "long" && direction !== "short") continue;
    const expectedEntrySide = direction === "long" ? "buy" : "sell";
    const latestEntry = (entries || []).find((entry) => String(entry.side).toLowerCase() === expectedEntrySide && isExecutedEntryOrder(entry));
    if (!latestEntry) continue;
    const plan = reserveStrategyTakeProfits(superAtrTakeProfitPlan(
      candles,
      direction,
      Number(position.average_price),
      strategy.definition?.settings || {},
    ));
    const planById = new Map(plan.map((target) => [String(target.id).toUpperCase(), target]));
    for (const [orderId, targetCommand] of targetCommandByOrder) {
      const order = orderById.get(orderId);
      if (!order?.client_order_id) continue;
      const payload = targetCommand.payload || {};
      if (String(payload.direction || "").toLowerCase() !== direction) continue;
      const parent = parentByKey.get(String(payload.parentEntryIdempotencyKey || ""));
      if (!parent || String(parent.execution_order_id || "") !== String(latestEntry.id)) continue;
      const targetId = String(payload.targetId || "").toUpperCase();
      const target = planById.get(targetId);
      if (!target || target.basis !== "ATR") continue;
      await enqueueTakeProfitReprice({
        strategy,
        binding,
        userId: strategy.owner_user_id,
        connectionId: binding.connection_id,
        executionOrder: order,
        target,
        targetId,
        direction,
        sourceCandleTime: candle.time,
        expectedEntryOrderId: latestEntry.id,
      });
    }
  }
}

async function enqueueGroupTakeProfitReprices(
  strategy: JsonRow,
  binding: JsonRow,
  candles: Candle[],
  candle: Candle,
) {
  if (!binding.group_id || strategy.market_type === "SPOT") return;
  const [{ data: positions, error: positionError }, { data: orders, error: orderError }, { data: entries, error: entryError }] = await Promise.all([
    supabase.from("account_positions")
      .select("account_id,direction,quantity,average_price,position_idx,strategy_target_binding_id")
      .eq("strategy_target_binding_id", binding.id)
      .eq("symbol", strategy.symbol)
      .gt("quantity", 0),
    supabase.from("execution_orders")
      .select("id,user_id,account_id,client_order_id,limit_price,status,group_intent_id,created_at")
      .eq("strategy_target_binding_id", binding.id)
      .eq("symbol", strategy.symbol)
      .eq("origin", "INVESTMENT_GROUP")
      .eq("reduce_only", true)
      .in("status", ACTIVE_EXECUTION_ORDER_STATUSES)
      .order("created_at", { ascending: false })
      .limit(128),
    supabase.from("execution_orders")
      .select("id,account_id,side,status,filled_quantity,group_intent_id,created_at")
      .eq("strategy_target_binding_id", binding.id)
      .eq("symbol", strategy.symbol)
      .eq("origin", "INVESTMENT_GROUP")
      .eq("reduce_only", false)
      .order("created_at", { ascending: false })
      .limit(128),
  ]);
  if (positionError) throw positionError;
  if (orderError) throw orderError;
  if (entryError) throw entryError;
  if (!positions?.length || !orders?.length) return;

  const orderIds = orders.map((order) => order.id);
  const intentIds = [...new Set(orders.map((order) => String(order.group_intent_id || "")).filter(Boolean))];
  const [{ data: intents, error: intentError }, { data: plans, error: planError }] = await Promise.all([
    supabase.from("group_trade_intents")
      .select("id,strategy_direction,strategy_execution_policy")
      .in("id", intentIds),
    supabase.from("follower_execution_plans")
      .select("id,execution_order_id,group_intent_id,follower_user_id,broker_connection_id")
      .in("execution_order_id", orderIds),
  ]);
  if (intentError) throw intentError;
  if (planError) throw planError;
  const intentById = new Map((intents || []).map((intent) => [String(intent.id), intent]));
  const planByOrderId = new Map((plans || []).map((plan) => [String(plan.execution_order_id), plan]));
  const positionByAccountDirection = new Map((positions || []).map((position) => [
    `${position.account_id}:${String(position.direction).toLowerCase()}`,
    position,
  ]));

  for (const order of orders) {
    if (!order.client_order_id || !order.group_intent_id) continue;
    const intent = intentById.get(String(order.group_intent_id));
    const followerPlan = planByOrderId.get(String(order.id));
    if (!intent || !followerPlan?.broker_connection_id) continue;
    const direction = String(intent.strategy_direction || "").toLowerCase();
    if (direction !== "long" && direction !== "short") continue;
    const targetId = String(intent.strategy_execution_policy?.targetId || "").toUpperCase();
    const parentGroupIntentId = String(intent.strategy_execution_policy?.parentGroupIntentId || "");
    if (!targetId || !parentGroupIntentId) continue;
    const position = positionByAccountDirection.get(`${order.account_id}:${direction}`);
    if (!position) continue;
    const expectedEntrySide = direction === "long" ? "buy" : "sell";
    const latestEntry = (entries || []).find((entry) =>
      String(entry.account_id) === String(order.account_id)
      && String(entry.side).toLowerCase() === expectedEntrySide
      && isExecutedEntryOrder(entry));
    if (!latestEntry || String(latestEntry.group_intent_id || "") !== parentGroupIntentId) continue;
    const target = reserveStrategyTakeProfits(superAtrTakeProfitPlan(
      candles,
      direction,
      Number(position.average_price),
      strategy.definition?.settings || {},
    )).find((candidate) => String(candidate.id).toUpperCase() === targetId);
    if (!target || target.basis !== "ATR") continue;
    await enqueueTakeProfitReprice({
      strategy,
      binding,
      userId: followerPlan.follower_user_id,
      connectionId: followerPlan.broker_connection_id,
      executionOrder: order,
      target,
      targetId,
      direction,
      sourceCandleTime: candle.time,
      expectedEntryOrderId: latestEntry.id,
      groupIntentId: order.group_intent_id,
      followerPlanId: followerPlan.id,
    });
  }
}

async function enqueueTakeProfitReprice({
  strategy,
  binding,
  userId,
  connectionId,
  executionOrder,
  target,
  targetId,
  direction,
  sourceCandleTime,
  expectedEntryOrderId,
  groupIntentId = null,
  followerPlanId = null,
}: JsonRow) {
  const desiredPrice = Number(target?.price);
  if (!connectionId || !executionOrder?.id || !executionOrder?.client_order_id || !Number.isFinite(desiredPrice) || desiredPrice <= 0) return;
  const signalKey = `${strategy.id}:${strategy.current_version}:${binding.id}:${executionOrder.id}:${targetId.toLowerCase()}:reprice:${sourceCandleTime}`;
  const idempotencyKey = crypto.createHash("sha256").update(signalKey).digest("hex");
  const { error } = await supabase.from("execution_commands").upsert({
    command_type: "MODIFY_ORDER",
    user_id: userId,
    connection_id: connectionId,
    group_intent_id: groupIntentId,
    follower_plan_id: followerPlanId,
    execution_order_id: executionOrder.id,
    strategy_automation_id: strategy.id,
    strategy_target_binding_id: binding.id,
    strategy_signal_key: signalKey,
    idempotency_key: idempotencyKey,
    payload: {
      strategyAction: "TAKE_PROFIT_REPRICE",
      request: {
        marketKind: strategy.market_type === "SPOT" ? "spot" : "perpetual",
        symbol: strategy.symbol,
        clientOrderId: executionOrder.client_order_id,
        limitPrice: desiredPrice,
      },
      targetId,
      direction,
      targetBasis: target.basis,
      targetValue: Number(target.value),
      targetAtrValue: Number(target.atrValue),
      desiredPrice,
      priorPersistedPrice: Number(executionOrder.limit_price || 0) || null,
      sourceCandleTime,
      strategyVersion: strategy.current_version,
      expectedEntryOrderId,
    },
    status: "QUEUED",
    priority: 60,
    max_attempts: 20,
  }, { onConflict: "idempotency_key", ignoreDuplicates: true });
  if (error) throw error;
}

function isExecutedEntryOrder(order: JsonRow) {
  const status = String(order?.status || "").toLowerCase();
  const filledQuantity = Number(order?.filled_quantity || 0);
  if (status === "cancelled") return filledQuantity > 0;
  return filledQuantity > 0
    || ["accepted", "working", "partially-filled", "filled"].includes(status);
}

function strategySourceFingerprint(strategy: JsonRow) {
  return hashCanonicalPayload({
    runtimeKind: strategy.runtime_kind,
    indicatorId: strategy.definition?.indicator?.indicatorId || null,
    sourceVersion: strategy.definition?.indicator?.version || null,
    runtimeVersion: strategy.definition?.indicator?.runtimeVersion || null,
  });
}

function buildSuperAtrCheckpoint(
  strategy: JsonRow,
  runtime: JsonRow | null,
  candles: Candle[],
  candle: Candle,
  transitions: JsonRow[],
) {
  const sourceSha256 = strategySourceFingerprint(strategy);
  const settingsSha256 = hashCanonicalPayload(strategy.definition);
  const latestTransition = transitions.at(-1);
  const previous = runtime?.pine_checkpoint && typeof runtime.pine_checkpoint === "object"
    ? runtime.pine_checkpoint
    : {};
  return {
    schemaVersion: 1,
    runtimeKind: "builtin-superatr-seven-step",
    sourceSha256,
    settingsSha256,
    virtualDirection: latestTransition?.direction || previous.virtualDirection || strategyDirectionFromSignalKey(runtime?.last_signal_key),
    lastTransitionCandleTime: latestTransition?.timestamp || previous.lastTransitionCandleTime || null,
    lastClosedCandleTime: candle.time,
    seedFirstCandleTime: candles.at(0)?.time || null,
    seedCandleCount: candles.length,
    requiredSeedBars: superAtrRequiredSeedBars(strategy.definition?.settings || {}),
    warmupComplete: candles.length >= superAtrRequiredSeedBars(strategy.definition?.settings || {}),
  };
}

async function existingGroupIntent(groupId: string, clientIntentId: string) {
  const { data, error } = await supabase.from("group_trade_intents").select("id").eq("group_id", groupId).eq("client_intent_id", clientIntentId).maybeSingle();
  if (error) throw error;
  return data?.id || null;
}

function strategyGenerationRecoveryWindowMs(timeframe: string) {
  // The public candle worker retains at most 1,000 bars. Preserve a signed
  // group generation for that complete replay horizon, but never longer than
  // seven days, so a crash before atomic command enqueue can recover without
  // authorizing an indefinitely stale market intent.
  const interval = bybitInterval(timeframe);
  const retainedCandleHorizon = interval.value === "M"
    ? MAX_STRATEGY_GENERATION_RECOVERY_MS
    : Math.max(60_000, Number(interval.milliseconds) * 1_000);
  return Math.min(
    MAX_STRATEGY_GENERATION_RECOVERY_MS,
    retainedCandleHorizon,
  );
}

async function enqueueStrategyGeneration(
  strategyId: string,
  bindingId: string,
  parentCommand: JsonRow,
  childCommands: JsonRow[],
) {
  const { data, error } = await supabase.rpc("black_cloud_enqueue_strategy_generation_v1", {
    p_strategy_id: strategyId,
    p_binding_id: bindingId,
    p_parent_command: parentCommand,
    p_child_commands: childCommands,
  });
  if (error) throw error;
  const expected = 1 + childCommands.length;
  if (Number(data) !== expected) {
    throw new Error(`The atomic strategy generation enqueue expected ${expected} durable commands.`);
  }
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
      candleCloseTimeMs(candle.time, strategy.timeframe),
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
    candleCloseTimeMs(candle.time, strategy.timeframe);
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
  url.searchParams.set("limit", "1000");
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
  // Bybit is the authority for its candle boundary. A VPS clock that is a few
  // seconds fast must never promote the still-forming row into an executable
  // closed-candle signal.
  const venueTimestamp = Number(payload.time);
  if (!Number.isFinite(venueTimestamp) || venueTimestamp <= 0) {
    throw Object.assign(new Error("Bybit did not provide an authoritative server timestamp for candle closure."), {
      code: "MARKET_DATA_SERVER_TIME_INVALID",
    });
  }
  const now = venueTimestamp;
  const candles = payload.result.list
    .map((row: string[]) => ({
      time: Math.floor(Number(row[0]) / 1000),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }))
    .filter((candle: Candle) => [candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))
    .sort((a: Candle, b: Candle) => a.time - b.time);
  const closed = candles.filter((candle: Candle) => candleCloseTimeMsForInterval(candle.time, interval) <= now);
  assertBybitCandleWindowIntegrity(closed, interval, now);
  return {
    closed,
    current: candles.find((candle: Candle) => candle.time * 1000 <= now && candleCloseTimeMsForInterval(candle.time, interval) > now) || null,
  };
}

async function fetchBybitBlackScriptIntrabars({
  symbol,
  timeframe,
  marketType,
  closedCandles,
  checkpoint,
}: {
  symbol: string;
  timeframe: string;
  marketType: string;
  closedCandles: Candle[];
  checkpoint: JsonRow | null | undefined;
}) {
  const lowerTimeframe = strategyMagnifierTimeframe(timeframe as Parameters<typeof strategyMagnifierTimeframe>[0]);
  if (!lowerTimeframe) {
    throw Object.assign(new Error("The selected Bybit timeframe has no certified lower-timeframe magnifier feed."), {
      code: "BLACK_SCRIPT_MAGNIFIER_TIMEFRAME_UNAVAILABLE",
    });
  }
  const priorTime = Number(checkpoint?.runtimeVersion === "black-script-v3" ? checkpoint.lastClosedCandleTime : NaN);
  const executable = closedCandles.filter((candle) => Number.isFinite(priorTime) ? candle.time > priorTime : candle === closedCandles.at(-1));
  if (!executable.length) return closedCandles.map(() => [] as Candle[]);
  const lowerInterval = bybitInterval(lowerTimeframe);
  const startMs = executable[0]!.time * 1000;
  const endMs = candleCloseTimeMs(executable.at(-1)!.time, timeframe) - 1;
  const fixedLowerMs = Number(lowerInterval.milliseconds || 86_400_000);
  const expected = Math.ceil((endMs + 1 - startMs) / fixedLowerMs);
  if (expected > 1_000) {
    throw Object.assign(new Error("The live Bar Magnifier request exceeds Bybit's atomic lower-timeframe page."), {
      code: "BLACK_SCRIPT_MAGNIFIER_WINDOW_TOO_LARGE",
    });
  }
  const url = new URL("https://api.bybit.com/v5/market/kline");
  url.searchParams.set("category", marketType === "SPOT" ? "spot" : "linear");
  url.searchParams.set("symbol", String(symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase());
  url.searchParams.set("interval", lowerInterval.value);
  url.searchParams.set("start", String(startMs));
  url.searchParams.set("end", String(endMs));
  url.searchParams.set("limit", String(Math.max(1, Math.min(1_000, expected + 2))));
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" } });
  if (!response.ok) {
    throw Object.assign(new Error("Bybit lower-timeframe candle request failed."), {
      code: `BLACK_SCRIPT_MAGNIFIER_HTTP_${response.status}`,
    });
  }
  const payload = await response.json();
  if (Number(payload.retCode) !== 0 || !Array.isArray(payload.result?.list)) {
    throw Object.assign(new Error("Bybit lower-timeframe candle payload was rejected."), {
      code: "BLACK_SCRIPT_MAGNIFIER_PAYLOAD_INVALID",
    });
  }
  const lowerCandles = payload.result.list.map((row: string[]): Candle => ({
    time: Math.floor(Number(row[0]) / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  })).filter((candle: Candle) => [candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))
    .sort((left: Candle, right: Candle) => left.time - right.time);
  const grouped = new Map<number, Candle[]>();
  for (const parent of executable) grouped.set(parent.time, []);
  for (const candle of lowerCandles) {
    const parent = executable.find((candidate) => candle.time >= candidate.time && candle.time * 1000 < candleCloseTimeMs(candidate.time, timeframe));
    if (parent) grouped.get(parent.time)!.push(candle);
  }
  for (const parent of executable) {
    const bucket = grouped.get(parent.time) || [];
    const parentCloseMs = candleCloseTimeMs(parent.time, timeframe);
    if (!bucket.length || bucket[0]!.time !== parent.time
      || candleCloseTimeMsForInterval(bucket.at(-1)!.time, lowerInterval) !== parentCloseMs) {
      throw Object.assign(new Error("Bybit lower-timeframe coverage is incomplete for a confirmed strategy candle."), {
        code: "BLACK_SCRIPT_MAGNIFIER_COVERAGE_INCOMPLETE",
      });
    }
    assertBybitCandleWindowIntegrity(bucket, lowerInterval, parentCloseMs);
  }
  return closedCandles.map((candle) => grouped.get(candle.time) || []);
}

function bybitInterval(timeframe: string): { value: string; milliseconds: number | null } {
  const normalized = String(timeframe).trim();
  const direct: Record<string, [string, number | null]> = {
    "1m": ["1", 60_000],
    "3m": ["3", 180_000],
    "5m": ["5", 300_000],
    "15m": ["15", 900_000],
    "30m": ["30", 1_800_000],
    "1h": ["60", 3_600_000],
    "2h": ["120", 7_200_000],
    "3h": ["180", 10_800_000],
    "4h": ["240", 14_400_000],
    "6h": ["360", 21_600_000],
    "12h": ["720", 43_200_000],
    "1d": ["D", 86_400_000],
    "1D": ["D", 86_400_000],
    "1w": ["W", 604_800_000],
    "1W": ["W", 604_800_000],
    "1M": ["M", null],
  };
  const match = direct[normalized];
  if (!match)
    throw Object.assign(new Error("Unsupported paper runtime timeframe."), {
      code: "TIMEFRAME_UNSUPPORTED",
    });
  return { value: match[0], milliseconds: match[1] };
}

function candleCloseTimeMs(candleOpenTimeSeconds: number, timeframe: string) {
  return candleCloseTimeMsForInterval(candleOpenTimeSeconds, bybitInterval(timeframe));
}

function candleCloseTimeMsForInterval(
  candleOpenTimeSeconds: number,
  interval: { value: string; milliseconds: number | null },
) {
  const openTimeMs = Number(candleOpenTimeSeconds) * 1000;
  if (interval.value !== "M") {
    if (!(Number(interval.milliseconds) > 0)) throw new Error("A positive fixed candle interval is required.");
    return openTimeMs + Number(interval.milliseconds);
  }
  const nextMonth = new Date(openTimeMs);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1);
  nextMonth.setUTCHours(0, 0, 0, 0);
  return nextMonth.getTime();
}

function nextCandleOpenTimeSeconds(candleOpenTimeSeconds: number, timeframe: string) {
  return Math.floor(candleCloseTimeMs(candleOpenTimeSeconds, timeframe) / 1000);
}

function previousCandleOpenTimeSeconds(closedAtMs: number, timeframe: string) {
  const interval = bybitInterval(timeframe);
  if (interval.value !== "M") {
    if (!(Number(interval.milliseconds) > 0)) throw new Error("A positive fixed candle interval is required.");
    return Math.floor((closedAtMs - Number(interval.milliseconds)) / 1000);
  }
  const previousMonth = new Date(closedAtMs);
  previousMonth.setUTCMonth(previousMonth.getUTCMonth() - 1, 1);
  previousMonth.setUTCHours(0, 0, 0, 0);
  return Math.floor(previousMonth.getTime() / 1000);
}

function assertBybitCandleWindowIntegrity(
  candles: Candle[],
  interval: { value: string; milliseconds: number | null },
  serverTimeMs: number,
) {
  if (!candles.length) return;
  for (let index = 1; index < candles.length; index += 1) {
    const expectedOpenTime = candleCloseTimeMsForInterval(candles[index - 1]!.time, interval) / 1000;
    if (candles[index]!.time !== expectedOpenTime) {
      throw Object.assign(new Error("Bybit closed-candle history is gapped or duplicated."), {
        code: "MARKET_DATA_CANDLE_GAP",
      });
    }
  }
  const latestCloseTime = candleCloseTimeMsForInterval(candles.at(-1)!.time, interval);
  const followingCloseTime = candleCloseTimeMsForInterval(latestCloseTime / 1000, interval);
  if (serverTimeMs >= followingCloseTime) {
    throw Object.assign(new Error("The latest Bybit closed candle is stale."), {
      code: "MARKET_DATA_STALE",
    });
  }
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
