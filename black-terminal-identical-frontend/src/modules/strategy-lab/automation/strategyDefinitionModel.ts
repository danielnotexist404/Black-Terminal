import type { MarketSymbol, Timeframe } from "../../../market-data/types";
import type { BacktestConfig } from "../types/backtest.types";
import {
  defaultStrategySettings,
  type StrategyRuntimeKind,
  type StrategySettings,
} from "../types/strategy.types.ts";
import type { StrategyAutomationDefinition } from "./strategyAutomation.types";

export const certifiedStrategyEngines: ReadonlyArray<{
  value: Extract<StrategyRuntimeKind, "builtin-adaptive-swing" | "builtin-ema-cross">;
  label: string;
  description: string;
}> = [
  {
    value: "builtin-adaptive-swing",
    label: "Hidden Distribution Swing",
    description: "Black Core adaptive regime, swing-retest, RSI, ATR and volume engine.",
  },
  {
    value: "builtin-ema-cross",
    label: "EMA Cross Baseline",
    description: "Closed-candle fast/slow EMA crossover with volume and session controls.",
  },
];

export const automationTimeframes: readonly Timeframe[] = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "3h",
  "4h",
  "6h",
  "12h",
  "1d",
  "1w",
  "1M",
];

const certifiedRuntimeKinds = new Set<StrategyRuntimeKind>(
  certifiedStrategyEngines.map((item) => item.value),
);
const supportedTimeframes = new Set<string>(automationTimeframes);

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

export function validateAutomationDefinition(
  definition: StrategyAutomationDefinition,
) {
  if (definition.exchange.toLowerCase() !== "bybit") {
    return "Black Cloud automation is currently certified for Bybit only.";
  }
  if (!certifiedRuntimeKinds.has(definition.runtimeKind)) {
    return "The selected indicator does not yet have a certified Black Cloud signal adapter.";
  }
  if (!supportedTimeframes.has(definition.timeframe)) {
    return "Select a closed-candle timeframe supported by the Black Cloud worker.";
  }
  if (!/^[A-Z0-9:_/.-]{2,40}$/.test(definition.symbol.toUpperCase())) {
    return "Select a valid Bybit market symbol.";
  }
  if (
    definition.runtimeKind === "builtin-ema-cross" &&
    definition.settings.emaFastLength >= definition.settings.emaSlowLength
  ) {
    return "EMA Fast must be shorter than EMA Slow.";
  }
  if (
    (definition.settings.rsiOversold ?? 42) >=
    (definition.settings.rsiOverbought ?? 58)
  ) {
    return "RSI Oversold must be below RSI Overbought.";
  }
  return null;
}

export function applyAutomationDefinitionToConfig(
  current: BacktestConfig,
  definition: StrategyAutomationDefinition,
): BacktestConfig {
  const execution = definition.execution || {};
  const marketKind = definition.marketType === "SPOT" ? "spot" : "perpetual";
  const symbol = definition.symbol.toUpperCase();

  return {
    ...current,
    symbol,
    rawSymbol: symbol,
    exchange: definition.exchange.toLowerCase() === "bybit" ? "bybit" : current.exchange,
    exchangeLabel:
      definition.exchange.toLowerCase() === "bybit"
        ? "Bybit"
        : current.exchangeLabel,
    marketKind,
    timeframe: supportedTimeframes.has(definition.timeframe)
      ? (definition.timeframe as Timeframe)
      : current.timeframe,
    strategyKind: definition.runtimeKind,
    strategySettings: {
      ...defaultStrategySettings,
      ...definition.settings,
    },
    feeRate: finiteNumber(execution.feeRate, current.feeRate),
    slippageTicks: finiteNumber(
      execution.slippageTicks,
      current.slippageTicks,
    ),
    tickSize: finiteNumber(execution.tickSize, current.tickSize),
    spreadBps: finiteNumber(execution.spreadBps, current.spreadBps),
    useBidAskExecution: booleanValue(
      execution.useBidAskExecution,
      current.useBidAskExecution,
    ),
    maxTradesPerDay: finiteNumber(
      execution.maxTradesPerDay,
      current.maxTradesPerDay ?? 8,
    ),
    maxDailyLoss: finiteNumber(
      execution.maxDailyLoss,
      current.maxDailyLoss ?? 250,
    ),
    maxDrawdown: finiteNumber(
      execution.maxDrawdown,
      current.maxDrawdown ?? 0.2,
    ),
    maxOpenPositions: finiteNumber(
      execution.maxOpenPositions,
      current.maxOpenPositions ?? 1,
    ),
    maxLeverage: finiteNumber(
      execution.maxLeverage,
      current.maxLeverage ?? 3,
    ),
    cooldownAfterLosses: finiteNumber(
      execution.cooldownAfterLosses,
      current.cooldownAfterLosses ?? 3,
    ),
    disableOnHighSpreadBps: finiteNumber(
      execution.disableOnHighSpreadBps,
      current.disableOnHighSpreadBps ?? 8,
    ),
    disableOnLowLiquidity: booleanValue(
      execution.disableOnLowLiquidity,
      current.disableOnLowLiquidity ?? true,
    ),
    disableOnAbnormalVolatility: booleanValue(
      execution.disableOnAbnormalVolatility,
      current.disableOnAbnormalVolatility ?? true,
    ),
    fundingRatePerDay: finiteNumber(
      execution.fundingRatePerDay,
      current.fundingRatePerDay ?? 0,
    ),
  };
}

export function marketSymbolFromBacktestConfig(
  config: BacktestConfig,
): MarketSymbol {
  const rawSymbol = config.rawSymbol || config.symbol;
  const normalized = rawSymbol.toUpperCase();
  const quoteAsset = normalized.endsWith("USDT") ? "USDT" : "";
  const baseAsset = quoteAsset
    ? normalized.slice(0, -quoteAsset.length)
    : normalized;
  return {
    exchange: config.exchange,
    rawSymbol,
    baseAsset,
    quoteAsset,
    marketKind: config.marketKind,
  };
}

export function definitionFingerprint(
  definition: StrategyAutomationDefinition,
) {
  const settings = Object.entries(definition.settings)
    .sort(([left], [right]) => left.localeCompare(right))
    .reduce<Record<string, StrategySettings[keyof StrategySettings]>>(
      (output, [key, value]) => {
        output[key] = value;
        return output;
      },
      {},
    );
  const execution = Object.entries(definition.execution || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .reduce<Record<string, unknown>>((output, [key, value]) => {
      output[key] = value;
      return output;
    }, {});
  return JSON.stringify({
    runtimeKind: definition.runtimeKind,
    symbol: definition.symbol.toUpperCase(),
    timeframe: definition.timeframe,
    marketType: definition.marketType,
    exchange: definition.exchange.toLowerCase(),
    settings,
    execution,
  });
}
