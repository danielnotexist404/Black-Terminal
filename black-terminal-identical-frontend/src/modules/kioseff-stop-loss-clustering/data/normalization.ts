import type { Candle } from "../../../chart-engine/types";
import {
  KioseffDataUnavailableError,
  type NormalizedCandle
} from "./types.ts";

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
    if (candle.time > 10_000_000_000) {
      throw new KioseffDataUnavailableError("invalid-timestamp-units", {
        time: candle.time,
        expected: "integer-seconds"
      });
    }
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
  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    if (partIndex > 0) {
      hash ^= 124;
      hash = Math.imul(hash, 0x01000193);
    }
    const text = String(parts[partIndex] ?? "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return `kioseff-fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function candleSourceVersion(candles: readonly NormalizedCandle[], prefix: string) {
  let hash = 0x811c9dc5;
  let partIndex = 0;
  const update = (value: string | number) => {
    if (partIndex > 0) {
      hash ^= 124;
      hash = Math.imul(hash, 0x01000193);
    }
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    partIndex += 1;
  };
  update(prefix);
  update(candles.length);
  for (const candle of candles) {
    update(candle.time);
    update(candle.open);
    update(candle.high);
    update(candle.low);
    update(candle.close);
    update(candle.volume);
    update(candle.source);
    update(candle.sourceRevision);
  }
  return `kioseff-fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
