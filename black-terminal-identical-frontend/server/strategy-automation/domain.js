import crypto from "node:crypto";

export const LIVE_TARGET_LIMIT = 9;
export const TARGET_TYPES = Object.freeze(["BROKER_ACCOUNT", "INVESTMENT_GROUP"]);
export const MARKET_TYPES = Object.freeze(["SPOT", "FUTURES"]);
export const CLOSED_CANDLE_TIMEFRAMES = Object.freeze(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "3h", "4h", "6h", "12h", "1d", "1w", "1M"]);
export const TRADE_AMOUNT_MODES = Object.freeze([
  "PERCENT_ACCOUNT_EQUITY",
  "PERCENT_STRATEGY_ALLOCATION",
  "RISK_PERCENT",
  "FIXED_USDT",
  "FIXED_QUANTITY",
  "VOLATILITY_TARGET"
]);
export const TARGET_ACTIVE_STATUSES = Object.freeze([
  "PENDING",
  "READY",
  "LIVE",
  "PAUSED",
  "DEGRADED",
  "RISK_SUSPENDED",
  "DISCONNECTING",
  "ERROR"
]);

export function strategyError(statusCode, code, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details) error.publicDetails = details;
  return error;
}

export function normalizeStrategyName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  if (!name) throw strategyError(400, "STRATEGY_NAME_REQUIRED", "Name the strategy before saving it.");
  if (name.length > 80) throw strategyError(400, "STRATEGY_NAME_TOO_LONG", "Strategy names cannot exceed 80 characters.");
  return name;
}

export function normalizeStrategyDefinition(value = {}) {
  const runtimeKind = String(value.runtimeKind || "builtin-adaptive-swing");
  if (!["builtin-ema-cross", "builtin-adaptive-swing", "builtin-superatr-seven-step", "python-script", "external-signals"].includes(runtimeKind)) {
    throw strategyError(400, "STRATEGY_RUNTIME_UNSUPPORTED", "The selected strategy runtime is not supported.");
  }
  const symbol = String(value.symbol || "").replace(/[^A-Za-z0-9:_/.-]/g, "").toUpperCase();
  if (symbol.length < 2 || symbol.length > 40) throw strategyError(400, "STRATEGY_SYMBOL_INVALID", "A valid strategy symbol is required.");
  const timeframe = normalizeClosedCandleTimeframe(value.timeframe);
  const marketType = normalizeMarketType(value.marketType || "FUTURES");
  const settings = plainObject(value.settings);
  const execution = plainObject(value.execution);
  return {
    runtimeKind,
    symbol,
    timeframe,
    marketType,
    exchange: String(value.exchange || "bybit").trim().toLowerCase().slice(0, 40),
    settings,
    execution,
    indicator: normalizeIndicatorBinding(value.indicator),
    signals: plainObject(value.signals),
    filters: plainObject(value.filters),
    exits: plainObject(value.exits),
    schedule: plainObject(value.schedule),
    paper: plainObject(value.paper),
    deployment: normalizeDeploymentPlan(value.deployment),
    controlPanel: plainObject(value.controlPanel),
    metadata: normalizeStrategyMetadata(value.metadata)
  };
}

function normalizeDeploymentPlan(value) {
  const plan = plainObject(value);
  const requested = String(plan.targetType || "PAPER").toUpperCase();
  const targetType = ["PAPER", "BROKER_ACCOUNT", "INVESTMENT_GROUP"].includes(requested) ? requested : "PAPER";
  return {
    targetType,
    targetId: targetType === "PAPER" ? undefined : String(plan.targetId || "").trim().slice(0, 80) || undefined,
    targetLabel: targetType === "PAPER" ? "Paper Backtester" : String(plan.targetLabel || "").trim().slice(0, 160) || undefined,
    authorizationAccepted: targetType === "PAPER" ? false : plan.authorizationAccepted === true,
    armOnActivation: targetType === "PAPER" ? false : plan.armOnActivation === true
  };
}

