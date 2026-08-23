export const QALC_ENGINE_ID = "black-core-qalc" as const;
export const QALC_MODEL_VERSION = "BC-QALC-BASELINE-1" as const;

export type QalcSymbol = "BTCUSDT" | "ETHUSDT";
export type QalcBookState =
  | "DISCONNECTED"
  | "SNAPSHOT_PENDING"
  | "SYNCHRONIZING"
  | "LIVE"
  | "GAP_DETECTED"
  | "RESYNCHRONIZING"
  | "STALE"
  | "FAILED";

export type QalcClockState = "CLOCK_SAFE" | "CLOCK_DEGRADED" | "CLOCK_UNSAFE";
export type QalcRuntimeState =
  | "STOPPED"
  | "INITIALIZING"
  | "SYNCHRONIZING_BOOK"
  | "WARMING_FEATURES"
  | "PAPER_READY"
  | "FLAT"
  | "QUOTE_CANDIDATE"
  | "QUOTE_PENDING"
  | "QUOTE_ACTIVE"
  | "PARTIALLY_FILLED"
  | "INVENTORY_LONG"
  | "INVENTORY_SHORT"
  | "EXIT_PENDING"
  | "DATA_STALE"
  | "TOXIC"
  | "RISK_SUSPENDED"
  | "RATE_LIMITED"
  | "RECONCILING"
  | "BOOK_GAP"
  | "CLOCK_UNSAFE"
  | "WORKER_DEGRADED"
  | "ERROR";

export type QalcMarketEventType =
  | "BOOK_SNAPSHOT"
  | "BOOK_DELTA"
  | "TRADE"
  | "TICKER"
  | "INSTRUMENT";

export type QalcBookLevel = readonly [price: number, quantity: number];

export type QalcBookPayload = {
  bids: QalcBookLevel[];
  asks: QalcBookLevel[];
  updateId: string;
  crossSequence?: string;
  systemTimestamp: number;
  matchingTimestamp?: number;
  depth: number;
};

export type QalcTradePayload = {
  tradeId: string;
  side: "BUY" | "SELL";
  price: number;
  quantity: number;
  notional: number;
  crossSequence?: string;
  blockTrade: boolean;
  rpiTrade: boolean;
};

export type QalcInstrumentPayload = {
  status: string;
  tickSize: number;
  quantityStep: number;
  minimumQuantity: number;
  minimumNotional: number;
  maximumLimitQuantity: number;
  maximumMarketQuantity: number;
  fundingIntervalMinutes: number;
  version: string;
};

export type QalcMarketEvent = {
  id: string;
  venue: "BYBIT";
  category: "linear";
  symbol: QalcSymbol;
  eventType: QalcMarketEventType;
  exchangeTimestamp: number;
  matchingTimestamp?: number;
  receiveTimestamp: number;
  processTimestamp: number;
  receiveMonotonicNs?: string;
  processMonotonicNs?: string;
  sequence?: string;
  updateId?: string;
  payloadVersion: 1;
  payload: QalcBookPayload | QalcTradePayload | QalcInstrumentPayload | Record<string, unknown>;
};

export type QalcBookChange = {
  side: "BID" | "ASK";
  price: number;
  before: number;
  after: number;
  delta: number;
  kind: "ADD" | "REMOVE" | "UPDATE";
};

export type QalcBookMutation = {
  accepted: boolean;
  duplicate: boolean;
  state: QalcBookState;
  reason?: string;
  changes: QalcBookChange[];
  bestBidBefore?: number;
  bestAskBefore?: number;
  bestBidAfter?: number;
  bestAskAfter?: number;
  version: number;
};

export type QalcBookView = {
  state: QalcBookState;
  symbol: QalcSymbol;
  bids: Array<{ price: number; quantity: number }>;
  asks: Array<{ price: number; quantity: number }>;
  updateId?: string;
  crossSequence?: string;
  exchangeTimestamp?: number;
  matchingTimestamp?: number;
  receiveTimestamp?: number;
  version: number;
  ageMs: number;
};

export type QalcSweep = {
  state: "BUY_SWEEP" | "SELL_SWEEP" | "NO_SWEEP";
  levelsCrossed: number;
  notional: number;
  durationMs: number;
  priceImpactTicks: number;
  recoveryMs?: number;
};

