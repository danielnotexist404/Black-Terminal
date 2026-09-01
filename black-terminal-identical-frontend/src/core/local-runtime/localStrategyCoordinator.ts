import { sha256 } from "@noble/hashes/sha2.js";
import type { Candle } from "../../chart-engine/types";
import type { ScriptInputValue } from "../../components/ScriptCompiler";
import type {
  BlackScriptBrokerOrderHandle,
  BlackScriptExecutionCommand,
  BlackScriptTargetFillState,
} from "../../modules/strategy-lab/adapters/blackScriptBrokerPlanner";
import {
  assertBlackScriptExpectedTargetFills,
  buildBlackScriptBrokerPlan,
  buildBlackScriptTargetCommandManifest,
  settleBlackScriptTargetMarketActions,
} from "../../modules/strategy-lab/adapters/blackScriptBrokerPlanner";
import {
  blackScriptOwnedSourceVersion,
  evaluateBlackScriptCloudRuntime,
  isBlackScriptV3CloudEligibleSource,
  type BlackScriptCloudCheckpoint,
  type BlackScriptCloudEvaluation,
} from "../../modules/strategy-lab/adapters/blackScriptCloudRuntime";
import { fetchStrategyLabCandles, fetchStrategyLabIntrabars, strategyTimeframeSeconds } from "../../modules/strategy-lab/adapters/marketDataAdapter";
import type {
  StrategyCapitalPolicy,
  StrategyTargetBinding,
  StrategyWorkspace,
} from "../../modules/strategy-lab/automation/strategyAutomation.types";
import { readStrategyControlPanel } from "../../modules/strategy-lab/execution-desk/strategyControlPanelModel";
import { normalizeUserScripts } from "../../scripts/userScriptLibrary";
import type { MarketSymbol, Timeframe } from "../../market-data/types";
import { getLocalBrokerRecord, getLocalBrokerSymbolExposure, refreshLocalBrokerAccount } from "./localBrokerStore";
import {
  getLocalBybitInstrumentRules,
  localBybitOrderLinkId,
  lookupLocalBybitOrder,
  type LocalBybitEnvironment,
  type LocalBybitInstrumentRules,
} from "./localBybitClient";
import { enqueueLocalExecution, getLocalExecution, type LocalExecutionIntent } from "./localExecutionClient";
import { getLocalDocument, putLocalDocument } from "./localDocumentStore";
import { getCachedLocalRuntimeStatus, isLocalOnlyRuntime } from "./localRuntimeClient";
import { loadLocalUserScripts } from "./localUserScriptStore";
import {
  activeLocalInvestmentGroupMandates,
  getLocalInvestmentGroupMandateByPublicId,
  validateLocalInvestmentGroupPolicy,
} from "./localInvestmentGroupMandateStore";
import {
  activeRemoteInvestmentGroupMandates,
  listRemoteInvestmentGroupExecutionReceipts,
  type RemoteInvestmentGroupMandate,
} from "./localInvestmentGroupRemoteStore";
import { sendLocalP2pDirect } from "./localP2pClient";
import { getLocalProfessionalNetworkState } from "../../modules/profile/professionalNetworkStore";
import { applyLocalStrategyPaperEvaluation, getLocalStrategy, getLocalStrategyPaperRuntime, listLocalStrategies, setLocalStrategyRuntimeStatus } from "./localStrategyStore";

const RUNTIME_NAMESPACE = "strategy-runtime-checkpoints";
const COORDINATOR_TICK_MS = 5_000;
const CLOSED_CANDLE_GRACE_SECONDS = 2;

type LocalTargetRuntime = {
  desiredOrderFingerprints: Record<string, string>;
  brokerOrderHandles: Record<string, BlackScriptBrokerOrderHandle>;
};

type LocalStrategyRuntimeRecord = {
  schemaVersion: 1;
  runtimeVersion: "black-script-v3-local";
  strategyVersion: number;
  sourceVersion: string;
  checkpoint: BlackScriptCloudCheckpoint | null;
  targets: Record<string, LocalTargetRuntime>;
  updatedAt: number;
};

type ExecutionStrategyContext = {
  strategy: Pick<StrategyWorkspace["strategy"], "id" | "runningVersion" | "currentVersion" | "symbol" | "marketType">;
};

type RemoteGroupDelivery = {
  binding: StrategyTargetBinding;
  mandate: RemoteInvestmentGroupMandate;
};

let stopCoordinator: (() => void) | null = null;

export function startLocalStrategyCoordinator() {
  if (!isLocalOnlyRuntime() || stopCoordinator) return () => undefined;
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const strategies = await listLocalStrategies();
      for (const strategy of strategies) {
        if (stopped) break;
        if (!strategy.runningVersion || !["PAPER_ACTIVE", "LIVE_ACTIVE", "PUBLISHED"].includes(strategy.status)) continue;
        await processLocalStrategy(strategy.id).catch(async (cause) => {
          const message = cause instanceof Error ? cause.message : String(cause);
          const waitingForBroker = message.startsWith("LOCAL_EXECUTION_DEPENDENCY_PENDING:")
            || message === "LOCAL_BLACK_SCRIPT_PARENT_ORDER_NOT_RECONCILED"
            || message === "LOCAL_GROUP_REMOTE_ACK_PENDING";
          await setLocalStrategyRuntimeStatus(strategy.id, {
            state: waitingForBroker ? "WAITING_FOR_BROKER_RECONCILIATION" : "DEGRADED",
            lastHeartbeatAt: new Date().toISOString(),
            ...(waitingForBroker ? {} : { safeErrorCode: safeRuntimeError(message) }),
          }).catch(() => undefined);
        });
      }
    } finally {
      running = false;
    }
  };
  const timer = window.setInterval(() => void tick(), COORDINATOR_TICK_MS);
  window.setTimeout(() => void tick(), 750);
  stopCoordinator = () => {
    stopped = true;
    window.clearInterval(timer);
    stopCoordinator = null;
  };
  return stopCoordinator;
}

function safeRuntimeError(value: string) {
  return value.replace(/[\r\n\t]+/g, " ").replace(/[^A-Za-z0-9:_ .-]/g, "").slice(0, 180) || "LOCAL_STRATEGY_RUNTIME_ERROR";
}

async function strategySource(workspace: StrategyWorkspace) {
  const indicatorId = workspace.strategy.definition.indicator?.indicatorId || "";
  const scriptId = indicatorId.startsWith("custom:") ? indicatorId.slice("custom:".length) : "";
  if (!scriptId) return null;
  const username = getCachedLocalRuntimeStatus()?.config?.profile.username;
  return normalizeUserScripts(await loadLocalUserScripts(username)).find((script) => script.id === scriptId) || null;
}

