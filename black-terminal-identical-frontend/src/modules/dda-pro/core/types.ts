import type { Candle } from "../../../chart-engine/types.ts";

export const DDA_PRO_SCHEMA_VERSION = 1 as const;
export const DDA_PRO_SETTINGS_VERSION = 4 as const;
export const DDA_PRO_INDICATOR_ID = "black-core-dda-pro" as const;
export const BC_RDA_LEGACY_REPAINTING = "BC_RDA_LEGACY_REPAINTING" as const;
export const BC_RDA_CAUSAL_V2 = "BC_RDA_CAUSAL_V2" as const;

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
export type DDAProSignalModelVersion = typeof BC_RDA_LEGACY_REPAINTING | typeof BC_RDA_CAUSAL_V2;
export type DDAProSignalLifecycle = "NONE" | "RAW_CANDIDATE" | "DEVELOPING" | "CONFIRMED" | "REJECTED" | "FINAL";
export type DDAProDistributionRegime = "COMPRESSION" | "CHOP" | "TRANSITION" | "DIRECTIONAL_EXPANSION" | "EXHAUSTION" | "REDISTRIBUTION" | "UNCLASSIFIED";
export type DDAProSignalState = "NEUTRAL" | "WATCHING" | "ARMED" | "CONFIRMED" | "COOLDOWN" | "RESET";
export type DDAProSignalReason =
  | "LOW_COHERENCE" | "HIGH_TRANSITION_ENTROPY" | "CENTROID_STALLED"
  | "CENTROID_MIGRATING_UP" | "CENTROID_MIGRATING_DOWN" | "DISTRIBUTION_COMPRESSED"
  | "DISTRIBUTION_EXPANDING" | "UPPER_TAIL_DOMINANT" | "LOWER_TAIL_DOMINANT"
  | "EXCURSION_NOT_PERSISTENT" | "EPISODE_ALREADY_SIGNALLED" | "RESET_NOT_CONFIRMED"
  | "STRUCTURE_NOT_CONFIRMED" | "VOLUME_NOT_CONFIRMED" | "CVD_UNAVAILABLE"
  | "HIGHER_TIMEFRAME_CONFLICT" | "HIGH_CHOP_PROBABILITY" | "TAIL_ASYMMETRY_WEAK"
  | "CONFIDENCE_BELOW_MINIMUM" | "CAUSAL_RECOVERY_CONFIRMED" | "CAUSAL_ROLLOVER_CONFIRMED"
  | "SIGNAL_CONFIRMED";

export type DDAProSettings = {
  settingsVersion: typeof DDA_PRO_SETTINGS_VERSION;
  engineMode: DDAProEngineMode;
  preset: DDAProPreset;
  source: DDAProPriceSource;
  peakMode: "all-history" | "rolling";
  equitySource: "price" | "connected-account" | "strategy-equity";
  realtimeMode: "confirmed-bars" | "developing-preview";
  signalModelVersion: DDAProSignalModelVersion;
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

export type DDAProSignalDirection = "long" | "short";

export type DDAProSignalEvent = {
  id: string;
  indicatorId: typeof DDA_PRO_INDICATOR_ID;
  direction: DDAProSignalDirection;
  index: number;
  time: number;
  value: number;
  sourceEventType: "DDA_DRAWDOWN_DEEPENED" | "DDA_DRAWDOWN_RECOVERED";
  markerTone: "blood-red" | "silver-white";
  classification?: "confirmed" | "provisional";
  confidence?: number;
  regime?: DDAProDistributionRegime;
  episodeId?: string;
  reasonCodes?: DDAProSignalReason[];
  lifecycle?: DDAProSignalLifecycle;
  candidateIndex?: number;
  confirmationIndex?: number;
  displayAnchorIndex?: number;
  candidateTimestamp?: number;
  confirmationTimestamp?: number;
  displayAnchorTimestamp?: number;
  candidatePrice?: number;
  confirmationPrice?: number;
  displayAnchorPrice?: number;
  executionEligibleTimestamp?: number | null;
  confirmationDelayBars?: number;
  finalized?: boolean;
  modelVersion?: DDAProSignalModelVersion;
  settingsHash?: string;
  dataHash?: string;
  causalAudit?: {
    confirmationDepth: number;
    confirmationVelocity: number;
    anchorDepth: number;
    percentileRank: number;
    p50: number;
    p95: number;
    p99: number;
    riskState: DDAProRiskState;
    cloudState: "DEEPENING" | "RECOVERY_CANDIDATE" | "RECOVERY_CONFIRMED" | "UPPER_EXTREME" | "ROLLOVER_CANDIDATE" | "ROLLOVER_CONFIRMED";
    episodeThresholdPercent: number;
    recoveryThresholdPercent: number;
    minimumImprovementPercent: number;
    requiredRecoveryBars: number;
    observedRecoveryBars: number;
  };
};

export type DDAProSignalIntegrity = {
  model: DDAProSignalModelVersion;
  currentBar: "DEVELOPING" | "FINAL";
  legacyResearchOnly: boolean;
  finalizedSignalDrift: number;
  finalizedValueDrift: number;
  signalTimestampDrift: number;
  backpaintedExecutionCount: number;
  lastPrefixTest: "PASS" | "FAIL" | "NOT_RUN";
  streamingBatchParity: "PASS" | "FAIL" | "NOT_RUN";
  reloadParity: "PASS" | "FAIL" | "NOT_RUN";
  checkpointParity: "PASS" | "FAIL" | "NOT_RUN";
  alertEligibility: "BLOCKED" | "CERTIFIED";
  strategyEligibility: "BLOCKED" | "CERTIFIED";
  statisticsStatus: "INVALIDATED_REPAINTING_SOURCE" | "CAUSAL_MODEL_ONLY";
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
  episodes: DDAProEpisode[];
  events: DDAProEvent[];
  rawSignals: DDAProSignalEvent[];
  signals: DDAProSignalEvent[];
  signalIntelligence: DDAProSignalIntelligence;
  signalIntegrity: DDAProSignalIntegrity;
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
  lastBarConfirmed?: boolean;
};