export function assertCertifiedStrategyDefinition(definition) {
  const indicatorId = String(definition.indicator?.indicatorId || "").toLowerCase();
  const indicatorName = String(definition.indicator?.name || "").toLowerCase();
  if (indicatorId === "black-core-dda-pro" || indicatorId.includes("ddapro") || indicatorName.includes("bc-rda") || indicatorName.includes("risk distribution analysis")) {
    throw strategyError(409, "BC_RDA_SIGNAL_INTEGRITY_BLOCKED", "BC-RDA is blocked from Strategy Lab while causal replay and headless runtime certification are incomplete.");
  }
  if (!["builtin-ema-cross", "builtin-adaptive-swing", "builtin-superatr-seven-step"].includes(definition.runtimeKind)) {
    throw strategyError(409, "STRATEGY_RUNTIME_NOT_CERTIFIED", "This indicator does not yet have a certified VPS strategy runtime.");
  }
  if (definition.indicator && definition.indicator.runtimeStatus !== "CERTIFIED") {
    throw strategyError(409, "STRATEGY_INDICATOR_NOT_CERTIFIED", "The selected indicator is visible on the chart but is not certified for Black Cloud automation.");
  }
  if (definition.runtimeKind === "builtin-superatr-seven-step") {
    const settings = definition.settings || {};
    minimum(settings.superAtrShortPeriod ?? 30, 1, "SuperATR short period");
    minimum(settings.superAtrLongPeriod ?? 70, 1, "SuperATR long period");
    minimum(settings.superAtrMomentumPeriod ?? 7, 1, "SuperATR momentum period");
    minimum(settings.superAtrConfirmationPeriod ?? 7, 1, "SuperATR confirmation period");
    minimum(settings.superAtrTrendStrengthThreshold ?? 3.1, 0, "SuperATR trend strength threshold");
    minimum(settings.superAtrTakeProfitAtrLength ?? 100, 1, "SuperATR take-profit ATR length");
    for (const [index, value] of numberList(settings.superAtrAtrMultipliers, [100, 70, 120, 300], 4, "SuperATR ATR multipliers").entries()) minimum(value, 0.1, `SuperATR ATR multiplier ${index + 1}`);
    for (const [index, value] of numberList(settings.superAtrFixedPercentages, [21, 21, 75], 3, "SuperATR fixed take-profits").entries()) minimum(value, 0.1, `SuperATR fixed take-profit ${index + 1}`);
    bounded(settings.superAtrAtrExitPercent ?? 10, 0.1, 100, "SuperATR ATR exit allocation");
    bounded(settings.superAtrFixedExitPercent ?? 10, 0.1, 100, "SuperATR fixed exit allocation");
  }
  const required = definition.marketType === "SPOT"
    ? [definition.signals?.buyEntry, definition.signals?.sellExit]
    : [definition.signals?.longEntry, definition.signals?.shortEntry];
  if (definition.indicator && required.some((value) => !value)) {
    throw strategyError(409, "STRATEGY_SIGNAL_MAPPING_INCOMPLETE", "Map every required entry action to a certified indicator alert before publishing.");
  }
  const alertIds = new Set((definition.indicator?.alerts || []).map((alert) => String(alert.id)));
  const mappedIds = Object.values(definition.signals || {}).filter(Boolean).map(String);
  if (mappedIds.some((id) => !alertIds.has(id))) {
    throw strategyError(409, "STRATEGY_ALERT_IDENTITY_INVALID", "One or more signal mappings are not present in the pinned indicator alert manifest.");
  }
  const takeProfits = Array.isArray(definition.exits?.takeProfits) ? definition.exits.takeProfits : [];
  const totalExitPercent = takeProfits.reduce((sum, target) => sum + finite(target?.closePercent), 0);
  if (totalExitPercent > 100) throw strategyError(409, "STRATEGY_EXIT_ALLOCATION_INVALID", "Take-profit allocations cannot exceed 100 percent.");
  for (const target of takeProfits) {
    const mode = String(target?.mode || (target?.alertId ? "ALERT" : "R_MULTIPLE")).toUpperCase();
    if (!['ALERT','R_MULTIPLE','PRICE_PERCENT'].includes(mode)) throw strategyError(409, "STRATEGY_EXIT_TRIGGER_INVALID", "Take-profit trigger type is invalid.");
    if (mode === "ALERT" && !alertIds.has(String(target?.alertId || ""))) throw strategyError(409, "STRATEGY_EXIT_ALERT_INVALID", "A take-profit alert is not present in the pinned indicator manifest.");
    if (mode !== "ALERT" && finite(target?.value) <= 0) throw strategyError(409, "STRATEGY_EXIT_VALUE_INVALID", "A price or risk-multiple take-profit requires a positive trigger value.");
    if (finite(target?.closePercent) <= 0) throw strategyError(409, "STRATEGY_EXIT_PERCENT_INVALID", "Every take-profit must close a positive percentage.");
  }
  const execution = definition.execution || {};
  if (execution.stopReversalEnabled === true) {
    bounded(execution.maximumReversalChain ?? 1, 1, 5, "maximum reversal chain");
    bounded(execution.maximumReversalsPerDay ?? 2, 1, 20, "maximum reversals per day");
    bounded(execution.reversalCooldownBars ?? 1, 0, 10_000, "reversal cooldown");
  }
  const deployment = definition.deployment || { targetType: "PAPER" };
  if (deployment.targetType !== "PAPER") {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(deployment.targetId || ""))) throw strategyError(409, "STRATEGY_DESTINATION_INVALID", "Select a valid owned execution destination.");
    if (deployment.authorizationAccepted !== true) throw strategyError(409, "STRATEGY_DESTINATION_NOT_AUTHORIZED", "Explicitly authorize the selected execution destination.");
  }
  return definition;
}

function normalizeIndicatorBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const alerts = Array.isArray(value.alerts)
    ? value.alerts.slice(0, 100).map((alert) => ({
        id: String(alert?.id || "").trim().slice(0, 160),
        name: String(alert?.name || "").trim().slice(0, 120),
        description: String(alert?.description || "").trim().slice(0, 500),
        semantic: String(alert?.semantic || "NEUTRAL").trim().toUpperCase().slice(0, 40),
        confirmedBar: alert?.confirmedBar !== false,
        intrabar: alert?.intrabar === true
      })).filter((alert) => alert.id && alert.name)
    : [];
  return {
    indicatorId: String(value.indicatorId || "").trim().slice(0, 160),
    instanceId: String(value.instanceId || "").trim().slice(0, 160),
    name: String(value.name || "").trim().slice(0, 160),
    instanceName: String(value.instanceName || "").trim().slice(0, 160),
    version: String(value.version || "1").trim().slice(0, 40),
    settingsHash: String(value.settingsHash || "").trim().slice(0, 128),
    settingsSummary: String(value.settingsSummary || "").trim().slice(0, 500),
    alertManifestVersion: String(value.alertManifestVersion || "1").trim().slice(0, 40),
    runtimeVersion: String(value.runtimeVersion || "").trim().slice(0, 80),
    warmupBars: Math.max(0, Math.min(100_000, Math.round(Number(value.warmupBars || 0)))),
    runtimeStatus: ["CERTIFIED", "REQUIRES_CERTIFICATION", "BROWSER_ONLY"].includes(String(value.runtimeStatus).toUpperCase())
      ? String(value.runtimeStatus).toUpperCase()
      : "REQUIRES_CERTIFICATION",
    useCurrentChartSettings: value.useCurrentChartSettings !== false,
    alerts
  };
}

function normalizeStrategyMetadata(value) {
  const metadata = plainObject(value);
  return {
    description: String(metadata.description || "").trim().slice(0, 2_000),
    tags: Array.isArray(metadata.tags)
      ? [...new Set(metadata.tags.map((tag) => String(tag).trim().slice(0, 40)).filter(Boolean))].slice(0, 20)
      : [],
    templateId: String(metadata.templateId || "blank-indicator").trim().slice(0, 80)
  };
}