export type QalcFeatureSnapshot = {
  generatedAt: number;
  eventCount: number;
  warm: boolean;
  mid: number;
  spreadTicks: number;
  spreadBps: number;
  spreadRegime: "TIGHT" | "NORMAL" | "WIDE" | "DISLOCATED";
  microprice: number;
  micropriceEdgeTicks: number;
  queueImbalance: Record<"1" | "5" | "10" | "20" | "50", number>;
  limitOfi: Record<"100" | "250" | "1000" | "3000" | "10000", number>;
  tradeOfi: Record<"100" | "250" | "1000" | "3000" | "10000", number>;
  combinedOfi: Record<"100" | "250" | "1000" | "3000" | "10000", number>;
  aggressiveBuyBase: Record<"100" | "250" | "1000" | "3000" | "10000", number>;
  aggressiveSellBase: Record<"100" | "250" | "1000" | "3000" | "10000", number>;
  baseCvd: Record<"250" | "1000" | "3000" | "5000" | "10000" | "30000", number>;
  notionalCvd: Record<"250" | "1000" | "3000" | "5000" | "10000" | "30000", number>;
  flowEfficiency: Record<"250" | "1000" | "3000" | "5000" | "10000" | "30000", number>;
  deltaImpulse: number;
  deltaAcceleration: number;
  realizedVolatilityBps: Record<"250" | "1000" | "3000" | "10000" | "30000", number>;
  bidCancellationRate: number;
  askCancellationRate: number;
  cancelToAddRatio: number;
  cancelToTradeRatio: number;
  bidReplenishment: number;
  askReplenishment: number;
  bidResilienceMs?: number;
  askResilienceMs?: number;
  depthSlope: number;
  depthConvexity: number;
  depthAsymmetry: number;
  liquidityGapTicks: number;
  topDepth: number;
  sweep: QalcSweep;
  initiativeState:
    | "INITIATIVE_BUYING"
    | "INITIATIVE_SELLING"
    | "BUYER_ABSORPTION"
    | "SELLER_ABSORPTION"
    | "BALANCED_CHURN"
    | "LIQUIDITY_VACUUM"
    | "TOXIC_SWEEP";
  toxicity: {
    score: number;
    state: "SAFE" | "CAUTION" | "ELEVATED" | "TOXIC" | "EMERGENCY";
    components: Record<string, number>;
    modelVersion: string;
  };
};

export type QalcModelOutput = {
  horizonMs: 250 | 500 | 1000 | 3000 | 5000 | 10000;
  probabilityUp: number;
  probabilityDown: number;
  expectedMoveTicks: number;
  confidence: number;
  modelVersion: string;
};

export type QalcFillEstimate = {
  within100Ms: number;
  within250Ms: number;
  within500Ms: number;
  within1Second: number;
  beforeInvalidation: number;
  confidence: number;
  modelVersion: string;
};

export type QalcCostEstimate = {
  grossEdgeUsdt: number;
  entryFeeUsdt: number;
  expectedExitFeeUsdt: number;
  expectedSlippageUsdt: number;
  expectedAdverseSelectionUsdt: number;
  fundingEstimateUsdt: number;
  safetyBufferUsdt: number;
  allInCostUsdt: number;
  expectedNetEdgeUsdt: number;
  feeSource: "ACCOUNT_API" | "PAPER_CONSERVATIVE" | "UNAVAILABLE";
  feeSourceTimestamp?: number;
  feeScheduleVersion?: string;
};

export type QalcDecision = {
  time: number;
  action: "QUOTE_BID" | "QUOTE_ASK" | "CANCEL" | "HOLD" | "NO_QUOTE";
  reason: string;
  quotePrice?: number;
  quantity?: number;
  projectedTargetPrice?: number;
  invalidationPrice?: number;
  expiresAt?: number;
  directional: QalcModelOutput;
  fill: QalcFillEstimate;
  costs: QalcCostEstimate;
  toxicity: number;
};

export type QalcPaperOrderState =
  | "CREATED"
  | "ACKNOWLEDGED"
  | "ACTIVE"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED"
  | "REJECTED"
  | "EXPIRED";

export type QalcPaperOrder = {
  id: string;
  clientOrderId: string;
  generation: number;
  symbol: QalcSymbol;
  side: "BUY" | "SELL";
  price: number;
  quantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  state: QalcPaperOrderState;
  createdAt: number;
  acknowledgedAt?: number;
  activatedAt?: number;
  expiresAt: number;
  cancelledAt?: number;
  queueAheadInitial: number;
  queueAheadEstimated: number;
  queueConfidence: number;
  maker: true;
  cancelReason?: string;
};

export type QalcPaperExecution = {
  id: string;
  orderId: string;
  symbol: QalcSymbol;
  side: "BUY" | "SELL";
  price: number;
  quantity: number;
  notional: number;
  fee: number;
  maker: boolean;
  time: number;
  sourceTradeId?: string;
};

