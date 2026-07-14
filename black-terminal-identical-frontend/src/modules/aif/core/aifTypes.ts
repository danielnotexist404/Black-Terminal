import type { Candle } from "../../../chart-engine/types";
import type { MarketSymbol, Timeframe } from "../../../market-data/types";
import type { StructuralZoneMethod } from "../../../profile-core/structuralZones";

export type AifProfileType = "volume" | "delta" | "tpo" | "volatility" | "pressure" | "absorption";
export type AifImplementedProfileType = Exclude<AifProfileType, "absorption">;
export type AifBucketMode = "fixed-rows" | "fixed-price" | "tick" | "percentage" | "logarithmic" | "atr-normalized" | "adaptive";
export type AifReadiness = "implemented" | "experimental" | "research-only" | "blocked-data" | "disabled";
export type AifDataQuality = "exact" | "estimated" | "partial" | "blocked-data";
export type AifNodeType = "hvn" | "lvn" | "positive-delta" | "negative-delta" | "balance" | "compression" | "expansion" | "buy-pressure" | "sell-pressure";
export type AifNodeStatus = "untested" | "approaching" | "first-test" | "rejected" | "accepted" | "broken" | "reclaimed" | "invalidated";
export type AifLvnLifecycle = "detected" | "qualified" | "projected" | "approaching" | "first-test" | "rejected" | "accepted" | "retest" | "second-rejection" | "chob-candidate" | "chob-confirmed" | "broken" | "reclaimed" | "invalidated" | "expired";
export type AifChobState = "UNTESTED" | "FIRST_TEST" | "FIRST_REJECTION" | "INTERMEDIATE_SWING" | "RETEST" | "SECOND_REJECTION" | "CHOB_CANDIDATE" | "CHOB_CONFIRMED" | "ACCEPTED" | "BROKEN" | "INVALIDATED" | "EXPIRED" | "INSUFFICIENT_SWING" | "SECOND_TEST_FAILED";

export type AifSettings = {
  version: number;
  primaryProfile: AifImplementedProfileType;
  secondaryProfile: "off" | AifImplementedProfileType;
  profilePlacement: "right" | "left" | "both" | "overlay";
  profileHorizontalOffset: number;
  profileNormalization: "raw" | "percent-max" | "percentile" | "z-score" | "robust-z-score" | "log";
  comparisonMode: "shared-domain" | "independent";
  lookbackBars: number;
  rangeMode: "lookback" | "visible" | "anchored";
  anchorTime: number | null;
  bucketMode: AifBucketMode;
  rowCount: number;
  fixedPriceSize: number;
  percentageBucket: number;
  logarithmic: boolean;
  sourceResolution: "best" | "chart" | "lower-timeframe";
  showPoc: boolean;
  showValueArea: boolean;
  valueAreaPercent: number;
  pocMode: "fixed" | "developing" | "both";
  showVah: boolean;
  showVal: boolean;
  valueAreaColor: string;
  valueAreaOpacity: number;
  showNodes: boolean;
  showFutureLvns: boolean;
  showSupportResistance: boolean;
  extendLevels: boolean;
  nodeSensitivity: number;
  nodeMethod: StructuralZoneMethod;
  lvnPercentileThreshold: number;
  lvnRelativePocThreshold: number;
  lvnRobustZThreshold: number;
  lvnNeighborWindow: number;
  lvnMinimumContiguousRows: number;
  lvnInternalGapRows: number;
  lvnMinimumWidthRows: number;
  lvnMaximumWidthRows: number;
  lvnMergeDistanceRows: number;
  lvnMinimumContrast: number;
  lvnMinimumStrength: number;
  lvnEdgeExclusionRows: number;
  showHvns: boolean;
  showLvns: boolean;
  showMinorNodes: boolean;
  futureLvnPolicy: "major-untested" | "untested-first-test" | "all-qualified" | "active-lifecycle";
  futureLvnMinimumStability: number;
  futureLvnMinimumContrast: number;
  futureLvnMinimumConfidence: number;
  futureLvnMaxAbove: number;
  futureLvnMaxBelow: number;
  futureLvnMaxTotal: number;
  futureLvnMinimumScore: number;
  futureLvnZoneOpacity: number;
  futureLvnBoundaryOpacity: number;
  futureLvnShowCenter: boolean;
  futureLvnShowMinimumActivity: boolean;
  futureLvnShowScore: boolean;
  futureLvnShowLookback: boolean;
  futureLvnShowState: boolean;
  futureLvnKeepTested: boolean;
  futureLvnKeepInvalidated: "off" | "faded" | "timeline-only";
  showTimeline: boolean;
  timelineHeight: number;
  minimumConfidence: number;
  timelineHorizon: number;
  enableImmConfirmation: boolean;
  minimumWallPersistence: number;
  showLiquidityConfluence: boolean;
  opacity: number;
  labelDensity: "low" | "medium" | "high";
  profileWidth: number;
  zoneIntensity: number;
  showDataQuality: boolean;
  showStatisticsCard: boolean;
  showLabels: boolean;
  calculationMode: "balanced" | "performance" | "maximum-detail";
  maximumVisibleNodes: number;
  maximumTimelineEvents: number;
  multiLookbackStability: "off" | "major" | "all";
  resolutionStability: "off" | "major" | "all";
  volatilityEstimator: "true-range" | "log-return-variance" | "realized" | "range-expansion" | "atr-normalized" | "parkinson" | "composite";
  volatilityAllocation: "uniform-range" | "body-weighted" | "close-location" | "lower-timeframe-path";
  tpoPeriodMinutes: number;
};

