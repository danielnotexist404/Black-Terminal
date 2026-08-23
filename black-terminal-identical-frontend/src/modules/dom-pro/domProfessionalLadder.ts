import type { OrderBookLevel, OrderBookSnapshot } from "../../market-data/types";
import type { WallDetection } from "./types";

export type ProfessionalDomSide = "ask" | "bid" | "mixed" | "empty";

export type ProfessionalDomRow = {
  key: string;
  price: number;
  priceLow: number;
  priceHigh: number;
  bidSize: number;
  askSize: number;
  totalSize: number;
  signedSize: number;
  delta: number;
  cumulativeSize: number;
  depthRatio: number;
  cumulativeRatio: number;
  side: ProfessionalDomSide;
  isCurrentPrice: boolean;
  isBestBid: boolean;
  isBestAsk: boolean;
  wall: WallDetection | null;
};

export type ProfessionalDomLadderModel = {
  identity: string;
  streamKey: string;
  rows: ProfessionalDomRow[];
  tickSize: number;
  requestedAggregationTicks: number;
  effectiveAggregationTicks: number;
  priceStep: number;
  priceDecimals: number;
  currentPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  coverageMin: number | null;
  coverageMax: number | null;
  totalBidSize: number;
  totalAskSize: number;
  bidLevels: number;
  askLevels: number;
  subscribedDepth: number | null;
  sequence: number | null;
  snapshotTimeMs: number | null;
  state: "live" | "stale" | "offline";
};

export type ProfessionalDomNodeMotion = {
  activity: number;
  energy: number;
  opacity: number;
  scaleX: number;
  scaleY: number;
  glowPx: number;
  brightness: number;
};

type ProfessionalDomLadderInput = {
  book: OrderBookSnapshot | null | undefined;
  currentPrice: number | null | undefined;
  aggregationTicks?: number;
  walls?: WallDetection[];
  bookStatus?: string;
  now?: number;
  staleAfterMs?: number;
  maximumRows?: number;
};

type AggregatedBook = {
  rows: Map<number, { bidSize: number; askSize: number }>;
  tickSize: number;
  requestedAggregationTicks: number;
  effectiveAggregationTicks: number;
  priceStep: number;
  minIndex: number;
  maxIndex: number;
  bestBid: number | null;
  bestAsk: number | null;
  totalBidSize: number;
  totalAskSize: number;
  bidLevels: number;
  askLevels: number;
};

type TrackerState = {
  identity: string;
  currentRows: Map<number, { bidSize: number; askSize: number }>;
  deltas: Map<number, number>;
};

const DEFAULT_AGGREGATION_TICKS = 20;
const DEFAULT_MAXIMUM_ROWS = 4_000;
const EPSILON = 1e-12;

/**
 * Keeps temporal DOM deltas stable across React rerenders. A repeated authoritative
 * snapshot is idempotent; it cannot be mistaken for a new zero-change snapshot.
 */
export class ProfessionalDomLadderTracker {
  private states = new Map<string, TrackerState>();

  update(input: ProfessionalDomLadderInput): ProfessionalDomLadderModel {
    const book = input.book;
    if (!book) return emptyProfessionalDomLadder(input.currentPrice ?? null, input.bookStatus);

    const aggregate = aggregateBook(book, input.currentPrice ?? null, input.aggregationTicks, input.maximumRows);
    const streamKey = `${book.exchange}:${book.symbol}:${stableNumber(aggregate.priceStep)}`;
    const identity = snapshotIdentity(book, aggregate.requestedAggregationTicks, aggregate.effectiveAggregationTicks);
    const previous = this.states.get(streamKey);
    let deltas: Map<number, number>;

    if (previous?.identity === identity) {
      deltas = previous.deltas;
    } else {
      deltas = new Map<number, number>();
      if (previous) {
        const indices = new Set([...aggregate.rows.keys(), ...previous.currentRows.keys()]);
        for (const index of indices) {
          const current = aggregate.rows.get(index) ?? ZERO_QUANTITY;
          const prior = previous.currentRows.get(index) ?? ZERO_QUANTITY;
          // Added bids and removed asks are positive; removed bids and added asks are negative.
          deltas.set(index, (current.bidSize - prior.bidSize) - (current.askSize - prior.askSize));
        }
      }
      this.states.set(streamKey, { identity, currentRows: aggregate.rows, deltas });
    }

    return finalizeModel(input, book, aggregate, deltas, identity, streamKey);
  }

