import type {
  StrategyAutomationDefinition,
  StrategyCapitalPolicy,
  StrategyControlPanel,
  StrategyPropertyConfiguration,
  SuperAtrInputConfiguration,
} from "../automation/strategyAutomation.types";

const finite = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const bounded = (value: unknown, fallback: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, finite(value, fallback)));
const atLeast = (value: unknown, fallback: number, minimum: number) => Math.max(minimum, finite(value, fallback));
const bool = (value: unknown, fallback: boolean) => typeof value === "boolean" ? value : fallback;
const color = (value: unknown, fallback: string) => /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : fallback;

export const defaultSuperAtrInputs: SuperAtrInputConfiguration = {
  shortPeriod: 30,
  longPeriod: 70,
  momentumPeriod: 7,
  atrConfirmationPeriod: 7,
  trendStrengthThreshold: 3.1,
  multiStepTakeProfit: true,
  takeProfitAtrLength: 100,
  atrMultipliers: [100, 70, 120, 300],
  fixedTakeProfitPercentages: [21, 21, 75],
  atrExitPercent: 10,
  fixedExitPercent: 10,
};

export const defaultStrategyProperties: StrategyPropertyConfiguration = {
  initialCapital: 10_000,
  currency: "USD",
  orderSizeValue: 10,
  orderSizeMode: "PERCENT_EQUITY",
  pyramiding: 1,
  barDetailization: "DEFAULT_4_TICKS",
  executionCadence: "BAR_CLOSE_AND_REALTIME",
  commissionValue: 0.1,
  commissionMode: "PERCENT",
  longLeverage: 1,
  shortLeverage: 1,
  slippageTicks: 1,
  limitExecution: "REQUESTED_PRICE",
  executionDelay: "ONE_TICK",
};

