export type LiquidationDataCertainty =
  | "OBSERVED"
  | "DERIVED"
  | "ESTIMATED_HIGH"
  | "ESTIMATED_MEDIUM"
  | "ESTIMATED_LOW"
  | "MISSING"
  | "SYNTHETIC_TEST"
  | "UNAVAILABLE";

export type BclifModelAuthority =
  | "PERSISTENT_NODE"
  | "BROWSER_FALLBACK"
  | "REPLAY"
  | "TEST_FIXTURE";

export type LiquidationFieldHorizon = "6H" | "12H" | "1D" | "3D" | "1W" | "3W" | "1M" | "CUSTOM";
export type LiquidationFieldViewMode =
  | "COMBINED_THERMAL"
  | "LONG_EXPOSURE"
  | "SHORT_EXPOSURE"
  | "DIRECTIONAL_SPLIT"
  | "CONFIDENCE_FIELD"
  | "CONFIRMED_LIQUIDATIONS"
  | "CASCADE_RISK"
  | "COMBINED_INTELLIGENCE";
export type LiquidationFieldPalette =
  | "REFERENCE_THERMAL"
  | "BLACK_TERMINAL_BLOOD"
  | "INSTITUTIONAL_MONOCHROME"
  | "DIRECTIONAL_SPLIT"
  | "CONFIDENCE";
export type LiquidationFieldScale =
  | "ABSOLUTE_NOTIONAL"
  | "LOG_NOTIONAL"
  | "PERCENTILE"
  | "OI_RELATIVE"
  | "CONFIDENCE_WEIGHTED_LOG";
export type LiquidationFieldModelPreset =
  | "CONSERVATIVE"
  | "BALANCED"
  | "VENUE_CALIBRATED"
  | "REGIME_ADAPTIVE"
  | "CUSTOM";
export type LiquidationFieldSmoothing = "SHARP" | "BALANCED" | "SMOOTH" | "CUSTOM";

export interface LiquidationFieldSettings {
  schemaVersion: 1;
  preset: "EVENT_HORIZON_3W" | "CUSTOM";
  viewMode: LiquidationFieldViewMode;
  horizon: LiquidationFieldHorizon;
  customHours: number;
  venue: "BYBIT" | "COMPOSITE";
  modelPreset: LiquidationFieldModelPreset;
  scale: LiquidationFieldScale;
  palette: LiquidationFieldPalette;
  opacity: number;
  gamma: number;
  lowQuantile: number;
  highQuantile: number;
  smoothing: LiquidationFieldSmoothing;
  priceSigmaRows: number;
  timeSigmaColumns: number;
  sharpness: number;
  candlePalette: "BLACK_TERMINAL_HIGH_CONTRAST" | "REFERENCE_CYAN_MAGENTA";
  legendVisible: boolean;
  diagnosticsVisible: boolean;
  confirmedMarkersVisible: boolean;
  cascadePathsVisible: boolean;
  minimumConfidence: number;
  minimumNotionalUsd: number;
  sideFilter: "BOTH" | "LONG" | "SHORT";
  leverageMinimum: number;
  leverageMaximum: number;
  priceRows: number;
  timeColumns: number;
  liveUpdateCadenceMs: number;
  visualFixture: boolean;
}

export interface DepthCurvePoint {
  distanceBps: number;
  notional: number;
}

export interface DepthCurve {
  points: DepthCurvePoint[];
  certainty: LiquidationDataCertainty;
}

export interface LiquidationMarketFrame {
  venue: string;
  symbol: string;
  timestamp: number;
  lastPrice: number;
  markPrice: number;
  indexPrice: number;
  basisBps: number;
  openInterest: number;
  openInterestDelta: number;
  fundingRate: number | null;
  longAccountRatio: number | null;
  shortAccountRatio: number | null;
  aggressiveBuyNotional: number;
  aggressiveSellNotional: number;
  cvd: number;
  cvdEfficiency: number;
  realizedVolatility: number;
  parkinsonVolatility: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  bidDepthCurve: DepthCurve;
  askDepthCurve: DepthCurve;
  confirmedLongLiquidations: number;
  confirmedShortLiquidations: number;
  certainty: Record<string, LiquidationDataCertainty>;
  sourceVersion: string;
}