export function defaultPaperCapitalPolicy(marketType = "FUTURES") {
  const normalizedMarket = normalizeMarketType(marketType);
  return normalizeCapitalPolicy({
    strategyAllocationMode: "PERCENT_ACCOUNT_EQUITY",
    strategyAllocationValue: 100,
    tradeAmountMode: "PERCENT_STRATEGY_ALLOCATION",
    tradeAmountValue: 10,
    requestedLeverage: normalizedMarket === "FUTURES" ? 1 : undefined,
    maximumLeverage: normalizedMarket === "FUTURES" ? 3 : undefined,
    maximumPositionPercent: 25,
    maximumExposurePercent: 100,
    maximumDailyLoss: 5,
    maximumDrawdown: 20,
    maximumPositions: 1,
    slippageBps: 5,
    marginMode: normalizedMarket === "FUTURES" ? "CROSS" : undefined,
    quoteAssetReservePercent: normalizedMarket === "SPOT" ? 10 : undefined,
    maximumBaseAssetExposurePercent: normalizedMarket === "SPOT" ? 90 : undefined
  }, normalizedMarket, { allowZeroAllocation: false });
}

export function defaultLiveCapitalPolicy(marketType = "FUTURES") {
  const normalizedMarket = normalizeMarketType(marketType);
  return normalizeCapitalPolicy({
    strategyAllocationMode: "PERCENT_ACCOUNT_EQUITY",
    strategyAllocationValue: 0,
    tradeAmountMode: "PERCENT_STRATEGY_ALLOCATION",
    tradeAmountValue: 0,
    requestedLeverage: normalizedMarket === "FUTURES" ? 1 : undefined,
    maximumLeverage: normalizedMarket === "FUTURES" ? 1 : undefined,
    maximumPositionPercent: 0,
    maximumExposurePercent: 0,
    maximumDailyLoss: 0,
    maximumDrawdown: 0,
    maximumPositions: 1,
    slippageBps: 5,
    marginMode: normalizedMarket === "FUTURES" ? "CROSS" : undefined,
    quoteAssetReservePercent: normalizedMarket === "SPOT" ? 100 : undefined,
    maximumBaseAssetExposurePercent: normalizedMarket === "SPOT" ? 0 : undefined
  }, normalizedMarket, { allowZeroAllocation: true });
}

export function normalizeCapitalPolicy(value = {}, marketType = "FUTURES", options = {}) {
  const market = normalizeMarketType(marketType);
  const allocationMode = enumValue(value.strategyAllocationMode, ["PERCENT_ACCOUNT_EQUITY", "FIXED_USDT"], "PERCENT_ACCOUNT_EQUITY", "strategy allocation mode");
  const tradeAmountMode = enumValue(value.tradeAmountMode, TRADE_AMOUNT_MODES, "PERCENT_STRATEGY_ALLOCATION", "trade amount mode");
  const strategyAllocationValue = bounded(value.strategyAllocationValue, 0, allocationMode === "PERCENT_ACCOUNT_EQUITY" ? 100 : 1_000_000_000, "strategy allocation");
  const tradeAmountValue = bounded(value.tradeAmountValue, 0, ["PERCENT_ACCOUNT_EQUITY", "PERCENT_STRATEGY_ALLOCATION", "RISK_PERCENT"].includes(tradeAmountMode) ? 100 : 1_000_000_000, "per-trade amount");
  if (!options.allowZeroAllocation && strategyAllocationValue <= 0) throw strategyError(400, "STRATEGY_ALLOCATION_REQUIRED", "Strategy allocation must be greater than zero.");
  const requestedLeverage = market === "FUTURES" ? bounded(value.requestedLeverage ?? 1, 1, 1000, "requested leverage") : undefined;
  const requestedLongLeverage = market === "FUTURES" ? bounded(value.requestedLongLeverage ?? requestedLeverage ?? 1, 1, 1000, "requested long leverage") : undefined;
  const requestedShortLeverage = market === "FUTURES" ? bounded(value.requestedShortLeverage ?? requestedLeverage ?? 1, 1, 1000, "requested short leverage") : undefined;
  const maximumLeverage = market === "FUTURES" ? bounded(value.maximumLeverage ?? requestedLeverage ?? 1, 1, 1000, "maximum leverage") : undefined;
  return {
    strategyAllocationMode: allocationMode,
    strategyAllocationValue,
    tradeAmountMode,
    tradeAmountValue,
    requestedLeverage,
    requestedLongLeverage,
    requestedShortLeverage,
    maximumLeverage,
    maximumPositionPercent: bounded(value.maximumPositionPercent ?? 100, 0, 100, "maximum position percentage"),
    maximumExposurePercent: bounded(value.maximumExposurePercent ?? 100, 0, 100, "maximum exposure percentage"),
    maximumDailyLoss: bounded(value.maximumDailyLoss ?? 0, 0, 1_000_000_000, "maximum daily loss"),
    maximumDrawdown: bounded(value.maximumDrawdown ?? 0, 0, 100, "maximum drawdown"),
    maximumPositions: Math.round(bounded(value.maximumPositions ?? 1, 1, 1000, "maximum positions")),
    slippageBps: bounded(value.slippageBps ?? 5, 0, 10_000, "slippage"),
    marginMode: market === "FUTURES" ? enumValue(value.marginMode, ["CROSS", "ISOLATED"], "CROSS", "margin mode") : undefined,
    quoteAssetReservePercent: market === "SPOT" ? bounded(value.quoteAssetReservePercent ?? 10, 0, 100, "quote asset reserve percentage") : undefined,
    maximumBaseAssetExposurePercent: market === "SPOT" ? bounded(value.maximumBaseAssetExposurePercent ?? 90, 0, 100, "maximum base-asset exposure percentage") : undefined
  };
}