export function readStrategyControlPanel(definition: StrategyAutomationDefinition, policy?: StrategyCapitalPolicy | null, initialCapital?: number, preferPolicy = false): StrategyControlPanel {
  const stored = definition.controlPanel;
  const settings = definition.settings as Record<string, unknown>;
  const execution = definition.execution || {};
  // V1 was seeded from the raw Pine declarations even when the user saved the
  // tuned SuperATR preset shown in the original strategy menu. Upgrade only
  // that exact legacy seed; every non-default/user-edited value is preserved.
  const legacySeed = stored?.schemaVersion !== 2 && isLegacySuperAtrSeed(stored?.inputs, settings);
  const input = legacySeed ? undefined : stored?.inputs;
  const properties = stored?.properties;
  const leverage = policy?.requestedLeverage || 1;
  const orderSizeMode = policy?.tradeAmountMode === "FIXED_USDT" ? "FIXED_USDT" : policy?.tradeAmountMode === "FIXED_QUANTITY" ? "FIXED_QUANTITY" : "PERCENT_EQUITY";
  const at = (values: unknown, index: number, fallback: number) => Array.isArray(values) ? finite(values[index], fallback) : fallback;
  const setting = (...keys: string[]) => legacySeed ? undefined : keys.map((key) => settings[key]).find((value) => value !== undefined);
  const arraySetting = (key: string) => legacySeed ? undefined : settings[key];
  return {
    schemaVersion: 2,
    inputs: {
      shortPeriod: Math.round(atLeast(input?.shortPeriod ?? setting("superAtrShortPeriod", "short_period", "Short Period"), defaultSuperAtrInputs.shortPeriod, 1)),
      longPeriod: Math.round(atLeast(input?.longPeriod ?? setting("superAtrLongPeriod", "long_period", "Long Period"), defaultSuperAtrInputs.longPeriod, 1)),
      momentumPeriod: Math.round(atLeast(input?.momentumPeriod ?? setting("superAtrMomentumPeriod", "momentum_period", "Momentum Period"), defaultSuperAtrInputs.momentumPeriod, 1)),
      atrConfirmationPeriod: Math.round(atLeast(input?.atrConfirmationPeriod ?? setting("superAtrConfirmationPeriod", "atr_sma_period", "ATR SMA Period for Confirmation"), defaultSuperAtrInputs.atrConfirmationPeriod, 1)),
      trendStrengthThreshold: atLeast(input?.trendStrengthThreshold ?? setting("superAtrTrendStrengthThreshold", "trend_strength_threshold", "Trend Strength Threshold"), defaultSuperAtrInputs.trendStrengthThreshold, 0),
      multiStepTakeProfit: bool(input?.multiStepTakeProfit ?? setting("superAtrMultiStepTakeProfit", "useMultiStepTP", "Enable Multi-Step Take Profit"), defaultSuperAtrInputs.multiStepTakeProfit),
      takeProfitAtrLength: Math.round(atLeast(input?.takeProfitAtrLength ?? setting("superAtrTakeProfitAtrLength", "atrLengthTP", "ATR Length for Take Profit"), defaultSuperAtrInputs.takeProfitAtrLength, 1)),
      atrMultipliers: [0, 1, 2, 3].map((index) => atLeast(input?.atrMultipliers?.[index] ?? at(arraySetting("superAtrAtrMultipliers"), index, finite(setting(`ATR Multiplier for TP Level ${index + 1}`), defaultSuperAtrInputs.atrMultipliers[index])), defaultSuperAtrInputs.atrMultipliers[index], 0.1)) as [number, number, number, number],
      fixedTakeProfitPercentages: [0, 1, 2].map((index) => atLeast(input?.fixedTakeProfitPercentages?.[index] ?? at(arraySetting("superAtrFixedPercentages"), index, finite(setting(`Fixed TP Level ${index + 1} (%)`), defaultSuperAtrInputs.fixedTakeProfitPercentages[index])), defaultSuperAtrInputs.fixedTakeProfitPercentages[index], 0.1)) as [number, number, number],
      atrExitPercent: bounded(input?.atrExitPercent ?? setting("superAtrAtrExitPercent", "tp_percent_atr", "Percentage to Exit at Each ATR TP Level"), defaultSuperAtrInputs.atrExitPercent, 0.1, 100),
      fixedExitPercent: bounded(input?.fixedExitPercent ?? setting("superAtrFixedExitPercent", "tp_percent_fixed", "Percentage to Exit at Each Fixed TP Level"), defaultSuperAtrInputs.fixedExitPercent, 0.1, 100),
    },
    properties: {
      initialCapital: bounded(initialCapital ?? properties?.initialCapital, defaultStrategyProperties.initialCapital, 1, 1_000_000_000),
      currency: properties?.currency === "USDT" ? "USDT" : "USD",
      orderSizeValue: bounded(preferPolicy ? policy?.tradeAmountValue ?? properties?.orderSizeValue : properties?.orderSizeValue ?? policy?.tradeAmountValue, defaultStrategyProperties.orderSizeValue, 0.00000001, 1_000_000_000),
      orderSizeMode: preferPolicy ? orderSizeMode : properties?.orderSizeMode || orderSizeMode,
      pyramiding: Math.round(bounded(properties?.pyramiding ?? execution.pyramiding, 1, 1, 100)),
      barDetailization: properties?.barDetailization || "DEFAULT_4_TICKS",
      executionCadence: properties?.executionCadence || "BAR_CLOSE_AND_REALTIME",
      commissionValue: bounded(properties?.commissionValue ?? finite(execution.feeRate, 0.001) * 100, defaultStrategyProperties.commissionValue, 0, 100),
      commissionMode: properties?.commissionMode || "PERCENT",
      longLeverage: bounded(preferPolicy ? policy?.requestedLongLeverage ?? policy?.requestedLeverage ?? properties?.longLeverage ?? execution.longLeverage : properties?.longLeverage ?? execution.longLeverage ?? policy?.requestedLongLeverage ?? leverage, 1, 1, 1_000),
      shortLeverage: bounded(preferPolicy ? policy?.requestedShortLeverage ?? policy?.requestedLeverage ?? properties?.shortLeverage ?? execution.shortLeverage : properties?.shortLeverage ?? execution.shortLeverage ?? policy?.requestedShortLeverage ?? leverage, 1, 1, 1_000),
      slippageTicks: Math.round(bounded(properties?.slippageTicks ?? execution.slippageTicks, 1, 0, 100_000)),
      limitExecution: properties?.limitExecution || "REQUESTED_PRICE",
      executionDelay: properties?.executionDelay || "ONE_TICK",
    },
    style: {
      shortMaVisible: bool(stored?.style?.shortMaVisible, true),
      shortMaColor: color(stored?.style?.shortMaColor, "#f4f4f5"),
      shortMaWidth: bounded(stored?.style?.shortMaWidth, 1, 1, 5),
      longMaVisible: bool(stored?.style?.longMaVisible, true),
      longMaColor: color(stored?.style?.longMaColor, "#ff174a"),
      longMaWidth: bounded(stored?.style?.longMaWidth, 1, 1, 5),
      tradesOnChart: bool(stored?.style?.tradesOnChart, true),
      signalLabels: bool(stored?.style?.signalLabels, true),
      quantity: bool(stored?.style?.quantity, true),
      precision: stored?.style?.precision || "DEFAULT",
      labelsOnPriceScale: bool(stored?.style?.labelsOnPriceScale, true),
      valuesInStatusLine: bool(stored?.style?.valuesInStatusLine, true),
      inputsInStatusLine: bool(stored?.style?.inputsInStatusLine, true),
    },
    visibility: {
      allTimeframes: bool(stored?.visibility?.allTimeframes, true),
      seconds: bool(stored?.visibility?.seconds, true),
      minutes: bool(stored?.visibility?.minutes, true),
      hours: bool(stored?.visibility?.hours, true),
      days: bool(stored?.visibility?.days, true),
      weeks: bool(stored?.visibility?.weeks, true),
      months: bool(stored?.visibility?.months, true),
    },
  };
}

