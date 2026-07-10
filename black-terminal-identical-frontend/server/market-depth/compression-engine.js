import { MARKET_DEPTH_COMPRESSION_VERSION, depthResolutions, floorTime } from "./types.js";
import { resolveBucketSize } from "./normalizer.js";

const levelLimit = 140;

export function compressDepthSample(sample, options = {}) {
  const bucketSize = Number(options.bucketSize) > 0 ? Number(options.bucketSize) : resolveBucketSize(sample, options.bucketMultiplier ?? 25);
  const timestamp = sample.capturedAt;
  const levels = [...sample.bids.slice(0, levelLimit), ...sample.asks.slice(0, levelLimit)];
  const maxBid = Math.max(...sample.bids.slice(0, levelLimit).map((level) => level.quantity), 1);
  const maxAsk = Math.max(...sample.asks.slice(0, levelLimit).map((level) => level.quantity), 1);
  const grouped = new Map();

  for (const level of levels) {
    const priceBucket = roundToBucket(level.price, bucketSize);
    const key = `${priceBucket}`;
    const current = grouped.get(key) ?? {
      priceBucket,
      bucketSize,
      bidSize: 0,
      askSize: 0,
      bidPeakSize: 0,
      askPeakSize: 0,
      observations: 0
    };
    if (level.side === "bid") {
      current.bidSize += level.quantity;
      current.bidPeakSize = Math.max(current.bidPeakSize, level.quantity);
    } else {
      current.askSize += level.quantity;
      current.askPeakSize = Math.max(current.askPeakSize, level.quantity);
    }
    current.observations += 1;
    grouped.set(key, current);
  }

  const rollups = [];
  for (const resolution of ["1s", "10s", "1m"]) {
    const config = depthResolutions[resolution];
    const bucketStart = floorTime(timestamp, resolution);
    const bucketEnd = bucketStart + config.ms;
    for (const bucket of grouped.values()) {
      const bidStrength = bucket.bidPeakSize / maxBid;
      const askStrength = bucket.askPeakSize / maxAsk;
      const liquidityScore = Math.min(1, Math.max(bidStrength, askStrength));
      rollups.push({
        venue: sample.venue,
        marketKind: sample.marketKind,
        symbol: sample.symbol,
        bucketStart,
        bucketEnd,
        resolution,
        priceBucket: bucket.priceBucket,
        bucketSize: bucket.bucketSize,
        bidSize: bucket.bidSize,
        askSize: bucket.askSize,
        bidPeakSize: bucket.bidPeakSize,
        askPeakSize: bucket.askPeakSize,
        observations: bucket.observations,
        liquidityScore,
        gravityScore: liquidityGravity(bucket, sample.midPrice),
        compressionVersion: MARKET_DEPTH_COMPRESSION_VERSION,
        retentionTier: config.retentionTier,
        metadata: {
          bestBid: sample.bestBid,
          bestAsk: sample.bestAsk,
          midPrice: sample.midPrice
        }
      });
    }
  }

  return {
    bucketSize,
    snapshot: {
      venue: sample.venue,
      marketKind: sample.marketKind,
      symbol: sample.symbol,
      exchangeSymbol: sample.exchangeSymbol,
      capturedAt: timestamp,
      sourceTimestamp: sample.sourceTimestamp,
      sequence: sample.sequence,
      checksum: sample.checksum,
      bestBid: sample.bestBid,
      bestAsk: sample.bestAsk,
      midPrice: sample.midPrice,
      spread: sample.spread,
      depthLevels: {
        bids: sample.bids.slice(0, 60),
        asks: sample.asks.slice(0, 60)
      },
      compressionVersion: MARKET_DEPTH_COMPRESSION_VERSION,
      retentionTier: "raw-hours",
      metadata: sample.metadata
    },
    rollups,
    statistics: buildStatistics(sample, rollups, bucketSize)
  };
}

export function buildDepthDeltas(previous, current) {
  if (!previous) return [];
  const now = current.capturedAt;
  const next = [];
  for (const side of ["bid", "ask"]) {
    const previousMap = levelMap(previous[side === "bid" ? "bids" : "asks"]);
    const currentMap = levelMap(current[side === "bid" ? "bids" : "asks"]);
    for (const [price, quantity] of currentMap.entries()) {
      const oldQuantity = previousMap.get(price) ?? 0;
      const delta = quantity - oldQuantity;
      if (Math.abs(delta) <= 0) continue;
      next.push({
        venue: current.venue,
        marketKind: current.marketKind,
        symbol: current.symbol,
        capturedAt: now,
        side,
        price,
        quantity,
        deltaSize: delta,
        action: oldQuantity === 0 ? "add" : "update",
        sequence: current.sequence,
        resolution: "raw",
        compressionVersion: MARKET_DEPTH_COMPRESSION_VERSION,
        retentionTier: "raw-hours",
        metadata: { previousQuantity: oldQuantity }
      });
    }
    for (const [price, quantity] of previousMap.entries()) {
      if (currentMap.has(price)) continue;
      next.push({
        venue: current.venue,
        marketKind: current.marketKind,
        symbol: current.symbol,
        capturedAt: now,
        side,
        price,
        quantity: 0,
        deltaSize: -quantity,
        action: "remove",
        sequence: current.sequence,
        resolution: "raw",
        compressionVersion: MARKET_DEPTH_COMPRESSION_VERSION,
        retentionTier: "raw-hours",
        metadata: { previousQuantity: quantity }
      });
    }
  }
  return next.slice(0, 240);
}

function buildStatistics(sample, rollups, bucketSize) {
  const totalBidSize = sample.bids.reduce((sum, level) => sum + level.quantity, 0);
  const totalAskSize = sample.asks.reduce((sum, level) => sum + level.quantity, 0);
  const denominator = Math.max(totalBidSize + totalAskSize, 1);
  return ["1s", "10s", "1m"].map((resolution) => {
    const bucketStart = floorTime(sample.capturedAt, resolution);
    return {
      venue: sample.venue,
      marketKind: sample.marketKind,
      symbol: sample.symbol,
      resolution,
      bucketStart,
      bucketEnd: bucketStart + depthResolutions[resolution].ms,
      bestBid: sample.bestBid,
      bestAsk: sample.bestAsk,
      midPrice: sample.midPrice,
      spread: sample.spread,
      totalBidSize,
      totalAskSize,
      imbalance: (totalBidSize - totalAskSize) / denominator,
      liquidityScore: Math.min(1, rollups.reduce((max, row) => Math.max(max, row.liquidityScore), 0)),
      updateCount: 1,
      packetLossCount: 0,
      reconnectCount: 0,
      latencyMs: Math.max(0, Date.now() - sample.sourceTimestamp),
      metadata: { bucketSize }
    };
  });
}

function liquidityGravity(bucket, midPrice) {
  const price = bucket.priceBucket;
  const distancePct = midPrice ? Math.abs(price - midPrice) / midPrice : 0;
  const sizeScore = Math.min(1, Math.max(bucket.bidPeakSize, bucket.askPeakSize) / Math.max(bucket.bidSize + bucket.askSize, 1));
  return Math.max(0, Math.min(1, sizeScore / (1 + distancePct * 55)));
}

function levelMap(levels) {
  return new Map(levels.slice(0, levelLimit).map((level) => [level.price, level.quantity]));
}

function roundToBucket(price, bucketSize) {
  return Math.round(price / bucketSize) * bucketSize;
}
