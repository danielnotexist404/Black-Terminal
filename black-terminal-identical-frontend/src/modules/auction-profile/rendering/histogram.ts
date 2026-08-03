import type { AuctionProfileRow, AuctionScopeMode } from "../core/types.ts";

export type AuctionProfileHorizontalBounds = {
  left: number;
  right: number;
  width: number;
  visible: boolean;
};

const LOOKBACK_ANCHORED_SCOPES = new Set<AuctionScopeMode>([
  "ROLLING",
  "COMPOSITE",
  "MACRO_COMPOSITE"
]);

export function auctionProfileStartX(
  scope: AuctionScopeMode,
  range: { start: number; loadedBars: number },
  xForTime: (time: number) => number,
  xForLookbackBars: (bars: number) => number
) {
  return LOOKBACK_ANCHORED_SCOPES.has(scope)
    ? xForLookbackBars(range.loadedBars)
    : xForTime(range.start);
}

export function auctionProfileHorizontalBounds(
  range: { start: number; end: number },
  viewportWidth: number,
  xForTime: (time: number) => number,
  startX = xForTime(range.start)
): AuctionProfileHorizontalBounds {
  const width = Math.max(0, viewportWidth);
  const rawStart = startX;
  const rawEnd = xForTime(range.end);
  const rawLeft = Math.min(rawStart, rawEnd);
  const rawRight = Math.max(rawStart, rawEnd);
  const visible = Number.isFinite(rawLeft) && Number.isFinite(rawRight) && rawRight >= 0 && rawLeft <= width;
  const left = Math.max(0, Math.min(width, rawLeft));
  const right = Math.max(left, Math.min(width, rawRight));
  return { left, right, width: Math.max(0, right - left), visible };
}

export function auctionHistogramWidth(
  row: AuctionProfileRow,
  maximum: number,
  availableWidth: number,
  widthPercent = 100
) {
  if (maximum <= 0) return 0;
  const strength = Math.min(1, Math.abs(row.value) / maximum);
  const normalizedWidth = Math.max(0.05, Math.min(1, widthPercent / 100));
  return availableWidth * Math.pow(strength, 2 - normalizedWidth);
}
