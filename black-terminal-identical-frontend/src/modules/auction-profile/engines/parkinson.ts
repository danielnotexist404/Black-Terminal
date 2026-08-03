import type { Candle } from "../../../chart-engine/types.ts";
import type { AuctionProfileRow } from "../core/types.ts";

export function parkinsonVariance(bar: Candle) {
  if (!(bar.high > 0 && bar.low > 0)) return 0;
  const range = Math.log(bar.high / bar.low);
  return range * range / (4 * Math.log(2));
}

export function parkinsonMetricValue(row: AuctionProfileRow, annualization: number) {
  return Math.sqrt(Math.max(0, row.parkinsonVariance) * annualization);
}