function marketSymbol(workspace: StrategyWorkspace): MarketSymbol {
  const raw = workspace.strategy.symbol.toUpperCase();
  const quoteAsset = raw.endsWith("USDT") ? "USDT" : raw.endsWith("USDC") ? "USDC" : "USD";
  return {
    exchange: "bybit",
    rawSymbol: raw,
    baseAsset: raw.slice(0, -quoteAsset.length),
    quoteAsset,
    marketKind: workspace.strategy.marketType === "FUTURES" ? "perpetual" : "spot",
  };
}

function inputValues(settings: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))) as Record<string, ScriptInputValue>;
}

async function closedCandleWindow(workspace: StrategyWorkspace) {
  const timeframe = workspace.strategy.timeframe as Timeframe;
  const timeframeSeconds = strategyTimeframeSeconds[timeframe];
  if (!timeframeSeconds || timeframe.endsWith("t")) throw new Error("LOCAL_STRATEGY_TIMEFRAME_NOT_SUPPORTED");
  const warmup = Math.max(500, Number(workspace.strategy.definition.indicator?.warmupBars || 500));
  const bars = Math.min(5_000, warmup + 400);
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const history = await fetchStrategyLabCandles(
    marketSymbol(workspace),
    timeframe,
    new Date((nowSeconds - bars * timeframeSeconds) * 1_000).toISOString(),
    new Date(nowSeconds * 1_000).toISOString(),
    bars,
  );
  const closed = history.filter((candle) => candle.time + timeframeSeconds <= nowSeconds - CLOSED_CANDLE_GRACE_SECONDS);
  const current = history.find((candle) => candle.time > (closed.at(-1)?.time || 0)) || null;
  if (closed.length < Math.min(250, warmup)) throw new Error("LOCAL_STRATEGY_HISTORY_INSUFFICIENT");
  return { closed, current };
}

async function processLocalStrategy(strategyId: string) {
  const workspace = await getLocalStrategy(strategyId);
  const version = Number(workspace.strategy.runningVersion || 0);
  if (!version) return;
  const liveBindings = workspace.bindings.filter((binding) => binding.status === "LIVE");
  const script = await strategySource(workspace);
  if (!script) throw new Error("LOCAL_STRATEGY_IMMUTABLE_SOURCE_MISSING");
  const settings = inputValues(workspace.strategy.definition.settings || {});
  if (!isBlackScriptV3CloudEligibleSource(script.source, settings)) throw new Error("LOCAL_BLACK_SCRIPT_RUNTIME_NOT_CERTIFIED");
  const sourceVersion = blackScriptOwnedSourceVersion(script.source);
  if (workspace.strategy.definition.indicator?.version !== sourceVersion) throw new Error("LOCAL_BLACK_SCRIPT_SOURCE_VERSION_MISMATCH");

  const stored = await getLocalDocument<LocalStrategyRuntimeRecord>(RUNTIME_NAMESPACE, strategyId);
  const prior = stored?.value;
  const runtime: LocalStrategyRuntimeRecord = prior
    && prior.schemaVersion === 1
    && prior.runtimeVersion === "black-script-v3-local"
    && prior.strategyVersion === version
    && prior.sourceVersion === sourceVersion
    ? structuredClone(prior)
    : { schemaVersion: 1, runtimeVersion: "black-script-v3-local", strategyVersion: version, sourceVersion, checkpoint: null, targets: {}, updatedAt: Date.now() };

  const { closed, current } = await closedCandleWindow(workspace);
  const initialPanel = readStrategyControlPanel(workspace.strategy.definition, workspace.strategy.globalCapitalPolicy);
  const paperRuntime = workspace.paper?.status === "ACTIVE" ? await getLocalStrategyPaperRuntime(strategyId) : null;
  const highDetail = initialPanel.properties.barDetailization === "HIGH_LOWER_TIMEFRAME" || /use_bar_magnifier\s*=\s*True/i.test(script.source);
  const firstExecutable = runtime.checkpoint
    ? closed.findIndex((candle) => candle.time > runtime.checkpoint!.lastClosedCandleTime)
    : closed.length - 1;
  const paperFirstExecutable = paperRuntime?.checkpoint
    ? closed.findIndex((candle) => candle.time > paperRuntime.checkpoint!.lastClosedCandleTime)
    : closed.length - 1;
  const detailStart = Math.min(
    firstExecutable < 0 ? closed.length : firstExecutable,
    paperRuntime ? paperFirstExecutable < 0 ? closed.length : paperFirstExecutable : closed.length,
  );
  let intrabars: Array<readonly Candle[] | null> | undefined;
  if (highDetail && detailStart < closed.length) {
    const detailCandles = closed.slice(detailStart);
    const magnifier = await fetchStrategyLabIntrabars(marketSymbol(workspace), workspace.strategy.timeframe as Timeframe, detailCandles);
    if (magnifier.coveredBars < magnifier.requestedBars) {
      throw new Error(`LOCAL_BAR_MAGNIFIER_COVERAGE_INCOMPLETE:${magnifier.coveredBars}/${magnifier.requestedBars}`);
    }
    intrabars = [
      ...Array.from({ length: detailStart }, () => null),
      ...magnifier.intrabars,
      ...(current ? [null] : []),
    ];
  }
  const runtimeConfig = {
    initialCapital: initialPanel.properties.initialCapital,
    defaultQuantityMode: initialPanel.properties.orderSizeMode === "FIXED_QUANTITY" ? "fixed" as const : initialPanel.properties.orderSizeMode === "FIXED_USDT" ? "cash" as const : "percent_of_equity" as const,
    defaultQuantityValue: initialPanel.properties.orderSizeValue,
    commissionMode: initialPanel.properties.commissionMode === "USDT_PER_ORDER" ? "cash_per_order" as const : "percent" as const,
    commissionValue: initialPanel.properties.commissionValue,
    slippageTicks: initialPanel.properties.slippageTicks,
    tickSize: Number(workspace.strategy.definition.execution?.tickSize || 0.01),
    pyramiding: initialPanel.properties.pyramiding,
    processOrdersOnClose: initialPanel.properties.executionDelay === "NONE",
    historicalFillMode: initialPanel.properties.barDetailization === "CLOSED_BAR" ? "conservative" as const : "tradingview" as const,
    useBarMagnifier: highDetail,
  };
  const evaluation = evaluateBlackScriptCloudRuntime({
    source: script.source,
    expectedSourceVersion: sourceVersion,
    settings,
    closedCandles: closed,
    currentCandle: current,
    checkpoint: runtime.checkpoint,
    runtimeConfig,
    intrabars,
  });

  const executionTargets: StrategyTargetBinding[] = [];
  const remoteGroupDeliveries: RemoteGroupDelivery[] = [];
  for (const binding of liveBindings) {
    if (binding.targetType === "BROKER_ACCOUNT" && binding.accountId) {
      executionTargets.push(binding);
      continue;
    }
    if (binding.targetType !== "INVESTMENT_GROUP") continue;
    const members = await activeLocalInvestmentGroupMandates(
      binding.groupId || binding.targetId,
      workspace.strategy.symbol,
      binding.capitalPolicy,
    );
    const remoteMembers = await activeRemoteInvestmentGroupMandates(
      binding.groupId || binding.targetId,
      workspace.strategy.symbol,
      binding.capitalPolicy,
    );
    if (!members.length && !remoteMembers.length) throw new Error("LOCAL_GROUP_HAS_NO_ACTIVE_EXECUTION_MANDATES");
    const reasons = [...members, ...remoteMembers].flatMap((member) => member.reasons);
    if (reasons.length) throw new Error(`LOCAL_GROUP_MANDATE_PREFLIGHT_FAILED:${[...new Set(reasons)].join(" ")}`);
    for (const { mandate } of members) {
      executionTargets.push({
        ...binding,
        id: `${binding.id}:mandate:${mandate.id}`,
        targetId: mandate.id,
        targetLabel: `${binding.targetLabel || "Investment Group"} · ${mandate.accountLabel}`,
        targetProvider: mandate.provider,
        executionEnvironment: mandate.environment === "MAINNET" ? "MAINNET_LIVE" : mandate.environment,
        connectionId: mandate.accountId,
        accountId: mandate.accountId,
        validation: { ...binding.validation, maximumLeverage: mandate.maxLeverage },
      });
    }
    remoteMembers.forEach(({ mandate }) => remoteGroupDeliveries.push({ binding, mandate }));
  }
  const duplicateAccount = executionTargets.map((target) => target.accountId).find((accountId, index, values) => accountId && values.indexOf(accountId) !== index);
  if (duplicateAccount) throw new Error("LOCAL_EXECUTION_ACCOUNT_BOUND_MORE_THAN_ONCE");

  const latestClosedPrice = closed.at(-1)!.close;
  if (workspace.paper?.status === "ACTIVE" && paperRuntime) {
    const paperMatchesExecution = paperRuntime.initialCapital === runtimeConfig.initialCapital
      && JSON.stringify(paperRuntime.checkpoint) === JSON.stringify(runtime.checkpoint);
    const paperEvaluation = paperMatchesExecution ? evaluation : evaluateBlackScriptCloudRuntime({
      source: script.source,
      expectedSourceVersion: sourceVersion,
      settings,
      closedCandles: closed,
      currentCandle: current,
      checkpoint: paperRuntime.checkpoint,
      runtimeConfig: { ...runtimeConfig, initialCapital: paperRuntime.initialCapital },
      intrabars,
    });
    await applyLocalStrategyPaperEvaluation(strategyId, version, paperEvaluation, paperRuntime.initialCapital);
  }
  const remoteAcknowledgements = await Promise.all(remoteGroupDeliveries.map((delivery) =>
    deliverRemoteGroupEvaluation(workspace, delivery.binding, delivery.mandate, evaluation, latestClosedPrice)));
  if (remoteAcknowledgements.some((acknowledged) => !acknowledged)) {
    throw new Error("LOCAL_GROUP_REMOTE_ACK_PENDING");
  }
  for (const binding of executionTargets) {
    await processTarget(workspace, binding, evaluation, runtime, latestClosedPrice);
  }

  runtime.checkpoint = evaluation.checkpoint;
  runtime.updatedAt = Date.now();
  await putLocalDocument(RUNTIME_NAMESPACE, strategyId, runtime);
  await setLocalStrategyRuntimeStatus(strategyId, {
    state: executionTargets.length || remoteGroupDeliveries.length ? "RUNNING_LOCAL" : "RUNNING_PAPER_ONLY",
    lastClosedCandleAt: new Date(evaluation.latestClosedCandleTime * 1_000).toISOString(),
    lastSignalAt: evaluation.marketActions.length ? new Date().toISOString() : workspace.runtime?.lastSignalAt,
    lastHeartbeatAt: new Date().toISOString(),
  });
}

