import type { Candle } from "../../../chart-engine/types";
import type { AifCoverage } from "./aifTypes";

export type AifNormalizedData = {
  candles: Candle[];
  times: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  coverage: AifCoverage;
};

export function normalizeAifCandles(input: Candle[], requestedLookbackBars: number, expectedIntervalSeconds: number): AifNormalizedData {
  const byTime = new Map<number, Candle>();
  for (const candle of input) {
    if (![candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)) continue;
    if (candle.time <= 0 || candle.high < candle.low || candle.open <= 0 || candle.close <= 0 || candle.volume < 0) continue;
    byTime.set(candle.time, { ...candle, high: Math.max(candle.high, candle.open, candle.close), low: Math.min(candle.low, candle.open, candle.close) });
  }
  const available = [...byTime.values()].sort((a, b) => a.time - b.time);
  const request = Math.max(1, Math.round(requestedLookbackBars));
  const candles = available.slice(-request);
  let missingIntervals = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const gap = candles[index].time - candles[index - 1].time;
    if (expectedIntervalSeconds > 0 && gap > expectedIntervalSeconds * 1.5) missingIntervals += Math.max(1, Math.round(gap / expectedIntervalSeconds) - 1);
  }
  const coverage: AifCoverage = {
    requestedLookbackBars: request,
    effectiveLookbackBars: candles.length,
    availableBars: available.length,
    calculationStart: candles[0]?.time ?? null,
    calculationEnd: candles.at(-1)?.time ?? null,
    wasClamped: candles.length < request,
    clampReason: candles.length < request ? "HISTORICAL COVERAGE LIMIT" : null,
    missingIntervals,
    coveragePct: Math.max(0, Math.min(100, candles.length / Math.max(1, request + missingIntervals) * 100))
  };
  return {
    candles,
    times: Float64Array.from(candles.map((candle) => candle.time)),
    open: Float64Array.from(candles.map((candle) => candle.open)),
    high: Float64Array.from(candles.map((candle) => candle.high)),
    low: Float64Array.from(candles.map((candle) => candle.low)),
    close: Float64Array.from(candles.map((candle) => candle.close)),
    volume: Float64Array.from(candles.map((candle) => candle.volume)),
    coverage
  };
}
