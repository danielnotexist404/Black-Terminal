import type { Candle } from "../../../chart-engine/types";

export function selectCompletedAifCandles(candles: Candle[], timeframe: string, nowSeconds = Date.now() / 1000) {
  const interval = timeframeSeconds(timeframe);
  return candles.filter((candle) => candle.time + interval <= nowSeconds);
}

export function timeframeSeconds(timeframe: string) {
  const match = /^(\d+)([smhdw])$/.exec(timeframe);
  const unit: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return match ? Number(match[1]) * unit[match[2]] : 60;
}
