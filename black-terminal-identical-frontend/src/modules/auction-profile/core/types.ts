import type { Candle } from "../../../chart-engine/types.ts";
import type { ExchangeId, SymbolMetadata, Timeframe, TradeTick } from "../../../market-data/types.ts";

export const AUCTION_PROFILE_SCHEMA_VERSION = 1;
export const AUCTION_PROFILE_ENGINE_VERSION = "bc-meap-2.0.0";

export type AuctionImplementationMode = "PINE_COMPATIBILITY" | "BLACK_CORE_NATIVE";
export type AuctionScopeMode =
  | "SESSION"
  | "ROLLING"
  | "FIXED_START"
  | "VISIBLE_RANGE"
  | "COMPOSITE"
  | "PERIODIC_COMPOSITE"
  | "MACRO_COMPOSITE"
  | "MANUAL_RANGE";

export type AuctionCalculationEngine =
  | "CVD_REAL_TRADES"
  | "CVD_PINE_COMPATIBLE"
  | "VOLUME"
  | "BUY_VOLUME"
  | "SELL_VOLUME"
  | "DELTA_VOLUME"
  | "IMBALANCE_RATIO"
  | "TPO"
  | "ACTIVITY"
  | "USD_VOLUME"
  | "REALIZED_VOLATILITY"
  | "PARKINSON_VOLATILITY"
  | "GARMAN_KLASS_VOLATILITY"
  | "RANGE_EXPANSION"
  | "TRADE_COUNT"
  | "AVERAGE_TRADE_SIZE"
  | "LIQUIDITY_WEIGHTED_ACTIVITY"
  | "HYBRID_AUCTION_SCORE";

export type AuctionCvdMetric =
  | "NET_CVD"
  | "ABSOLUTE_CVD"
  | "POSITIVE_CVD"
  | "NEGATIVE_CVD"
  | "CVD_IMBALANCE_RATIO"
  | "CVD_EFFICIENCY"
  | "CVD_ACCELERATION"
  | "CVD_PERSISTENCE"
  | "CVD_DIVERGENCE";

export type AuctionPriceAllocation =
  | "UNIFORM_BAR_RANGE"
  | "CLOSE_WEIGHTED"
  | "TYPICAL_PRICE_WEIGHTED"
  | "TRADE_AT_PRICE_EXACT"
  | "VOLUME_AT_PRICE_EXACT"
  | "GAUSSIAN_AROUND_VWAP"
  | "BODY_WICK_WEIGHTED"
  | "HYBRID";

export type AuctionDataSource =
  | "LIVE_TRADE_STREAM"
  | "HISTORICAL_TRADE_ARCHIVE"
  | "LOWER_TIMEFRAME_BARS"
  | "CHART_BARS"
  | "HYBRID";

export type AuctionRowSizingMode =
  | "AUTO"
  | "TICKS"
  | "PRICE"
  | "BASIS_POINTS"
  | "ATR_FRACTION"
  | "VISIBLE_PIXEL_ADAPTIVE"
  | "FIXED_ROW_COUNT";

export type AuctionGridAnchor =
  | "PROFILE_OPEN"
  | "ROUND_NUMBER"
  | "FIXED_ORIGIN"
  | "INSTRUMENT_TICK_ORIGIN"
  | "MANUAL_ORIGIN";

export type AuctionValueAreaBasis =
  | "SELECTED_ENGINE"
  | "TOTAL_VOLUME"
  | "BUY_VOLUME"
  | "SELL_VOLUME"
  | "ABSOLUTE_VALUE"
  | "POSITIVE_SIDE"
  | "NEGATIVE_SIDE"
  | "TPO"
  | "HYBRID";

export type AuctionPocBasis =
  | "MAXIMUM_SELECTED_METRIC"
  | "MAXIMUM_ABSOLUTE_METRIC"
  | "MAXIMUM_POSITIVE_METRIC"
  | "MINIMUM_NEGATIVE_METRIC"
  | "MAXIMUM_TOTAL_VOLUME"
  | "MAXIMUM_TPO"
  | "HYBRID";

export type AuctionNodeSource =
  | "NET_CVD"
  | "ABSOLUTE_CVD"
  | "CVD_EFFICIENCY"
  | "BUY_VOLUME"
  | "SELL_VOLUME"
  | "DELTA_IMBALANCE"
  | "TPO"
  | "VOLUME"
  | "VOLATILITY"
  | "PARKINSON"
  | "HYBRID";

