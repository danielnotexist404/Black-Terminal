import type { Candle } from "../../../chart-engine/types.ts";

export const DDA_PRO_SCHEMA_VERSION = 1 as const;
export const DDA_PRO_SETTINGS_VERSION = 4 as const;
export const DDA_PRO_INDICATOR_ID = "black-core-dda-pro" as const;

export type DDAProEngineMode = "pine-compatibility" | "black-core-native";
export type DDAProPriceSource = "close" | "hlc3" | "ohlc4";
export type DDAProQuantileMethod = "type7" | "nearest-rank";
export type DDAProZScoreMethod = "classical" | "robust";
export type DDAProSmoothingMethod = "none" | "ema" | "sma" | "rma";
export type DDAProTheme =
  | "black-terminal" | "black-terminal-blood" | "institutional-monochrome" | "custom"
  | "gold" | "edge-tools" | "behavioral" | "quant" | "ocean" | "fire" | "matrix" | "arctic";
export type DDAProPreset = "Custom" | "BC-RDA — Original Compatibility" | "BC-RDA — Institutional" | "BC-RDA — Macro Risk";
export type DDAProRiskState = "LOW" | "MODERATE" | "HIGH" | "EXTREME" | "INSUFFICIENT";
export type DDAProFlowState = "BULLISH" | "NEUTRAL" | "BEARISH" | "UNAVAILABLE";
export type DDAProFlowAuthority = "EXACT_AGGRESSOR_TRADES" | "UNAVAILABLE";
export type DDAProSignalIntelligenceMode = "RAW" | "BALANCED" | "INSTITUTIONAL" | "CUSTOM";
export type DDAProDistributionRegime = "COMPRESSION" | "CHOP" | "TRANSITION" | "DIRECTIONAL_EXPANSION" | "EXHAUSTION" | "REDISTRIBUTION" | "UNCLASSIFIED";
export type DDAProSignalState = "NEUTRAL" | "WATCHING" | "ARMED" | "CONFIRMED" | "COOLDOWN" | "RESET";
export type BCRDATopEpisodeState =
  | "NEUTRAL" | "EXPANDING" | "TOP_WATCH" | "TOP_BUILDING"
  | "TOP_ARMED" | "TOP_CONFIRMED" | "COOLDOWN" | "RESET";
export type BCRDAMarketRegime =
  | "STRONG_BULL" | "WEAK_BULL" | "RANGE" | "WEAK_BEAR"
  | "STRONG_BEAR" | "TRANSITION" | "INSUFFICIENT";