export interface LiquidationRiskTier {
  tierId: string;
  riskLimitValue: number;
  maintenanceMarginRate: number;
  initialMarginRate: number;
  maintenanceMarginDeduction: number;
  maxLeverage: number;
  certainty: LiquidationDataCertainty;
}

export interface LiquidationInstrumentRules {
  venue: string;
  symbol: string;
  contractType: string;
  contractMultiplier: number;
  maxLeverage: number;
  leverageStep: number;
  fundingIntervalMinutes: number;
  riskTiers: LiquidationRiskTier[];
  fetchedAt: number;
  sourceVersion: string;
  certainty: LiquidationDataCertainty;
}

export interface LiquidationPositionCohort {
  id: string;
  venue: string;
  symbol: string;
  side: "LONG" | "SHORT";
  createdAt: number;
  updatedAt: number;
  entryMean: number;
  entryStdDev: number;
  entryLower: number;
  entryUpper: number;
  leverageMean: number;
  leverageStdDev: number;
  leverageLower: number;
  leverageUpper: number;
  estimatedInitialNotional: number;
  estimatedRemainingNotional: number;
  marginMode: "ISOLATED_ESTIMATE" | "CROSS_ESTIMATE" | "MIXED" | "UNKNOWN";
  riskTierDistribution: Array<{ tierId: string; weight: number }>;
  liquidationMean: number;
  liquidationStdDev: number;
  liquidationLower: number;
  liquidationUpper: number;
  survivalProbability: number;
  posteriorWeight: number;
  confidence: number;
  state:
    | "FORMING"
    | "ACTIVE"
    | "REDUCING"
    | "PARTIALLY_LIQUIDATED"
    | "LIKELY_CLOSED"
    | "LIQUIDATED"
    | "EXPIRED"
    | "INVALIDATED";
  modelVersion: string;
}

/**
 * Versioned, JSON-safe state owned by the shared cohort engine. The browser
 * may use it for deterministic tests, while only the persistent collector is
 * allowed to publish it as an authoritative checkpoint.
 */
export interface LiquidationCohortEngineState {
  schemaVersion: 1;
  modelVersion: string;
  sourceVersion: string;
  modelPreset: LiquidationFieldModelPreset;
  previousFrame: LiquidationMarketFrame | null;
  cohortOrdinal: number;
  cohorts: LiquidationPositionCohort[];
  particles: LiquidationExposureParticle[];
  traversedCohortIds: string[];
}

export interface LiquidationExposureParticle {
  cohortId: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  leverage: number;
  marginMode: string;
  riskTier: string;
  notional: number;
  liquidationPrice: number;
  liquidationStdDev: number;
  survival: number;
  weight: number;
  confidence: number;
}

export interface ConfirmedLiquidationEvent {
  id: string;
  venue: string;
  symbol: string;
  timestamp: number;
  receivedAt: number;
  liquidatedPositionSide: "LONG" | "SHORT";
  quantity: number;
  bankruptcyPrice: number;
  notional: number;
  certainty: "OBSERVED";
  sourceVersion: string;
}

export interface LiquidationCoverage {
  venue: string;
  symbol: string;
  horizon: string;
  requestedStart: number;
  requestedEnd: number;
  availableStart: number | null;
  availableEnd: number | null;
  observedTradeCoveragePercent: number;
  openInterestCoveragePercent: number;
  liquidationEventCoveragePercent: number;
  orderbookCoveragePercent: number;
  modelContinuityPercent: number;
  missingIntervals: Array<{ start: number; end: number }>;
  quality: "EXCELLENT" | "HIGH" | "MIXED" | "LOW" | "INSUFFICIENT";
  state: "COLLECTING" | "LIVE" | "STALE" | "UNAVAILABLE" | "SYNTHETIC_TEST";
}