  reset(exchange?: string, symbol?: string) {
    if (!exchange && !symbol) {
      this.states.clear();
      return;
    }
    const prefix = `${exchange ?? ""}:${symbol ?? ""}:`;
    for (const key of this.states.keys()) {
      if (key.startsWith(prefix)) this.states.delete(key);
    }
  }
}

export function buildProfessionalDomLadder(input: ProfessionalDomLadderInput): ProfessionalDomLadderModel {
  return new ProfessionalDomLadderTracker().update(input);
}

/**
 * Maps genuine snapshot-to-snapshot depth change into bounded presentation
 * energy. A steady book still communicates resting depth, while stale/offline
 * rows can never keep pulsing from their last known delta.
 */
export function resolveProfessionalDomNodeMotion(
  row: Pick<ProfessionalDomRow, "totalSize" | "delta" | "depthRatio">,
  live = true
): ProfessionalDomNodeMotion {
  const totalSize = Number.isFinite(row.totalSize) ? Math.max(0, row.totalSize) : 0;
  const depth = Number.isFinite(row.depthRatio) ? clamp(row.depthRatio, 0, 1) : 0;
  if (totalSize <= EPSILON) {
    return { activity: 0, energy: 0, opacity: 0.05, scaleX: 0.68, scaleY: 0.48, glowPx: 0, brightness: 0.82 };
  }

  const deltaMagnitude = live && Number.isFinite(row.delta) ? Math.abs(row.delta) : 0;
  const relativeChange = clamp(deltaMagnitude / Math.max(totalSize, deltaMagnitude, EPSILON), 0, 1);
  const activity = Math.sqrt(relativeChange);
  const energy = clamp(depth * 0.64 + activity * 0.36, 0, 1);
  return {
    activity,
    energy,
    opacity: clamp(0.16 + depth * 0.54 + activity * 0.30, 0.16, 1),
    scaleX: 0.74 + energy * 0.34,
    scaleY: 0.58 + energy * 0.42,
    glowPx: 1.5 + energy * 7.5,
    brightness: 0.9 + energy * 0.7
  };
}

