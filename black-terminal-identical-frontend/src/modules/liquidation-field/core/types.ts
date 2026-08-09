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
export type BclifPresentationPreset =
  | "TRADE_FOCUS"
  | "HIGH_CONFIDENCE"
  | "LIVE_CALIBRATED"
  | "FULL_SPECTRUM_RESEARCH"
  | "RAW_MODEL"
  | "CUSTOM";
export type BclifPriceDisplay =
  | "CHART_SCALE"
  | "CURRENT_PRICE_5"
  | "CURRENT_PRICE_10"
  | "CURRENT_PRICE_20"
  | "CURRENT_PRICE_40"
  | "AUTO_FOCUS"
  | "FULL_MODEL_RANGE"
  | "CUSTOM";
export type BclifVisualChannel = "HISTORICAL_CONTEXT" | "LIVE_CALIBRATED" | "COMBINED";
export type BclifThermalNormalization =
  | "GLOBAL_MODEL"
  | "VISIBLE_FOCUS"
  | "HYBRID"
  | "FIXED_ABSOLUTE"
  | "OI_RELATIVE"
  | "CONFIDENCE_WEIGHTED";
export type BclifAdaptiveResolution = "AUTO" | "HIGH" | "BALANCED" | "LOW_PERFORMANCE";
export type BclifFocusBand = "OFF" | "PERCENT_2" | "PERCENT_5" | "PERCENT_10" | "CUSTOM";
export type BclifOiNoiseMethod = "HYBRID_ROBUST" | "ABSOLUTE_NOTIONAL" | "OI_PERCENT" | "ROBUST_MAD";
export type CohortEntrySource =
  | "EXACT_TRADES"
  | "LOWER_TF_VOLUME_AT_PRICE"
  | "LOWER_TF_APPROXIMATION"
  | "CHART_BAR_APPROXIMATION";

export interface CohortEntryDistribution {
  priceRows: number[];
  weights: number[];
  source: CohortEntrySource;
  intervalStart: number;
  intervalEnd: number;
  confidence: number;
  hash: string;
}

export interface BclifOiMaterialityDecision {
  rawDelta: number;
  effectiveDelta: number;
  threshold: number;
  method: BclifOiNoiseMethod;
  version: string;
  material: boolean;
}

export interface BclifCohortModelConfiguration {
  oiNoiseMethod: BclifOiNoiseMethod;
  oiNoiseAbsoluteNotionalUsd: number;
  oiNoisePercent: number;
  oiNoiseMadMultiplier: number;
  isolatedContributionCap: number;
  crossContributionCap: number;
  unknownContributionCap: number;
  oiEventWindowMs: number;
  oiEventContinuationRatio: number;
  oiEventTerminationRatio: number;
  oiEventHysteresisIntervals: number;
}

/**
 * Authoritative model storage is always expressed on the exchange quote-price
 * axis. Screen pixels, normalized intensity and the current mark are not valid
 * coordinates for this distribution.
 */
export interface AbsoluteLiquidationDistribution {
  priceUnit: "QUOTE_PRICE";
  gridOrigin: number;
  priceStep: number;
  minPrice: number;
  maxPrice: number;
  rows: number;
  modelVersion: string;
  gridVersion: string;
}

export interface BclifAbsolutePriceGrid {
  minPrice: number;
  maxPrice: number;
  priceStep: number;
  gridOrigin: number;
  gridVersion: string;
  rows: number;
}

export interface BclifAbsolutePriceGrid {
  minPrice: number;
  maxPrice: number;
  priceStep: number;
  gridOrigin: number;
  gridVersion: string;
  rows: number;
}

export interface BclifOiEventWindowState {
  startedAt: number;
  lastObservedAt: number;
  intervalStart: number;
  intervalEnd: number;
  effectiveDelta: number;
  threshold: number;
  quietIntervals: number;
  source: CohortEntrySource;
  confidence: number;
  observations: Array<{ price: number; weight: number }>;
  latestFrame: LiquidationMarketFrame;
}

export interface BclifRawCohortShelf {
  cohortId: string;
  side: "LONG" | "SHORT";
  createdAt: number;
  sourceIntervalStart: number;
  sourceIntervalEnd: number;
  entryLower: number;
  entryMean: number;
  entryUpper: number;
  liquidationLower: number;
  liquidationMean: number;
  liquidationUpper: number;
  remainingMass: number;
  confidence: number;
  entrySource: CohortEntrySource;
  leverageContributions: Array<{ leverage: number; probability: number }>;
  marginMode: LiquidationPositionCohort["marginMode"];
}

