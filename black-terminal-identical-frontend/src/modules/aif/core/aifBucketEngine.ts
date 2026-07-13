import type { Candle } from "../../../chart-engine/types";
import { bucketIndexForPrice } from "./aifAuctionDomain.ts";
import type { AifAuctionDomain, AifProfileRow } from "./aifTypes";

export function emptyProfileRows(domain: AifAuctionDomain): AifProfileRow[] {
  return Array.from({ length: domain.bucketCount }, (_, index) => ({
    index,
    low: domain.boundaries[index],
    high: domain.boundaries[index + 1],
    center: (domain.boundaries[index] + domain.boundaries[index + 1]) / 2,
    value: 0,
    positive: 0,
    negative: 0,
    normalized: 0,
    valueArea: false
  }));
}

export function distributeConserved(rows: AifProfileRow[], domain: AifAuctionDomain, candle: Candle, amount: number, positiveShare = 0.5, weighting?: (row: AifProfileRow) => number) {
  if (!Number.isFinite(amount) || amount === 0) return;
  const low = Math.min(candle.low, candle.high);
  const high = Math.max(candle.low, candle.high);
  if (high <= low) {
    const row = rows[bucketIndexForPrice(domain, candle.close)];
    apply(row, amount, positiveShare);
    return;
  }
  const start = bucketIndexForPrice(domain, low);
  const end = bucketIndexForPrice(domain, high);
  const targets: Array<{ row: AifProfileRow; weight: number }> = [];
  let totalWeight = 0;
  for (let index = start; index <= end; index += 1) {
    const row = rows[index];
    const overlap = Math.max(0, Math.min(high, row.high) - Math.max(low, row.low));
    const weight = Math.max(0, overlap) * Math.max(0.000001, weighting?.(row) ?? 1);
    if (weight <= 0) continue;
    targets.push({ row, weight });
    totalWeight += weight;
  }
  if (!targets.length || totalWeight <= 0) {
    apply(rows[bucketIndexForPrice(domain, candle.close)], amount, positiveShare);
    return;
  }
  let allocated = 0;
  targets.forEach((target, index) => {
    const value = index === targets.length - 1 ? amount - allocated : amount * target.weight / totalWeight;
    allocated += value;
    apply(target.row, value, positiveShare);
  });
}

export function finalizeRows(rows: AifProfileRow[]) {
  let max = 1e-12;
  for (const row of rows) max = Math.max(max, Math.abs(row.value));
  for (const row of rows) row.normalized = Math.abs(row.value) / max;
}

function apply(row: AifProfileRow, amount: number, positiveShare: number) {
  const share = Math.max(0, Math.min(1, positiveShare));
  row.value += amount;
  row.positive += Math.abs(amount) * share;
  row.negative += Math.abs(amount) * (1 - share);
}