async function processTarget(
  workspace: ExecutionStrategyContext,
  binding: StrategyTargetBinding,
  evaluation: BlackScriptCloudEvaluation,
  runtime: LocalStrategyRuntimeRecord,
  latestClosedPrice: number,
) {
  const accountId = binding.accountId!;
  const record = await refreshLocalBrokerAccount(accountId, true);
  if (!record.lastSnapshot || record.lastError || !record.lastSnapshot.tradingEnabled || record.lastSnapshot.withdrawalEnabled) {
    throw new Error("LOCAL_BROKER_TARGET_NOT_READY");
  }
  const priorTarget = runtime.targets[binding.id];
  const initialExposure = getLocalBrokerSymbolExposure(accountId, workspace.strategy.symbol);
  if (!priorTarget && (initialExposure.positions || initialExposure.openOrders)) {
    throw new Error("LOCAL_TARGET_PREEXISTING_SYMBOL_EXPOSURE");
  }
  const priorHandles = priorTarget?.brokerOrderHandles || {};
  const fillState = await targetFillState(record.environment, accountId, workspace.strategy.symbol, priorHandles);
  assertBlackScriptExpectedTargetFills({ evaluation, priorHandles, state: fillState });
  const settledHandles = settleBlackScriptTargetMarketActions({ priorHandles, state: fillState });
  const opensThisGeneration = evaluation.marketActions.some((action) => action.action === "ENTRY" || action.action === "REVERSE");
  const hasOwnedPosition = fillState.ownedPositions.length > 0;
  const targetEvaluation = !priorTarget && !hasOwnedPosition && !opensThisGeneration
    ? { ...evaluation, desiredOrders: evaluation.desiredOrders.filter((order) => order.action === "entry") }
    : evaluation;
  const targetPreviousCheckpoint = priorTarget ? {
    ...evaluation.checkpoint,
    brokerOrderFingerprints: priorTarget.desiredOrderFingerprints,
  } : null;
  const rules = await getLocalBybitInstrumentRules(record.environment, workspace.strategy.symbol);
  const plan = buildBlackScriptBrokerPlan({
    evaluation: targetEvaluation,
    previousCheckpoint: targetPreviousCheckpoint,
    tickSize: Number(rules.tickSize),
  });
  const manifest = buildBlackScriptTargetCommandManifest({
    strategyId: workspace.strategy.id,
    strategyVersion: workspace.strategy.runningVersion || workspace.strategy.currentVersion,
    ownerUserId: getCachedLocalRuntimeStatus()?.config?.profile.username || "local-owner",
    bindingId: binding.id,
    connectionId: binding.connectionId || accountId,
    accountId,
    symbol: workspace.strategy.symbol,
    marketType: workspace.strategy.marketType,
    executionEnvironment: record.environment === "MAINNET" ? "MAINNET_LIVE" : record.environment,
    requestedLongLeverage: targetLeverage(binding, "long"),
    requestedShortLeverage: targetLeverage(binding, "short"),
    evaluation: targetEvaluation,
    plan,
    priorHandles: settledHandles,
    digest: sha256Hex,
  });
  for (const command of orderManifestCommands(manifest.commands)) {
    await enqueueManifestCommand(command, binding, record.environment, rules, latestClosedPrice, record.mainnetConfirmed);
  }
  runtime.targets[binding.id] = {
    desiredOrderFingerprints: manifest.desiredOrderFingerprints,
    brokerOrderHandles: manifest.brokerOrderHandles,
  };
}

