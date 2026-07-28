import type { Candle } from "../../../chart-engine/types";
import type { NormalizedCandle } from "./types";

export type NormalizeCandleOptions = {
  source: string;
  sourceRevision: string;
};

export type NormalizedCandleSet = {
  candles: NormalizedCandle[];
  duplicateTimes: number[];
  outOfOrderTimes: number[];
  conflictingTimes: number[];
};

function sameOhlcv(left: Candle, right: Candle) {
  return (
    left.open === right.open &&
    left.high === right.high &&
    left.low === right.low &&
    left.close === right.close &&
    left.volume === right.volume
  );
}

export function normalizeKioseffCandles(
  candles: readonly (Candle & { originalTime?: string | number })[],
  options: NormalizeCandleOptions
): NormalizedCandleSet {
  const byTime = new Map<number, NormalizedCandle>();
  const duplicateTimes: number[] = [];
  const outOfOrderTimes: number[] = [];
  const conflictingTimes: number[] = [];
  let priorTime = Number.NEGATIVE_INFINITY;

  for (const candle of candles) {
    if (!Number.isInteger(candle.time)) throw new Error(`Candle time must be integer seconds: ${candle.time}`);
    if (
      ![candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite) ||
      candle.high < candle.low
    ) {
      throw new Error(`Invalid OHLCV at ${candle.time}`);
    }
    if (candle.time < priorTime) outOfOrderTimes.push(candle.time);
    priorTime = candle.time;

    const normalized: NormalizedCandle = {
      time: candle.time,
      originalTime: candle.originalTime ?? candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      source: options.source,
      sourceRevision: options.sourceRevision
    };
    const existing = byTime.get(candle.time);
    if (existing) {
      duplicateTimes.push(candle.time);
      if (!sameOhlcv(existing, normalized)) conflictingTimes.push(candle.time);
    }
    // Last writer wins. Callers merge historical first and newer realtime revisions last.
    byTime.set(candle.time, normalized);
  }

  return {
    candles: [...byTime.values()].sort((left, right) => left.time - right.time),
    duplicateTimes: uniqueSorted(duplicateTimes),
    outOfOrderTimes: uniqueSorted(outOfOrderTimes),
    conflictingTimes: uniqueSorted(conflictingTimes)
  };
}

function uniqueSorted(values: number[]) {
  return [...new Set(values)].sort((left, right) => left - right);
}

export function stableSourceVersion(parts: readonly (string | number | boolean | null | undefined)[]) {
  let hash = 0x811c9dc5;
  const text = parts.map((part) => String(part ?? "")).join("|");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `kioseff-fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function candleSourceVersion(candles: readonly NormalizedCandle[], prefix: string) {
  return stableSourceVersion([
    prefix,
    candles.length,
    ...candles.flatMap((candle) => [
      candle.time,
      candle.open,
      candle.high,
      candle.low,
      candle.close,
      candle.volume,
      candle.source,
      candle.sourceRevision
    ])
  ]);
}

