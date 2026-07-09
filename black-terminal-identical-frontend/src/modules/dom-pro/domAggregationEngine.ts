import type { MarketSymbol, OrderBookSnapshot, TickerSnapshot, TradeTick } from "../../market-data/types";
import type {
  AbsorptionSignal,
  AggregatedDomSnapshot,
  DomBucket,
  DomHeatmapFrame,
  DomMetrics,
  DomRenderStats,
  DomSettings,
  IcebergEstimate,
  LiquidityDelta,
  VolumeProfileNode,
  WallDetection
} from "./types";

type WallMemory = {
  firstSeen: number;
  lastSeen: number;
  refreshes: number;
};

const emptyAbsorption: AbsorptionSignal = {
  detected: false,
  side: "none",
  price: null,
  confidence: 0,
  label: "NO ABSORPTION"
};

export class DomAggregationEngine {
  private previousBuckets = new Map<string, DomBucket>();
  private wallMemory = new Map<string, WallMemory>();
  private heatmap: DomHeatmapFrame[] = [];
  private cvd = 0;
  private cvdSeries: Array<{ time: number; value: number }> = [];
  private cvdTradeIds = new Set<string>();
  private updateTimes: number[] = [];

  aggregate(input: {
    marketSymbol: MarketSymbol;
    book: OrderBookSnapshot | null;
    ticker: TickerSnapshot | null;
    trades: TradeTick[];
    settings: DomSettings;
    renderStats?: Partial<DomRenderStats>;
    subscriptionCount: number;
  }): AggregatedDomSnapshot {
    const now = Date.now();
    this.updateTimes.push(now);
    this.updateTimes = this.updateTimes.filter((time) => now - time < 1000);

    if (!input.book || input.book.bids.length === 0 || input.book.asks.length === 0) {
      return this.emptySnapshot(input.marketSymbol, input.ticker, input.trades, input.settings, input.subscriptionCount, now);
    }

    const bestBid = input.book.bids[0]?.price ?? null;
    const bestAsk = input.book.asks[0]?.price ?? null;
    const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
    const lastPrice = input.ticker?.lastPrice ?? midPrice;
    const tickSize = inferTickSize(input.book, input.marketSymbol);
    const bucketSize = resolveBucketSize(input.settings, tickSize);
    const buckets = buildBuckets(input.book, bucketSize, lastPrice ?? midPrice ?? bestBid ?? bestAsk ?? 0, input.settings);
    const deltas = this.detectLiquidityDelta(buckets);
    const profile = buildVolumeProfile(buckets);
    const walls = this.detectWalls(buckets, input.settings, lastPrice ?? midPrice ?? 0, now);
    const heatmap = this.pushHeatmapFrame(buckets, input.settings, now);
    this.updateCvd(input.trades);
    const absorption = detectAbsorption(input.trades, buckets, deltas, lastPrice ?? midPrice ?? 0);
    const iceberg = detectIceberg(input.trades, buckets, deltas, lastPrice ?? midPrice ?? 0);
    const metrics = buildMetrics(buckets, deltas, input.trades, this.updateTimes.length, input.book.time);

    this.previousBuckets = new Map(buckets.map((bucket) => [bucketKey(bucket), bucket]));

    return {
      marketSymbol: input.marketSymbol,
      sourceBook: input.book,
      ticker: input.ticker,
      trades: input.trades,
      buckets,
      bids: buckets.filter((bucket) => bucket.bidSize > 0).sort((a, b) => b.price - a.price),
      asks: buckets.filter((bucket) => bucket.askSize > 0).sort((a, b) => a.price - b.price),
      volumeProfile: profile,
      heatmap,
      walls,
      liquidityDelta: deltas,
      absorption,
      iceberg,
      metrics,
      renderStats: {
        updateRate: this.updateTimes.length,
        renderFps: input.renderStats?.renderFps ?? 0,
        fpsCap: input.settings.fpsCap,
        visibleBuckets: buckets.length,
        bucketSize,
        droppedFrames: input.renderStats?.droppedFrames ?? 0,
        lastRenderMs: input.renderStats?.lastRenderMs ?? 0,
        memoryEstimateKb: estimateMemoryKb(buckets.length, heatmap.length, input.trades.length),
        subscriptionCount: input.subscriptionCount
      },
      bestBid,
      bestAsk,
      midPrice,
      lastPrice,
      spread: bestBid && bestAsk ? bestAsk - bestBid : null,
      status: input.book.time ? "live" : "rest",
      statusMessage: "LIVE ORDERBOOK STREAM",
      generatedAt: now
    };
  }

  cvdData() {
    return this.cvdSeries.slice(-80);
  }