const legacySuperAtrSeed: SuperAtrInputConfiguration = {
  shortPeriod: 3,
  longPeriod: 7,
  momentumPeriod: 7,
  atrConfirmationPeriod: 7,
  trendStrengthThreshold: 1.618,
  multiStepTakeProfit: true,
  takeProfitAtrLength: 14,
  atrMultipliers: [2.618, 5, 10, 13.82],
  fixedTakeProfitPercentages: [3, 8, 17],
  atrExitPercent: 10,
  fixedExitPercent: 10,
};

function isLegacySuperAtrSeed(input: SuperAtrInputConfiguration | undefined, settings: Record<string, unknown>) {
  const value = input || {
    shortPeriod: finite(settings.superAtrShortPeriod ?? settings["Short Period"], Number.NaN),
    longPeriod: finite(settings.superAtrLongPeriod ?? settings["Long Period"], Number.NaN),
    momentumPeriod: finite(settings.superAtrMomentumPeriod ?? settings["Momentum Period"], Number.NaN),
    atrConfirmationPeriod: finite(settings.superAtrConfirmationPeriod ?? settings["ATR SMA Period for Confirmation"], Number.NaN),
    trendStrengthThreshold: finite(settings.superAtrTrendStrengthThreshold ?? settings["Trend Strength Threshold"], Number.NaN),
    multiStepTakeProfit: settings.superAtrMultiStepTakeProfit ?? settings["Enable Multi-Step Take Profit"],
    takeProfitAtrLength: finite(settings.superAtrTakeProfitAtrLength ?? settings["ATR Length for Take Profit"], Number.NaN),
    atrMultipliers: Array.isArray(settings.superAtrAtrMultipliers) ? settings.superAtrAtrMultipliers : [1, 2, 3, 4].map((index) => settings[`ATR Multiplier for TP Level ${index}`]),
    fixedTakeProfitPercentages: Array.isArray(settings.superAtrFixedPercentages) ? settings.superAtrFixedPercentages : [1, 2, 3].map((index) => settings[`Fixed TP Level ${index} (%)`]),
    atrExitPercent: finite(settings.superAtrAtrExitPercent ?? settings["Percentage to Exit at Each ATR TP Level"], Number.NaN),
    fixedExitPercent: finite(settings.superAtrFixedExitPercent ?? settings["Percentage to Exit at Each Fixed TP Level"], Number.NaN),
  } as SuperAtrInputConfiguration;
  return value.shortPeriod === legacySuperAtrSeed.shortPeriod
    && value.longPeriod === legacySuperAtrSeed.longPeriod
    && value.momentumPeriod === legacySuperAtrSeed.momentumPeriod
    && value.atrConfirmationPeriod === legacySuperAtrSeed.atrConfirmationPeriod
    && value.trendStrengthThreshold === legacySuperAtrSeed.trendStrengthThreshold
    && value.multiStepTakeProfit === legacySuperAtrSeed.multiStepTakeProfit
    && value.takeProfitAtrLength === legacySuperAtrSeed.takeProfitAtrLength
    && Array.isArray(value.atrMultipliers)
    && value.atrMultipliers.length === legacySuperAtrSeed.atrMultipliers.length
    && value.atrMultipliers.every((item, index) => item === legacySuperAtrSeed.atrMultipliers[index])
    && Array.isArray(value.fixedTakeProfitPercentages)
    && value.fixedTakeProfitPercentages.length === legacySuperAtrSeed.fixedTakeProfitPercentages.length
    && value.fixedTakeProfitPercentages.every((item, index) => item === legacySuperAtrSeed.fixedTakeProfitPercentages[index])
    && value.atrExitPercent === legacySuperAtrSeed.atrExitPercent
    && value.fixedExitPercent === legacySuperAtrSeed.fixedExitPercent;
}