export function calculateCapitalPreview({ equity, availableBalance, policy, marketType, caps = {} }) {
  const safeEquity = Math.max(0, finite(equity));
  const safeAvailable = Math.max(0, finite(availableBalance));
  const normalized = normalizeCapitalPolicy(policy, marketType, { allowZeroAllocation: true });
  const allocatedStrategyCapital = normalized.strategyAllocationMode === "FIXED_USDT"
    ? Math.min(safeEquity, normalized.strategyAllocationValue)
    : safeEquity * normalized.strategyAllocationValue / 100;
  let entryCapital = 0;
  if (normalized.tradeAmountMode === "PERCENT_ACCOUNT_EQUITY") entryCapital = safeEquity * normalized.tradeAmountValue / 100;
  else if (normalized.tradeAmountMode === "PERCENT_STRATEGY_ALLOCATION" || normalized.tradeAmountMode === "RISK_PERCENT" || normalized.tradeAmountMode === "VOLATILITY_TARGET") entryCapital = allocatedStrategyCapital * normalized.tradeAmountValue / 100;
  else if (normalized.tradeAmountMode === "FIXED_USDT") entryCapital = normalized.tradeAmountValue;
  else entryCapital = normalized.tradeAmountValue;
  const quoteAssetReserve = marketType === "SPOT" ? safeEquity * (normalized.quoteAssetReservePercent || 0) / 100 : 0;
  const spendableAvailable = marketType === "SPOT" ? Math.max(0, safeAvailable - quoteAssetReserve) : safeAvailable;
  entryCapital = Math.min(entryCapital, allocatedStrategyCapital, spendableAvailable);
  const effectiveLeverage = marketType === "SPOT" ? 1 : calculateEffectiveLeverage({ requested: normalized.requestedLeverage, targetMaximum: normalized.maximumLeverage, ...caps });
  const estimatedNotional = marketType === "SPOT" ? entryCapital : entryCapital * effectiveLeverage;
  return {
    equity: safeEquity,
    availableBalance: safeAvailable,
    allocatedStrategyCapital,
    entryCapital,
    requestedLeverage: marketType === "SPOT" ? undefined : normalized.requestedLeverage,
    effectiveLeverage,
    estimatedNotional,
    estimatedMargin: entryCapital,
    remainingReserve: Math.max(0, allocatedStrategyCapital - entryCapital),
    quoteAssetReserve,
    maximumBaseAssetExposure: marketType === "SPOT" ? allocatedStrategyCapital * (normalized.maximumBaseAssetExposurePercent || 0) / 100 : undefined
  };
}

