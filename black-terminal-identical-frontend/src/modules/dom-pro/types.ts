import type { MarketSymbol, OrderBookSnapshot, TickerSnapshot, TradeTick } from "../../market-data/types";

export type DomMode = "micro" | "scalper" | "standard" | "swing" | "macro" | "custom";
export type DomVisibleRange = "auto" | "0.25" | "0.5" | "1" | "2" | "5" | "custom";
export type DomProfileSource = "session" | "visible-range" | "rolling-window";

export type DomLevel = {
  price: number;
  quantity: number;
  side: "bid" | "ask";
};

export type DomBucket = {
  price: number;
  low: number;
  high: number;
  bidSize: number;
  askSize: number;
  totalSize: number;
  bidDelta: number;
  askDelta: number;
  heat: number;
  isBestBid: boolean;
  isBestAsk: boolean;
  isCurrentPrice: boolean;
};

export type VolumeProfileNode = {
  price: number;
  volume: number;
  kind: "poc" | "hvn" | "lvn" | "normal";
};

export type WallDetection = {
  id: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  score: number;
  distancePct: number;
  persistenceMs: number;
  state: "added" | "persisting" | "removed";
};

export type LiquidityDelta = {
  price: number;
  bidAdded: number;
  askAdded: number;
  bidRemoved: number;
  askRemoved: number;
  net: number;
};

export type AbsorptionSignal = {
  detected: boolean;
  side: "bid" | "ask" | "none";
  price: number | null;
  confidence: number;
  label: string;
};

export type IcebergEstimate = {
  estimatedCount: number;
  probability: "low" | "medium" | "high";
  score: number;
};

export type DomMetrics = {
  orderBookImbalance: number;
  depthImbalance: number;
  liquidityScore: number;
  largeTradesLastMinute: number;
  bidStacked: number;
  askStacked: number;
  bidPulled: number;
  askPulled: number;
  updateRate: number;
  latencyMs: number;
};

export type DomRenderStats = {
  updateRate: number;
  renderFps: number;
  fpsCap: number;
  visibleBuckets: number;
  bucketSize: number;
  droppedFrames: number;
  lastRenderMs: number;
  memoryEstimateKb: number;
  subscriptionCount: number;
};

export type DomHeatmapFrame = {
  time: number;
  cells: Array<{ price: number; side: "bid" | "ask"; intensity: number }>;
};

export type AggregatedDomSnapshot = {
  marketSymbol: MarketSymbol;
  sourceBook: OrderBookSnapshot | null;
  ticker: TickerSnapshot | null;
  trades: TradeTick[];
  buckets: DomBucket[];
  bids: DomBucket[];
  asks: DomBucket[];
  volumeProfile: VolumeProfileNode[];
  heatmap: DomHeatmapFrame[];
  walls: WallDetection[];
  liquidityDelta: LiquidityDelta[];
  absorption: AbsorptionSignal;
  iceberg: IcebergEstimate;
  metrics: DomMetrics;
  renderStats: DomRenderStats;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  lastPrice: number | null;
  spread: number | null;
  status: "awaiting-book" | "live" | "rest" | "degraded";
  statusMessage: string;
  generatedAt: number;
};

export type DomSettings = {
  workspaceId: string;
  symbolKey: string;
  mode: DomMode;
  bucketMultiplier: 1 | 5 | 10 | 25 | 50 | 100 | 250 | 500 | 1000 | "custom";
  customBucketSize: number;
  visibleRange: DomVisibleRange;
  customVisibleRangePct: number;
  fpsCap: number;
  showVolumeProfile: boolean;
  showHeatmap: boolean;
  showWallDetection: boolean;
  showCvd: boolean;
  showExecutionPanel: boolean;
  showDiagnostics: boolean;
  colorIntensity: number;
  liquidityThreshold: number;
  maxVisibleBuckets: number;
  maxHeatmapHistory: number;
  updateThrottleMs: number;
  profileSource: DomProfileSource;
  profileWidth: number;
  showPoc: boolean;
  showHvnLvn: boolean;
  showValueArea: boolean;
};