export interface LiquidationFieldSettings {
  schemaVersion: 9;
  preset: BclifPresentationPreset;
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
  /** Minimum confidence at which estimated context may be drawn at all. */
  contextVisibilityFloor: number;
  /** Minimum confidence for shelf labels and operational summaries. */
  clusterLabelFloor: number;
  /** Minimum confidence permitted to use high-authority green/yellow colors. */
  highAuthorityColorFloor: number;
  /** Explicit destructive filter. Off by default; never implied by a preset. */
  strictHideBelowEnabled: boolean;
  strictHideBelowConfidence: number;
  historicalContextEnabled: boolean;
  liveCalibratedEnabled: boolean;
  minimumNotionalUsd: number;
  sideFilter: "BOTH" | "LONG" | "SHORT";
  leverageMinimum: number;
  leverageMaximum: number;
  priceRows: number;
  timeColumns: number;
  liveUpdateCadenceMs: number;
  visualFixture: boolean;
  priceDisplay: BclifPriceDisplay;
  customPriceMinimum: number;
  customPriceMaximum: number;
  autoFocusMarginPercent: number;
  visualChannel: BclifVisualChannel;
  thermalNormalization: BclifThermalNormalization;
  confidenceWeightEnabled: boolean;
  backgroundFloor: number;
  /** Full-plot presentation layer; never interpreted as modeled exposure. */
  plasmaBackgroundOpacity: number;
  /** Render-only contrast for modeled shelf bodies and high-energy cores. */
  shelfContrast: number;
  /** Minimum visibility retained while a mitigated shelf still has mass. */
  residualShelfVisibility: number;
  yellowTailPercent: number;
  historicalContextOpacity: number;
  liveCalibratedOpacity: number;
  requireMultipleEvidenceChannels: boolean;
  uncertaintyEnvelopesVisible: boolean;
  adaptiveResolution: BclifAdaptiveResolution;
  focusBand: BclifFocusBand;
  customFocusBandPercent: number;
  candleContrast: "STANDARD" | "HIGH" | "MAXIMUM";
  maximumClusterLabels: number;
  operationalSummaryVisible: boolean;
  collectionStartMarkerVisible: boolean;
  cohortProvenanceVisible: boolean;
  cohortBirthMarkersVisible: boolean;
  oiNoiseMethod: BclifOiNoiseMethod;
  oiNoiseAbsoluteNotionalUsd: number;
  oiNoisePercent: number;
  oiNoiseMadMultiplier: number;
  isolatedContributionCap: number;
  crossContributionCap: number;
  unknownContributionCap: number;
  oiEventWindowMs: number;
  oiEventContinuationRatio: number;
  oiEventTerminationRatio: number;
  oiEventHysteresisIntervals: number;
  rawCohortShelvesVisible: boolean;
}

export interface BclifEvidenceComposition {
  openInterest: number;
  trades: number;
  confirmedLiquidations: number;
  orderBook: number;
  funding: number;
  markPrice: number;
  positioning: number;
}

export type BclifEvidenceClass =
  | "OI_ONLY"
  | "OI_PLUS_PRICE"
  | "OI_PLUS_TRADES"
  | "OI_PLUS_TRADES_PLUS_LIQUIDATIONS"
  | "OI_PLUS_TRADES_PLUS_BOOK"
  | "FULL_CONTEXT";

export interface BclifOperationalCluster {
  id: string;
  side: "LONG_LIQUIDATION" | "SHORT_LIQUIDATION";
  priceLow: number;
  priceHigh: number;
  peakPrice: number;
  distanceFromMarkBps: number;
  estimatedExposureLow: number;
  estimatedExposureHigh: number;
  confidence: number;
  persistence: number;
  survivalProbability: number;
  evidenceComposition: BclifEvidenceComposition;
  observedLiquidationNotionalNearby: number;
  state: "FORMING" | "ACTIVE" | "STRENGTHENING" | "DECAYING" | "TRIGGERED" | "ABSORBED" | "EXHAUSTED";
  prominence: number;
  rankScore: number;
  exposureConcentration: number;
  shelfWidth: number;
  priceEntropy: number;
  cohortOverlapCount: number;
  cohortIds: string[];
  provenanceCoverage: number;
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
  oiIntervalStart?: number;
  oiIntervalEnd?: number;
  entryDistribution?: CohortEntryDistribution;
  oiMateriality?: BclifOiMaterialityDecision;
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
  tickSize?: number;
}

