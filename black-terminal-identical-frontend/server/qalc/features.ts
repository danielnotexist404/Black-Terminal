import { clamp, finite, type QalcBookMutation, type QalcBookView, type QalcFeatureSnapshot, type QalcMarketEvent, type QalcSweep, type QalcTradePayload } from "./contracts.ts";

const FLOW_WINDOWS = [100, 250, 1_000, 3_000, 10_000] as const;
const CVD_WINDOWS = [250, 1_000, 3_000, 5_000, 10_000, 30_000] as const;
const VOL_WINDOWS = [250, 1_000, 3_000, 10_000, 30_000] as const;
type FlowWindow = typeof FLOW_WINDOWS[number];

type FlowKey = "limit" | "tradeBase" | "tradeNotional" | "add" | "cancel" | "bidCancel" | "askCancel" | "bidAdd" | "askAdd";
type FlowValues = Record<FlowKey, number>;
type TimedFlow = FlowValues & { time: number; cumulative: FlowValues; grossTradeBase: number; grossTradeNotional: number };
type TimedMid = { time: number; mid: number; returnCount: number; returnSum: number; returnSquares: number };
type TimedTrade = { time: number; id: string; side: "BUY" | "SELL"; price: number; quantity: number; notional: number };

/** Stateful, event-time feature calculator. No candle direction or synthetic volume is used. */
export class QalcFeatureEngine {
  private tickSize: number;
  private flows: TimedFlow[] = [];
  private mids: TimedMid[] = [];
  private trades: TimedTrade[] = [];
  private flowBaseline = zeroFlows();
  private grossTradeBaseline = 0;
  private grossTradeNotionalBaseline = 0;
  private midBaseline = { returnCount: 0, returnSum: 0, returnSquares: 0 };
  private eventCount = 0;
  private firstEventAt = 0;
  private bidDamageAt?: number;
  private askDamageAt?: number;
  private bidResilienceMs?: number;
  private askResilienceMs?: number;
  private previousBestBid?: number;
  private previousBestAsk?: number;

  constructor(tickSize: number) { this.tickSize = tickSize; }
  updateTickSize(tickSize: number) { if (Number.isFinite(tickSize) && tickSize > 0) this.tickSize = tickSize; }

  observeBook(event: QalcMarketEvent, mutation: QalcBookMutation, book: QalcBookView) {
    if (!mutation.accepted) return;
    this.markEvent(event.receiveTimestamp);
    let limit = 0;
    let add = 0;
    let cancel = 0;
    let bidCancel = 0;
    let askCancel = 0;
    let bidAdd = 0;
    let askAdd = 0;
    for (const change of mutation.changes) {
      limit += change.side === "BID" ? change.delta : -change.delta;
      if (change.delta > 0) {
        add += change.delta;
        if (change.side === "BID") bidAdd += change.delta;
        else askAdd += change.delta;
      } else {
        cancel += -change.delta;
        if (change.side === "BID") bidCancel += -change.delta;
        else askCancel += -change.delta;
      }
    }
    this.pushFlow(event.receiveTimestamp, { limit, tradeBase: 0, tradeNotional: 0, add, cancel, bidCancel, askCancel, bidAdd, askAdd });
    const bid = book.bids[0]?.price;
    const ask = book.asks[0]?.price;
    if (bid && ask) {
      this.pushMid(event.receiveTimestamp, (bid + ask) / 2);
      this.observeResilience(event.receiveTimestamp, bid, ask);
    }
    this.prune(event.receiveTimestamp);
  }

  observeTrade(event: QalcMarketEvent) {
    if (event.eventType !== "TRADE") return;
    const trade = event.payload as QalcTradePayload;
    this.markEvent(event.receiveTimestamp);
    const sign = trade.side === "BUY" ? 1 : -1;
    this.trades.push({ time: event.receiveTimestamp, id: trade.tradeId, side: trade.side, price: trade.price, quantity: trade.quantity, notional: trade.notional });
    this.pushFlow(event.receiveTimestamp, { limit: 0, tradeBase: sign * trade.quantity, tradeNotional: sign * trade.notional, add: 0, cancel: 0, bidCancel: 0, askCancel: 0, bidAdd: 0, askAdd: 0 });
    this.prune(event.receiveTimestamp);
  }

