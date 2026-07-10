import { normalizeMarketKind, normalizeSymbol, normalizeVenue } from "./types.js";

export function normalizeDepthSample(input) {
  const venue = normalizeVenue(input.venue || input.exchange);
  const symbol = normalizeSymbol(input.symbol);
  const marketKind = normalizeMarketKind(input.marketKind);
  const capturedAt = toTimestampMs(input.capturedAt ?? input.time ?? Date.now());
  const sourceTimestamp = toTimestampMs(input.sourceTimestamp ?? input.sourceTs ?? capturedAt);
  const bids = normalizeLevels(input.bids, "bid").sort((a, b) => b.price - a.price);
  const asks = normalizeLevels(input.asks, "ask").sort((a, b) => a.price - b.price);

  if (!venue) throw validationError("Missing depth venue.");
  if (!symbol) throw validationError("Missing depth symbol.");
  if (!bids.length || !asks.length) throw validationError("Depth sample requires bid and ask levels.");

  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk || null;

  return {
    venue,
    marketKind,
    symbol,
    exchangeSymbol: normalizeSymbol(input.exchangeSymbol || input.symbol),
    capturedAt,
    sourceTimestamp,
    sequence: input.sequence ?? input.seq ?? null,
    checksum: input.checksum ?? null,
    bids,
    asks,
    bestBid,
    bestAsk,
    midPrice,
    spread: bestBid && bestAsk ? bestAsk - bestBid : null,
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {}
  };
}

export function inferTickSize(sample) {
  const prices = [...sample.bids.slice(0, 30), ...sample.asks.slice(0, 30)]
    .map((level) => level.price)
    .filter((price) => Number.isFinite(price) && price > 0)
    .sort((a, b) => a - b);
  const diffs = prices
    .map((price, index) => index === 0 ? 0 : price - prices[index - 1])
    .filter((diff) => Number.isFinite(diff) && diff > 0);
  if (diffs.length) return Math.min(...diffs);
  return Math.max((sample.midPrice ?? prices[0] ?? 1) * 0.00001, 0.01);
}

export function resolveBucketSize(sample, multiplier = 25) {
  const tick = inferTickSize(sample);
  const mid = Math.max(sample.midPrice ?? sample.bestBid ?? sample.bestAsk ?? 1, 1);
  return Math.max(tick * multiplier, mid * 0.00005, 0.01);
}

function normalizeLevels(levels, side) {
  if (!Array.isArray(levels)) return [];
  return levels
    .map((level) => {
      if (Array.isArray(level)) return { price: Number(level[0]), quantity: Number(level[1]), side };
      return { price: Number(level.price ?? level.px), quantity: Number(level.quantity ?? level.size ?? level.sz), side };
    })
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.quantity) && level.quantity > 0);
}

function toTimestampMs(value) {
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Date.now();
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
