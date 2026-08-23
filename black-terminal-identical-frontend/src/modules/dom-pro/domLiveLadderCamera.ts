import type { OrderBookSnapshot } from "../../market-data/types";
import type { MacroLiquidityRange } from "./types";

/**
 * Resolves the ladder-only camera domain from the complete genuine venue book
 * currently held by the shared DOM feed. This function deliberately knows
 * nothing about IMM walls, heatmap frames, profiles, or historical candles.
 */
export function resolveDomFullLiveRange(
  book: OrderBookSnapshot | null | undefined,
  currentPrice: number | null | undefined,
  fallback: MacroLiquidityRange
): MacroLiquidityRange {
  const prices = [
    ...(book?.bids ?? []).map((level) => level.price),
    ...(book?.asks ?? []).map((level) => level.price)
  ].filter(isPositiveFinite);

  if (isPositiveFinite(currentPrice)) prices.push(currentPrice);
  if (prices.length === 0) return fallback;

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  if (max > min) return { min, max, source: "live-depth" };

  // A one-price snapshot still needs a non-zero camera span. The expansion is
  // display geometry only; it never creates a synthetic order-book quantity.
  const halfSpan = Math.max(min * 0.000001, 0.00000001);
  return {
    min: Math.max(0.00000001, min - halfSpan),
    max: max + halfSpan,
    source: "live-depth"
  };
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