function remoteEvaluationPayload(evaluation: BlackScriptCloudEvaluation) {
  return {
    sourceVersion: evaluation.sourceVersion,
    settingsVersion: evaluation.settingsVersion,
    latestClosedCandleTime: evaluation.latestClosedCandleTime,
    marketActions: evaluation.marketActions,
    desiredOrders: evaluation.desiredOrders,
    expectedOrderFills: evaluation.expectedOrderFills,
    retiredOrderKeys: evaluation.retiredOrderKeys,
  };
}

async function deliverRemoteGroupEvaluation(
  workspace: StrategyWorkspace,
  binding: StrategyTargetBinding,
  mandate: RemoteInvestmentGroupMandate,
  evaluation: BlackScriptCloudEvaluation,
  latestClosedPrice: number,
): Promise<boolean> {
  const identity = [
    workspace.strategy.id,
    workspace.strategy.runningVersion || workspace.strategy.currentVersion,
    binding.id,
    mandate.publicMandateId,
    evaluation.sourceVersion,
    evaluation.settingsVersion,
    evaluation.latestClosedCandleTime,
  ].join(":");
  const messageId = `group-eval:${sha256Hex(identity).slice(0, 64)}:a${Math.floor(Date.now() / 15_000)}`;
  const receipts = await listRemoteInvestmentGroupExecutionReceipts(binding.groupId || binding.targetId);
  const matching = receipts
    .filter((receipt) => receipt.publicMandateId === mandate.publicMandateId
      && receipt.strategyId === workspace.strategy.id
      && receipt.strategyVersion === (workspace.strategy.runningVersion || workspace.strategy.currentVersion)
      && receipt.latestClosedCandleTime === evaluation.latestClosedCandleTime)
    .sort((left, right) => right.receivedAt - left.receivedAt)[0];
  if (matching?.status === "ENQUEUED") return true;
  if (matching?.status === "REJECTED" && Date.now() - matching.receivedAt < 15_000) {
    throw new Error(`LOCAL_GROUP_REMOTE_REJECTED:${matching.safeErrorCode || "MEMBER_REJECTED_EVALUATION"}`);
  }
  await sendLocalP2pDirect(mandate.memberPeerId, messageId, {
    schemaVersion: 1,
    kind: "group-strategy-evaluation",
    groupId: binding.groupId || binding.targetId,
    publicMandateId: mandate.publicMandateId,
    expectedMandateVersion: mandate.version,
    groupBindingId: binding.id,
    strategyId: workspace.strategy.id,
    strategyVersion: workspace.strategy.runningVersion || workspace.strategy.currentVersion,
    sourceVersion: evaluation.sourceVersion,
    symbol: workspace.strategy.symbol,
    marketType: workspace.strategy.marketType,
    capitalPolicy: binding.capitalPolicy,
    evaluation: remoteEvaluationPayload(evaluation),
    latestClosedPrice,
  });
  return false;
}

function strictNumber(value: unknown, label: string, minimum = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum) throw new Error(`REMOTE_GROUP_${label}_INVALID`);
  return number;
}

function remoteCapitalPolicy(value: unknown): StrategyCapitalPolicy {
  const raw = object(value);
  const strategyAllocationMode = raw.strategyAllocationMode === "PERCENT_ACCOUNT_EQUITY" || raw.strategyAllocationMode === "FIXED_USDT" ? raw.strategyAllocationMode : null;
  const tradeAmountMode = ["FIXED_USDT", "FIXED_QUANTITY", "PERCENT_ACCOUNT_EQUITY", "PERCENT_STRATEGY_ALLOCATION"].includes(String(raw.tradeAmountMode))
    ? raw.tradeAmountMode as StrategyCapitalPolicy["tradeAmountMode"] : null;
  if (!strategyAllocationMode || !tradeAmountMode) throw new Error("REMOTE_GROUP_CAPITAL_POLICY_INVALID");
  return {
    strategyAllocationMode,
    strategyAllocationValue: strictNumber(raw.strategyAllocationValue, "STRATEGY_ALLOCATION"),
    tradeAmountMode,
    tradeAmountValue: strictNumber(raw.tradeAmountValue, "TRADE_AMOUNT"),
    requestedLeverage: strictNumber(raw.requestedLeverage ?? 1, "LEVERAGE", 1),
    requestedLongLeverage: strictNumber(raw.requestedLongLeverage ?? raw.requestedLeverage ?? 1, "LONG_LEVERAGE", 1),
    requestedShortLeverage: strictNumber(raw.requestedShortLeverage ?? raw.requestedLeverage ?? 1, "SHORT_LEVERAGE", 1),
    maximumLeverage: raw.maximumLeverage == null ? undefined : strictNumber(raw.maximumLeverage, "MAXIMUM_LEVERAGE", 1),
    maximumPositionPercent: strictNumber(raw.maximumPositionPercent, "MAXIMUM_POSITION"),
    maximumExposurePercent: strictNumber(raw.maximumExposurePercent, "MAXIMUM_EXPOSURE"),
    maximumDailyLoss: strictNumber(raw.maximumDailyLoss, "MAXIMUM_DAILY_LOSS"),
    maximumDrawdown: strictNumber(raw.maximumDrawdown, "MAXIMUM_DRAWDOWN"),
    maximumPositions: strictNumber(raw.maximumPositions, "MAXIMUM_POSITIONS", 1),
    slippageBps: strictNumber(raw.slippageBps, "SLIPPAGE"),
    marginMode: raw.marginMode === "ISOLATED" ? "ISOLATED" : "CROSS",
    quoteAssetReservePercent: raw.quoteAssetReservePercent == null ? undefined : strictNumber(raw.quoteAssetReservePercent, "QUOTE_RESERVE"),
    maximumBaseAssetExposurePercent: raw.maximumBaseAssetExposurePercent == null ? undefined : strictNumber(raw.maximumBaseAssetExposurePercent, "BASE_EXPOSURE"),
  };
}