  snapshot(book: QalcBookView, now: number): QalcFeatureSnapshot | undefined {
    const bid = book.bids[0];
    const ask = book.asks[0];
    if (!bid || !ask || this.tickSize <= 0) return undefined;
    const mid = (bid.price + ask.price) / 2;
    const spreadTicks = (ask.price - bid.price) / this.tickSize;
    const topTotal = bid.quantity + ask.quantity;
    const microprice = topTotal > 0 ? (bid.price * ask.quantity + ask.price * bid.quantity) / topTotal : mid;
    const limitOfi = windowRecord(FLOW_WINDOWS, (window) => this.sumFlow(now, window, "limit"));
    const tradeOfi = windowRecord(FLOW_WINDOWS, (window) => this.sumFlow(now, window, "tradeBase"));
    const combinedOfi = windowRecord(FLOW_WINDOWS, (window) => limitOfi[String(window) as `${FlowWindow}`] + tradeOfi[String(window) as `${FlowWindow}`]);
    const aggressiveBuyBase = windowRecord(FLOW_WINDOWS, (window) => {
      const signed = this.sumFlow(now, window, "tradeBase");
      const gross = this.grossFlow(now, window, "tradeBase");
      return Math.max(0, (gross + signed) / 2);
    });
    const aggressiveSellBase = windowRecord(FLOW_WINDOWS, (window) => {
      const signed = this.sumFlow(now, window, "tradeBase");
      const gross = this.grossFlow(now, window, "tradeBase");
      return Math.max(0, (gross - signed) / 2);
    });
    const baseCvd = windowRecord(CVD_WINDOWS, (window) => this.sumFlow(now, window, "tradeBase"));
    const notionalCvd = windowRecord(CVD_WINDOWS, (window) => this.sumFlow(now, window, "tradeNotional"));
    const flowEfficiency = windowRecord(CVD_WINDOWS, (window) => {
      const signedNotional = this.sumFlow(now, window, "tradeNotional");
      const grossNotional = this.grossFlow(now, window, "tradeNotional");
      return grossNotional > 0 ? clamp(signedNotional / grossNotional, -1, 1) : 0;
    });
    const realizedVolatilityBps = windowRecord(VOL_WINDOWS, (window) => this.volatilityBps(now, window));
    const cvd250 = baseCvd["250"];
    // Derive impulse from fixed event-time windows. Snapshot reads must be pure:
    // telemetry polling frequency must never alter subsequent model inputs.
    const priorCvd250 = this.sumFlow(now - 100, 250, "tradeBase");
    const priorPriorCvd250 = this.sumFlow(now - 200, 250, "tradeBase");
    const deltaImpulse = cvd250 - priorCvd250;
    const deltaAcceleration = deltaImpulse - (priorCvd250 - priorPriorCvd250);
    const cancel = this.sumFlow(now, 3_000, "cancel");
    const add = this.sumFlow(now, 3_000, "add");
    const grossTrade = this.grossFlow(now, 3_000, "tradeBase");
    const bidCancel = this.sumFlow(now, 3_000, "bidCancel");
    const askCancel = this.sumFlow(now, 3_000, "askCancel");
    const bidAdd = this.sumFlow(now, 3_000, "bidAdd");
    const askAdd = this.sumFlow(now, 3_000, "askAdd");
    const bidCancellationRate = rate(bidCancel, bidCancel + bidAdd);
    const askCancellationRate = rate(askCancel, askCancel + askAdd);
    const sweep = detectSweep(this.trades.slice(lowerBoundTime(this.trades, now - 1_000)), this.tickSize);
    const queueImbalance = depthImbalance(book);
    const shape = bookShape(book, mid, this.tickSize);
    const toxicity = toxicityScore({ spreadTicks, volatility: realizedVolatilityBps["1000"], cancellationRatio: rate(cancel, add), flow: tradeOfi["1000"], topDepth: shape.topDepth, sweep });
    const initiativeState = classifyInitiative(tradeOfi["1000"], limitOfi["1000"], queueImbalance["5"], sweep, toxicity.score);
    return {
      generatedAt: now,
      eventCount: this.eventCount,
      warm: this.eventCount >= 100 && now - this.firstEventAt >= 3_000,
      mid,
      spreadTicks,
      spreadBps: ((ask.price - bid.price) / mid) * 10_000,
      spreadRegime: spreadTicks <= 1 ? "TIGHT" : spreadTicks <= 2 ? "NORMAL" : spreadTicks <= 5 ? "WIDE" : "DISLOCATED",
      microprice,
      micropriceEdgeTicks: (microprice - mid) / this.tickSize,
      queueImbalance,
      limitOfi,
      tradeOfi,
      combinedOfi,
      aggressiveBuyBase,
      aggressiveSellBase,
      baseCvd,
      notionalCvd,
      flowEfficiency,
      deltaImpulse,
      deltaAcceleration,
      realizedVolatilityBps,
      bidCancellationRate,
      askCancellationRate,
      cancelToAddRatio: rate(cancel, add),
      cancelToTradeRatio: rate(cancel, grossTrade),
      bidReplenishment: bidAdd,
      askReplenishment: askAdd,
      bidResilienceMs: this.bidResilienceMs,
      askResilienceMs: this.askResilienceMs,
      ...shape,
      sweep,
      initiativeState,
      toxicity: { ...toxicity, modelVersion: "QALC-TOXICITY-1" },
    };
  }

