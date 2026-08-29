import type {
  StrategyAutomationDefinition,
  StrategyCapitalPolicy,
  StrategyControlPanel,
  StrategyPropertyConfiguration,
  SuperAtrInputConfiguration,
} from "../automation/strategyAutomation.types";

const finite = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const bounded = (value: unknown, fallback: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, finite(value, fallback)));
const bool = (value: unknown, fallback: boolean) => typeof value === "boolean" ? value : fallback;
const color = (value: unknown, fallback: string) => /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : fallback;

export const defaultSuperAtrInputs: SuperAtrInputConfiguration = {
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

export function readStrategyControlPanel(definition: StrategyAutomationDefinition, policy?: StrategyCapitalPolicy | null, initialCapital?: number): StrategyControlPanel {
  const stored = definition.controlPanel;
  const settings = definition.settings as Record<string, unknown>;
  const execution = definition.execution || {};
  const input = stored?.inputs;
  const properties = stored?.properties;
  const leverage = policy?.requestedLeverage || 1;
  const orderSizeMode = policy?.tradeAmountMode === "FIXED_USDT" ? "FIXED_USDT" : policy?.tradeAmountMode === "FIXED_QUANTITY" ? "FIXED_QUANTITY" : "PERCENT_EQUITY";
  const at = (values: unknown, index: number, fallback: number) => Array.isArray(values) ? finite(values[index], fallback) : fallback;
  return {
    schemaVersion: 1,
    inputs: {
      shortPeriod: Math.round(bounded(input?.shortPeriod ?? settings.superAtrShortPeriod ?? settings.short_period, defaultSuperAtrInputs.shortPeriod, 1, 10_000)),
      longPeriod: Math.round(bounded(input?.longPeriod ?? settings.superAtrLongPeriod ?? settings.long_period, defaultSuperAtrInputs.longPeriod, 1, 10_000)),
      momentumPeriod: Math.round(bounded(input?.momentumPeriod ?? settings.superAtrMomentumPeriod ?? settings.momentum_period, defaultSuperAtrInputs.momentumPeriod, 1, 10_000)),
      atrConfirmationPeriod: Math.round(bounded(input?.atrConfirmationPeriod ?? settings.superAtrConfirmationPeriod ?? settings.atr_sma_period, defaultSuperAtrInputs.atrConfirmationPeriod, 1, 10_000)),
      trendStrengthThreshold: bounded(input?.trendStrengthThreshold ?? settings.superAtrTrendStrengthThreshold ?? settings.trend_strength_threshold, defaultSuperAtrInputs.trendStrengthThreshold, 0, 1_000),
      multiStepTakeProfit: bool(input?.multiStepTakeProfit ?? settings.superAtrMultiStepTakeProfit ?? settings.useMultiStepTP, defaultSuperAtrInputs.multiStepTakeProfit),
      takeProfitAtrLength: Math.round(bounded(input?.takeProfitAtrLength ?? settings.superAtrTakeProfitAtrLength ?? settings.atrLengthTP, defaultSuperAtrInputs.takeProfitAtrLength, 1, 10_000)),
      atrMultipliers: [0, 1, 2, 3].map((index) => bounded(input?.atrMultipliers?.[index] ?? at(settings.superAtrAtrMultipliers, index, defaultSuperAtrInputs.atrMultipliers[index]), defaultSuperAtrInputs.atrMultipliers[index], 0.001, 100_000)) as [number, number, number, number],
      fixedTakeProfitPercentages: [0, 1, 2].map((index) => bounded(input?.fixedTakeProfitPercentages?.[index] ?? at(settings.superAtrFixedPercentages, index, defaultSuperAtrInputs.fixedTakeProfitPercentages[index]), defaultSuperAtrInputs.fixedTakeProfitPercentages[index], 0.001, 100_000)) as [number, number, number],
      atrExitPercent: bounded(input?.atrExitPercent ?? settings.superAtrAtrExitPercent ?? settings.tp_percent_atr, defaultSuperAtrInputs.atrExitPercent, 0.1, 100),
      fixedExitPercent: bounded(input?.fixedExitPercent ?? settings.superAtrFixedExitPercent ?? settings.tp_percent_fixed, defaultSuperAtrInputs.fixedExitPercent, 0.1, 100),
    },
    properties: {
      initialCapital: bounded(properties?.initialCapital ?? initialCapital, defaultStrategyProperties.initialCapital, 1, 1_000_000_000),
      currency: properties?.currency === "USDT" ? "USDT" : "USD",
      orderSizeValue: bounded(properties?.orderSizeValue ?? policy?.tradeAmountValue, defaultStrategyProperties.orderSizeValue, 0.00000001, 1_000_000_000),
      orderSizeMode: properties?.orderSizeMode || orderSizeMode,
      pyramiding: Math.round(bounded(properties?.pyramiding ?? execution.pyramiding, 1, 1, 100)),
      barDetailization: properties?.barDetailization || "DEFAULT_4_TICKS",
      executionCadence: properties?.executionCadence || "BAR_CLOSE_AND_REALTIME",
      commissionValue: bounded(properties?.commissionValue ?? finite(execution.feeRate, 0.001) * 100, defaultStrategyProperties.commissionValue, 0, 100),
      commissionMode: properties?.commissionMode || "PERCENT",
      longLeverage: bounded(properties?.longLeverage ?? execution.longLeverage ?? policy?.requestedLongLeverage ?? leverage, 1, 1, 1_000),
      shortLeverage: bounded(properties?.shortLeverage ?? execution.shortLeverage ?? policy?.requestedShortLeverage ?? leverage, 1, 1, 1_000),
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

export function applyStrategyControlPanel(definition: StrategyAutomationDefinition, policy: StrategyCapitalPolicy, panel: StrategyControlPanel) {
  const inputs = panel.inputs;
  const properties = panel.properties;
  const nextDefinition: StrategyAutomationDefinition = {
    ...definition,
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
    },
    execution: {
      ...definition.execution,
      pyramiding: properties.pyramiding,
      processOrdersOnClose: true,
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