export interface BclifCoverageGap {
  start: number;
  end: number;
  missingSources: string[];
}

export interface BclifPersistentCoverage {
  venue: string;
  symbol: string;
  horizon: string;
  requestedStart: number;
  requestedEnd: number;
  modelStart: number | null;
  modelEnd: number | null;
  openInterestCoveragePercent: number | null;
  tradeCoveragePercent: number | null;
  liquidationCoveragePercent: number | null;
  orderbookCoveragePercent: number | null;
  fundingCoveragePercent: number | null;
  continuityPercent: number | null;
  sourceMode: "PERSISTENT_COLLECTOR" | "BROWSER_SESSION" | "MIXED" | "UNAVAILABLE";
  quality: "EXCELLENT" | "HIGH" | "MIXED" | "LOW" | "INSUFFICIENT";
  gaps: BclifCoverageGap[];
  updatedAt: number;
}

export interface LiquidationConfidenceBreakdown {
  total: number;
  tradeCoverage: number;
  openInterest: number;
  entryPrice: number;
  leverage: number;
  marginModel: number;
  eventCalibration: number;
  continuity: number;
  penalties: string[];
}

export interface CascadeRiskSnapshot {
  timestamp: number;
  symbol: string;
  direction: "UP" | "DOWN";
  triggerRange: [number, number];
  nextClusterRange: [number, number] | null;
  estimatedForcedNotional: number;
  estimatedAbsorptionCapacity: number;
  estimatedSlippageBps: number;
  cascadeProbability: number;
  confidence: number;
  state: "DORMANT" | "BUILDING" | "ARMED" | "TRIGGERED" | "CASCADING" | "ABSORBED" | "EXHAUSTED";
}

export interface LiquidationFieldTileHeader {
  schemaVersion: number;
  modelVersion: string;
  venue: string;
  symbol: string;
  horizon: string;
  startTime: number;
  endTime: number;
  minPrice: number;
  maxPrice: number;
  columns: number;
  rows: number;
  timeStepMs: number;
  priceStep: number;
  exposureScale: number;
  confidenceScale: number;
  compression: string;
  checksum: string;
  sourceCutoffTimestamp?: number;
  tileId?: string;
  tileVersion?: number;
}

export interface LiquidationFieldSnapshot {
  header: LiquidationFieldTileHeader;
  timestamps: Float64Array;
  longExposure: Float32Array;
  shortExposure: Float32Array;
  combinedExposure: Float32Array;
  normalizedIntensity: Uint8Array;
  longNormalizedIntensity: Uint8Array;
  shortNormalizedIntensity: Uint8Array;
  confidence: Uint8Array;
  validity: Uint8Array;
  confirmedIntensity: Uint8Array;
  confirmedNotional: Float32Array;
  confirmedCount: Uint16Array;
  cohorts: LiquidationPositionCohort[];
  confirmedEvents: ConfirmedLiquidationEvent[];
  cascade: CascadeRiskSnapshot[];
  coverage: LiquidationCoverage;
  confidenceBreakdown: LiquidationConfidenceBreakdown;
  buildTimeMs: number;
  generatedAt: number;
  certainty: LiquidationDataCertainty;
  authority: BclifModelAuthority;
  collectorNodeId: string | null;
  persistentCoverage?: BclifPersistentCoverage;
}

export interface LiquidationFieldRuntimeStatus {
  state: "IDLE" | "LOADING" | "LIVE" | "COLLECTING" | "STALE" | "UNAVAILABLE" | "ERROR";
  message: string;
  lastInputAt: number | null;
  source: "PERSISTENT_COLLECTOR" | "BYBIT_PUBLIC" | "SYNTHETIC_TEST" | "NONE";
  authority?: BclifModelAuthority;
  persistence?: "ON" | "OFF";
  collectorNodeId?: string | null;
  error?: string;
}

export const BCLIF_MODEL_VERSION = "BCLIF_MODEL_V4_CAUSAL";
export const BCLIF_SOURCE_VERSION = "BYBIT_V5_PUBLIC_2026_08";
