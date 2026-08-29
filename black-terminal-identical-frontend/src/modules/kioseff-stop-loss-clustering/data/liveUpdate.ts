import type { Candle } from "../../../chart-engine/types.ts";

export type KioseffLiveUpdateCursor = {
  committedThrough: number | null;
  lastProcessedBarTime: number | null;
};

/**
 * Selects only the causal tail required to advance the already-warmed worker.
 * The first returned bar is the formerly provisional bar that can now be
 * committed. The final returned bar is the new provisional bar. Repeated
 * snapshots of the same open bar are idempotent and do not schedule work.
 */
export function selectKioseffLiveUpdateBars(
  chartCandles: readonly Candle[],
  cursor: KioseffLiveUpdateCursor
) {
  if (chartCandles.length === 0) return [];
  const newestTime = chartCandles.at(-1)!.time;
  if (
    cursor.lastProcessedBarTime !== null &&
    newestTime <= cursor.lastProcessedBarTime
  ) {
    return [];
  }

  if (cursor.committedThrough === null) {
    return chartCandles.slice(-2);
  }

  const firstUncommitted = chartCandles.findIndex(
    (candle) => candle.time > cursor.committedThrough!
  );
  return firstUncommitted < 0 ? [] : chartCandles.slice(firstUncommitted);
}