export type AifLvnZone = {
  id: string;
  venue: string;
  symbol: string;
  timeframe: string;
  profileType: AifProfileType;
  low: number;
  high: number;
  center: number;
  weightedCenter: number;
  minimumActivityPrice: number;
  widthAbsolute: number;
  widthPercent: number;
  widthTicks: number;
  rawActivity: number;
  normalizedActivity: number;
  activityPercentile: number;
  neighborContrast: number;
  valleyDepth: number;
  strength: number;
  stability: number;
  confidence: number;
  score: number;
  requestedLookback: number;
  effectiveLookback: number;
  sourceResolution: string;
  dataQuality: AifDataQuality;
  detectionMethod: StructuralZoneMethod;
  algorithmVersion: "hybrid-structural-v1";
  firstObserved: number;
  lastObserved: number;
  touchCount: number;
  rejectionCount: number;
  acceptanceCount: number;
  state: AifLvnLifecycle;
  projected: boolean;
  invalidated: boolean;
  provenance: AifProvenance;
};

export type AifCoverage = {
  requestedLookbackBars: number;
  effectiveLookbackBars: number;
  availableBars: number;
  calculationStart: number | null;
  calculationEnd: number | null;
  wasClamped: boolean;
  clampReason: string | null;
  missingIntervals: number;
  coveragePct: number;
};

export type AifProvenance = AifCoverage & {
  venue: string;
  symbol: string;
  marketType: string;
  timeframe: string;
  sourceType: "classified-trades" | "trades" | "one-second-candles" | "lower-timeframe-candles" | "chart-candles";
  sourceResolution: string;
  profileType: AifProfileType;
  profileVersion: string;
  bucketMethod: AifBucketMode;
  allocationMethod: string;
  quality: AifDataQuality;
  engineVersion: string;
  calculatedAt: number;
};

export type AifAuctionDomain = {
  domainMin: number;
  domainMax: number;
  currentPrice: number;
  bucketMode: AifBucketMode;
  bucketCount: number;
  bucketSize: number;
  logarithmic: boolean;
  rangeStart: number;
  rangeEnd: number;
  requestedLookbackBars: number;
  effectiveLookbackBars: number;
  currentProfileType: AifProfileType;
  sourceResolution: string;
  boundaries: number[];
};

export type AifProfileRow = {
  index: number;
  low: number;
  high: number;
  center: number;
  value: number;
  positive: number;
  negative: number;
  normalized: number;
  valueArea: boolean;
};