export type QalcPaperInventory = {
  side: "LONG" | "SHORT";
  quantity: number;
  averagePrice: number;
  openedAt: number;
  entryFees: number;
  realizedPnl: number;
  unrealizedPnl: number;
  lastMarkPrice: number;
};

export type QalcRiskState = {
  suspended: boolean;
  reason?: string;
  dailyPnl: number;
  dailyDrawdownPercent: number;
  consecutiveLosses: number;
  toxicExits10m: number;
  recentMarkoutsBps: number[];
};

export type QalcFeeSchedule = {
  makerRate: number;
  takerRate: number;
  source: "ACCOUNT_API" | "PAPER_CONSERVATIVE" | "UNAVAILABLE";
  observedAt?: number;
  version: string;
};

export type QalcConfig = {
  strategyId: string;
  runId: string;
  symbol: QalcSymbol;
  mode: "RESEARCH" | "REPLAY" | "PAPER" | "SHADOW";
  paperEnabled: boolean;
  shadowEnabled: boolean;
  liveExecutionEnabled: false;
  groupFanoutEnabled: false;
  modelVersion: string;
  predictionHorizonMs: 250 | 500 | 1000 | 3000 | 5000 | 10000;
  quoteLifetimeMs: number;
  quotePlacement: "BEST" | "ONE_TICK_BEHIND" | "MICROPRICE_ADJUSTED" | "QUEUE_OPTIMIZED";
  minimumNetEdgeMultiplier: number;
  minimumFillProbability: number;
  maximumToxicity: number;
  maximumQuoteActionsPerSecond: number;
  maximumQuoteActionsPerMinute: number;
  paperEquity: number;
  riskPerTradePercent: number;
  maximumDailyLossPercent: number;
  maximumConsecutiveLosses: number;
  maximumToxicExits10m: number;
  maximumInventoryDurationMs: number;
  maximumLeverage: 1;
  hardStopTicks: number;
  confirmationCount: number;
  safetyBufferBps: number;
  latency: {
    marketDataMs: number;
    processingMs: number;
    submissionMs: number;
    acknowledgementMs: number;
    cancelMs: number;
    executionNotificationMs: number;
  };
};

export type QalcAuditEvent = {
  type: string;
  time: number;
  severity: "INFO" | "WARN" | "ERROR" | "CRITICAL";
  message: string;
  metadata?: Record<string, unknown>;
};

export type QalcTelemetry = {
  engineId: typeof QALC_ENGINE_ID;
  modelVersion: string;
  certificationState: "RESEARCH" | "EVENT_REPLAY_CERTIFIED" | "PAPER_CANDIDATE" | "PAPER_CERTIFIED";
  runtimeState: QalcRuntimeState;
  book: QalcBookView;
  clock: {
    state: QalcClockState;
    offsetMs: number;
    driftMsPerMinute: number;
    sampledAt: number;
  };
  features?: QalcFeatureSnapshot;
  decision?: QalcDecision;
  activeQuote?: QalcPaperOrder;
  inventory?: QalcPaperInventory;
  risk: QalcRiskState;
  executions: QalcPaperExecution[];
  recentAudit: QalcAuditEvent[];
  counters: Record<string, number>;
  performance: Record<string, { p50: number; p95: number; p99: number; max: number }>;
  updatedAt: number;
};

export const defaultQalcConfig = (overrides: Partial<QalcConfig> = {}): QalcConfig => ({
  strategyId: "qalc-research",
  runId: "qalc-research-run",
  symbol: "BTCUSDT",
  mode: "RESEARCH",
  paperEnabled: false,
  shadowEnabled: false,
  liveExecutionEnabled: false,
  groupFanoutEnabled: false,
  modelVersion: QALC_MODEL_VERSION,
  predictionHorizonMs: 1000,
  quoteLifetimeMs: 500,
  quotePlacement: "QUEUE_OPTIMIZED",
  minimumNetEdgeMultiplier: 2,
  minimumFillProbability: 0.35,
  maximumToxicity: 44,
  maximumQuoteActionsPerSecond: 2,
  maximumQuoteActionsPerMinute: 60,
  paperEquity: 10_000,
  riskPerTradePercent: 0.02,
  maximumDailyLossPercent: 0.5,
  maximumConsecutiveLosses: 4,
  maximumToxicExits10m: 3,
  maximumInventoryDurationMs: 10_000,
  maximumLeverage: 1,
  hardStopTicks: 8,
  confirmationCount: 2,
  safetyBufferBps: 0.5,
  latency: {
    marketDataMs: 30,
    processingMs: 3,
    submissionMs: 35,
    acknowledgementMs: 35,
    cancelMs: 50,
    executionNotificationMs: 35,
  },
  ...overrides,
});

export function finite(value: number, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

export function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}