  private observeResilience(time: number, bid: number, ask: number) {
    if (this.previousBestBid !== undefined) {
      if (bid < this.previousBestBid) this.bidDamageAt = time;
      else if (this.bidDamageAt !== undefined && bid >= this.previousBestBid) { this.bidResilienceMs = time - this.bidDamageAt; this.bidDamageAt = undefined; }
    }
    if (this.previousBestAsk !== undefined) {
      if (ask > this.previousBestAsk) this.askDamageAt = time;
      else if (this.askDamageAt !== undefined && ask <= this.previousBestAsk) { this.askResilienceMs = time - this.askDamageAt; this.askDamageAt = undefined; }
    }
    this.previousBestBid = bid;
    this.previousBestAsk = ask;
  }

  private markEvent(time: number) { this.eventCount += 1; if (!this.firstEventAt) this.firstEventAt = time; }
  private sumFlow(now: number, window: number, key: FlowKey) {
    if (!this.flows.length) return 0;
    const start = lowerBoundTime(this.flows, now - window);
    const end = upperBoundTime(this.flows, now) - 1;
    if (end < start) return 0;
    const before = start > 0 ? this.flows[start - 1].cumulative[key] : this.flowBaseline[key];
    return this.flows[end].cumulative[key] - before;
  }
  private grossFlow(now: number, window: number, key: FlowKey) {
    if ((key !== "tradeBase" && key !== "tradeNotional") || !this.flows.length) return Math.abs(this.sumFlow(now, window, key));
    const start = lowerBoundTime(this.flows, now - window);
    const end = upperBoundTime(this.flows, now) - 1;
    if (end < start) return 0;
    if (key === "tradeBase") {
      const before = start > 0 ? this.flows[start - 1].grossTradeBase : this.grossTradeBaseline;
      return this.flows[end].grossTradeBase - before;
    }
    const before = start > 0 ? this.flows[start - 1].grossTradeNotional : this.grossTradeNotionalBaseline;
    return this.flows[end].grossTradeNotional - before;
  }
  private volatilityBps(now: number, window: number) {
    if (!this.mids.length) return 0;
    const start = lowerBoundTime(this.mids, now - window);
    const end = upperBoundTime(this.mids, now) - 1;
    if (end <= start) return 0;
    const before = this.mids[start].returnCount;
    const beforeSum = this.mids[start].returnSum;
    const beforeSquares = this.mids[start].returnSquares;
    const count = this.mids[end].returnCount - before;
    const sum = this.mids[end].returnSum - beforeSum;
    const sumSquares = this.mids[end].returnSquares - beforeSquares;
    if (count < 2) return 0;
    const variance = Math.max(0, (sumSquares - sum * sum / count) / (count - 1));
    return Math.sqrt(variance) * 10_000;
  }
  private pushFlow(time: number, values: FlowValues) {
    const previous = this.flows.at(-1)?.cumulative || this.flowBaseline;
    const cumulative = zeroFlows();
    for (const key of flowKeys) cumulative[key] = previous[key] + values[key];
    const grossTradeBase = (this.flows.at(-1)?.grossTradeBase ?? this.grossTradeBaseline) + Math.abs(values.tradeBase);
    const grossTradeNotional = (this.flows.at(-1)?.grossTradeNotional ?? this.grossTradeNotionalBaseline) + Math.abs(values.tradeNotional);
    this.flows.push({ time, ...values, cumulative, grossTradeBase, grossTradeNotional });
  }
  private pushMid(time: number, mid: number) {
    const previous = this.mids.at(-1);
    const base = previous || this.midBaseline;
    const value = previous && previous.mid > 0 && mid > 0 ? Math.log(mid / previous.mid) : 0;
    this.mids.push({ time, mid, returnCount: base.returnCount + (previous ? 1 : 0), returnSum: base.returnSum + value, returnSquares: base.returnSquares + value * value });
  }
  private prune(now: number) {
    const cutoff = now - 35_000;
    while (this.flows[0]?.time < cutoff) {
      const removed = this.flows.shift()!;
      this.flowBaseline = removed.cumulative;
      this.grossTradeBaseline = removed.grossTradeBase;
      this.grossTradeNotionalBaseline = removed.grossTradeNotional;
    }
    while (this.mids[0]?.time < cutoff) {
      const removed = this.mids.shift()!;
      this.midBaseline = { returnCount: removed.returnCount, returnSum: removed.returnSum, returnSquares: removed.returnSquares };
    }
    while (this.trades[0]?.time < cutoff) this.trades.shift();
  }
}