export type AuctionNodeMethod =
  | "PERCENTILE"
  | "LOCAL_MINIMA"
  | "PROMINENCE"
  | "Z_SCORE"
  | "ADAPTIVE_VALLEY"
  | "KERNEL_SMOOTHED_VALLEY"
  | "HYBRID";

export type AuctionDisplayStyle =
  | "HEATMAP_BLOCKS"
  | "HORIZONTAL_HISTOGRAM"
  | "PROFILE_COLUMNS"
  | "LETTERS_TPO"
  | "CONTOUR"
  | "NODES_ONLY"
  | "STRUCTURAL_ZONES"
  | "COMBINED";

export type AuctionPresentationMode =
  | "DYNAMIC_BLOCKS"
  | "AGGREGATE_HISTOGRAM"
  | "STRUCTURAL_NODES"
  | "DYNAMIC_KEY_LEVELS"
  | "DYNAMIC_AGGREGATE"
  | "MACRO_STRUCTURE";

export type AuctionVisualizationType = "AUCTION_PROFILE" | "CVD_FOOTPRINT" | "COMBINED";
export type AuctionProfileGeometry =
  | "BIDIRECTIONAL_DELTA"
  | "ABSOLUTE_DIRECTIONAL"
  | "POSITIVE_NEGATIVE_SPLIT"
  | "MIRRORED"
  | "SINGLE_SIDED_RIGHT"
  | "SINGLE_SIDED_LEFT"
  | "CENTERED";
export type AuctionProfilePlacement = "RIGHT" | "LEFT" | "OVERLAY" | "INSIDE_RANGE" | "DETACHED_PANEL";
export type AuctionProfileWidthMetric = "NET_CVD" | "ABSOLUTE_CVD" | "BUY_VOLUME" | "SELL_VOLUME" | "TOTAL_VOLUME" | "CVD_EFFICIENCY" | "IMBALANCE_RATIO" | "SELECTED_ENGINE";
export type AuctionProfileTimeSegments = "OFF" | "STACKED" | "LATEST_N" | "SESSION_BLOCKS" | "CUSTOM";
export type AuctionRowLabelMode = "ALWAYS" | "AUTO" | "STRONG_ONLY" | "HOVER" | "OFF";

export type AuctionBlockResolution =
  | "CHART_TIMEFRAME"
  | "1m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "4h"
  | "1d"
  | "ADAPTIVE"
  | "CUSTOM";

export type AuctionCellTextMode = "ALWAYS" | "AUTO" | "HOVER_ONLY" | "STRONG_ONLY" | "OFF";
export type AuctionCellTextSize = "AUTO" | "TINY" | "SMALL" | "NORMAL" | "LARGE" | "HUGE";
export type AuctionNormalizationMode = "PER_PROFILE" | "PER_TIME_BLOCK" | "ROLLING" | "ABSOLUTE_FIXED" | "PERCENTILE" | "LOGARITHMIC" | "SQUARE_ROOT" | "ROBUST_PERCENTILE";
export type AuctionColorScalingLifecycle = "DEVELOPING_GLOBAL" | "FROZEN_PER_BLOCK" | "FROZEN_ON_BLOCK_CLOSE" | "FROZEN_ON_PROFILE_LOCK" | "ROLLING";
export type AuctionCellBorder = "NONE" | "SUBTLE" | "STANDARD" | "HIGH_CONTRAST";
export type AuctionStructuralDetail = "MINIMAL" | "STANDARD" | "DETAILED" | "RESEARCH";
export type AuctionZoneExtensionMode = "PROFILE_ONLY" | "UNTIL_FIRST_TOUCH" | "UNTIL_MITIGATED" | "UNTIL_INVALIDATED" | "FIXED_N_BARS" | "EXTEND_RIGHT" | "FULL_CHART";

export type AuctionPalette =
  | "ORIGINAL"
  | "BLACK_TERMINAL_INSTITUTIONAL"
  | "THERMAL"
  | "BLOOD_RED"
  | "CVD_DIRECTIONAL"
  | "MONOCHROME"
  | "CUSTOM";

export type CanonicalAggressorSide = "BUY" | "SELL" | "UNKNOWN";
export type CanonicalAggressorSource =
  | "EXCHANGE_AGGRESSOR_FLAG"
  | "MAKER_SIDE_INVERSION"
  | "QUOTE_RULE"
  | "TICK_RULE"
  | "INFERRED";

export interface CanonicalTrade {
  venue: string;
  symbol: string;
  timestamp: number;
  tradeId: string;
  price: number;
  quantity: number;
  notional: number;
  aggressorSide: CanonicalAggressorSide;
  source: CanonicalAggressorSource;
}

