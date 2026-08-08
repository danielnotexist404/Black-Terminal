import type {
  BclifModelAuthority,
  LiquidationCohortEngineState,
  LiquidationDataCertainty,
  LiquidationInstrumentRules,
  LiquidationMarketFrame
} from "../../src/modules/liquidation-field/core/types.ts";

export const BCLIF_COLLECTOR_SCHEMA_VERSION = 1 as const;
export const BCLIF_TILE_SCHEMA_VERSION = 2 as const;
export const BCLIF_DEFAULT_NODE_ID = "LIQUIDATION_INTELLIGENCE_NODE_01";
export const BCLIF_OBJECT_BUCKET = "bclif-field-chunks";

export type BclifCollectorEnvironment = "PRODUCTION" | "STAGING" | "DEVELOPMENT";
export type BclifCollectorStatus =
  | "STARTING"
  | "SYNCING"
  | "BACKFILLING"
  | "LIVE"
  | "DEGRADED"
  | "DRAINING"
  | "OFFLINE";

export type BclifCollectorPhase =
  | "PROCESS_STARTING"
  | "CONFIG_VALIDATING"
  | "DATABASE_CONNECTING"
  | "SCHEMA_VALIDATING"
  | "STORAGE_CONNECTING"
  | "CHECKPOINT_LOADING"
  | "STATE_REPLAYING"
  | "SOURCE_BACKFILLING"
  | "SOURCE_CONNECTING"
  | "SOURCE_SYNCHRONIZING"
  | "LIVE"
  | "DRAINING"
  | "STOPPED"
  | "CONFIGURATION_ERROR"
  | "SCHEMA_MISMATCH"
  | "STORAGE_UNAVAILABLE"
  | "CHECKPOINT_CORRUPT"
  | "MODEL_VERSION_UNSUPPORTED"
  | "FATAL";

export type BclifDegradedState =
  | "TRADES_STALE"
  | "LIQUIDATIONS_STALE"
  | "ORDERBOOK_STALE"
  | "OI_STALE"
  | "STORAGE_DEGRADED"
  | "CHECKPOINT_DEGRADED"
  | "PARTIAL_COVERAGE";

export type BclifPersistedLifecycleState = BclifCollectorPhase | BclifDegradedState;

export interface BclifCollectorNode {
  nodeId: string;
  instanceId: string;
  environment: BclifCollectorEnvironment;
  region: string;
  deploymentCommit: string;
  imageDigest: string;
  modelVersion: string;
  startedAt: number;
  lastHeartbeatAt: number;
  status: BclifCollectorStatus;
  fencingEpoch: number;
}

export interface BclifWriterFence {
  nodeId: string;
  instanceId: string;
  fencingEpoch: number;
}

export type BclifCanonicalEventKind =
  | "TRADE"
  | "LIQUIDATION"
  | "OPEN_INTEREST"
  | "FUNDING"
  | "MARK_INDEX"
  | "POSITION_RATIO"
  | "INSTRUMENT_INFO"
  | "RISK_TIER"
  | "BOOK_FRAME"
  | "SOURCE_GAP";

export interface BclifCanonicalEvent<T = unknown> {
  schemaVersion: typeof BCLIF_COLLECTOR_SCHEMA_VERSION;
  eventId: string;
  dedupKey: string;
  kind: BclifCanonicalEventKind;
  venue: "BYBIT";
  symbol: string;
  marketKind: "linear_perpetual";
  exchangeTimestamp: number;
  receivedTimestamp: number;
  sourceSequence: string | null;
  sourceVersion: string;
  certainty: "OBSERVED";
  payload: T;
}

export interface PersistentPublicTrade {
  venue: "BYBIT";
  symbol: string;
  tradeId: string;
  exchangeTimestamp: number;
  receivedTimestamp: number;
  sequence: string | null;
  price: number;
  quantity: number;
  notional: number;
  aggressorSide: "BUY" | "SELL" | "UNKNOWN";
  certainty: "OBSERVED";
  sourceVersion: string;
}