  private updateCvd(trades: TradeTick[]) {
    const ordered = trades.slice().sort((a, b) => a.time - b.time);
    for (const trade of ordered) {
      if (this.cvdTradeIds.has(trade.tradeId)) continue;
      this.cvdTradeIds.add(trade.tradeId);
      if (this.cvdTradeIds.size > 3000) {
        const keep = new Set(trades.slice(0, 1200).map((item) => item.tradeId));
        this.cvdTradeIds = keep;
      }
      if (trade.side === "buy") this.cvd += trade.quantity;
      if (trade.side === "sell") this.cvd -= trade.quantity;
      this.cvdSeries.push({ time: trade.time, value: this.cvd });
    }
    this.cvdSeries = this.cvdSeries.slice(-240);
  }

  private emptySnapshot(
    marketSymbol: MarketSymbol,
    ticker: TickerSnapshot | null,
    trades: TradeTick[],
    settings: DomSettings,
    subscriptionCount: number,
    now: number
  ): AggregatedDomSnapshot {
    return {
      marketSymbol,
      sourceBook: null,
      ticker,
      trades,
      buckets: [],
      bids: [],
      asks: [],
      volumeProfile: [],
      heatmap: [],
      walls: [],
      liquidityDelta: [],
      absorption: emptyAbsorption,
      iceberg: { estimatedCount: 0, probability: "low", score: 0 },
      metrics: {
        orderBookImbalance: 0,
        depthImbalance: 0,
        liquidityScore: 0,
        largeTradesLastMinute: 0,
        bidStacked: 0,
        askStacked: 0,
        bidPulled: 0,
        askPulled: 0,
        updateRate: this.updateTimes.length,
        latencyMs: 0
      },
      renderStats: {
        updateRate: this.updateTimes.length,
        renderFps: 0,
        fpsCap: settings.fpsCap,
        visibleBuckets: 0,
        bucketSize: settings.customBucketSize,
        droppedFrames: 0,
        lastRenderMs: 0,
        memoryEstimateKb: 0,
        subscriptionCount
      },
      bestBid: null,
      bestAsk: null,
      midPrice: null,
      lastPrice: ticker?.lastPrice ?? null,
      spread: null,
      status: "awaiting-book",
      statusMessage: "Awaiting live orderbook stream.",
      generatedAt: now
    };
  }

  private detectLiquidityDelta(buckets: DomBucket[]): LiquidityDelta[] {
    return buckets.map((bucket) => {
      const previous = this.previousBuckets.get(bucketKey(bucket));
      const bidChange = bucket.bidSize - (previous?.bidSize ?? 0);
      const askChange = bucket.askSize - (previous?.askSize ?? 0);
      return {
        price: bucket.price,
        bidAdded: Math.max(0, bidChange),
        askAdded: Math.max(0, askChange),
        bidRemoved: Math.max(0, -bidChange),
        askRemoved: Math.max(0, -askChange),
        net: bidChange - askChange
      };
    });
  }

  private detectWalls(buckets: DomBucket[], settings: DomSettings, price: number, now: number): WallDetection[] {
    const sizes = buckets.flatMap((bucket) => [bucket.bidSize, bucket.askSize]).filter((size) => size > 0);
    const average = sizes.reduce((sum, size) => sum + size, 0) / Math.max(1, sizes.length);
    const threshold = Math.max(average * settings.liquidityThreshold, average + standardDeviation(sizes));
    const seen = new Set<string>();
    const walls: WallDetection[] = [];

    for (const bucket of buckets) {
      for (const side of ["bid", "ask"] as const) {
        const size = side === "bid" ? bucket.bidSize : bucket.askSize;
        if (size < threshold) continue;
        const key = `${side}:${bucket.price}`;
        const existing = this.wallMemory.get(key);
        const distancePct = price > 0 ? Math.abs(bucket.price - price) / price * 100 : 0;
        const memory = existing ?? { firstSeen: now, lastSeen: now, refreshes: 0 };
        memory.lastSeen = now;
        memory.refreshes += existing ? 1 : 0;
        this.wallMemory.set(key, memory);
        seen.add(key);
        const persistenceMs = now - memory.firstSeen;
        walls.push({
          id: key,
          side: side === "bid" ? "buy" : "sell",
          price: bucket.price,
          size,
          score: Math.min(100, (size / Math.max(average, 1)) * 16 + Math.max(0, 30 - distancePct * 20) + Math.min(24, persistenceMs / 1000)),
          distancePct,
          persistenceMs,
          state: existing ? "persisting" : "added"
        });
      }
    }

    for (const [key, memory] of this.wallMemory) {
      if (!seen.has(key) && now - memory.lastSeen > 15000) this.wallMemory.delete(key);
    }

    return walls.sort((a, b) => b.score - a.score).slice(0, 8);
  }

