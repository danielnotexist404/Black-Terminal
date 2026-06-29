import type { Candle } from "../../../chart-engine/types";

export function classifyMarketRegime(candles: Candle[], index: number) {
  const lookback = 34;
  if (index < lookback) return "warming-up";
  const window = candles.slice(index - lookback + 1, index + 1);
  const first = window[0];
  const last = window[window.length - 1];
  const high = Math.max(...window.map((candle) => candle.high));
  const low = Math.min(...window.map((candle) => candle.low));
  const range = Math.max(high - low, last.close * 0.0001);
  const trend = Math.abs(last.close - first.close) / range;
  const realizedVolatility = range / Math.max(last.close, 1);

  if (trend > 0.62 && realizedVolatility > 0.018) return "volatile-trend";
  if (trend > 0.58) return "trend";
  if (realizedVolatility > 0.025) return "volatile-chop";
  return "chop";
}

export function sessionForTimestamp(time: number) {
  const hour = new Date(time * 1000).getUTCHours();
  if (hour >= 0 && hour < 7) return "Asia";
  if (hour >= 7 && hour < 13) return "London";
  if (hour >= 13 && hour < 21) return "New York";
  return "Post NY";
}
