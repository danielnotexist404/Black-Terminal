import type { AuctionProfileRow } from "../core/types.ts";

export function auctionBrightnessAlpha(alpha: number, brightness: number) {
  const gain = Math.max(0.1, Math.min(3, brightness / 100));
  return Math.max(0, Math.min(1, 1 - Math.pow(1 - Math.max(0, Math.min(1, alpha)), gain)));
}

export function normalizedAuctionRowStrength(row: AuctionProfileRow, maximum: number) {
  return maximum > 0 ? Math.min(1, Math.abs(row.value) / maximum) : 0;
}