export type AifProfileResult = {
  profileType: AifProfileType;
  rows: AifProfileRow[];
  poc: number | null;
  vah: number | null;
  val: number | null;
  total: number;
  valueAreaPercent: number;
  quality: AifDataQuality;
  allocationMethod: string;
  statistics: Record<string, number | string | boolean | null>;
  provenance: AifProvenance;
};

export type AifAuctionNode = {
  id: string;
  profileType: AifProfileType;
  nodeType: AifNodeType;
  low: number;
  high: number;
  center: number;
  weightedCenter: number;
  rawStrength: number;
  normalizedStrength: number;
  confidence: number;
  stability: number;
  firstObserved: number;
  lastObserved: number;
  sourceRange: { start: number; end: number };
  status: AifNodeStatus;
  touchCount: number;
  tested: boolean;
  provenance: AifProvenance;
};

export type AifProfileConfluence = {
  primaryNodeId: string;
  secondaryNodeId: string;
  overlapPercent: number;
  distance: number;
  relationship: string;
  confidence: number;
};

export type AifEventType = "profile-calculated" | "node-created" | "node-strengthened" | "node-weakened" | "node-tested" | "node-rejected" | "node-accepted" | "node-broken" | "node-reclaimed" | "node-invalidated" | "lvn-zone-created" | "lvn-zone-projected" | "lvn-zone-first-test" | "lvn-zone-rejected" | "lvn-zone-accepted" | "lvn-zone-invalidated" | "poc-migrated" | "value-area-shifted" | "volatility-compression-detected" | "volatility-expansion-detected" | "imm-wall-confluence" | "absorption-candidate" | "chob-candidate" | "chob-confirmed";

export type AifTimelineEvent = {
  id: string;
  time: number;
  type: AifEventType;
  price: number | null;
  confidence: number;
  source: string;
  direction?: "bullish" | "bearish" | "neutral";
  experimental?: boolean;
  nodeId?: string;
  details: Record<string, string | number | boolean | null>;
  provenance: AifProvenance;
};

export type AifAuctionStateSummary = {
  profile: string;
  nearestStructure: string;
  state: string;
  rejection: number;
  acceptance: number;
  imm: string;
  chob: AifChobState;
  dataQuality: string;
};

export type AifRenderModel = {
  currentPrice: number;
  profileHistogram: AifProfileResult;
  primaryNodes: AifAuctionNode[];
  secondaryProfile?: AifProfileResult;
  secondaryNodes: AifAuctionNode[];
  confluenceMarkers: AifProfileConfluence[];
  supportResistanceZones: AifAuctionNode[];
  lvnZones: AifLvnZone[];
  projectedLvns: AifLvnZone[];
  activeNode: AifAuctionNode | null;
  auctionStateSummary: AifAuctionStateSummary;
  timelineEvents: AifTimelineEvent[];
  provenance: AifProvenance;
  renderVersion: string;
  calculationMs: number;
  timings: {
    normalizationMs: number;
    profileMs: number;
    nodeAndStabilityMs: number;
    eventMs: number;
    renderModelMs: number;
  };
  cacheState: "hit" | "miss";
};

export type AifCalculationRequest = {
  id: number;
  generation: number;
  marketSymbol: MarketSymbol;
  timeframe: Timeframe;
  candles: Candle[];
  currentPrice: number;
  settings: AifSettings;
  sourceVersion: string;
};

export type AifProgressStage = "LOADING HISTORY" | "NORMALIZING" | "CALCULATING PROFILE" | "EXTRACTING NODES" | "BUILDING TIMELINE" | "READY";

export type AifNodeInteractionRecord = {
  nodeId: string;
  sequence: number;
  testTime: number;
  rejection: number;
  acceptance: number;
  profileConfluence: number;
  immContext: "confirmed" | "divergent" | "unavailable";
  regime: string;
};

export type AifChobEventRecord = {
  nodeId: string;
  state: AifChobState;
  time: number;
  confidence: number;
  swingPrice: number | null;
  provenance: AifProvenance;
};

export type AifOutcomeRecord = {
  eventId: string;
  laterMfe: number | null;
  laterMae: number | null;
  durationSeconds: number | null;
  resolvedAt: number | null;
};
