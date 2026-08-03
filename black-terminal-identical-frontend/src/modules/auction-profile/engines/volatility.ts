import type { Candle } from "../../../chart-engine/types.ts";
import type { AuctionProfileRow } from "../core/types.ts";

export function realizedVariance(bar: Candle, previousClose?: number) {
  if (!(bar.close > 0 && (previousClose ?? bar.open) > 0)) return 0;
  const value = Math.log(bar.close / (previousClose ?? bar.open));
  return value * value;
}

export function garmanKlassVariance(bar: Candle) {
  if (!(bar.high > 0 && bar.low > 0 && bar.open > 0 && bar.close > 0)) return 0;
  const highLow = Math.log(bar.high / bar.low);
  const closeOpen = Math.log(bar.close / bar.open);
  return Math.max(0, 0.5 * highLow * highLow - (2 * Math.log(2) - 1) * closeOpen * closeOpen);
}

export function volatilityMetricValue(row: AuctionProfileRow, annualization: number) {
  return Math.sqrt(Math.max(0, row.realizedVariance) * annualization);
}

export function garmanKlassMetricValue(row: AuctionProfileRow, annualization: number) {
  return Math.sqrt(Math.max(0, row.garmanKlassVariance) * annualization);
}