export interface PersistentLiquidationEvent {
  id: string;
  venue: "BYBIT";
  symbol: string;
  exchangeTimestamp: number;
  receivedTimestamp: number;
  liquidatedSide: "LONG" | "SHORT";
  bankruptcyPrice: number;
  quantity: number;
  estimatedNotional: number;
  certainty: "OBSERVED";
  sourceVersion: string;
}

export interface BclifOpenInterestPoint {
  timestamp: number;
  receivedTimestamp: number;
  availableAt: number;
  availabilityMode: "LIVE_OBSERVATION" | "OFFICIAL_HISTORICAL_BACKFILL";
  interval: string;
  singleSideOpenInterest: number;
  bothSidesOpenInterest: number | null;
  unit: "BASE" | "QUOTE";
  sourceVersion: string;
}

export interface BclifBookLevel {
  price: number;
  quantity: number;
}

export interface BclifBookFrame {
  venue: "BYBIT";
  symbol: string;
  exchangeTimestamp: number;
  receivedTimestamp: number;
  updateId: string;
  crossSequence: string | null;
  bids: BclifBookLevel[];
  asks: BclifBookLevel[];
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spreadBps: number;
  bidNotional: number;
  askNotional: number;
  certainty: "OBSERVED";
  sourceVersion: string;
}

export interface BclifSourceFreshness {
  tradesAgeMs: number | null;
  liquidationsAgeMs: number | null;
  orderbookAgeMs: number | null;
  openInterestAgeMs: number | null;
  fundingAgeMs: number | null;
  markPriceAgeMs: number | null;
  riskTierAgeMs: number | null;
}

export interface BclifFrameEnvelope {
  frameStart: number;
  frameEnd: number;
  sourceCutoffTimestamp: number;
  generatedAt: number;
  authority: BclifModelAuthority;
  freshness: BclifSourceFreshness;
  frame: LiquidationMarketFrame;
}

export interface BclifSourceOffset {
  sourceId: string;
  venue: "BYBIT";
  symbol: string;
  source: string;
  sourceVersion: string;
  lastExchangeTimestamp: number | null;
  lastReceivedTimestamp: number | null;
  lastSequence: string | null;
  lastEventId: string | null;
  continuityStartedAt: number | null;
  continuityState: Exclude<LiquidationDataCertainty, "UNAVAILABLE">;
  gapCount: number;
  reconnectCount: number;
  safeMetadata: Record<string, unknown>;
  updatedAt: number;
}

export interface BclifCausalNormalizerState {
  schemaVersion: 1;
  trailingColumns: number;
  recentLogColumns: number[][];
  lastLow: number;
  lastHigh: number;
}

export interface BclifConfirmedIntensityState {
  schemaVersion: 1;
  maximumSamples: number;
  recentLogNotionals: number[];
  lastScale: number;
  lastProcessedKnownAt: number | null;
}

export interface BclifActiveTileCheckpoint {
  rows: number;
  minPrice: number;
  priceStep: number;
  timeStepMs: number;
  columns: Array<{
    timestamp: number;
    longExposure: number[];
    shortExposure: number[];
    combinedExposure: number[];
    confidence: number[];
    validity: number[];
    confirmedIntensity: number[];
    confirmedNotional: number[];
    confirmedCount: number[];
    causalNormalizationLow: number;
    causalNormalizationHigh: number;
  }>;
}

export interface BclifCohortCheckpointState {
  schemaVersion: 1;
  modelVersion: string;
  sourceVersion: string;
  venue: "BYBIT";
  symbol: string;
  timestamp: number;
  sourceCutoffTimestamp: number;
  cohortState: LiquidationCohortEngineState;
  normalizerState: BclifCausalNormalizerState;
  confirmedIntensityState?: BclifConfirmedIntensityState;
  instrumentRules: LiquidationInstrumentRules;
  /** Last live OI observation whose delta was applied to the cohort engine. */
  lastConsumedOpenInterest: BclifOpenInterestPoint | null;
  sourceOffsets: BclifSourceOffset[];
  processedEventIds: string[];
  activeFrame: BclifFrameEnvelope | null;
  activeTile?: BclifActiveTileCheckpoint | null;
  coverageIntervals?: Partial<Record<"TRADE" | "LIQUIDATION" | "OPEN_INTEREST" | "BOOK_FRAME" | "FUNDING", Array<{ start: number; end: number }>>>;
}