const flowKeys: FlowKey[] = ["limit", "tradeBase", "tradeNotional", "add", "cancel", "bidCancel", "askCancel", "bidAdd", "askAdd"];
function zeroFlows(): FlowValues { return { limit: 0, tradeBase: 0, tradeNotional: 0, add: 0, cancel: 0, bidCancel: 0, askCancel: 0, bidAdd: 0, askAdd: 0 }; }
function lowerBoundTime<T extends { time: number }>(rows: T[], time: number) { let low = 0; let high = rows.length; while (low < high) { const middle = (low + high) >>> 1; if (rows[middle].time < time) low = middle + 1; else high = middle; } return low; }
function upperBoundTime<T extends { time: number }>(rows: T[], time: number) { let low = 0; let high = rows.length; while (low < high) { const middle = (low + high) >>> 1; if (rows[middle].time <= time) low = middle + 1; else high = middle; } return low; }

function windowRecord<T extends readonly number[]>(windows: T, calculate: (window: T[number]) => number) {
  return Object.fromEntries(windows.map((window) => [String(window), finite(calculate(window))])) as Record<`${T[number]}`, number>;
}
function rate(numerator: number, denominator: number) { return denominator > 0 ? numerator / denominator : 0; }

function depthImbalance(book: QalcBookView): QalcFeatureSnapshot["queueImbalance"] {
  const calculate = (depth: number) => {
    const weight = (index: number) => Math.exp(-0.35 * index);
    const bid = book.bids.slice(0, depth).reduce((sum, row, index) => sum + row.quantity * weight(index), 0);
    const ask = book.asks.slice(0, depth).reduce((sum, row, index) => sum + row.quantity * weight(index), 0);
    return bid + ask ? (bid - ask) / (bid + ask) : 0;
  };
  return { "1": calculate(1), "5": calculate(5), "10": calculate(10), "20": calculate(20), "50": calculate(50) };
}