function remoteEvaluation(value: unknown, expectedSourceVersion: string): BlackScriptCloudEvaluation {
  const raw = object(value);
  const sourceVersion = String(raw.sourceVersion || "");
  const settingsVersion = String(raw.settingsVersion || "");
  const latestClosedCandleTime = strictNumber(raw.latestClosedCandleTime, "CANDLE_TIME", 1);
  if (!sourceVersion || sourceVersion !== expectedSourceVersion || !settingsVersion) throw new Error("REMOTE_GROUP_EVALUATION_IDENTITY_INVALID");
  const marketActions = Array.isArray(raw.marketActions) ? raw.marketActions : [];
  const desiredOrders = Array.isArray(raw.desiredOrders) ? raw.desiredOrders : [];
  const expectedOrderFills = Array.isArray(raw.expectedOrderFills) ? raw.expectedOrderFills : [];
  const retiredOrderKeys = Array.isArray(raw.retiredOrderKeys) ? raw.retiredOrderKeys.map(String) : [];
  if (marketActions.length > 100 || desiredOrders.length > 100 || expectedOrderFills.length > 100 || retiredOrderKeys.length > 500) {
    throw new Error("REMOTE_GROUP_EVALUATION_LIMIT_EXCEEDED");
  }
  return {
    sourceVersion,
    settingsVersion,
    latestClosedCandleTime,
    marketActions: marketActions as BlackScriptCloudEvaluation["marketActions"],
    desiredOrders: desiredOrders as BlackScriptCloudEvaluation["desiredOrders"],
    expectedOrderFills: expectedOrderFills as BlackScriptCloudEvaluation["expectedOrderFills"],
    retiredOrderKeys,
    checkpoint: {
      schemaVersion: 1,
      runtimeVersion: "black-script-v3",
      sourceVersion,
      settingsVersion,
      lastClosedCandleTime: latestClosedCandleTime,
      processedFillKeys: [],
      desiredOrderFingerprints: {},
      engine: {} as BlackScriptCloudCheckpoint["engine"],
    },
  };
}

type LocalFollowerRuntime = {
  schemaVersion: 1;
  managerPeerId: string;
  groupId: string;
  publicMandateId: string;
  strategyId: string;
  strategyVersion: number;
  sourceVersion: string;
  lastClosedCandleTime: number;
  target: LocalTargetRuntime | null;
  updatedAt: number;
};

const FOLLOWER_RUNTIME_NAMESPACE = "investment-group-follower-runtime";

/**
 * Executes an authenticated manager evaluation on the member's own device.
 * The member-side mandate and live broker state are revalidated before any
 * durable execution command is accepted.
 */