export function applyStrategyControlPanel(definition: StrategyAutomationDefinition, policy: StrategyCapitalPolicy, panel: StrategyControlPanel) {
  const inputs = panel.inputs;
  const shared = applySharedStrategyControlPanel(definition, policy, panel);
  const nextDefinition: StrategyAutomationDefinition = {
    ...shared.definition,
    runtimeKind: "builtin-superatr-seven-step",
    indicator: definition.indicator ? { ...definition.indicator, runtimeStatus: "CERTIFIED", runtimeVersion: "black-cloud-superatr-v1", warmupBars: Math.max(definition.indicator.warmupBars || 0, inputs.longPeriod * 3, inputs.takeProfitAtrLength * 3) } : definition.indicator,
    controlPanel: structuredClone(panel),
    settings: {
      ...definition.settings,
      superAtrShortPeriod: inputs.shortPeriod,
      superAtrLongPeriod: inputs.longPeriod,
      superAtrMomentumPeriod: inputs.momentumPeriod,
      superAtrConfirmationPeriod: inputs.atrConfirmationPeriod,
      superAtrTrendStrengthThreshold: inputs.trendStrengthThreshold,
      superAtrMultiStepTakeProfit: inputs.multiStepTakeProfit,
      superAtrTakeProfitAtrLength: inputs.takeProfitAtrLength,
      superAtrAtrMultipliers: [...inputs.atrMultipliers],
      superAtrFixedPercentages: [...inputs.fixedTakeProfitPercentages],
      superAtrAtrExitPercent: inputs.atrExitPercent,
      superAtrFixedExitPercent: inputs.fixedExitPercent,
      // Keep the script-native names synchronized with the certified adapter
      // names. Two conflicting parameter sets were previously persisted and
      // made the Script Editor menu disagree with the VPS runtime.
      "Short Period": inputs.shortPeriod,
      "Long Period": inputs.longPeriod,
      "Momentum Period": inputs.momentumPeriod,
      "ATR SMA Period for Confirmation": inputs.atrConfirmationPeriod,
      "Trend Strength Threshold": inputs.trendStrengthThreshold,
      "Enable Multi-Step Take Profit": inputs.multiStepTakeProfit,
      "ATR Length for Take Profit": inputs.takeProfitAtrLength,
      "ATR Multiplier for TP Level 1": inputs.atrMultipliers[0],
      "ATR Multiplier for TP Level 2": inputs.atrMultipliers[1],
      "ATR Multiplier for TP Level 3": inputs.atrMultipliers[2],
      "ATR Multiplier for TP Level 4": inputs.atrMultipliers[3],
      "Fixed TP Level 1 (%)": inputs.fixedTakeProfitPercentages[0],
      "Fixed TP Level 2 (%)": inputs.fixedTakeProfitPercentages[1],
      "Fixed TP Level 3 (%)": inputs.fixedTakeProfitPercentages[2],
      "Percentage to Exit at Each ATR TP Level": inputs.atrExitPercent,
      "Percentage to Exit at Each Fixed TP Level": inputs.fixedExitPercent,
    },
  };
  return { definition: nextDefinition, capitalPolicy: shared.capitalPolicy };
}