export interface ProfileDataQuality {
  requestedStart: number;
  requestedEnd: number;
  exactTradeCoveragePercent: number;
  lowerTimeframeCoveragePercent: number;
  chartBarCoveragePercent: number;
  unknownAggressorPercent: number;
  missingIntervals: Array<{ start: number; end: number }>;
  quality: "EXACT" | "HIGH" | "MIXED" | "APPROXIMATE" | "INSUFFICIENT";
  sourceMix: AuctionDataSource[];
}

export interface HybridAuctionWeights {
  volume: number;
  cvd: number;
  cvdEfficiency: number;
  tpo: number;
  realizedVolatility: number;
  parkinsonVolatility: number;
  tradeCount: number;
  notional: number;
}

export interface NodeDetectionSettings {
  source: AuctionNodeSource;
  method: AuctionNodeMethod;
  sensitivityPercentile: number;
  neighborhood: number;
  prominence: number;
  minimumWidthRows: number;
  maximumGapRows: number;
  mergeContiguousRows: boolean;
  showLvns: boolean;
  showHvns: boolean;
}

export interface AuctionProfileRenderingSettings {
  displayStyle: AuctionDisplayStyle;
  presentationMode: AuctionPresentationMode;
  visualizationType: AuctionVisualizationType;
  profileGeometry: AuctionProfileGeometry;
  profilePlacement: AuctionProfilePlacement;
  profileWidthMetric: AuctionProfileWidthMetric;
  rowLabelMode: AuctionRowLabelMode;
  timeSegmentsMode: AuctionProfileTimeSegments;
  latestSegmentCount: number;
  palette: AuctionPalette;
  widthPercent: number;
  profileWidthAuto: boolean;
  opacity: number;
  brightness: number;
  showText: boolean;
  showKeyLevels: boolean;
  showNodeLabels: boolean;
  showValueArea: boolean;
  showInitialBalance: boolean;
  showMidpoint: boolean;
  showStructuralSr: boolean;
  showHistoricalExtensions: boolean;
  showOffChart: boolean;
  cellTextMode: AuctionCellTextMode;
  cellTextSize: AuctionCellTextSize;
  cellBorder: AuctionCellBorder;
  normalizationMode: AuctionNormalizationMode;
  colorScalingLifecycle: AuctionColorScalingLifecycle;
  robustLowerPercentile: number;
  robustUpperPercentile: number;
  absoluteFixedScale: number;
  maximumVisibleColumns: number;
  maximumVisibleRows: number;
  maximumVisibleLabels: number;
  structuralDetail: AuctionStructuralDetail;
  maximumVisibleLvns: number;
  maximumVisibleHvns: number;
  maximumVisibleStructuralZones: number;
  zoneExtensionMode: AuctionZoneExtensionMode;
  fixedExtensionBars: number;
  positiveColor: string;
  negativeColor: string;
  balancedColor: string;
  valueAreaColor: string;
  pocColor: string;
  lvnColor: string;
  hvnColor: string;
}

export interface AuctionProfileSettings {
  schemaVersion: 1;
  implementationMode: AuctionImplementationMode;
  scopeMode: AuctionScopeMode;
  calculationEngine: AuctionCalculationEngine;
  cvdMetric: AuctionCvdMetric;
  dataSource: AuctionDataSource;
  fallbackSource: Exclude<AuctionDataSource, "HYBRID">;
  priceAllocation: AuctionPriceAllocation;
  lookbackBars: number;
  blockResolution: AuctionBlockResolution;
  customBlockMinutes: number;
  updateDevelopingBlock: boolean;
  fixedStartTime?: number;
  fixedEndTime?: number;
  visibleStartTime?: number;
  visibleEndTime?: number;
  compositeLocked: boolean;
  periodicity: "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "CUSTOM_BARS" | "CUSTOM_HOURS";
  periodicBars: number;
  periodicHours: number;
  sessionTemplate: "UTC_DAY" | "ASIA" | "LONDON" | "NEW_YORK" | "CUSTOM" | "EXCHANGE_DAY" | "WEEK" | "MONTH";
  sessionTimezone: string;
  customSessionStartMinute: number;
  customSessionEndMinute: number;
  initialBalanceMinutes: number;
  lowerTimeframe: Timeframe;
  rowSizingMode: AuctionRowSizingMode;
  ticksPerRow: number;
  rowSizePrice: number;
  basisPointsPerRow: number;
  atrFraction: number;
  targetRows: number;
  maximumRows: number;
  maximumTimeBlocks: number;
  gridAnchor: AuctionGridAnchor;
  manualGridOrigin?: number;
  valueAreaFraction: number;
  valueAreaBasis: AuctionValueAreaBasis;
  pocBasis: AuctionPocBasis;
  tpoBracketMinutes: number;
  volatilityAnnualization: "NONE" | "CRYPTO_365" | "CALENDAR_365" | "CUSTOM";
  annualizationPeriods: number;
  unknownSideHandling: "SEPARATE" | "EXCLUDE_DIRECTIONAL";
  nodeDetection: NodeDetectionSettings;
  hybridWeights: HybridAuctionWeights;
  rendering: AuctionProfileRenderingSettings;
  offChartMetrics: Array<"CVD_DELTA" | "CVD_ACCELERATION" | "CVD_EFFICIENCY" | "CVD_PERSISTENCE" | "BUY_SELL_IMBALANCE" | "POC_MIGRATION" | "VALUE_MIGRATION" | "VOLATILITY" | "PARKINSON_VOLATILITY" | "PROFILE_ENTROPY" | "NODE_STRENGTH">;
  diagnosticsVisible: boolean;
  settingsVersion: string;
}