export interface LiquidationPositionCohort {
  id: string;
  venue: string;
  symbol: string;
  side: "LONG" | "SHORT";
  createdAt: number;
  updatedAt: number;
  sourceIntervalStart: number;
  sourceIntervalEnd: number;
  initialOpenMass: number;
  remainingMass: number;
  massUnit: "QUOTE_NOTIONAL";
  entryDistribution: CohortEntryDistribution;
  leverageDistribution: Array<{ leverage: number; probability: number }>;
  evidenceChannels: string[];
  creationReason: string;
  fundingAdjustmentBps: number;
  lastLifecycleEvent: BclifCohortLifecycleEvent;
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

export interface BclifCohortLifecycleEvent {
  id: string;
  cohortId: string;
  timestamp: number;
  kind: "BIRTH" | "OI_CONTRACTION" | "CONFIRMED_LIQUIDATION" | "UNRESOLVED_TRAVERSAL" | "TIME_DECAY" | "EXPIRY";
  massRemoved: number;
  evidenceId: string | null;
  reason: string;
}

export interface BclifModelMassLedger {
  totalCreatedMass: number;
  voluntaryClosureMass: number;
  confirmedLiquidationMass: number;
  decayExpiryMass: number;
  totalRemainingMass: number;
  conservationError: number;
  tolerance: number;
}

/**
 * Versioned, JSON-safe state owned by the shared cohort engine. The browser
 * may use it for deterministic tests, while only the persistent collector is
 * allowed to publish it as an authoritative checkpoint.
 */
export interface LiquidationCohortEngineState {
  schemaVersion: 2;
  modelVersion: string;
  sourceVersion: string;
  modelPreset: LiquidationFieldModelPreset;
  previousFrame: LiquidationMarketFrame | null;
  cohortOrdinal: number;
  cohorts: LiquidationPositionCohort[];
  particles: LiquidationExposureParticle[];
  traversedCohortIds: string[];
  oiDeltaHistory: number[];
  oiEventWindow?: BclifOiEventWindowState | null;
  configuration: BclifCohortModelConfiguration;
  massLedger: BclifModelMassLedger;
  lifecycleEvents: BclifCohortLifecycleEvent[];
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
  entrySource: CohortEntrySource;
  uncertaintyClass: "ISOLATED_ESTIMATE" | "CROSS_ESTIMATE" | "UNKNOWN";
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
  gridOrigin?: number;
  gridVersion?: string;
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
  massLedger: BclifModelMassLedger;
  lifecycleEvents: BclifCohortLifecycleEvent[];
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
  absoluteDistribution?: AbsoluteLiquidationDistribution;
  rawCohortShelves?: BclifRawCohortShelf[];
  generations?: BclifGenerationHandoff;
}

export interface BclifGenerationHandoff {
  modelGeneration: number;
  exposureGeneration: number;
  rendererGeneration: number;
  settingsGeneration: number;
  authority: BclifModelAuthority;
  modelVersion: string;
}

export type BclifClientLifecycle =
  | "UNMOUNTED"
  | "MOUNTING"
  | "RESTORING_LOCAL_PUBLIC_CACHE"
  | "WAITING_FOR_MODEL"
  | "BACKFILLING_OI"
  | "OI_CONTEXT_READY"
  | "LIVE_CALIBRATING"
  | "PERSISTENT_READY"
  | "FILTERED_EMPTY"
  | "RENDERER_INITIALIZING"
  | "TEXTURE_ERROR"
  | "SOURCE_UNAVAILABLE"
  | "VENUE_UNSUPPORTED"
  | "FATAL";

export interface LiquidationFieldRuntimeStatus {
  state: "IDLE" | "LOADING" | "LIVE" | "COLLECTING" | "STALE" | "UNAVAILABLE" | "ERROR";
  message: string;
  lastInputAt: number | null;
  source: "PERSISTENT_COLLECTOR" | "BYBIT_PUBLIC" | "SYNTHETIC_TEST" | "NONE";
  authority?: BclifModelAuthority;
  persistence?: "ON" | "OFF";
  collectorNodeId?: string | null;
  error?: string;
  lifecycle?: BclifClientLifecycle;
}

export const BCLIF_MODEL_VERSION = "BCLIF_MODEL_V6_ABSOLUTE_SHELVES";
export const BCLIF_SOURCE_VERSION = "BYBIT_V6_PUBLIC_2026_08";
