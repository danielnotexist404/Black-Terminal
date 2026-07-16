import type { OrderBookLevel } from "../../market-data/types";
import type { DomProPriceCamera } from "./domPriceCamera";
import { domPriceBucketAt } from "./domPriceCamera.ts";
import type { AggregatedDomSnapshot, WallDetection } from "./types";

export type DomLiveCoverageState = "live" | "unavailable" | "stale" | "offline";

export type DomLiveBookCoverage = {
  min: number | null;
  max: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  bidLevels: number;
  askLevels: number;
  subscribedDepth: number | null;
  sequence: number | null;
  snapshotTime: number | null;
  ageMs: number | null;
  state: Exclude<DomLiveCoverageState, "unavailable">;
};

export type DomLadderRow = {
  key: string;
  price: number;
  priceLow: number;
  priceHigh: number;
  centerPrice: number;
  topPct: number;
  heightPct: number;
  bidSize: number;
  askSize: number;
  totalSize: number;
  netDepth: number;
  bidDepth: number;
  askDepth: number;
  coverage: DomLiveCoverageState;
  isCurrentPrice: boolean;
  isBestBid: boolean;
  isBestAsk: boolean;
  wall: WallDetection | null;
};

export type DomLadderModel = {
  cameraVersion: string;
  rows: DomLadderRow[];
  priceStep: number;
  coverage: DomLiveBookCoverage;
  visibleRows: number;
};

type LadderQuantity = { bidSize: number; askSize: number };

type BuildDomLadderInput = {
  snapshot: AggregatedDomSnapshot;
  camera: DomProPriceCamera;
  walls?: WallDetection[];
  bookStatus?: string;
  now?: number;
  staleAfterMs?: number;
  minimumSize?: number;
  hideUncovered?: boolean;
};