export interface AuctionProfileGrid {
  origin: number;
  rowSize: number;
  rowCount: number;
  priceLow: number;
  priceHigh: number;
  tickSize: number;
  anchor: AuctionGridAnchor;
  stable: boolean;
}

export interface AuctionProfileRow {
  index: number;
  low: number;
  high: number;
  center: number;
  value: number;
  buyQuantity: number;
  sellQuantity: number;
  unknownQuantity: number;
  totalQuantity: number;
  buyNotional: number;
  sellNotional: number;
  unknownNotional: number;
  tradeCount: number;
  averageTradeSize: number;
  maximumTradeSize: number;
  tpoCount: number;
  realizedVariance: number;
  parkinsonVariance: number;
  garmanKlassVariance: number;
  rangeExpansion: number;
  cvdEfficiency: number;
  cvdPersistence: number;
  hybridScore: number;
  inValueArea: boolean;
}

export interface AuctionTimeBlock {
  id: string;
  index: number;
  startTime: number;
  endTime: number;
  isDeveloping: boolean;
  isFinalized: boolean;
}

export interface AuctionBlockCell {
  id: string;
  rowIndex: number;
  blockIndex: number;
  priceLow: number;
  priceHigh: number;
  startTime: number;
  endTime: number;
  rawValue: number;
  normalizedValue: number;
  buyValue: number;
  sellValue: number;
  unknownValue: number;
  totalValue: number;
  notional: number;
  tradeCount: number;
  tpoCount: number;
  realizedVariance: number;
  garmanKlassVariance: number;
  parkinsonVariance: number;
  rangeExpansion: number;
  sign: -1 | 0 | 1;
  isDeveloping: boolean;
  isFinalized: boolean;
  dataQuality: "EXACT_TRADES" | "LOWER_TF_APPROXIMATION" | "CHART_BAR_APPROXIMATION";
}

export interface AuctionBlockMatrix {
  rows: AuctionProfileRow[];
  blocks: AuctionTimeBlock[];
  cells: AuctionBlockCell[];
  blockDurationSeconds: number;
  normalizationLower: number;
  normalizationUpper: number;
  normalizationMode: AuctionNormalizationMode;
  sourceCellCount: number;
  matrixVersion: string;
}

export interface AuctionNodeZone {
  id: string;
  type: "LVN" | "HVN";
  classification:
    | "CVD_LVN"
    | "CVD_HVN"
    | "BUY_DOMINANT_HVN"
    | "SELL_DOMINANT_HVN"
    | "BALANCED_ACCEPTANCE_NODE"
    | "DIRECTIONAL_INEFFICIENCY"
    | "VOLATILITY_NODE"
    | "TPO_SINGLE_PRINT_ZONE"
    | "HYBRID_STRUCTURAL_NODE";
  sourceEngine: string;
  low: number;
  high: number;
  center: number;
  weightedCenter: number;
  componentRowIndices: number[];
  widthRows: number;
  rawScore: number;
  normalizedScore: number;
  prominence: number;
  createdAt: number;
  profileVersion: string;
  status: "ACTIVE" | "TESTED" | "MITIGATED" | "ACCEPTED" | "INVALIDATED";
}