  private pushHeatmapFrame(buckets: DomBucket[], settings: DomSettings, time: number) {
    const max = Math.max(...buckets.map((bucket) => bucket.totalSize), 1);
    this.heatmap.push({
      time,
      cells: buckets.map((bucket) => ({
        price: bucket.price,
        side: bucket.askSize > bucket.bidSize ? "ask" : "bid",
        intensity: Math.min(1, bucket.totalSize / max) * (settings.colorIntensity / 100)
      }))
    });
    this.heatmap = this.heatmap.slice(-settings.maxHeatmapHistory);
    return this.heatmap;
  }
}

function buildBuckets(book: OrderBookSnapshot, bucketSize: number, price: number, settings: DomSettings): DomBucket[] {
  const map = new Map<number, DomBucket>();
  const ensure = (bucketPrice: number) => {
    const existing = map.get(bucketPrice);
    if (existing) return existing;
    const next: DomBucket = {
      price: bucketPrice,
      low: bucketPrice - bucketSize / 2,
      high: bucketPrice + bucketSize / 2,
      bidSize: 0,
      askSize: 0,
      totalSize: 0,
      bidDelta: 0,
      askDelta: 0,
      heat: 0,
      isBestBid: false,
      isBestAsk: false,
      isCurrentPrice: false
    };
    map.set(bucketPrice, next);
    return next;
  };

  for (const level of book.bids) {
    const bucketPrice = roundToBucket(level.price, bucketSize);
    const bucket = ensure(bucketPrice);
    bucket.bidSize += level.quantity;
  }

  for (const level of book.asks) {
    const bucketPrice = roundToBucket(level.price, bucketSize);
    const bucket = ensure(bucketPrice);
    bucket.askSize += level.quantity;
  }

  const bestBidBucket = book.bids[0] ? roundToBucket(book.bids[0].price, bucketSize) : null;
  const bestAskBucket = book.asks[0] ? roundToBucket(book.asks[0].price, bucketSize) : null;
  const rangePct = resolveVisibleRangePct(settings, price, bucketSize);
  const min = price * (1 - rangePct / 100);
  const max = price * (1 + rangePct / 100);
  const buckets = Array.from(map.values())
    .map((bucket) => ({
      ...bucket,
      totalSize: bucket.bidSize + bucket.askSize,
      isBestBid: bucket.price === bestBidBucket,
      isBestAsk: bucket.price === bestAskBucket,
      isCurrentPrice: price >= bucket.low && price <= bucket.high
    }))
    .filter((bucket) => bucket.price >= min && bucket.price <= max)
    .sort((a, b) => b.price - a.price);

  const maxSize = Math.max(...buckets.map((bucket) => bucket.totalSize), 1);
  return buckets
    .map((bucket) => ({ ...bucket, heat: bucket.totalSize / maxSize }))
    .slice(0, settings.maxVisibleBuckets);
}

function buildVolumeProfile(buckets: DomBucket[]): VolumeProfileNode[] {
  const volumes = buckets.map((bucket) => ({ price: bucket.price, volume: bucket.totalSize }));
  const max = Math.max(...volumes.map((node) => node.volume), 0);
  const average = volumes.reduce((sum, node) => sum + node.volume, 0) / Math.max(1, volumes.length);
  return volumes.map((node) => ({
    ...node,
    kind: node.volume === max ? "poc" : node.volume > average * 1.35 ? "hvn" : node.volume < average * 0.45 ? "lvn" : "normal"
  }));
}

function buildMetrics(buckets: DomBucket[], deltas: LiquidityDelta[], trades: TradeTick[], updateRate: number, bookTime: number): DomMetrics {
  const bid = buckets.reduce((sum, bucket) => sum + bucket.bidSize, 0);
  const ask = buckets.reduce((sum, bucket) => sum + bucket.askSize, 0);
  const total = bid + ask;
  const largeThreshold = Math.max(1, average(trades.map((trade) => trade.quantity)) * 2.5);
  const recent = Date.now() / 1000 - 60;
  return {
    orderBookImbalance: total ? ((bid - ask) / total) * 100 : 0,
    depthImbalance: total ? (bid / total) * 100 : 50,
    liquidityScore: Math.min(100, Math.sqrt(total) * 8),
    largeTradesLastMinute: trades.filter((trade) => trade.time >= recent && trade.quantity >= largeThreshold).length,
    bidStacked: deltas.reduce((sum, delta) => sum + delta.bidAdded, 0),
    askStacked: deltas.reduce((sum, delta) => sum + delta.askAdded, 0),
    bidPulled: deltas.reduce((sum, delta) => sum + delta.bidRemoved, 0),
    askPulled: deltas.reduce((sum, delta) => sum + delta.askRemoved, 0),
    updateRate,
    latencyMs: bookTime ? Math.max(0, Date.now() - bookTime * 1000) : 0
  };
}