export function buildDomLadderModel({
  snapshot,
  camera,
  walls = [],
  bookStatus = "",
  now = Date.now(),
  staleAfterMs = 10_000,
  minimumSize = 0,
  hideUncovered = false
}: BuildDomLadderInput): DomLadderModel {
  const book = snapshot.sourceBook;
  const bids = normalizeLevels(book?.bids ?? [], "bid");
  const asks = normalizeLevels(book?.asks ?? [], "ask");
  const snapshotTime = book?.time && Number.isFinite(book.time) ? book.time * 1000 : null;
  const ageMs = snapshotTime === null ? null : Math.max(0, now - snapshotTime);
  const offline = !book || /AWAITING|UNAVAILABLE|OFFLINE|NO BOOK/i.test(bookStatus);
  const stale = !offline && (ageMs === null || ageMs > staleAfterMs || /STALE|CACHE/i.test(bookStatus));
  const coverageState: DomLiveBookCoverage["state"] = offline ? "offline" : stale ? "stale" : "live";
  const minBid = bids.length ? Math.min(...bids.map((level) => level.price)) : null;
  const maxAsk = asks.length ? Math.max(...asks.map((level) => level.price)) : null;
  const coverageMin = minBid ?? (asks[0]?.price ?? null);
  const coverageMax = maxAsk ?? (bids[0]?.price ?? null);
  const quantities = new Map<number, LadderQuantity>();

  const add = (level: OrderBookLevel, side: "bid" | "ask") => {
    if (level.quantity < minimumSize) return;
    const bucket = domPriceBucketAt(camera, level.price);
    if (!bucket) return;
    const aggregate = quantities.get(bucket.index) ?? { bidSize: 0, askSize: 0 };
    if (side === "bid") aggregate.bidSize += level.quantity;
    else aggregate.askSize += level.quantity;
    quantities.set(bucket.index, aggregate);
  };
  bids.forEach((level) => add(level, "bid"));
  asks.forEach((level) => add(level, "ask"));

  const bestBidBucket = snapshot.bestBid === null ? null : domPriceBucketAt(camera, snapshot.bestBid)?.index ?? null;
  const bestAskBucket = snapshot.bestAsk === null ? null : domPriceBucketAt(camera, snapshot.bestAsk)?.index ?? null;
  const currentPrice = snapshot.lastPrice ?? snapshot.midPrice;
  const currentBucket = currentPrice === null ? null : domPriceBucketAt(camera, currentPrice)?.index ?? null;
  const wallsByBucket = new Map<number, WallDetection>();
  for (const wall of walls) {
    const bucket = domPriceBucketAt(camera, wall.price);
    if (!bucket) continue;
    const existing = wallsByBucket.get(bucket.index);
    if (!existing || wall.score > existing.score) wallsByBucket.set(bucket.index, wall);
  }

  const rows = camera.buckets.map((bucket): DomLadderRow => {
    const quantity = quantities.get(bucket.index) ?? { bidSize: 0, askSize: 0 };
    const insideCoverage = quantity.bidSize > 0 || quantity.askSize > 0 || coverageMin !== null && coverageMax !== null && bucket.center >= coverageMin && bucket.center <= coverageMax;
    const coverage: DomLiveCoverageState = coverageState !== "live" ? coverageState : insideCoverage ? "live" : "unavailable";
    return {
      key: bucket.key,
      price: bucket.center,
      priceLow: bucket.low,
      priceHigh: bucket.high,
      centerPrice: bucket.center,
      topPct: bucket.topPct,
      heightPct: bucket.heightPct,
      bidSize: quantity.bidSize,
      askSize: quantity.askSize,
      totalSize: quantity.bidSize + quantity.askSize,
      netDepth: quantity.bidSize - quantity.askSize,
      bidDepth: 0,
      askDepth: 0,
      coverage,
      isCurrentPrice: currentBucket === bucket.index,
      isBestBid: bestBidBucket === bucket.index,
      isBestAsk: bestAskBucket === bucket.index,
      wall: wallsByBucket.get(bucket.index) ?? null
    };
  });
  const bidReference = percentile(rows.map((row) => row.bidSize).filter((size) => size > 0), 0.9);
  const askReference = percentile(rows.map((row) => row.askSize).filter((size) => size > 0), 0.9);
  for (const row of rows) {
    row.bidDepth = depthRatio(row.bidSize, bidReference);
    row.askDepth = depthRatio(row.askSize, askReference);
  }
  const visibleRows = hideUncovered ? rows.filter((row) => row.coverage !== "unavailable") : rows;

  return {
    cameraVersion: camera.version,
    rows: visibleRows.slice().sort((left, right) => right.centerPrice - left.centerPrice),
    priceStep: camera.bucketSize,
    coverage: {
      min: coverageMin,
      max: coverageMax,
      bestBid: snapshot.bestBid,
      bestAsk: snapshot.bestAsk,
      bidLevels: bids.length,
      askLevels: asks.length,
      subscribedDepth: book?.subscribedDepth ?? null,
      sequence: book?.sequence ?? null,
      snapshotTime,
      ageMs,
      state: coverageState
    },
    visibleRows: visibleRows.length
  };
}

export type DomLadderDisplayUnit = "base" | "contracts" | "notional";

export function formatDomLadderQuantity(row: DomLadderRow, side: "bid" | "ask", fractionDigits = 3, displayUnit: DomLadderDisplayUnit = "base") {
  if (row.coverage === "unavailable") return "--";
  if (row.coverage === "offline") return "OFFLINE";
  if (row.coverage === "stale") return "STALE";
  const rawQuantity = side === "bid" ? row.bidSize : row.askSize;
  const quantity = displayUnit === "notional" ? rawQuantity * row.centerPrice : rawQuantity;
  return quantity.toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
}

function normalizeLevels(levels: OrderBookLevel[], side: "bid" | "ask") {
  return levels
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.quantity) && level.quantity > 0)
    .sort((left, right) => side === "bid" ? right.price - left.price : left.price - right.price)
    .slice(0, 1500);
}

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return 1;
  const sorted = values.slice().sort((left, right) => left - right);
  return Math.max(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))], 0.00000001);
}

function depthRatio(size: number, reference: number) {
  if (size <= 0) return 0;
  return Math.min(1, Math.max(0.04, Math.sqrt(size / Math.max(reference, 0.00000001))));
}
