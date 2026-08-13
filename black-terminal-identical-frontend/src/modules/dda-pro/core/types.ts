import type { Candle } from "../../../chart-engine/types.ts";

export const DDA_PRO_SCHEMA_VERSION = 1 as const;
export const DDA_PRO_SETTINGS_VERSION = 1 as const;
export const DDA_PRO_INDICATOR_ID = "black-core-dda-pro" as const;

export type DDAProEngineMode = "pine-compatibility" | "black-core-native";
export type DDAProPriceSource = "close" | "hlc3" | "ohlc4";
export type DDAProQuantileMethod = "type7" | "nearest-rank";
export type DDAProZScoreMethod = "classical" | "robust";
export type DDAProSmoothingMethod = "none" | "ema" | "sma" | "rma";
export type DDAProTheme =
  | "black-terminal" | "black-terminal-blood" | "institutional-monochrome" | "custom"
  | "gold" | "edge-tools" | "behavioral" | "quant" | "ocean" | "fire" | "matrix" | "arctic";
export type DDAProPreset = "Custom" | "DDA Pro — Original" | "BC-DDA — Institutional" | "BC-DDA — Macro Risk";
export type DDAProRiskState = "LOW" | "MODERATE" | "HIGH" | "EXTREME" | "INSUFFICIENT";

export type DDAProSettings = {
  settingsVersion: typeof DDA_PRO_SETTINGS_VERSION;
  engineMode: DDAProEngineMode;
  preset: DDAProPreset;
  source: DDAProPriceSource;
  peakMode: "all-history" | "rolling";
  equitySource: "price" | "connected-account" | "strategy-equity";
  realtimeMode: "confirmed-bars" | "developing-preview";
  lookback: number;
  smoothingMethod: DDAProSmoothingMethod;
  smoothingLength: number;
  quantileMethod: DDAProQuantileMethod;
  zScoreMethod: DDAProZScoreMethod;
  sigmaMultiplier: number;
  downsideOnlySigma: boolean;
  annualizationMode: "auto" | "crypto-365" | "traditional-252" | "custom";
  customPeriodsPerYear: number;
  riskFreeRatePercent: number;
  vaddVolatilityFloorPercent: number;
  drawdownEpisodeThresholdPercent: number;
  hysteresisPercent: number;
  moderateThreshold: number;
  highThreshold: number;
  extremeThreshold: number;
  depthWeight: number;
  durationWeight: number;
  velocityWeight: number;
  volatilityWeight: number;
  tailWeight: number;
  showRawDrawdown: boolean;
  showSmoothedDrawdown: boolean;
  showMean: boolean;
  showSigmaBands: boolean;
  showQuantiles: boolean;
  showZScore: boolean;
  showDuration: boolean;
  showVelocity: boolean;
  showRiskScore: boolean;
  showDashboard: boolean;
  showExpandedDashboard: boolean;
  showEpisodeMarkers: boolean;
  theme: DDAProTheme;
  scaleMode: "auto" | "fixed-10" | "fixed-20" | "fixed-50" | "dynamic-tail" | "custom";
  customScaleDepthPercent: number;
  dashboardPosition: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  rawColor: string;
  smoothedColor: string;
  meanColor: string;
  moderateColor: string;
  highColor: string;
  extremeColor: string;
  lineIntensity: number;
  fillIntensity: number;
  lineWidth: number;
};

export type DDAProEpisode = {
  id: string;
  startIndex: number;
  troughIndex: number;
  recoveryIndex: number | null;
  depthPercent: number;
  durationBars: number;
  recoveryBars: number | null;
  areaUnderWater: number;
  recovered: boolean;
};

export type DDAProEventType =
  | "DDA_DRAWDOWN_STARTED" | "DDA_DRAWDOWN_DEEPENED" | "DDA_DRAWDOWN_RECOVERING"
  | "DDA_DRAWDOWN_RECOVERED" | "DDA_NEW_MAX_DRAWDOWN" | "DDA_RISK_STATE_CHANGED"
  | "DDA_TAIL_BAND_ENTERED" | "DDA_DURATION_EXTREME" | "DDA_CDAR_BREACHED"
  | "DDA_CONFIDENCE_DEGRADED" | "DDA_RISK_SCORE_CROSSED_50" | "DDA_RISK_SCORE_CROSSED_75"
  | "DDA_RISK_SCORE_CROSSED_90" | "DDA_P90_ENTERED" | "DDA_P95_ENTERED" | "DDA_P99_ENTERED"
  | "DDA_DURATION_P90_EXCEEDED" | "DDA_DURATION_P95_EXCEEDED" | "DDA_VADD_EXTREME"
  | "DDA_RISK_DETERIORATION_ACCELERATED";

export type DDAProEvent = {
  id: string;
  type: DDAProEventType;
  index: number;
  time: number;
  state: DDAProRiskState;
  value: number;
  engineMode?: DDAProEngineMode;
  sourceAuthority?: DDAProSnapshot["sourceAuthority"];
  lookback?: number;
  riskScore?: number;
  confidence?: number;
  drawdownPercent?: number;
  confirmed?: boolean;
};

export type DDAProSeries = {
  rawDrawdown: number[];
  smoothedDrawdown: number[];
  depth: number[];
  mean: number[];
  sigmaUpper: number[];
  sigmaLower: number[];
  p05: number[];
  p10: number[];
  p25: number[];
  p50: number[];
  p75: number[];
  p90: number[];
  p95: number[];
  p99: number[];
  percentileRank: number[];
  zScore: number[];
  duration: number[];
  timeUnderWater: number[];
  recoveryProgress: number[];
  velocity: number[];
  acceleration: number[];
  vadd: number[];
  riskScore: number[];
  riskState: DDAProRiskState[];
};

export type DDAProLatestMetrics = {
  drawdownPercent: number;
  depthPercent: number;
  maxDrawdownPercent: number;
  percentileRank: number;
  zScore: number;
  riskState: DDAProRiskState;
  riskScore: number;
  confidence: number;
  durationBars: number;
  timeUnderWaterBars: number;
  recoveryProgressPercent: number;
  velocity: number;
  acceleration: number;
  annualizedReturnPercent: number;
  annualizedVolatilityPercent: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  returnVaR95Percent: number;
  returnES95Percent: number;
  drawdownAtRisk95Percent: number;
  conditionalDrawdownAtRisk95Percent: number;
  ulcerIndex: number;
  painIndex: number;
  recoveryFactor: number;
  omegaRatio: number;
  vadd: number;
};

export type DDAProSnapshot = {
  schemaVersion: typeof DDA_PRO_SCHEMA_VERSION;
  engineMode: DDAProEngineMode;
  calculationHash: string;
  engineVersion: string;
  dataHash: string;
  settingsHash: string;
  outputHash: string;
  calculatedAt: number;
  inputSize: number;
  validFromIndex: number;
  barsPerYear: number;
  sourceAuthority: "MARKET_PRICE" | "ACCOUNT_EQUITY" | "STRATEGY_EQUITY" | "UNAVAILABLE";
  sourceWarning: string | null;
  series: DDAProSeries;
  episodes: DDAProEpisode[];
  events: DDAProEvent[];
  latest: DDAProLatestMetrics;
};

export type DDAProCalculationInput = {
  candles: Candle[];
  settings: DDAProSettings;
  timeframeSeconds?: number;
  equityValues?: number[];
};