export async function executeRemoteInvestmentGroupEvaluation(sourcePeerId: string, value: unknown) {
  const raw = object(value);
  const groupId = String(raw.groupId || "");
  const publicMandateId = String(raw.publicMandateId || "");
  const strategyId = String(raw.strategyId || "");
  const groupBindingId = String(raw.groupBindingId || "");
  const strategyVersion = strictNumber(raw.strategyVersion, "STRATEGY_VERSION", 1);
  const sourceVersion = String(raw.sourceVersion || "");
  const symbol = String(raw.symbol || "").toUpperCase();
  const latestClosedPrice = strictNumber(raw.latestClosedPrice, "REFERENCE_PRICE", Number.MIN_VALUE);
  if (!groupId || !publicMandateId || !strategyId || !groupBindingId || !sourceVersion || !/^[A-Z0-9]{5,24}$/.test(symbol)) {
    throw new Error("REMOTE_GROUP_EVALUATION_ENVELOPE_INVALID");
  }
  if (raw.marketType !== "FUTURES") throw new Error("REMOTE_GROUP_MARKET_NOT_CERTIFIED");
  const group = getLocalProfessionalNetworkState().groups.find((item) => item.id === groupId && item.ownerPeerId === sourcePeerId && item.status === "active");
  if (!group) throw new Error("REMOTE_GROUP_MANAGER_AUTHORITY_INVALID");
  const mandate = await getLocalInvestmentGroupMandateByPublicId(publicMandateId);
  if (!mandate || mandate.groupId !== groupId || mandate.status !== "ACTIVE") throw new Error("REMOTE_GROUP_LOCAL_MANDATE_NOT_ACTIVE");
  if (Number(raw.expectedMandateVersion || 0) !== mandate.version) throw new Error("REMOTE_GROUP_MANDATE_VERSION_MISMATCH");
  if (!mandate.allowedSymbols.includes("*") && !mandate.allowedSymbols.includes(symbol)) throw new Error("REMOTE_GROUP_SYMBOL_NOT_AUTHORIZED");
  if (mandate.environment === "MAINNET" && !mandate.allowMainnet) throw new Error("REMOTE_GROUP_MAINNET_NOT_AUTHORIZED");
  const policy = remoteCapitalPolicy(raw.capitalPolicy);
  const account = await refreshLocalBrokerAccount(mandate.accountId, true);
  if (!account.lastSnapshot || account.lastError || !account.lastSnapshot.tradingEnabled || account.lastSnapshot.withdrawalEnabled) {
    throw new Error("REMOTE_GROUP_BROKER_NOT_READY");
  }
  const mandateReasons = validateLocalInvestmentGroupPolicy(mandate, policy, account.account.equityUsd);
  if (mandateReasons.length) throw new Error(`REMOTE_GROUP_POLICY_REJECTED:${mandateReasons.join(" ")}`);
  const rules = await getLocalBybitInstrumentRules(account.environment, symbol);
  const requestedLeverage = Math.max(Number(policy.requestedLeverage || 1), Number(policy.requestedLongLeverage || 1), Number(policy.requestedShortLeverage || 1));
  if (requestedLeverage > Number(rules.maxLeverage) || requestedLeverage > mandate.maxLeverage) throw new Error("REMOTE_GROUP_LEVERAGE_REJECTED");
  const evaluation = remoteEvaluation(raw.evaluation, sourceVersion);
  if (evaluation.latestClosedCandleTime > Math.floor(Date.now() / 1_000) + 300) throw new Error("REMOTE_GROUP_EVALUATION_FROM_FUTURE");
  const runtimeKey = sha256Hex([sourcePeerId, groupId, publicMandateId, strategyId].join(":"));
  const stored = await getLocalDocument<LocalFollowerRuntime>(FOLLOWER_RUNTIME_NAMESPACE, runtimeKey);
  const prior = stored?.value;
  if (prior && evaluation.latestClosedCandleTime < prior.lastClosedCandleTime) throw new Error("REMOTE_GROUP_EVALUATION_OUT_OF_ORDER");
  const targetId = `remote:${groupBindingId}:mandate:${publicMandateId}`;
  const runtime: LocalStrategyRuntimeRecord = {
    schemaVersion: 1,
    runtimeVersion: "black-script-v3-local",
    strategyVersion,
    sourceVersion,
    checkpoint: null,
    targets: prior?.target ? { [targetId]: prior.target } : {},
    updatedAt: Date.now(),
  };
  const binding: StrategyTargetBinding = {
    id: targetId,
    strategyId,
    strategyVersion,
    slotIndex: 0,
    targetType: "INVESTMENT_GROUP",
    targetId: publicMandateId,
    targetLabel: `${group.firmName} · ${mandate.accountLabel}`,
    targetProvider: mandate.provider,
    executionEnvironment: mandate.environment === "MAINNET" ? "MAINNET_LIVE" : mandate.environment,
    connectionId: mandate.accountId,
    accountId: mandate.accountId,
    groupId,
    marketType: "FUTURES",
    status: "LIVE",
    capitalPolicyVersion: mandate.version,
    capitalPolicy: policy,
    validation: { eligible: true, reasons: [], checkedAt: new Date().toISOString(), maximumLeverage: Math.min(mandate.maxLeverage, Number(rules.maxLeverage)) },
    rowVersion: mandate.version,
    createdAt: mandate.createdAt,
    updatedAt: mandate.updatedAt,
    armedAt: mandate.updatedAt,
  };
  await processTarget({ strategy: { id: strategyId, runningVersion: strategyVersion, currentVersion: strategyVersion, symbol, marketType: "FUTURES" } }, binding, evaluation, runtime, latestClosedPrice);
  const follower: LocalFollowerRuntime = {
    schemaVersion: 1,
    managerPeerId: sourcePeerId,
    groupId,
    publicMandateId,
    strategyId,
    strategyVersion,
    sourceVersion,
    lastClosedCandleTime: evaluation.latestClosedCandleTime,
    target: runtime.targets[targetId] || null,
    updatedAt: Date.now(),
  };
  await putLocalDocument(FOLLOWER_RUNTIME_NAMESPACE, runtimeKey, follower, stored?.revision ?? 0);
  return { status: "ENQUEUED" as const, strategyId, strategyVersion, latestClosedCandleTime: evaluation.latestClosedCandleTime };
}

export function orderManifestCommands(commands: readonly BlackScriptExecutionCommand[]) {
  const pending = new Map(commands.map((command) => [command.idempotencyKey, command]));
  const manifestKeys = new Set(pending.keys());
  const completed = new Set<string>();
  const ordered: BlackScriptExecutionCommand[] = [];
  while (pending.size) {
    const ready = [...pending.values()].filter((command) => {
      const raw = command.payload.dependsOnIdempotencyKeys;
      const dependencies = Array.isArray(raw) ? raw.map(String).filter((key) => manifestKeys.has(key)) : [];
      return dependencies.every((key) => completed.has(key));
    });
    if (!ready.length) throw new Error("LOCAL_BLACK_SCRIPT_DEPENDENCY_CYCLE");
    ready.sort((left, right) => left.priority - right.priority || left.idempotencyKey.localeCompare(right.idempotencyKey));
    for (const command of ready) {
      pending.delete(command.idempotencyKey);
      completed.add(command.idempotencyKey);
      ordered.push(command);
    }
  }
  return ordered;
}