function aggregateBook(book: OrderBookSnapshot, currentPrice: number | null, aggregationTicks = DEFAULT_AGGREGATION_TICKS, maximumRows = DEFAULT_MAXIMUM_ROWS): AggregatedBook {
  const bids = normalizeLevels(book.bids, "bid");
  const asks = normalizeLevels(book.asks, "ask");
  const tickSize = inferTickSize([...bids, ...asks]);
  const requestedAggregationTicks = clampInteger(aggregationTicks, 1, 10_000);
  const requestedStep = tickSize * requestedAggregationTicks;
  const sourcePrices = [...bids.map((level) => level.price), ...asks.map((level) => level.price)];
  if (currentPrice !== null && Number.isFinite(currentPrice) && currentPrice > 0) sourcePrices.push(currentPrice);
  const sourceMin = sourcePrices.length > 0 ? Math.min(...sourcePrices) : tickSize;
  const sourceMax = sourcePrices.length > 0 ? Math.max(...sourcePrices) : sourceMin;
  const requestedSpan = Math.max(1, Math.round((sourceMax - sourceMin) / Math.max(requestedStep, EPSILON)) + 1);
  const compression = Math.max(1, Math.ceil(requestedSpan / clampInteger(maximumRows, 100, 20_000)));
  const effectiveAggregationTicks = requestedAggregationTicks * compression;
  const priceStep = tickSize * effectiveAggregationTicks;
  const rows = new Map<number, { bidSize: number; askSize: number }>();

  const add = (level: OrderBookLevel, side: "bid" | "ask") => {
    const index = priceIndex(level.price, priceStep);
    const row = rows.get(index) ?? { bidSize: 0, askSize: 0 };
    if (side === "bid") row.bidSize += level.quantity;
    else row.askSize += level.quantity;
    rows.set(index, row);
  };
  bids.forEach((level) => add(level, "bid"));
  asks.forEach((level) => add(level, "ask"));

  const indices = [...rows.keys()];
  if (currentPrice !== null && Number.isFinite(currentPrice) && currentPrice > 0) indices.push(priceIndex(currentPrice, priceStep));
  const minIndex = indices.length > 0 ? Math.min(...indices) : 0;
  const maxIndex = indices.length > 0 ? Math.max(...indices) : 0;

  return {
    rows,
    tickSize,
    requestedAggregationTicks,
    effectiveAggregationTicks,
    priceStep,
    minIndex,
    maxIndex,
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    totalBidSize: bids.reduce((sum, level) => sum + level.quantity, 0),
    totalAskSize: asks.reduce((sum, level) => sum + level.quantity, 0),
    bidLevels: bids.length,
    askLevels: asks.length
  };
}

