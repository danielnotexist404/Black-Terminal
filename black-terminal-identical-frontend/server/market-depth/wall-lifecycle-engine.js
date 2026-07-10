import { MARKET_DEPTH_COMPRESSION_VERSION } from "./types.js";

export function detectWallLifecycle(sample, compressed, previousWalls = new Map()) {
  const candidates = selectWallCandidates(sample, compressed.bucketSize);
  const walls = [];
  const events = [];
  const nextMemory = new Map(previousWalls);
  const now = sample.capturedAt;

  for (const candidate of candidates) {
    const key = wallKey(sample, candidate.side, candidate.priceBucket);
    const previous = previousWalls.get(key);
    const ageMs = previous ? now - previous.firstSeenAt : 0;
    const previousSize = previous?.currentSize ?? 0;
    const status = deriveStatus(candidate.size, previousSize, ageMs);
    const confidence = wallConfidence(candidate, previous, sample.midPrice);
    const spoofProbability = spoofProbabilityScore(candidate, previous, ageMs);
    const gravityScore = gravityScoreFor(candidate, sample.midPrice);
    const reliabilityScore = reliabilityScoreFor(confidence, spoofProbability, previous, ageMs);
    const wall = {
      wallKey: key,
      venue: sample.venue,
      marketKind: sample.marketKind,
      symbol: sample.symbol,
      side: candidate.side,
      status,
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastSeenAt: now,
      currentPrice: candidate.priceBucket,
      peakSize: Math.max(previous?.peakSize ?? 0, candidate.size),
      currentSize: candidate.size,
      touches: (previous?.touches ?? 0) + (candidate.nearMarket ? 1 : 0),
      executedVolume: previous?.executedVolume ?? 0,
      confidence,
      spoofProbability,
      reliabilityScore,
      gravityScore,
      compressionVersion: MARKET_DEPTH_COMPRESSION_VERSION,
      metadata: {
        bucketSize: compressed.bucketSize,
        distancePct: candidate.distancePct,
        observationCount: (previous?.metadata?.observationCount ?? 0) + 1
      }
    };
    nextMemory.set(key, wall);
    walls.push(wall);

    const eventType = eventTypeFor(wall, previous);
    if (eventType) {
      events.push({
        venue: sample.venue,
        marketKind: sample.marketKind,
        symbol: sample.symbol,
        eventType,
        side: candidate.side,
        price: candidate.priceBucket,
        priceBucket: candidate.priceBucket,
        size: candidate.size,
        confidence,
        wallKey: key,
        occurredAt: now,
        resolution: "1s",
        metadata: {
          previousSize,
          status,
          gravityScore,
          reliabilityScore,
          spoofProbability
        }
      });
    }
  }

  for (const [key, previous] of previousWalls.entries()) {
    if (nextMemory.get(key)?.lastSeenAt === now) continue;
    const staleMs = now - previous.lastSeenAt;
    if (staleMs < 60_000) continue;
    const status = staleMs > 5 * 60_000 ? "PULLED" : "WEAKENING";
    const nextWall = {
      ...previous,
      status,
      currentSize: previous.currentSize * 0.65,
      spoofProbability: Math.min(1, previous.spoofProbability + 0.08),
      reliabilityScore: Math.max(0, previous.reliabilityScore - 0.08),
      lastSeenAt: previous.lastSeenAt
    };
    nextMemory.set(key, nextWall);
    if (status === "PULLED") {
      events.push({
        venue: previous.venue,
        marketKind: previous.marketKind,
        symbol: previous.symbol,
        eventType: "WALL_PULLED",
        side: previous.side,
        price: previous.currentPrice,
        priceBucket: previous.currentPrice,
        size: previous.currentSize,
        confidence: nextWall.confidence,
        wallKey: key,
        occurredAt: now,
        resolution: "1s",
        metadata: { staleMs }
      });
    }
  }

  return { walls, events, nextMemory };
}

function selectWallCandidates(sample, bucketSize) {
  const bidMax = Math.max(...sample.bids.map((level) => level.quantity), 1);
  const askMax = Math.max(...sample.asks.map((level) => level.quantity), 1);
  const sideCandidates = [
    ...rankSide(sample.bids, "buy", bidMax, sample.midPrice, bucketSize),
    ...rankSide(sample.asks, "sell", askMax, sample.midPrice, bucketSize)
  ];
  return sideCandidates.sort((a, b) => b.score - a.score).slice(0, 32);
}

function rankSide(levels, side, maxSize, midPrice, bucketSize) {
  const average = levels.reduce((sum, level) => sum + level.quantity, 0) / Math.max(levels.length, 1);
  const threshold = Math.max(average * 1.35, maxSize * 0.18);
  return levels
    .filter((level) => level.quantity >= threshold)
    .map((level) => {
      const distancePct = midPrice ? Math.abs(level.price - midPrice) / midPrice : 0;
      const sizeScore = level.quantity / maxSize;
      return {
        side,
        priceBucket: Math.round(level.price / bucketSize) * bucketSize,
        size: level.quantity,
        distancePct,
        nearMarket: distancePct < 0.004,
        score: sizeScore / (1 + distancePct * 30)
      };
    });
}

function deriveStatus(size, previousSize, ageMs) {
  if (!previousSize) return "ACTIVE";
  if (size > previousSize * 1.2) return "GROWING";
  if (size < previousSize * 0.65) return "WEAKENING";
  if (ageMs > 30 * 60_000) return "ACTIVE";
  return "ACTIVE";
}

function eventTypeFor(wall, previous) {
  if (!previous) return "WALL_APPEARED";
  if (wall.currentSize > previous.currentSize * 1.35) return "WALL_STRENGTHENED";
  if (wall.currentSize < previous.currentSize * 0.6) return "WALL_WEAKENED";
  return null;
}

function wallConfidence(candidate, previous, midPrice) {
  const ageBoost = previous ? Math.min(0.28, 0.12 + (previous.metadata?.observationCount ?? 0) * 0.012) : 0;
  const distancePenalty = Math.min(0.25, candidate.distancePct * 6);
  const gravity = gravityScoreFor(candidate, midPrice);
  return Math.max(0.05, Math.min(1, 0.48 + candidate.score * 0.28 + gravity * 0.2 + ageBoost - distancePenalty));
}

function spoofProbabilityScore(candidate, previous, ageMs) {
  const youngPenalty = ageMs < 30_000 ? 0.22 : 0;
  const pullHistory = previous?.status === "PULLED" ? 0.28 : 0;
  const distancePenalty = candidate.distancePct > 0.08 ? 0.08 : 0;
  return Math.max(0, Math.min(1, youngPenalty + pullHistory + distancePenalty));
}

function reliabilityScoreFor(confidence, spoofProbability, previous, ageMs) {
  const persistence = Math.min(0.25, ageMs / (60 * 60_000) * 0.1);
  const touches = Math.min(0.18, (previous?.touches ?? 0) * 0.03);
  return Math.max(0, Math.min(1, confidence * 0.65 + persistence + touches - spoofProbability * 0.35));
}

function gravityScoreFor(candidate, midPrice) {
  const distance = midPrice ? Math.abs(candidate.priceBucket - midPrice) / midPrice : 0;
  return Math.max(0, Math.min(1, candidate.score / (1 + distance * 40)));
}

function wallKey(sample, side, priceBucket) {
  return [sample.venue, sample.marketKind, sample.symbol, side, priceBucket.toFixed(8)].join(":");
}
