import type { AuctionProfileRow } from "../core/types.ts";

export function activityMetricValue(row: AuctionProfileRow) {
  const directional = Math.abs(row.buyQuantity - row.sellQuantity);
  return (row.tradeCount + Math.sqrt(Math.max(0, row.totalQuantity))) * (0.5 + directional / Math.max(row.totalQuantity, Number.EPSILON));
}

export function liquidityWeightedActivity(row: AuctionProfileRow) {
  return activityMetricValue(row) * Math.log1p(row.maximumTradeSize) / Math.max(1, Math.sqrt(row.averageTradeSize || 1));
}
