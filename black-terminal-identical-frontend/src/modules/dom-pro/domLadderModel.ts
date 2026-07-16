import type { OrderBookLevel } from "../../market-data/types";
import type { AggregatedDomSnapshot } from "./types";

export type DomLadderRow = {
  price: number;
  bidSize: number;
  askSize: number;
  totalSize: number;
  bidDepth: number;
  askDepth: number;
  isCurrentPrice: boolean;
  isBestBid: boolean;
  isBestAsk: boolean;
};

export type DomLadderModel = {
  rows: DomLadderRow[];
  priceStep: number;
  sourceBidLevels: number;
  sourceAskLevels: number;
};

type LadderQuantity = { bidSize: number; askSize: number };

export function buildDomLadderModel(snapshot: AggregatedDomSnapshot, desiredRowCount = 40): DomLadderModel {
  const currentPrice = positive(snapshot.midPrice) ?? positive(snapshot.lastPrice) ?? positive(snapshot.bestBid) ?? positive(snapshot.bestAsk) ?? 1;
  const sourceBids = normalizeLevels(
    snapshot.sourceBook?.bids?.length
      ? snapshot.sourceBook.bids
      : snapshot.bids.map((bucket) => ({ price: bucket.price, quantity: bucket.bidSize })),
    "bid",
    currentPrice
  );
  const sourceAsks = normalizeLevels(
    snapshot.sourceBook?.asks?.length
      ? snapshot.sourceBook.asks
      : snapshot.asks.map((bucket) => ({ price: bucket.price, quantity: bucket.askSize })),
    "ask",
    currentPrice
  );
  const rowsPerSide = Math.max(8, Math.min(36, Math.floor(desiredRowCount / 2)));
  const priceStep = resolveLadderStep(sourceBids, sourceAsks, currentPrice, rowsPerSide, snapshot.renderStats.bucketSize);
  const firstAskPrice = roundPrice((Math.floor(currentPrice / priceStep) + 1) * priceStep);
  const firstBidPrice = roundPrice(Math.floor(currentPrice / priceStep) * priceStep);
  const quantities = new Map<string, LadderQuantity>();

  for (const level of sourceBids) {
    const rowPrice = roundPrice(Math.floor(level.price / priceStep) * priceStep);
    if (rowPrice > firstBidPrice || rowPrice < firstBidPrice - priceStep * (rowsPerSide - 1)) continue;
    addQuantity(quantities, rowPrice, "bid", level.quantity);
  }
  for (const level of sourceAsks) {
    const rowPrice = roundPrice(Math.ceil(level.price / priceStep) * priceStep);
    if (rowPrice < firstAskPrice || rowPrice > firstAskPrice + priceStep * (rowsPerSide - 1)) continue;
    addQuantity(quantities, rowPrice, "ask", level.quantity);
  }

  const bestBidRow = snapshot.bestBid === null ? null : roundPrice(Math.floor(snapshot.bestBid / priceStep) * priceStep);
  const bestAskRow = snapshot.bestAsk === null ? null : roundPrice(Math.ceil(snapshot.bestAsk / priceStep) * priceStep);
  const rows: DomLadderRow[] = [];

  for (let index = rowsPerSide - 1; index >= 0; index -= 1) {
    rows.push(createRow(firstAskPrice + index * priceStep, quantities, null, bestAskRow));
  }
  for (let index = 0; index < rowsPerSide; index += 1) {
    rows.push(createRow(firstBidPrice - index * priceStep, quantities, bestBidRow, null));
  }

  const bidReference = percentile(rows.map((row) => row.bidSize).filter((size) => size > 0), 0.9);
  const askReference = percentile(rows.map((row) => row.askSize).filter((size) => size > 0), 0.9);
  for (const row of rows) {
    row.bidDepth = depthRatio(row.bidSize, bidReference);
    row.askDepth = depthRatio(row.askSize, askReference);
  }

  return {
    rows,
    priceStep,
    sourceBidLevels: sourceBids.length,
    sourceAskLevels: sourceAsks.length
  };
}

function normalizeLevels(levels: OrderBookLevel[], side: "bid" | "ask", currentPrice: number) {
  return levels
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.quantity) && level.quantity > 0)
    .filter((level) => side === "bid" ? level.price <= currentPrice : level.price >= currentPrice)
    .sort((left, right) => side === "bid" ? right.price - left.price : left.price - right.price)
    .slice(0, 1500);
}

function resolveLadderStep(
  bids: OrderBookLevel[],
  asks: OrderBookLevel[],
  currentPrice: number,
  rowsPerSide: number,
  fallbackBucketSize: number
) {
  const sampleDepth = rowsPerSide * 8;
  const deepestBid = bids[Math.min(bids.length, sampleDepth) - 1]?.price;
  const deepestAsk = asks[Math.min(asks.length, sampleDepth) - 1]?.price;
  const bidSpan = deepestBid === undefined ? 0 : Math.max(0, currentPrice - deepestBid);
  const askSpan = deepestAsk === undefined ? 0 : Math.max(0, deepestAsk - currentPrice);
  const spans = [bidSpan, askSpan].filter((span) => span > 0);
  const sharedSpan = spans.length === 2 ? Math.min(spans[0], spans[1]) : spans[0] ?? 0;
  const tickSize = inferTickSize([...bids.slice(0, 80), ...asks.slice(0, 80)]);
  const rawStep = sharedSpan > 0 ? sharedSpan / rowsPerSide : Math.max(tickSize, fallbackBucketSize / 20);
  return nicePriceStep(Math.max(tickSize, rawStep));
}

function inferTickSize(levels: OrderBookLevel[]) {
  const prices = [...new Set(levels.map((level) => level.price))].sort((left, right) => left - right);
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < prices.length; index += 1) {
    const difference = prices[index] - prices[index - 1];
    if (difference > 0) minimum = Math.min(minimum, difference);
  }
  return Number.isFinite(minimum) ? Math.max(0.00000001, roundPrice(minimum)) : 0.01;
}

function nicePriceStep(value: number) {
  const raw = Math.max(0.00000001, value);
  const exponent = Math.floor(Math.log10(raw));
  const base = 10 ** exponent;
  const normalized = raw / base;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return roundPrice(multiplier * base);
}

function addQuantity(map: Map<string, LadderQuantity>, price: number, side: "bid" | "ask", quantity: number) {
  const key = priceKey(price);
  const current = map.get(key) ?? { bidSize: 0, askSize: 0 };
  if (side === "bid") current.bidSize += quantity;
  else current.askSize += quantity;
  map.set(key, current);
}

function createRow(priceValue: number, quantities: Map<string, LadderQuantity>, bestBid: number | null, bestAsk: number | null): DomLadderRow {
  const price = roundPrice(priceValue);
  const quantity = quantities.get(priceKey(price)) ?? { bidSize: 0, askSize: 0 };
  return {
    price,
    bidSize: quantity.bidSize,
    askSize: quantity.askSize,
    totalSize: quantity.bidSize + quantity.askSize,
    bidDepth: 0,
    askDepth: 0,
    isCurrentPrice: false,
    isBestBid: bestBid === price,
    isBestAsk: bestAsk === price
  };
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

function positive(value: number | null | undefined) {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

function roundPrice(value: number) {
  return Number(value.toFixed(8));
}

function priceKey(price: number) {
  return price.toFixed(8);
}