function finalizeModel(
  input: ProfessionalDomLadderInput,
  book: OrderBookSnapshot,
  aggregate: AggregatedBook,
  deltas: Map<number, number>,
  identity: string,
  streamKey: string
): ProfessionalDomLadderModel {
  const currentPrice = finitePositive(input.currentPrice) ?? midpoint(aggregate.bestBid, aggregate.bestAsk);
  const currentIndex = currentPrice === null ? null : priceIndex(currentPrice, aggregate.priceStep);
  const bestBidIndex = aggregate.bestBid === null ? null : priceIndex(aggregate.bestBid, aggregate.priceStep);
  const bestAskIndex = aggregate.bestAsk === null ? null : priceIndex(aggregate.bestAsk, aggregate.priceStep);
  const wallsByIndex = mapWalls(input.walls ?? [], aggregate.priceStep);
  const cumulativeByIndex = new Map<number, number>();
  let bidCumulative = 0;
  for (let index = bestBidIndex ?? aggregate.maxIndex; index >= aggregate.minIndex; index -= 1) {
    bidCumulative += aggregate.rows.get(index)?.bidSize ?? 0;
    cumulativeByIndex.set(index, bidCumulative);
  }
  let askCumulative = 0;
  for (let index = bestAskIndex ?? aggregate.minIndex; index <= aggregate.maxIndex; index += 1) {
    askCumulative += aggregate.rows.get(index)?.askSize ?? 0;
    cumulativeByIndex.set(index, askCumulative);
  }

  const rawDepth = [...aggregate.rows.values()].map((row) => Math.max(row.bidSize, row.askSize)).filter((value) => value > 0);
  const depthReference = percentile(rawDepth, 0.95);
  const rows: ProfessionalDomRow[] = [];
  for (let index = aggregate.maxIndex; index >= aggregate.minIndex; index -= 1) {
    const quantity = aggregate.rows.get(index) ?? ZERO_QUANTITY;
    const price = normalizeFloatingPoint(index * aggregate.priceStep, aggregate.tickSize);
    const side = classifySide(quantity.bidSize, quantity.askSize);
    const cumulativeSize = cumulativeByIndex.get(index) ?? 0;
    const cumulativeReference = side === "ask" ? aggregate.totalAskSize : side === "bid" ? aggregate.totalBidSize : Math.max(aggregate.totalBidSize, aggregate.totalAskSize);
    rows.push({
      key: `${streamKey}:${index}`,
      price,
      priceLow: price - aggregate.priceStep / 2,
      priceHigh: price + aggregate.priceStep / 2,
      bidSize: quantity.bidSize,
      askSize: quantity.askSize,
      totalSize: quantity.bidSize + quantity.askSize,
      signedSize: quantity.bidSize - quantity.askSize,
      delta: deltas.get(index) ?? 0,
      cumulativeSize,
      depthRatio: depthRatio(Math.max(quantity.bidSize, quantity.askSize), depthReference),
      cumulativeRatio: cumulativeReference > EPSILON ? clamp(cumulativeSize / cumulativeReference, 0, 1) : 0,
      side,
      isCurrentPrice: currentIndex === index,
      isBestBid: bestBidIndex === index,
      isBestAsk: bestAskIndex === index,
      wall: wallsByIndex.get(index) ?? null
    });
  }

  const snapshotTimeMs = normalizeTimestamp(book.time);
  const now = input.now ?? Date.now();
  const offline = /AWAITING|UNAVAILABLE|OFFLINE|NO BOOK/i.test(input.bookStatus ?? "") || rows.length === 0;
  const stale = !offline && (snapshotTimeMs === null || now - snapshotTimeMs > (input.staleAfterMs ?? 10_000) || /STALE|CACHE/i.test(input.bookStatus ?? ""));
  return {
    identity,
    streamKey,
    rows,
    tickSize: aggregate.tickSize,
    requestedAggregationTicks: aggregate.requestedAggregationTicks,
    effectiveAggregationTicks: aggregate.effectiveAggregationTicks,
    priceStep: aggregate.priceStep,
    priceDecimals: decimalsForStep(aggregate.priceStep),
    currentPrice,
    bestBid: aggregate.bestBid,
    bestAsk: aggregate.bestAsk,
    spread: aggregate.bestBid !== null && aggregate.bestAsk !== null ? Math.max(0, aggregate.bestAsk - aggregate.bestBid) : null,
    coverageMin: rows.at(-1)?.price ?? null,
    coverageMax: rows[0]?.price ?? null,
    totalBidSize: aggregate.totalBidSize,
    totalAskSize: aggregate.totalAskSize,
    bidLevels: aggregate.bidLevels,
    askLevels: aggregate.askLevels,
    subscribedDepth: book.subscribedDepth ?? null,
    sequence: book.sequence ?? book.updateId ?? null,
    snapshotTimeMs,
    state: offline ? "offline" : stale ? "stale" : "live"
  };
}

function emptyProfessionalDomLadder(currentPrice: number | null, bookStatus = ""): ProfessionalDomLadderModel {
  return {
    identity: `offline:${bookStatus}`,
    streamKey: "offline",
    rows: [],
    tickSize: 1,
    requestedAggregationTicks: DEFAULT_AGGREGATION_TICKS,
    effectiveAggregationTicks: DEFAULT_AGGREGATION_TICKS,
    priceStep: DEFAULT_AGGREGATION_TICKS,
    priceDecimals: 2,
    currentPrice,
    bestBid: null,
    bestAsk: null,
    spread: null,
    coverageMin: null,
    coverageMax: null,
    totalBidSize: 0,
    totalAskSize: 0,
    bidLevels: 0,
    askLevels: 0,
    subscribedDepth: null,
    sequence: null,
    snapshotTimeMs: null,
    state: "offline"
  };
}

function normalizeLevels(levels: OrderBookLevel[], side: "bid" | "ask") {
  return levels
    .filter((level) => finitePositive(level.price) !== null && Number.isFinite(level.quantity) && level.quantity > 0)
    .slice()
    .sort((left, right) => side === "bid" ? right.price - left.price : left.price - right.price)
    .slice(0, 5_000);
}

