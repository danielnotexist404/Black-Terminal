import type { OrderBookSnapshot } from "../../market-data/types";

export type BookHeatmapRejectionReason =
  | "invalid_timestamp"
  | "invalid_level"
  | "duplicate_level"
  | "empty_book"
  | "crossed_book"
  | "uncertified_quantity_unit";

export type CompactedBookSnapshot = {
  accepted: true;
  venue: string;
  symbol: string;
  sourceAt: number;
  receivedAt: number;
  sequence?: number;
  updateId?: number;
  subscribedDepth?: number;
  bucketSize: number;
  buckets: Float64Array;
} | {
  accepted: false;
  venue: string;
  symbol: string;
  sourceAt: number;
  receivedAt: number;
  sequence?: number;
  reason: BookHeatmapRejectionReason;
  invalidLevels: number;
  duplicateLevels: number;
};

// These adapters expose base-asset quantity for the normalized snapshots used by
// the main chart. Other venues remain unavailable until their contract value and
// quantity semantics are carried through the normalized market-data contract.
const CERTIFIED_BASE_QUANTITY_VENUES = new Set(["binance", "binance-us", "bybit", "hyperliquid"]);

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function toEpochMs(value: number) {
  if (!Number.isFinite(value)) return Number.NaN;
  return value < 10_000_000_000 ? value * 1000 : value;
}

function niceBucketSize(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const normalized = value / base;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * base;
}

function resolveBucketSize(
  bids: Array<{ price: number; quantity: number }>,
  asks: Array<{ price: number; quantity: number }>,
  midPrice: number
) {
  const prices = [...bids.slice(0, 80), ...asks.slice(0, 80)].map((level) => level.price).sort((a, b) => a - b);
  let smallestTick = Number.POSITIVE_INFINITY;
  for (let index = 1; index < prices.length; index += 1) {
    const difference = prices[index] - prices[index - 1];
    if (difference > 0) smallestTick = Math.min(smallestTick, difference);
  }
  const nativeTick = Number.isFinite(smallestTick) ? smallestTick : midPrice * 0.00001;
  return niceBucketSize(Math.max(nativeTick * 4, midPrice * 0.00004, 0.00000001));
}

function inspectLevels(levels: Array<{ price: number; quantity: number }>) {
  const prices = new Set<number>();
  let invalidLevels = 0;
  let duplicateLevels = 0;
  for (const level of levels) {
    if (!finitePositive(level.price) || !finitePositive(level.quantity)) {
      invalidLevels += 1;
      continue;
    }
    if (prices.has(level.price)) duplicateLevels += 1;
    prices.add(level.price);
  }
  return { invalidLevels, duplicateLevels };
}

export function compactBookSnapshot(snapshot: OrderBookSnapshot, receivedAt = Date.now()): CompactedBookSnapshot {
  const sourceAt = toEpochMs(snapshot.time);
  const base = {
    venue: snapshot.exchange,
    symbol: snapshot.symbol,
    sourceAt,
    receivedAt,
    sequence: snapshot.sequence
  };
  const bidInspection = inspectLevels(snapshot.bids);
  const askInspection = inspectLevels(snapshot.asks);
  const invalidLevels = bidInspection.invalidLevels + askInspection.invalidLevels;
  const duplicateLevels = bidInspection.duplicateLevels + askInspection.duplicateLevels;
  const reject = (reason: BookHeatmapRejectionReason): CompactedBookSnapshot => ({
    accepted: false,
    ...base,
    reason,
    invalidLevels,
    duplicateLevels
  });

  if (!Number.isFinite(sourceAt)) return reject("invalid_timestamp");
  if (!CERTIFIED_BASE_QUANTITY_VENUES.has(snapshot.exchange)) return reject("uncertified_quantity_unit");
  if (invalidLevels > 0) return reject("invalid_level");
  if (duplicateLevels > 0) return reject("duplicate_level");

  const bids = snapshot.bids.slice().sort((a, b) => b.price - a.price);
  const asks = snapshot.asks.slice().sort((a, b) => a.price - b.price);
  const bestBid = bids[0]?.price;
  const bestAsk = asks[0]?.price;
  if (!finitePositive(bestBid) || !finitePositive(bestAsk)) return reject("empty_book");
  if (bestBid >= bestAsk) return reject("crossed_book");

  const bucketSize = resolveBucketSize(bids, asks, (bestBid + bestAsk) / 2);
  const grouped = new Map<number, [number, number]>();
  const add = (side: "bid" | "ask", price: number, quantity: number) => {
    const bucket = Math.round(price / bucketSize) * bucketSize;
    const current = grouped.get(bucket) ?? [0, 0];
    current[side === "bid" ? 0 : 1] += price * quantity;
    grouped.set(bucket, current);
  };
  bids.slice(0, 400).forEach((level) => add("bid", level.price, level.quantity));
  asks.slice(0, 400).forEach((level) => add("ask", level.price, level.quantity));
  const values = [...grouped.entries()].sort(([left], [right]) => left - right);
  const buckets = new Float64Array(values.length * 3);
  values.forEach(([price, [bid, ask]], index) => {
    buckets[index * 3] = price;
    buckets[index * 3 + 1] = bid;
    buckets[index * 3 + 2] = ask;
  });

  return {
    accepted: true,
    ...base,
    updateId: snapshot.updateId,
    subscribedDepth: snapshot.subscribedDepth,
    bucketSize,
    buckets
  };
}