export type BCRDATopEngineMode = "mirrored-causal" | "disabled";
export type BCRDATopAnchorMethod = "causal-episode-trough";
export type DDAProSignalReason =
  | "LOW_COHERENCE" | "HIGH_TRANSITION_ENTROPY" | "CENTROID_STALLED"
  | "CENTROID_MIGRATING_UP" | "CENTROID_MIGRATING_DOWN" | "DISTRIBUTION_COMPRESSED"
  | "DISTRIBUTION_EXPANDING" | "UPPER_TAIL_DOMINANT" | "LOWER_TAIL_DOMINANT"
  | "EXCURSION_NOT_PERSISTENT" | "EPISODE_ALREADY_SIGNALLED" | "RESET_NOT_CONFIRMED"
  | "STRUCTURE_NOT_CONFIRMED" | "VOLUME_NOT_CONFIRMED" | "CVD_UNAVAILABLE"
  | "HIGHER_TIMEFRAME_CONFLICT" | "HIGH_CHOP_PROBABILITY" | "TAIL_ASYMMETRY_WEAK"
  | "CONFIDENCE_BELOW_MINIMUM" | "SIGNAL_CONFIRMED";

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
  topEngineMode: BCRDATopEngineMode;
  enableMirroredTopEngine: boolean;
  topAnchorMethod: BCRDATopAnchorMethod;
  topEpisodeMinimumThresholdPercent: number;
  topEpisodeMaximumThresholdPercent: number;
  topAtrLookback: number;
  topAtrMultiplier: number;
  topReturnQuantileLookback: number;
  topReturnQuantile: number;
  topQuantileMultiplier: number;
  topExtremityPercentile: number;
  topBarrierDispersionMultiplier: number;
  topMinimumMaturityBars: number;
  topReversalAtrMultiplier: number;
  topMinimumReversalPercent: number;
  topChangePointSensitivity: number;
  topStructureConfirmation: boolean;
  strongBullProtection: boolean;
  oneShortPerTopEpisode: boolean;
  topCooldownBars: number;
  topRequireExactBearishFlow: boolean;
  showTopCandidates: boolean;
  showDynamicTopBarrier: boolean;
  showTopDiagnostics: boolean;
  hysteresisPercent: number;
  moderateThreshold: number;
  highThreshold: number;
  extremeThreshold: number;
  depthWeight: number;
  durationWeight: number;
  velocityWeight: number;
  volatilityWeight: number;
  tailWeight: number;
  showFlowPressure: boolean;
  flowPressureSmoothingLength: number;
  flowPressureNormalizationLookback: number;
  flowPressureNeutralThreshold: number;
  flowPressureMinimumCoveragePercent: number;
  flowAggressorWeight: number;
  flowCvdWeight: number;
  flowBullishColor: string;
  flowBearishColor: string;
  flowNeutralColor: string;
  flowLineIntensity: number;
  flowLineWidth: number;
  signalIntelligenceMode: DDAProSignalIntelligenceMode;
  showRawSignals: boolean;
  showConfirmedSignals: boolean;
  showProvisionalSignals: boolean;
  confirmedAlertsOnly: boolean;
  showSignalConfidence: boolean;
  showRegimeDiagnostics: boolean;
  distributionCoherenceFilter: boolean;
  riskCentroidMigration: boolean;
  distributionExpansionConfirmation: boolean;
  tailAsymmetryConfirmation: boolean;
  entropyChopSuppression: boolean;
  excursionPersistence: boolean;
  signalEpisodeClustering: boolean;
  distributionalResetRequirement: boolean;
  priceStructureConfirmation: boolean;
  volumeConfirmation: boolean;
  cvdConfirmation: boolean;
  higherTimeframeConfirmation: boolean;
  minimumCoherence: number;
  minimumCentroidDisplacement: number;
  minimumCentroidPersistence: number;
  minimumExpansionScore: number;
  minimumTailAsymmetry: number;
  maximumChopProbability: number;
  maximumTransitionEntropy: number;
  minimumExcursionBars: number;
  minimumConfirmationScore: number;
  resetSensitivity: number;
  episodeSeparationSensitivity: number;
  safetyCooldownFloor: number;
  higherTimeframeMultiplier: 4 | 12 | 24;
  structureConfirmationStrength: number;
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
  | "DDA_RISK_DETERIORATION_ACCELERATED"
  | "BC_RDA_TOP_CANDIDATE" | "BC_RDA_TOP_CONFIRMED";

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

export type DDAProSignalDirection = "long" | "short";

export type DDAProSignalEvent = {
  id: string;
  indicatorId: typeof DDA_PRO_INDICATOR_ID;
  direction: DDAProSignalDirection;
  index: number;
  time: number;
  value: number;
  sourceEventType: "DDA_DRAWDOWN_DEEPENED" | "BC_RDA_TOP_CANDIDATE" | "BC_RDA_TOP_CONFIRMED";
  markerTone: "blood-red" | "silver-white";
  classification?: "confirmed" | "provisional";
  confidence?: number;
  regime?: DDAProDistributionRegime;
  episodeId?: string;
  reasonCodes?: DDAProSignalReason[];
  episodeExtremityIndex?: number;
  episodeExtremityTime?: number;
};