function inferTickSize(levels: OrderBookLevel[]) {
  const unique = [...new Set(levels.map((level) => level.price).filter((price) => Number.isFinite(price) && price > 0))].sort((left, right) => left - right);
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < unique.length; index += 1) {
    const difference = unique[index] - unique[index - 1];
    if (difference > EPSILON && difference < minimum) minimum = difference;
  }
  if (Number.isFinite(minimum)) return normalizeTick(minimum);
  const price = unique[0] ?? 1;
  return price >= 10_000 ? 0.1 : price >= 100 ? 0.01 : price >= 1 ? 0.001 : 0.000001;
}

function normalizeTick(value: number) {
  // Venue JSON prices commonly produce binary residues such as 0.099999999991.
  // Eight significant digits preserves genuine fractional ticks while restoring
  // their canonical decimal grid (0.1 in this example).
  return Math.max(EPSILON, Number(value.toPrecision(8)));
}

function mapWalls(walls: WallDetection[], priceStep: number) {
  const mapped = new Map<number, WallDetection>();
  for (const wall of walls) {
    if (!Number.isFinite(wall.price) || wall.price <= 0) continue;
    const index = priceIndex(wall.price, priceStep);
    const existing = mapped.get(index);
    if (!existing || wall.score > existing.score) mapped.set(index, wall);
  }
  return mapped;
}

function snapshotIdentity(book: OrderBookSnapshot, requestedAggregationTicks: number, effectiveAggregationTicks: number) {
  let hash = 2166136261;
  const mix = (value: number) => {
    const normalized = Math.round(value * 1e8);
    hash ^= normalized & 0xffffffff;
    hash = Math.imul(hash, 16777619);
  };
  for (const level of book.bids) { mix(level.price); mix(level.quantity); }
  hash ^= 0x9e3779b9;
  for (const level of book.asks) { mix(level.price); mix(level.quantity); }
  return `${book.exchange}:${book.symbol}:${book.sequence ?? book.updateId ?? "na"}:${book.time}:${requestedAggregationTicks}:${effectiveAggregationTicks}:${(hash >>> 0).toString(36)}`;
}

function classifySide(bidSize: number, askSize: number): ProfessionalDomSide {
  if (bidSize > 0 && askSize > 0) return "mixed";
  if (askSize > 0) return "ask";
  if (bidSize > 0) return "bid";
  return "empty";
}

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return 1;
  const sorted = values.slice().sort((left, right) => left - right);
  return Math.max(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))], EPSILON);
}

function depthRatio(size: number, reference: number) {
  if (size <= 0) return 0;
  return clamp(Math.sqrt(size / Math.max(reference, EPSILON)), 0.025, 1);
}

function priceIndex(price: number, step: number) {
  return Math.round(price / Math.max(step, EPSILON));
}

function normalizeTimestamp(time: number) {
  if (!Number.isFinite(time) || time <= 0) return null;
  return time > 10_000_000_000 ? time : time * 1_000;
}

function decimalsForStep(step: number) {
  if (!Number.isFinite(step) || step <= 0) return 2;
  for (let decimals = 0; decimals <= 8; decimals += 1) {
    if (Math.abs(step * 10 ** decimals - Math.round(step * 10 ** decimals)) < 1e-8) return decimals;
  }
  return 8;
}

function normalizeFloatingPoint(value: number, tickSize: number) {
  return Number(value.toFixed(Math.min(10, Math.max(0, decimalsForStep(tickSize) + 2))));
}

function finitePositive(value: number | null | undefined) {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

function midpoint(bestBid: number | null, bestAsk: number | null) {
  if (bestBid !== null && bestAsk !== null) return (bestBid + bestAsk) / 2;
  return bestBid ?? bestAsk;
}

function stableNumber(value: number) {
  return Number(value.toPrecision(12)).toString();
}

function clampInteger(value: number, min: number, max: number) {
  return Math.round(clamp(Number.isFinite(value) ? value : min, min, max));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const ZERO_QUANTITY = Object.freeze({ bidSize: 0, askSize: 0 });
