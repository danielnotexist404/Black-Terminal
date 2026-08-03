import type { Candle } from "../../../chart-engine/types.ts";
import { auctionRowIndex } from "../core/profileGrid.ts";
import type { AuctionProfileGrid, AuctionProfileRow } from "../core/types.ts";

export const PINE_CVD_PROFILE_KNOWN_ANOMALIES = [
  "Lower-timeframe direction is close-to-close (or bid/ask on 1T), not venue aggressor side.",
  "buyVol and sellVol are overwritten per row rather than accumulated before the ratio is calculated.",
  "Imbalance uses buy/sell division and therefore retains zero-denominator behavior.",
  "Activity is cleared on each chart-bar update before the current lower-timeframe contribution.",
  "Automatic tick amount multiplies ATR by minimum tick instead of quantizing ATR to the tick.",
  "Value area expands symmetrically around total-volume POC instead of choosing the stronger adjacent row.",
  "The source declares max_bars_back=1500 despite calc_bars_count=10000."
] as const;

export function applyPineCompatibleBars(
  rows: AuctionProfileRow[],
  grid: AuctionProfileGrid,
  bars: readonly Candle[]
) {
  let previousClose: number | undefined;
  for (const bar of bars) {
    const direction = previousClose === undefined ? 0 : Math.sign(bar.close - previousClose);
    previousClose = bar.close;
    const start = auctionRowIndex(grid, bar.low);
    const end = auctionRowIndex(grid, bar.high);
    const divided = direction * bar.volume / Math.max(1, end - start + 1);
    for (let index = start; index <= end; index += 1) {
      const row = rows[index]!;
      row.value += divided;
      row.totalQuantity += Math.abs(divided);
      if (divided > 0) row.buyQuantity = Math.abs(divided);
      if (divided < 0) row.sellQuantity = Math.abs(divided);
    }
  }
  rows.forEach(row => {
    row.cvdEfficiency = row.value / Math.max(row.totalQuantity, Number.EPSILON);
  });
}