export function calculateEffectiveLeverage(values = {}) {
  const caps = [values.requested, values.targetMaximum, values.accountRiskCap, values.groupMandateCap, values.emsRiskCap, values.providerCap]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => Math.max(1, finite(value)));
  return caps.length ? Math.min(...caps) : 1;
}

export function buildTargetSlots(bindings = []) {
  const bySlot = new Map(bindings.filter((binding) => binding && binding.status !== "DISCONNECTED").map((binding) => [Number(binding.slotIndex ?? binding.slot_index), binding]));
  return Array.from({ length: LIVE_TARGET_LIMIT }, (_, index) => ({ slotIndex: index + 1, state: bySlot.get(index + 1)?.status || "EMPTY", binding: bySlot.get(index + 1) }));
}

export function assertSlotIndex(value) {
  const slot = Number(value);
  if (!Number.isInteger(slot) || slot < 1 || slot > LIVE_TARGET_LIMIT) throw strategyError(400, "STRATEGY_TARGET_SLOT_INVALID", "Target slot must be between 1 and 9.");
  return slot;
}

export function normalizeTargetType(value) {
  return enumValue(value, TARGET_TYPES, undefined, "target type");
}

export function normalizeMarketType(value) {
  return enumValue(String(value || "").toUpperCase(), MARKET_TYPES, undefined, "market type");
}

export function normalizeClosedCandleTimeframe(value) {
  const raw = String(value || "").trim();
  const normalized = raw === "1M" ? "1M" : raw.toLowerCase();
  if (!CLOSED_CANDLE_TIMEFRAMES.includes(normalized)) {
    throw strategyError(400, "STRATEGY_TIMEFRAME_INVALID", "Strategy automation requires a supported closed-candle timeframe (1m through 1M; second, tick, and 8h charts are not executable)." );
  }
  return normalized;
}

export function liveAutomationEnabled(environment = process.env) {
  return environment.STRATEGY_AUTOMATION_LIVE_EXECUTION_ENABLED === "true"
    && environment.STRATEGY_AUTOMATION_LIVE_EXECUTION_CERTIFIED === "true"
    && environment.BLACK_CLOUD_GLOBAL_EXECUTION_KILL_SWITCH !== "true";
}

export function demoAutomationEnabled(environment = process.env) {
  return environment.STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED === "true"
    && environment.BYBIT_DEMO_ENABLED === "true"
    && environment.BLACK_CLOUD_GLOBAL_EXECUTION_KILL_SWITCH !== "true";
}

export function groupAutomationEnabled(environment = process.env) {
  return environment.INVESTMENT_GROUP_EXECUTION_ENABLED === "true"
    && environment.STRATEGY_AUTOMATION_GROUP_EXECUTION_ENABLED === "true"
    && environment.BLACK_CLOUD_GLOBAL_EXECUTION_KILL_SWITCH !== "true";
}

export function assertCanArmStrategyTarget({ policy, marketType, validation, executionEnvironment, environment = process.env }) {
  const reasons = [];
  const normalized = normalizeCapitalPolicy(policy, marketType, { allowZeroAllocation: true });
  if (normalized.strategyAllocationValue <= 0) reasons.push("A non-zero strategy allocation is required.");
  if (normalized.tradeAmountValue <= 0) reasons.push("A non-zero per-trade amount is required.");
  if (normalized.maximumPositionPercent <= 0) reasons.push("A non-zero maximum position size is required.");
  if (normalized.maximumExposurePercent <= 0) reasons.push("A non-zero maximum exposure is required.");
  if (normalized.maximumDailyLoss <= 0) reasons.push("A non-zero maximum daily loss is required.");
  if (normalized.maximumDrawdown <= 0) reasons.push("A non-zero maximum drawdown is required.");
  if (!validation?.eligible) reasons.push(...(validation?.reasons || ["Target validation is incomplete."]));
  if (executionEnvironment === "DEMO") {
    if (!demoAutomationEnabled(environment)) reasons.push("Bybit Demo strategy execution is disabled by VPS rollout policy.");
  } else if (executionEnvironment === "MAINNET_LIVE") {
    if (!liveAutomationEnabled(environment)) reasons.push("Bybit Mainnet strategy execution is disabled or not certified by VPS rollout policy.");
  } else if (executionEnvironment === "INVESTMENT_GROUP") {
    if (!groupAutomationEnabled(environment)) reasons.push("Investment Group strategy execution is disabled by VPS rollout policy.");
  } else {
    reasons.push("The target execution environment is unavailable or unsupported.");
  }
  if (reasons.length) throw strategyError(403, "STRATEGY_TARGET_NOT_ARMABLE", `This target cannot be armed: ${reasons.join(" ")}`, { reasons });
  return normalized;
}

