import type { AuctionProfileRow } from "./types.ts";

export type AuctionProfileShape = "D_SHAPE" | "P_SHAPE" | "B_SHAPE" | "DOUBLE_DISTRIBUTION" | "TREND" | "THIN" | "UNCLASSIFIED";

export function classifyAuctionProfileShape(rows: readonly AuctionProfileRow[]): AuctionProfileShape {
  if (rows.length < 5) return "UNCLASSIFIED";
  const values = rows.map(row => Math.max(0, row.totalQuantity));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return "THIN";
  const third = Math.floor(values.length / 3);
  const lower = values.slice(0, third).reduce((sum, value) => sum + value, 0);
  const middle = values.slice(third, third * 2).reduce((sum, value) => sum + value, 0);
  const upper = values.slice(third * 2).reduce((sum, value) => sum + value, 0);
  const peaks = values.filter((value, index) => value > (values[index - 1] ?? value) && value > (values[index + 1] ?? value) && value > total / values.length * 1.4).length;
  if (peaks >= 2) return "DOUBLE_DISTRIBUTION";
  if (middle > lower * 1.25 && middle > upper * 1.25) return "D_SHAPE";
  if (upper > lower * 1.6) return "P_SHAPE";
  if (lower > upper * 1.6) return "B_SHAPE";
  if (Math.max(lower, upper) > middle * 1.4) return "TREND";
  return "UNCLASSIFIED";
}
