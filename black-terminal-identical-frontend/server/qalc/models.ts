import { clamp, type QalcConfig, type QalcCostEstimate, type QalcFeatureSnapshot, type QalcFeeSchedule, type QalcFillEstimate, type QalcModelOutput } from "./contracts.ts";

/** Interpretable signed model. Coefficients are versioned baseline priors, not trained claims. */
export function directionModel(features: QalcFeatureSnapshot, config: QalcConfig): QalcModelOutput {
  const scale = Math.max(0.001, features.topDepth);
  const signal =
    features.queueImbalance["5"] * 1.05 +
    features.queueImbalance["20"] * 0.45 +
    clamp(features.micropriceEdgeTicks, -2, 2) * 0.55 +
    clamp(features.combinedOfi["1000"] / scale, -2, 2) * 0.7 +
    clamp(features.notionalCvd["3000"] / Math.max(1, features.mid * scale), -2, 2) * 0.55 +
    clamp(features.depthAsymmetry, -1, 1) * 0.5;
  const probabilityUp = logistic(signal);
  const confidence = clamp(Math.abs(probabilityUp - 0.5) * 2 * (1 - features.toxicity.score / 130), 0, 1);
  return {
    horizonMs: config.predictionHorizonMs,
    probabilityUp,
    probabilityDown: 1 - probabilityUp,
    expectedMoveTicks: signal * Math.max(0.25, features.realizedVolatilityBps["1000"] / Math.max(0.01, features.spreadBps)),
    confidence,
    modelVersion: `${config.modelVersion}:direction-1`,
  };
}

/** Queue-aware fill prior. Queue position is explicit and conservative. */
export function fillModel(features: QalcFeatureSnapshot, queueAhead: number, side: "BUY" | "SELL", config: QalcConfig): QalcFillEstimate {
  // A passive bid advances when aggressive sells consume the bid queue; a
  // passive ask advances when aggressive buys consume the ask queue. Net OFI
  // is directional evidence, not executed queue-consumption volume: opposing
  // trades must not disappear merely because same-window trades offset them.
  const opposingFlow = side === "BUY" ? features.aggressiveSellBase["1000"] : features.aggressiveBuyBase["1000"];
  const sameSideCancel = side === "BUY" ? features.bidCancellationRate : features.askCancellationRate;
  const replenishment = side === "BUY" ? features.bidReplenishment : features.askReplenishment;
  const effectiveQueue = Math.max(0.000001, queueAhead + replenishment * 0.5);
  const intensity = (opposingFlow + sameSideCancel * effectiveQueue * 0.25) / effectiveQueue;
  const probability = (milliseconds: number) => clamp(1 - Math.exp(-intensity * milliseconds / 1_000), 0, 0.98);
  return {
    within100Ms: probability(100),
    within250Ms: probability(250),
    within500Ms: probability(500),
    within1Second: probability(1_000),
    beforeInvalidation: probability(config.quoteLifetimeMs) * (1 - features.toxicity.score / 120),
    confidence: clamp(features.eventCount / 2_000, 0.1, 0.9),
    modelVersion: `${config.modelVersion}:fill-1`,
  };
}

export function adverseSelectionTicks(features: QalcFeatureSnapshot, side: "BUY" | "SELL") {
  const directionAgainstQuote = side === "BUY" ? Math.max(0, -features.micropriceEdgeTicks) : Math.max(0, features.micropriceEdgeTicks);
  const sweepAgainstQuote = (side === "BUY" && features.sweep.state === "SELL_SWEEP") || (side === "SELL" && features.sweep.state === "BUY_SWEEP") ? features.sweep.priceImpactTicks : 0;
  return Math.max(0, directionAgainstQuote + sweepAgainstQuote * 0.5 + features.toxicity.score / 100);
}

export function costModel(input: {
  quotePrice: number;
  quantity: number;
  tickSize: number;
  expectedMoveTicks: number;
  adverseSelectionTicks: number;
  fees: QalcFeeSchedule;
  config: QalcConfig;
}): QalcCostEstimate {
  const notional = input.quotePrice * input.quantity;
  const grossEdgeUsdt = Math.max(0, input.expectedMoveTicks) * input.tickSize * input.quantity;
  const entryFeeUsdt = notional * input.fees.makerRate;
  // Exit is conservatively assumed taker until replay evidence proves otherwise.
  const expectedExitFeeUsdt = notional * input.fees.takerRate;
  const expectedSlippageUsdt = input.tickSize * input.quantity * 0.5;
  const expectedAdverseSelectionUsdt = input.adverseSelectionTicks * input.tickSize * input.quantity;
  const fundingEstimateUsdt = 0;
  const safetyBufferUsdt = notional * input.config.safetyBufferBps / 10_000;
  const allInCostUsdt = entryFeeUsdt + expectedExitFeeUsdt + expectedSlippageUsdt + expectedAdverseSelectionUsdt + fundingEstimateUsdt + safetyBufferUsdt;
  return {
    grossEdgeUsdt,
    entryFeeUsdt,
    expectedExitFeeUsdt,
    expectedSlippageUsdt,
    expectedAdverseSelectionUsdt,
    fundingEstimateUsdt,
    safetyBufferUsdt,
    allInCostUsdt,
    expectedNetEdgeUsdt: grossEdgeUsdt - allInCostUsdt,
    feeSource: input.fees.source,
    feeSourceTimestamp: input.fees.observedAt,
    feeScheduleVersion: input.fees.version,
  };
}

function logistic(value: number) { return 1 / (1 + Math.exp(-clamp(value, -20, 20))); }