export function assertCanArmLiveTarget({ policy, marketType, validation, environment = process.env }) {
  const reasons = [];
  const normalized = normalizeCapitalPolicy(policy, marketType, { allowZeroAllocation: true });
  if (normalized.strategyAllocationValue <= 0) reasons.push("A non-zero strategy allocation is required.");
  if (normalized.tradeAmountValue <= 0) reasons.push("A non-zero per-trade amount is required.");
  if (normalized.maximumPositionPercent <= 0) reasons.push("A non-zero maximum position size is required.");
  if (normalized.maximumExposurePercent <= 0) reasons.push("A non-zero maximum exposure is required.");
  if (normalized.maximumDailyLoss <= 0) reasons.push("A non-zero maximum daily loss is required.");
  if (normalized.maximumDrawdown <= 0) reasons.push("A non-zero maximum drawdown is required.");
  if (!validation?.eligible) reasons.push(...(validation?.reasons || ["Target validation is incomplete."]));
  if (!liveAutomationEnabled(environment)) reasons.push("Live strategy automation is disabled by VPS rollout policy.");
  if (reasons.length) throw strategyError(403, "STRATEGY_TARGET_NOT_ARMABLE", "This target cannot be armed.", { reasons });
  return normalized;
}

export function riskIncrease(previous, next, marketType) {
  const before = normalizeCapitalPolicy(previous, marketType, { allowZeroAllocation: true });
  const after = normalizeCapitalPolicy(next, marketType, { allowZeroAllocation: true });
  return after.strategyAllocationValue > before.strategyAllocationValue
    || after.tradeAmountValue > before.tradeAmountValue
    || (after.requestedLongLeverage || 1) > (before.requestedLongLeverage || 1)
    || (after.requestedShortLeverage || 1) > (before.requestedShortLeverage || 1)
    || (after.maximumLeverage || 1) > (before.maximumLeverage || 1)
    || after.maximumExposurePercent > before.maximumExposurePercent
    || after.maximumPositionPercent > before.maximumPositionPercent
    || after.maximumDailyLoss > before.maximumDailyLoss
    || after.maximumDrawdown > before.maximumDrawdown
    || after.maximumPositions > before.maximumPositions
    || (marketType === "SPOT" && (after.quoteAssetReservePercent || 0) < (before.quoteAssetReservePercent || 0))
    || (marketType === "SPOT" && (after.maximumBaseAssetExposurePercent || 0) > (before.maximumBaseAssetExposurePercent || 0));
}

export function canonicalRequestHash(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function enumValue(value, allowed, fallback, label) {
  const normalized = value === undefined || value === null || value === "" ? fallback : String(value).toUpperCase();
  if (!allowed.includes(normalized)) throw strategyError(400, "STRATEGY_POLICY_INVALID", `Unsupported ${label}.`);
  return normalized;
}

function bounded(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw strategyError(400, "STRATEGY_POLICY_INVALID", `${label} must be between ${minimum} and ${maximum}.`);
  return parsed;
}

function minimum(value, lowerBound, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < lowerBound) throw strategyError(400, "STRATEGY_POLICY_INVALID", `${label} must be ${lowerBound} or greater.`);
  return parsed;
}

function numberList(value, fallback, length, label) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length !== length) throw strategyError(400, "STRATEGY_POLICY_INVALID", `${label} must contain exactly ${length} values.`);
  return value;
}

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : {};
}