/** Applies the common Properties, Style and Visibility contract without
 * changing which runtime owns the strategy's native signal calculations. */
export function applySharedStrategyControlPanel(
  definition: StrategyAutomationDefinition,
  policy: StrategyCapitalPolicy,
  panel: StrategyControlPanel,
  nativeSettings?: Record<string, unknown>,
) {
  const properties = panel.properties;
  const nextDefinition: StrategyAutomationDefinition = {
    ...definition,
    controlPanel: structuredClone(panel),
    settings: { ...definition.settings, ...(nativeSettings || {}) },
    execution: {
      ...definition.execution,
      pyramiding: properties.pyramiding,
      processOrdersOnClose: properties.executionDelay === "NONE",
      realtimeEvaluation: properties.executionCadence === "BAR_CLOSE_AND_REALTIME",
      barDetailization: properties.barDetailization,
      feeRate: properties.commissionMode === "PERCENT" ? properties.commissionValue / 100 : 0,
      commissionMode: properties.commissionMode,
      commissionValue: properties.commissionValue,
      longLeverage: properties.longLeverage,
      shortLeverage: properties.shortLeverage,
      slippageTicks: properties.slippageTicks,
      limitExecution: properties.limitExecution,
      executionDelay: properties.executionDelay,
    },
  };
  const nextPolicy: StrategyCapitalPolicy = {
    ...policy,
    tradeAmountMode: properties.orderSizeMode === "FIXED_USDT" ? "FIXED_USDT" : properties.orderSizeMode === "FIXED_QUANTITY" ? "FIXED_QUANTITY" : "PERCENT_ACCOUNT_EQUITY",
    tradeAmountValue: properties.orderSizeValue,
    requestedLeverage: Math.max(properties.longLeverage, properties.shortLeverage),
    requestedLongLeverage: properties.longLeverage,
    requestedShortLeverage: properties.shortLeverage,
    maximumLeverage: Math.max(policy.maximumLeverage || 1, properties.longLeverage, properties.shortLeverage),
    maximumPositions: properties.pyramiding,
  };
  return { definition: nextDefinition, capitalPolicy: nextPolicy };
}

export function superAtrTakeProfitAllocation(panel: StrategyControlPanel) {
  return panel.inputs.multiStepTakeProfit
    ? [panel.inputs.atrExitPercent, panel.inputs.atrExitPercent, panel.inputs.atrExitPercent, panel.inputs.atrExitPercent, panel.inputs.fixedExitPercent, panel.inputs.fixedExitPercent, panel.inputs.fixedExitPercent]
    : [];
}
