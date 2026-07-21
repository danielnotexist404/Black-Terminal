import { Candle } from "../chart-engine/types";

export type IndicatorRuntime = "python";

export type IndicatorInput = {
  symbol: string;
  timeframe: string;
  candles: Candle[];
  params: Record<string, unknown>;
};

export type IndicatorPlotKind = "line" | "histogram" | "band" | "marker" | "heatmap";

export type IndicatorPlotPoint = {
  time: number;
  value: number | null;
};

export type IndicatorPlot = {
  id: string;
  name: string;
  kind: IndicatorPlotKind;
  color?: string;
  points: IndicatorPlotPoint[];
};

export type IndicatorSignal = {
  time: number;
  name: string;
  direction: "bullish" | "bearish" | "neutral";
  price?: number;
  message?: string;
};

export type IndicatorZone = {
  id: string;
  startTime: number;
  endTime: number;
  priceLow: number;
  priceHigh: number;
  strength: number;
  side: "support" | "resistance" | "neutral";
  color?: string;
};

export type IndicatorResult = {
  plots: IndicatorPlot[];
  zones?: IndicatorZone[];
  signals?: IndicatorSignal[];
  series?: Record<string, unknown>[];
  panel?: Record<string, unknown> | null;
  alerts?: IndicatorRuntimeAlert[];
  alert_conditions?: IndicatorAlertCondition[];
  scanner?: IndicatorScannerResult;
  diagnostics?: string[];
  metadata?: Record<string, unknown>;
};

export type IndicatorDefinition = {
  id: string;
  name: string;
  runtime: IndicatorRuntime;
  version: string;
  author?: string;
  description?: string;
  defaultParams: Record<string, unknown>;
};

export type IndicatorAlertCondition = {
  id: string;
  name: string;
  enabledByDefault?: boolean;
  message: string;
};

export type IndicatorRuntimeAlert = {
  id: string;
  symbol: string;
  timeframe: string;
  side?: string;
  price?: number | null;
  cluster_volume?: number | null;
  delta?: number;
  delta_ratio?: number;
  strength_score?: number;
  timestamp: number;
};

export type IndicatorScannerResult = {
  preset: string;
  fields: string[];
  records: Record<string, unknown>[];
};