export interface BclifCohortCheckpointMetadata {
  checkpointId: string;
  venue: "BYBIT";
  symbol: string;
  modelVersion: string;
  sourceVersion: string;
  timestamp: number;
  sourceCutoffTimestamp: number;
  cohortCount: number;
  particleCount: number;
  serializedStateLocation: string;
  checksum: string;
  compressedBytes: number;
  createdByNodeId: string;
  reason: "INTERVAL" | "GRACEFUL_SHUTDOWN" | "BACKFILL_COMPLETE" | "MODEL_MIGRATION";
}

export type BclifTileHorizon = "6H" | "12H" | "1D" | "3D" | "1W" | "3W" | "1M" | "CUSTOM";

export interface BclifTileChannels {
  timestamps: Float64Array;
  longExposure: Float32Array;
  shortExposure: Float32Array;
  combinedExposure: Float32Array;
  confidence: Uint8Array;
  validity: Uint8Array;
  confirmedIntensity: Uint8Array;
  confirmedNotional: Float32Array;
  confirmedCount: Uint16Array;
  causalNormalizationLow: Float32Array;
  causalNormalizationHigh: Float32Array;
  longExposureScale?: Float32Array;
  shortExposureScale?: Float32Array;
  combinedExposureScale?: Float32Array;
}

export interface BclifTileInput {
  tileId: string;
  tileVersion?: number;
  venue: "BYBIT";
  symbol: string;
  marketKind: "linear_perpetual";
  horizon: BclifTileHorizon;
  authority: "PERSISTENT_NODE" | "REPLAY" | "TEST_FIXTURE";
  modelVersion: string;
  sourceVersion: string;
  coverageQuality: "EXCELLENT" | "HIGH" | "MIXED" | "LOW" | "INSUFFICIENT";
  startTime: number;
  endTime: number;
  sourceCutoffTimestamp: number;
  minPrice: number;
  maxPrice: number;
  timeStepMs: number;
  priceStep: number;
  columns: number;
  rows: number;
  createdAt: number;
  channels: BclifTileChannels;
}

export interface BclifDecodedTile extends BclifTileInput {
  schemaVersion: typeof BCLIF_TILE_SCHEMA_VERSION;
  tileVersion: number;
  payloadChecksum: string;
}

export interface BclifTileMetadata {
  tileId: string;
  venue: "BYBIT";
  symbol: string;
  horizon: BclifTileHorizon;
  startTime: number;
  endTime: number;
  minPrice: number;
  maxPrice: number;
  timeStepMs: number;
  priceStep: number;
  columns: number;
  rows: number;
  modelVersion: string;
  schemaVersion: number;
  objectPath: string;
  checksum: string;
  sourceCutoffTimestamp: number;
  coverageQuality: string;
  compressedBytes: number;
  createdAt: number;
  supersededAt?: number;
}

export interface BclifCoverageGap {
  start: number;
  end: number;
  missingSources: string[];
}

export type BclifCoverageSourceName = "TRADE" | "LIQUIDATION" | "OPEN_INTEREST" | "BOOK_FRAME" | "FUNDING";
export interface BclifCoverageInterval { start: number; end: number; }

export interface BclifPersistentCoverage {
  venue: "BYBIT";
  symbol: string;
  horizon: BclifTileHorizon;
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
  modelAuthority: BclifModelAuthority;
  sourceCutoffTimestamp: number | null;
  quality: "EXCELLENT" | "HIGH" | "MIXED" | "LOW" | "INSUFFICIENT";
  gaps: BclifCoverageGap[];
  /** Durable source-continuity ledger used to derive any requested sub-window. */
  sourceIntervals: Record<BclifCoverageSourceName, BclifCoverageInterval[]>;
}

export interface BclifSourceHealth {
  source: string;
  initialized: boolean;
  connected: boolean;
  lastMessageAt: number | null;
  reconnects: number;
  gaps: number;
  deduplicated: number;
  error: string | null;
  certainty: LiquidationDataCertainty;
}