function sha256Hex(value: string) {
  return [...sha256(new TextEncoder().encode(value))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function venuePositions(accountId: string, symbol: string) {
  const record = getLocalBrokerRecord(accountId);
  const result = object(record?.lastSnapshot?.positions);
  return (Array.isArray(result.list) ? result.list : []).map(object).filter((position) => String(position.symbol || "") === symbol && Number(position.size || 0) > 0);
}

function accountPositionMode(accountId: string, symbol: string) {
  const record = getLocalBrokerRecord(accountId);
  const result = object(record?.lastSnapshot?.positions);
  const rows = (Array.isArray(result.list) ? result.list : []).map(object).filter((position) => String(position.symbol || "") === symbol);
  return rows.some((position) => [1, 2].includes(Number(position.positionIdx))) ? "HEDGE" : "ONE_WAY";
}

function positionIdx(accountId: string, symbol: string, direction: "long" | "short") {
  return accountPositionMode(accountId, symbol) === "HEDGE" ? direction === "long" ? 1 as const : 2 as const : 0 as const;
}

function positionQuantity(accountId: string, symbol: string, direction: "long" | "short") {
  const side = direction === "long" ? "Buy" : "Sell";
  return venuePositions(accountId, symbol).filter((position) => position.side === side).reduce((sum, position) => sum + Number(position.size || 0), 0);
}

function targetOwnedPositions(accountId: string, symbol: string) {
  return venuePositions(accountId, symbol).map((position) => ({
    direction: position.side === "Buy" ? "long" as const : "short" as const,
    quantity: Number(position.size || 0),
  }));
}

async function targetFillState(
  environment: LocalBybitEnvironment,
  accountId: string,
  symbol: string,
  handles: Record<string, BlackScriptBrokerOrderHandle>,
): Promise<BlackScriptTargetFillState> {
  const commandsByIdempotencyKey: BlackScriptTargetFillState["commandsByIdempotencyKey"] = {};
  const ordersById: BlackScriptTargetFillState["ordersById"] = {};
  for (const handle of Object.values(handles)) {
    const intent = await getLocalExecution<Record<string, unknown>>(handle.placeIdempotencyKey);
    const receipt = executionReceipt(intent);
    commandsByIdempotencyKey[handle.placeIdempotencyKey] = {
      status: intent?.status || "MISSING",
      executionOrderId: receipt?.orderId ? String(receipt.orderId) : null,
    };
    if (!receipt?.orderId) continue;
    const linkId = String(receipt.orderLinkId || "");
    const current = linkId ? await lookupLocalBybitOrder({ accountId, environment, symbol, orderLinkId: linkId }).catch(() => null) : null;
    const order = current || object(receipt.raw);
    ordersById[String(receipt.orderId)] = {
      status: String(order.orderStatus || receipt.orderStatus || "unknown"),
      filledQuantity: Number(order.cumExecQty || 0),
      quantity: Number(order.qty || 0),
    };
  }
  return { commandsByIdempotencyKey, ordersById, ownedPositions: targetOwnedPositions(accountId, symbol) };
}

function executionReceipt(intent: LocalExecutionIntent<Record<string, unknown>> | null) {
  if (!intent?.result) return null;
  const result = object(intent.result);
  return object(result.entryOrder && typeof result.entryOrder === "object" ? result.entryOrder : result);
}

async function requireSucceededDependencies(keys: readonly string[]) {
  for (const key of keys) {
    const intent = await getLocalExecution(key);
    if (!intent) throw new Error(`LOCAL_EXECUTION_DEPENDENCY_MISSING:${key}`);
    if (["FAILED", "CANCELLED"].includes(intent.status)) {
      throw new Error(`LOCAL_EXECUTION_DEPENDENCY_FAILED:${key}`);
    }
    if (intent.status !== "SUCCEEDED") {
      throw new Error(`LOCAL_EXECUTION_DEPENDENCY_PENDING:${key}`);
    }
  }
}

function decimalPlaces(step: number) {
  const text = step.toString().toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  return text.includes(".") ? text.split(".")[1]!.length : 0;
}

function floorStep(value: number, step: number) {
  const precision = Math.min(12, decimalPlaces(step));
  return Number((Math.floor((value + Number.EPSILON) / step) * step).toFixed(precision));
}

function roundTick(value: number, tick: number) {
  const precision = Math.min(12, decimalPlaces(tick));
  return Number((Math.round(value / tick) * tick).toFixed(precision));
}

function policyQuantity(policy: StrategyCapitalPolicy, equity: number, available: number, price: number, leverage: number, rules: LocalBybitInstrumentRules) {
  const allocation = policy.strategyAllocationMode === "FIXED_USDT"
    ? policy.strategyAllocationValue
    : equity * policy.strategyAllocationValue / 100;
  if (allocation > equity + 1e-9) throw new Error("LOCAL_STRATEGY_ALLOCATION_EXCEEDS_EQUITY");
  let margin: number;
  if (policy.tradeAmountMode === "FIXED_QUANTITY") {
    return validatedQuantity(policy.tradeAmountValue, price, rules, "Market");
  }
  if (policy.tradeAmountMode === "FIXED_USDT") margin = policy.tradeAmountValue;
  else if (policy.tradeAmountMode === "PERCENT_ACCOUNT_EQUITY") margin = equity * policy.tradeAmountValue / 100;
  else if (policy.tradeAmountMode === "PERCENT_STRATEGY_ALLOCATION") margin = allocation * policy.tradeAmountValue / 100;
  else throw new Error(`LOCAL_SIZING_MODE_NOT_CERTIFIED:${policy.tradeAmountMode}`);
  if (margin > available + 1e-9) throw new Error("LOCAL_STRATEGY_ENTRY_MARGIN_EXCEEDS_AVAILABLE_BALANCE");
  return validatedQuantity(margin * leverage / price, price, rules, "Market");
}

function validatedQuantity(value: number, price: number, rules: LocalBybitInstrumentRules, orderType: "Market" | "Limit") {
  const step = Number(rules.quantityStep);
  const quantity = floorStep(value, step);
  const minimum = Number(rules.minQuantity);
  const maximum = Number(orderType === "Market" ? rules.maxMarketQuantity : rules.maxLimitQuantity);
  if (!(quantity >= minimum) || quantity > maximum || quantity * price < Number(rules.minNotional)) {
    throw new Error("LOCAL_BYBIT_ORDER_QUANTITY_OUTSIDE_INSTRUMENT_LIMITS");
  }
  return quantity;
}

function targetLeverage(binding: StrategyTargetBinding, direction: "long" | "short") {
  const policy = binding.capitalPolicy;
  return Number(direction === "long"
    ? policy.requestedLongLeverage || policy.requestedLeverage || 1
    : policy.requestedShortLeverage || policy.requestedLeverage || 1);
}

async function enqueueManifestCommand(
  command: BlackScriptExecutionCommand,
  binding: StrategyTargetBinding,
  environment: LocalBybitEnvironment,
  rules: LocalBybitInstrumentRules,
  latestClosedPrice: number,
  mainnetConfirmed: boolean,
) {
  const payload = command.payload;
  const accountId = binding.accountId!;
  const symbol = String(payload.symbol || "").toUpperCase();
  const referencePrice = Number(payload.referencePrice || 0) || latestClosedPrice;
  if (!(referencePrice > 0)) throw new Error("LOCAL_STRATEGY_REFERENCE_PRICE_INVALID");
  const direction = String(payload.direction || "long") === "short" ? "short" as const : "long" as const;
  const action = String(payload.action || "");
  const opensPosition = ["ENTRY", "REVERSE", "BLACK_SCRIPT_ENTRY"].includes(action);
  const leverage = targetLeverage(binding, direction);
  const dependencies = Array.isArray(payload.dependsOnIdempotencyKeys)
    ? [...new Set(payload.dependsOnIdempotencyKeys.map(String))]
    : [];
  if (opensPosition) {
    const leverageIdempotencyKey = `${command.idempotencyKey}:leverage`;
    await enqueueLocalExecution({
      executionType: "LEVERAGE",
      idempotencyKey: leverageIdempotencyKey,
      payload: { accountId, environment, symbol, leverage: String(leverage), mainnetConfirmed },
      priority: 5,
      maxAttempts: Math.min(20, command.maxAttempts),
    });
    dependencies.push(leverageIdempotencyKey);
  }
  const dependencyPayload = dependencies.length ? { dependsOnIdempotencyKeys: dependencies } : {};

  if (command.commandType === "PLACE_ORDER") {
    if (action === "REVERSE") {
      const record = getLocalBrokerRecord(accountId);
      const quantity = policyQuantity(binding.capitalPolicy, record?.account.equityUsd || 0, record?.account.availableMargin || 0, referencePrice, leverage, rules);
      await enqueueLocalExecution({
        executionType: "REVERSE",
        idempotencyKey: command.idempotencyKey,
        payload: { accountId, environment, symbol, targetSide: direction === "long" ? "Buy" : "Sell", targetQuantity: String(quantity), leverage: String(leverage), orderLinkId: localBybitOrderLinkId(command.deterministicClientOrderId || command.idempotencyKey), mainnetConfirmed, ...dependencyPayload },
        priority: command.priority,
        maxAttempts: Math.min(20, command.maxAttempts),
      });
      return;
    }
    const reduceOnly = payload.reduceOnly === true || action === "CLOSE" || action === "BLACK_SCRIPT_EXIT";
    const positionDirection = String(payload.positionDirection || payload.direction || "long") === "short" ? "short" as const : "long" as const;
    const orderType = String(payload.orderType || "market");
    const nativeOrderType = orderType === "limit" || orderType === "stop-limit" ? "Limit" as const : "Market" as const;
    if (reduceOnly && dependencies.length) await requireSucceededDependencies(dependencies);
    const record = reduceOnly
      ? await refreshLocalBrokerAccount(accountId, true)
      : getLocalBrokerRecord(accountId);
    let quantity: number;
    if (!reduceOnly) {
      quantity = policyQuantity(binding.capitalPolicy, record?.account.equityUsd || 0, record?.account.availableMargin || 0, referencePrice, leverage, rules);
    } else {
      const open = positionQuantity(accountId, symbol, positionDirection);
      const percent = Number(payload.closeQuantityPercent ?? payload.quantityPercent ?? 100);
      const fixed = Number(payload.closeQuantity ?? payload.quantity ?? 0);
      const base = fixed > 0 ? Math.min(open || fixed, fixed) : open * Math.min(100, Math.max(0, percent)) / 100;
      if (!(base > 0)) return;
      quantity = validatedQuantity(base, referencePrice, rules, nativeOrderType);
    }
    const stopPriceRaw = Number(payload.stopPrice || 0);
    const limitPriceRaw = Number(payload.limitPrice || 0);
    const stopPrice = stopPriceRaw > 0 ? roundTick(stopPriceRaw, Number(rules.tickSize)) : undefined;
    const limitPrice = limitPriceRaw > 0 ? roundTick(limitPriceRaw, Number(rules.tickSize)) : undefined;
    const side = reduceOnly
      ? positionDirection === "long" ? "Sell" as const : "Buy" as const
      : payload.side === "buy" || (!payload.side && direction === "long") ? "Buy" as const : "Sell" as const;
    await enqueueLocalExecution({
      executionType: "ORDER",
      idempotencyKey: command.idempotencyKey,
      payload: {
        accountId,
        environment,
        symbol,
        side,
        orderType: nativeOrderType,
        quantity: String(quantity),
        ...(limitPrice ? { price: String(limitPrice) } : {}),
        reduceOnly,
        closeOnTrigger: reduceOnly && Boolean(stopPrice),
        positionIdx: positionIdx(accountId, symbol, reduceOnly ? positionDirection : direction),
        ...(!reduceOnly ? { leverage: String(leverage) } : {}),
        orderLinkId: localBybitOrderLinkId(command.deterministicClientOrderId || command.idempotencyKey),
        ...(stopPrice ? { triggerPrice: String(stopPrice), triggerDirection: stopPrice > referencePrice ? 1 : 2, triggerBy: "MarkPrice" } : {}),
        mainnetConfirmed,
        ...dependencyPayload,
      },
      priority: command.priority,
      maxAttempts: Math.min(20, command.maxAttempts),
    });
    return;
  }

  if (command.commandType === "CANCEL_ORDER" || command.commandType === "MODIFY_ORDER") {
    const parentKey = String(payload.parentPlaceIdempotencyKey || "");
    const parent = executionReceipt(await getLocalExecution<Record<string, unknown>>(parentKey));
    if (!parent?.orderId) throw new Error("LOCAL_BLACK_SCRIPT_PARENT_ORDER_NOT_RECONCILED");
    if (command.commandType === "CANCEL_ORDER") {
      await enqueueLocalExecution({ executionType: "CANCEL", idempotencyKey: command.idempotencyKey, payload: { accountId, environment, symbol, orderId: String(parent.orderId), mainnetConfirmed, ...dependencyPayload }, priority: command.priority, maxAttempts: Math.min(20, command.maxAttempts) });
    } else {
      const request = object(payload.request);
      const quantity = Number(request.quantity || 0);
      const price = Number(request.limitPrice || 0);
      const triggerPrice = Number(request.stopPrice || 0);
      await enqueueLocalExecution({ executionType: "AMEND", idempotencyKey: command.idempotencyKey, payload: { accountId, environment, symbol, orderId: String(parent.orderId), ...(quantity > 0 ? { quantity: String(validatedQuantity(quantity, referencePrice, rules, "Limit")) } : {}), ...(price > 0 ? { price: String(roundTick(price, Number(rules.tickSize))) } : {}), ...(triggerPrice > 0 ? { triggerPrice: String(roundTick(triggerPrice, Number(rules.tickSize))) } : {}), mainnetConfirmed, ...dependencyPayload }, priority: command.priority, maxAttempts: Math.min(20, command.maxAttempts) });
    }
    return;
  }

  if (command.commandType === "PLACE_PROTECTION") {
    const cancel = payload.cancelStopLoss === true || payload.cancelTrailingStop === true;
    const stopLoss = cancel && payload.cancelStopLoss === true ? "0" : Number(payload.stopLoss || 0) > 0 ? String(roundTick(Number(payload.stopLoss), Number(rules.tickSize))) : undefined;
    const trailingStop = cancel && payload.cancelTrailingStop === true ? "0" : Number(payload.trailingDistance || 0) > 0 ? String(roundTick(Number(payload.trailingDistance), Number(rules.tickSize))) : undefined;
    const activePrice = Number(payload.trailingActivationPrice || 0) > 0 ? String(roundTick(Number(payload.trailingActivationPrice), Number(rules.tickSize))) : undefined;
    if (!stopLoss && !trailingStop) return;
    await enqueueLocalExecution({ executionType: "PROTECTION", idempotencyKey: command.idempotencyKey, payload: { accountId, environment, symbol, positionIdx: positionIdx(accountId, symbol, direction), ...(stopLoss ? { stopLoss } : {}), ...(trailingStop ? { trailingStop } : {}), ...(activePrice ? { activePrice } : {}), mainnetConfirmed, ...dependencyPayload }, priority: command.priority, maxAttempts: Math.min(20, command.maxAttempts) });
  }
}
