import type { AuctionCvdMetric, AuctionProfileRow } from "../core/types.ts";

export function cvdMetricValue(row: AuctionProfileRow, metric: AuctionCvdMetric) {
  const delta = row.buyQuantity - row.sellQuantity;
  const total = row.buyQuantity + row.sellQuantity;
  switch (metric) {
    case "ABSOLUTE_CVD": return Math.abs(delta);
    case "POSITIVE_CVD": return Math.max(0, delta);
    case "NEGATIVE_CVD": return Math.min(0, delta);
    case "CVD_IMBALANCE_RATIO": return delta / Math.max(total, Number.EPSILON);
    case "CVD_EFFICIENCY": return row.cvdEfficiency;
    case "CVD_PERSISTENCE": return row.cvdPersistence;
    case "CVD_ACCELERATION": return delta;
    case "CVD_DIVERGENCE": return delta / Math.max(row.rangeExpansion, Number.EPSILON);
    case "NET_CVD":
    default: return delta;
  }
}

export function stableImbalanceRatio(buy: number, sell: number) {
  return (buy - sell) / Math.max(buy + sell, Number.EPSILON);
}
