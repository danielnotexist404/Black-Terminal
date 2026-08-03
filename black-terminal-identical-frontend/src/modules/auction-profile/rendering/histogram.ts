import type { AuctionProfileRow } from "../core/types.ts";

export function auctionHistogramWidth(row: AuctionProfileRow, maximum: number, availableWidth: number) {
  return maximum > 0 ? availableWidth * Math.min(1, Math.abs(row.value) / maximum) : 0;
}
