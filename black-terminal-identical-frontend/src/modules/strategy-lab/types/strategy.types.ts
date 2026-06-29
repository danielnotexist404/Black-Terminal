import type { Timeframe } from "../../../market-data/types";

export type StrategyDirection = "long" | "short" | "flat";

export type StrategySignal = {
  timestamp: number;
  symbol: string;
  direction: StrategyDirection;
  entry?: boolean;
  exit?: boolean;
  stopLoss?: number;
  takeProfit?: number;
  confidence?: number;
  reason?: string;
  signalName?: string;
  metadata?: Record<string, unknown>;
};

export type StrategyRuntimeKind = "builtin-ema-cross" | "builtin-adaptive-swing" | "python-script" | "external-signals";

export type StrategySettings = {
  emaFastLength: number;
  emaSlowLength: number;
  stopLossPercent: number;
  takeProfitRatio: number;
  trailingStopPercent?: number;
  breakEvenAtR?: number;
  partialExitAtR?: number;
  partialExitPercent?: number;
  atrLength?: number;
  regimeEmaLength?: number;
  swingLookback?: number;
  rsiLength?: number;
  rsiOversold?: number;
  rsiOverbought?: number;
  atrStopMultiplier?: number;
  swingRetestAtr?: number;
  minTrendQuality?: number;
  maxChopRatio?: number;
  volumeLookback?: number;
  sessionStartHour?: number;
  sessionEndHour?: number;
  minVolumeMultiplier?: number;
};

export type StrategyScriptDefinition = {
  id: string;
  name: string;
  kind: StrategyRuntimeKind;
  timeframe: Timeframe;
  source?: string;
  settings: StrategySettings;
};

export const defaultStrategySettings: StrategySettings = {
  emaFastLength: 20,
  emaSlowLength: 50,
  stopLossPercent: 0.85,
  takeProfitRatio: 2.1,
  trailingStopPercent: 0,
  breakEvenAtR: 1,
  partialExitAtR: 1.5,
  partialExitPercent: 0,
  atrLength: 21,
  regimeEmaLength: 200,
  swingLookback: 36,
  rsiLength: 14,
  rsiOversold: 42,
  rsiOverbought: 58,
  atrStopMultiplier: 1.55,
  swingRetestAtr: 0.8,
  minTrendQuality: 0.16,
  maxChopRatio: 0.24,
  volumeLookback: 50,
  minVolumeMultiplier: 0.5
};