export type BCRDATopEpisode = {
  id: string;
  troughIndex: number;
  troughTime: number;
  troughPrice: number;
  startIndex: number;
  entryThresholdPercent: number;
  maximumIndex: number;
  maximumTime: number;
  maximumPrice: number;
  maximumDrawupPercent: number;
  terminalTouches: number;
  confirmedIndex: number | null;
  resetIndex: number | null;
  state: BCRDATopEpisodeState;
};

export type BCRDATopSeries = {
  rawDrawup: number[];
  smoothedDrawup: number[];
  drawupDepth: number[];
  drawupMean: number[];
  drawupP50: number[];
  drawupP75: number[];
  drawupP90: number[];
  drawupP95: number[];
  drawupP99: number[];
  drawupPercentileRank: number[];
  drawupZScore: number[];
  drawupDuration: number[];
  timeAboveTrough: number[];
  drawupVelocity: number[];
  drawupAcceleration: number[];
  drawupVadd: number[];
  distributionWidth: number[];
  tailSeverity: number[];
  topRiskScore: number[];
  topRiskState: DDAProRiskState[];
  adaptiveEntryThreshold: number[];
  dynamicTopBarrier: number[];
  reversalFromEpisodeHigh: number[];
  requiredTopReversal: number[];
  state: BCRDATopEpisodeState[];
  marketRegime: BCRDAMarketRegime[];
  episodeId: Array<string | null>;
};

export type DDAProSignalEpisode = {
  id: string;
  direction: DDAProSignalDirection;
  startIndex: number;
  confirmedIndex: number | null;
  resetIndex: number | null;
  peakConfidence: number;
  rawSignalCount: number;
};

export type DDAProSignalIntelligence = {
  engineVersion: "BC_RDA_SIGNAL_INTELLIGENCE_V1";
  mode: DDAProSignalIntelligenceMode;
  regime: DDAProDistributionRegime[];
  regimeConfidence: number[];
  longConfidence: number[];
  shortConfidence: number[];
  chopProbability: number[];
  transitionEntropy: number[];
  coherence: number[];
  centroidVelocity: number[];
  centroidAcceleration: number[];
  expansionScore: number[];
  tailAsymmetry: number[];
  state: DDAProSignalState[];
  longState: DDAProSignalState[];
  shortState: DDAProSignalState[];
  rawCandidateSignals: DDAProSignalEvent[];
  episodes: DDAProSignalEpisode[];
  provisionalSignals: DDAProSignalEvent[];
  suppressedRawSignalCount: number;
  latestReasonCodes: DDAProSignalReason[];
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
  flowImbalance: number[];
  flowCvdMomentum: number[];
  flowPressure: number[];
  flowCoveragePercent: number[];
  flowState: DDAProFlowState[];
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
  flowPressure: number;
  flowCoveragePercent: number;
  flowState: DDAProFlowState;
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
  flowAuthority: DDAProFlowAuthority;
  flowWarning: string | null;
  series: DDAProSeries;
  topSeries: BCRDATopSeries;
  episodes: DDAProEpisode[];
  topEpisodes: BCRDATopEpisode[];
  events: DDAProEvent[];
  topCandidates: DDAProSignalEvent[];
  rawSignals: DDAProSignalEvent[];
  signals: DDAProSignalEvent[];
  signalIntelligence: DDAProSignalIntelligence;
  latest: DDAProLatestMetrics;
};

export type DDAProFlowBarInput = {
  time: number;
  buyVolume: number;
  sellVolume: number;
  unknownVolume: number;
  buyNotional: number;
  sellNotional: number;
  unknownNotional: number;
  exactTradeCount: number;
  totalTradeCount: number;
  deliveryComplete: boolean;
};

export type DDAProCalculationInput = {
  candles: Candle[];
  settings: DDAProSettings;
  timeframeSeconds?: number;
  equityValues?: number[];
  cvdValues?: number[];
  flowBars?: DDAProFlowBarInput[];
  flowAuthority?: DDAProFlowAuthority;
  flowWarning?: string | null;
  signalContext?: { exchange: string; symbol: string; timeframe: string };
};