export interface AuctionProfileKeyLevels {
  poc: number | null;
  vah: number | null;
  val: number | null;
  midpoint: number | null;
  ibHigh: number | null;
  ibLow: number | null;
  cvdPoc: number | null;
  buyPoc: number | null;
  sellPoc: number | null;
  tpoPoc: number | null;
  volatilityPoc: number | null;
  dominantLvn: number | null;
  dominantHvn: number | null;
}

export interface AuctionOffChartPoint {
  time: number;
  cvdDelta: number;
  cvdAcceleration: number;
  cvdEfficiency: number;
  cvdPersistence: number;
  imbalance: number;
  realizedVolatility: number;
  parkinsonVolatility: number;
}

export interface AuctionProfileDiagnostics {
  profileHash: string;
  settingsHash: string;
  dataHash: string;
  calculationMode: AuctionImplementationMode;
  scope: AuctionScopeMode;
  engine: AuctionCalculationEngine;
  lookback: number;
  rows: number;
  timeBlocks: number;
  buildDurationMs: number;
  incrementalUpdateDurationMs: number;
  memoryEstimateBytes: number;
  exactCoveragePercent: number;
  fallbackCoveragePercent: number;
  nodeCount: number;
  viewportAffectsCalculation: boolean;
  warnings: string[];
}

export interface AuctionScopeWindow {
  id: string;
  start: number;
  end: number;
  startBarIndex: number;
  endBarIndex: number;
  locked: boolean;
  viewportDependent: boolean;
  label: string;
}

export interface AuctionProfileSnapshot {
  schemaVersion: 1;
  profileId: string;
  profileVersion: string;
  engineVersion: string;
  symbol: string;
  venue: string;
  timeframe: Timeframe;
  engine: AuctionCalculationEngine;
  implementationMode: AuctionImplementationMode;
  scope: AuctionScopeMode;
  range: { start: number; end: number; loadedBars: number; requestedBars: number };
  grid: AuctionProfileGrid;
  rows: AuctionProfileRow[];
  matrix: AuctionBlockMatrix;
  nodes: AuctionNodeZone[];
  keyLevels: AuctionProfileKeyLevels;
  offChart: AuctionOffChartPoint[];
  quality: ProfileDataQuality;
  diagnostics: AuctionProfileDiagnostics;
  createdAt: number;
}

export interface AuctionProfileBundle {
  active: AuctionProfileSnapshot | null;
  composites: AuctionProfileSnapshot[];
  generation: number;
  loading: boolean;
  progress: number;
  error: string | null;
}

export interface AuctionProfileCalculationInput {
  venue: ExchangeId;
  symbol: string;
  timeframe: Timeframe;
  metadata?: SymbolMetadata;
  bars: Candle[];
  lowerTimeframeBars?: Candle[];
  trades: CanonicalTrade[];
  settings: AuctionProfileSettings;
  visibleRange?: { start: number; end: number };
  sourceRevision: string;
  now?: number;
}

export interface AuctionIncrementalUpdate {
  trades?: CanonicalTrade[];
  bars?: Candle[];
  sourceRevision: string;
}

export interface CanonicalCvdQuery {
  venue: string;
  symbol: string;
  start: number;
  end: number;
}

export interface CanonicalCvdSeriesPoint {
  time: number;
  buyQuantity: number;
  sellQuantity: number;
  unknownQuantity: number;
  delta: number;
  cumulativeDelta: number;
}

export interface CanonicalCVDService {
  ingest(trades: readonly CanonicalTrade[]): number;
  getTrades(query: CanonicalCvdQuery): CanonicalTrade[];
  getDeltaSeries(query: CanonicalCvdQuery): CanonicalCvdSeriesPoint[];
  coverage(query: CanonicalCvdQuery): Pick<ProfileDataQuality, "exactTradeCoveragePercent" | "unknownAggressorPercent">;
  clear(venue?: string, symbol?: string): void;
}

export function canonicalTradeFromTick(
  tick: TradeTick,
  source: CanonicalAggressorSource = "INFERRED"
): CanonicalTrade {
  const price = Number.isFinite(tick.price) ? tick.price : 0;
  const quantity = Number.isFinite(tick.quantity) ? Math.max(0, tick.quantity) : 0;
  return {
    venue: tick.exchange,
    symbol: tick.symbol,
    timestamp: tick.time,
    tradeId: tick.tradeId,
    price,
    quantity,
    notional: price * quantity,

    aggressorSide: tick.side === "buy" ? "BUY" : tick.side === "sell" ? "SELL" : "UNKNOWN",
    source
  };
}