function detectAbsorption(trades: TradeTick[], buckets: DomBucket[], deltas: LiquidityDelta[], price: number): AbsorptionSignal {
  const recent = trades.filter((trade) => Date.now() / 1000 - trade.time < 20);
  if (!recent.length || !price) return emptyAbsorption;
  const near = recent.filter((trade) => Math.abs(trade.price - price) / price < 0.0009);
  const aggressiveBuy = near.filter((trade) => trade.side === "buy").reduce((sum, trade) => sum + trade.quantity, 0);
  const aggressiveSell = near.filter((trade) => trade.side === "sell").reduce((sum, trade) => sum + trade.quantity, 0);
  const bidRefresh = deltas.reduce((sum, delta) => sum + delta.bidAdded, 0);
  const askRefresh = deltas.reduce((sum, delta) => sum + delta.askAdded, 0);
  const visibleAverage = average(buckets.map((bucket) => bucket.totalSize));
  const buyAbsorption = aggressiveBuy > visibleAverage && askRefresh > visibleAverage * 0.4;
  const sellAbsorption = aggressiveSell > visibleAverage && bidRefresh > visibleAverage * 0.4;
  const confidence = Math.min(1, Math.max(aggressiveBuy + aggressiveSell, askRefresh + bidRefresh) / Math.max(visibleAverage * 5, 1));

  if (buyAbsorption || sellAbsorption) {
    return {
      detected: true,
      side: buyAbsorption ? "ask" : "bid",
      price,
      confidence,
      label: "ABSORPTION DETECTED"
    };
  }

  return { ...emptyAbsorption, confidence };
}

function detectIceberg(trades: TradeTick[], buckets: DomBucket[], deltas: LiquidityDelta[], price: number): IcebergEstimate {
  if (!trades.length || !price) return { estimatedCount: 0, probability: "low", score: 0 };
  const repeatedPriceGroups = new Map<number, number>();
  for (const trade of trades.slice(0, 120)) {
    const key = Number(trade.price.toFixed(1));
    repeatedPriceGroups.set(key, (repeatedPriceGroups.get(key) ?? 0) + trade.quantity);
  }
  const repeatedVolume = Math.max(...Array.from(repeatedPriceGroups.values()), 0);
  const visibleAverage = Math.max(average(buckets.map((bucket) => bucket.totalSize)), 1);
  const refresh = deltas.reduce((sum, delta) => sum + delta.bidAdded + delta.askAdded, 0);
  const score = Math.min(1, repeatedVolume / (visibleAverage * 4) + refresh / (visibleAverage * 14));
  return {
    estimatedCount: score > 0.65 ? 3 : score > 0.35 ? 1 : 0,
    probability: score > 0.65 ? "high" : score > 0.35 ? "medium" : "low",
    score
  };
}

function resolveBucketSize(settings: DomSettings, tickSize: number) {
  if (settings.bucketMultiplier === "custom") return Math.max(tickSize, settings.customBucketSize);
  return Math.max(tickSize, tickSize * settings.bucketMultiplier);
}

function resolveVisibleRangePct(settings: DomSettings, price: number, bucketSize: number) {
  if (settings.visibleRange === "custom") return Math.max(0.05, settings.customVisibleRangePct);
  if (settings.visibleRange !== "auto") return Number(settings.visibleRange);
  if (!price) return 1;
  return Math.max(0.35, Math.min(5, (bucketSize * settings.maxVisibleBuckets * 0.5) / price * 100));
}

function inferTickSize(book: OrderBookSnapshot, symbol: MarketSymbol) {
  const explicit = symbol.pricePrecision !== undefined ? 1 / Math.pow(10, symbol.pricePrecision) : 0;
  const prices = [...book.bids.slice(0, 12), ...book.asks.slice(0, 12)].map((level) => level.price).sort((a, b) => a - b);
  let minDiff = Number.POSITIVE_INFINITY;
  for (let index = 1; index < prices.length; index += 1) {
    const diff = Math.abs(prices[index] - prices[index - 1]);
    if (diff > 0) minDiff = Math.min(minDiff, diff);
  }
  return Number.isFinite(minDiff) ? Math.max(explicit, Number(minDiff.toFixed(8))) : explicit || 0.1;
}

function roundToBucket(price: number, bucketSize: number) {
  return Number((Math.round(price / bucketSize) * bucketSize).toFixed(8));
}

function bucketKey(bucket: DomBucket) {
  return `${bucket.price}`;
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function standardDeviation(values: number[]) {
  const avg = average(values);
  const variance = values.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / Math.max(1, values.length);
  return Math.sqrt(variance);
}

function estimateMemoryKb(bucketCount: number, heatmapFrames: number, trades: number) {
  return Math.round((bucketCount * 120 + heatmapFrames * bucketCount * 24 + trades * 64) / 1024);
}