function bookShape(book: QalcBookView, mid: number, tick: number) {
  const bidDepth = book.bids.slice(0, 20).reduce((sum, row) => sum + row.quantity, 0);
  const askDepth = book.asks.slice(0, 20).reduce((sum, row) => sum + row.quantity, 0);
  const weightedDistance = (levels: Array<{ price: number; quantity: number }>) => levels.slice(0, 20).reduce((sum, row) => sum + Math.abs(row.price - mid) / tick * row.quantity, 0);
  const total = bidDepth + askDepth;
  const near = book.bids.slice(0, 5).reduce((sum, row) => sum + row.quantity, 0) + book.asks.slice(0, 5).reduce((sum, row) => sum + row.quantity, 0);
  const far = Math.max(0, total - near);
  const prices = [...book.bids.slice(0, 10).map((row) => row.price), ...book.asks.slice(0, 10).map((row) => row.price)].sort((a, b) => a - b);
  let maximumGap = 0;
  for (let index = 1; index < prices.length; index += 1) maximumGap = Math.max(maximumGap, (prices[index] - prices[index - 1]) / tick);
  return {
    depthSlope: total ? (weightedDistance(book.asks) - weightedDistance(book.bids)) / total : 0,
    depthConvexity: far > 0 ? near / far : near,
    depthAsymmetry: total ? (bidDepth - askDepth) / total : 0,
    liquidityGapTicks: maximumGap,
    topDepth: total,
  };
}

function detectSweep(trades: TimedTrade[], tick: number): QalcSweep {
  if (!trades.length) return { state: "NO_SWEEP", levelsCrossed: 0, notional: 0, durationMs: 0, priceImpactTicks: 0 };
  const buys = trades.filter((row) => row.side === "BUY");
  const sells = trades.filter((row) => row.side === "SELL");
  const dominant = buys.reduce((sum, row) => sum + row.notional, 0) >= sells.reduce((sum, row) => sum + row.notional, 0) ? buys : sells;
  if (dominant.length < 2) return { state: "NO_SWEEP", levelsCrossed: 0, notional: dominant[0]?.notional || 0, durationMs: 0, priceImpactTicks: 0 };
  const prices = new Set(dominant.map((row) => row.price));
  const impact = Math.abs(dominant.at(-1)!.price - dominant[0].price) / tick;
  const notional = dominant.reduce((sum, row) => sum + row.notional, 0);
  const durationMs = dominant.at(-1)!.time - dominant[0].time;
  if (prices.size < 2 || impact < 1) return { state: "NO_SWEEP", levelsCrossed: prices.size, notional, durationMs, priceImpactTicks: impact };
  return { state: dominant[0].side === "BUY" ? "BUY_SWEEP" : "SELL_SWEEP", levelsCrossed: prices.size, notional, durationMs, priceImpactTicks: impact };
}

function toxicityScore(input: { spreadTicks: number; volatility: number; cancellationRatio: number; flow: number; topDepth: number; sweep: QalcSweep }) {
  const components = {
    spread: clamp(input.spreadTicks / 5, 0, 1) * 20,
    volatility: clamp(input.volatility / 8, 0, 1) * 20,
    cancellation: clamp(input.cancellationRatio / 2, 0, 1) * 20,
    flowShock: clamp(Math.abs(input.flow) / Math.max(0.001, input.topDepth * 0.2), 0, 1) * 20,
    sweep: clamp(input.sweep.priceImpactTicks / 5, 0, 1) * 20,
  };
  const score = Object.values(components).reduce((sum, value) => sum + value, 0);
  return { score, state: score < 25 ? "SAFE" as const : score < 45 ? "CAUTION" as const : score < 65 ? "ELEVATED" as const : score < 85 ? "TOXIC" as const : "EMERGENCY" as const, components };
}

function classifyInitiative(trade: number, limit: number, imbalance: number, sweep: QalcSweep, toxicity: number): QalcFeatureSnapshot["initiativeState"] {
  if (toxicity >= 65 && sweep.state !== "NO_SWEEP") return "TOXIC_SWEEP";
  if (Math.abs(imbalance) > 0.7 && Math.abs(trade) < 0.01) return "LIQUIDITY_VACUUM";
  if (trade > 0 && limit < 0) return "SELLER_ABSORPTION";
  if (trade < 0 && limit > 0) return "BUYER_ABSORPTION";
  if (trade > 0 && imbalance > 0) return "INITIATIVE_BUYING";
  if (trade < 0 && imbalance < 0) return "INITIATIVE_SELLING";
  return "BALANCED_CHURN";
}
