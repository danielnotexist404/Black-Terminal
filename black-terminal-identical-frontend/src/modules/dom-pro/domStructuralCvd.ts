import type { Candle } from "../../chart-engine/types";

export type StructuralCvdCumulation = "sum" | "ema" | "sma";

export type StructuralCvdOptions = {
  cumulationType: StructuralCvdCumulation;
  cumulationLength: number;
  normalizeMovingAverages: boolean;
  scaleFactor: number;
  outlierPercentile: number;
};

export type StructuralCvdPoint = {
  time: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  cumulativeBuy: number;
  cumulativeSell: number;
  cumulativeDelta: number;
};

export type StructuralCvdStats = {
  current: number;
  windowDelta: number;
  buyPct: number;
  sellPct: number;
  trend: "rising" | "falling" | "flat";
};

type ClassifiedTrade = {
  time: number;
  quantity: number;
  side: "buy" | "sell" | string;
};

const defaultOptions: StructuralCvdOptions = {
  cumulationType: "sum",
  cumulationLength: 14,
  normalizeMovingAverages: true,
  scaleFactor: 1,
  outlierPercentile: 99
};

/**
 * OHLCV pressure allocation is adapted from the MPL-2.0 SVD+CVD reference
 * supplied with the project. The implementation is original TypeScript and
 * keeps estimated candle pressure distinct from classified trade flow.
 */
export function buildStructuralCvdFromCandles(
  candles: Candle[],
  options: Partial<StructuralCvdOptions> = {}
): StructuralCvdPoint[] {
  const config = normalizeOptions(options);
  const pressure = candles
    .filter(validCandle)
    .sort((a, b) => normalizeEpochSeconds(a.time) - normalizeEpochSeconds(b.time))
    .map((candle) => {
      const split = estimateCandlePressure(candle);
      return {
        time: normalizeEpochSeconds(candle.time),
        buyVolume: split.buyVolume,
        sellVolume: split.sellVolume,
        delta: split.buyVolume - split.sellVolume
      };
    });
  return cumulatePressure(pressure, config);
}

export function buildStructuralCvdFromTrades(
  trades: ClassifiedTrade[],
  bucketSeconds: number,
  options: Partial<StructuralCvdOptions> = {}
): StructuralCvdPoint[] {
  const config = normalizeOptions(options);
  const duration = Math.max(1, Math.round(bucketSeconds));
  const buckets = new Map<number, { buyVolume: number; sellVolume: number }>();
  for (const trade of trades) {
    const time = normalizeEpochSeconds(trade.time);
    const quantity = Number(trade.quantity);
    if (!Number.isFinite(time) || !Number.isFinite(quantity) || quantity <= 0) continue;
    if (trade.side !== "buy" && trade.side !== "sell") continue;
    const bucket = Math.floor(time / duration) * duration;
    const current = buckets.get(bucket) ?? { buyVolume: 0, sellVolume: 0 };
    if (trade.side === "buy") current.buyVolume += quantity;
    else current.sellVolume += quantity;
    buckets.set(bucket, current);
  }
  const pressure = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({
      time,
      buyVolume: value.buyVolume,
      sellVolume: value.sellVolume,
      delta: value.buyVolume - value.sellVolume
    }));
  return cumulatePressure(pressure, config);
}

export function estimateCandlePressure(candle: Candle) {
  const volume = Math.max(0, Number(candle.volume) || 0);
  const high = Math.max(candle.high, candle.open, candle.close);
  const low = Math.min(candle.low, candle.open, candle.close);
  const spread = high - low;
  if (!Number.isFinite(spread) || spread <= 0 || volume <= 0) {
    return { buyVolume: volume / 2, sellVolume: volume / 2 };
  }

  const body = Math.abs(candle.close - candle.open);
  const upperWick = Math.max(0, high - Math.max(candle.open, candle.close));
  const lowerWick = Math.max(0, Math.min(candle.open, candle.close) - low);
  const effectiveWickPortion = ((upperWick + lowerWick) / spread) / 2;
  const dominantPortion = Math.min(1, body / spread + effectiveWickPortion);
  const passivePortion = Math.max(0, 1 - dominantPortion);
  const bullish = candle.close > candle.open;
  const bearish = candle.close < candle.open;
  if (!bullish && !bearish) return { buyVolume: volume / 2, sellVolume: volume / 2 };
  return bullish
    ? { buyVolume: volume * dominantPortion, sellVolume: volume * passivePortion }
    : { buyVolume: volume * passivePortion, sellVolume: volume * dominantPortion };
}

export function structuralCvdStats(points: StructuralCvdPoint[], trendThreshold = 0.08): StructuralCvdStats {
  if (!points.length) return { current: 0, windowDelta: 0, buyPct: 0, sellPct: 0, trend: "flat" };
  const current = points.at(-1)?.cumulativeDelta ?? 0;
  const first = points[0]?.cumulativeDelta ?? 0;
  const windowDelta = current - first;
  const buyVolume = points.reduce((sum, point) => sum + point.buyVolume, 0);
  const sellVolume = points.reduce((sum, point) => sum + point.sellVolume, 0);
  const total = Math.max(Number.EPSILON, buyVolume + sellVolume);
  const lookbackIndex = Math.max(0, points.length - Math.max(4, Math.floor(points.length * 0.2)));
  const lookback = points[lookbackIndex]?.cumulativeDelta ?? first;
  const amplitude = Math.max(1, ...points.map((point) => Math.abs(point.cumulativeDelta)));
  const threshold = amplitude * Math.max(0, trendThreshold);
  const slope = current - lookback;
  return {
    current,
    windowDelta,
    buyPct: buyVolume / total * 100,
    sellPct: sellVolume / total * 100,
    trend: slope > threshold ? "rising" : slope < -threshold ? "falling" : "flat"
  };
}

export function structuralCvdRange(points: StructuralCvdPoint[], percentileValue = 99) {
  const magnitudes = points
    .flatMap((point) => [point.cumulativeBuy, Math.abs(point.cumulativeSell), Math.abs(point.delta), Math.abs(point.cumulativeDelta)])
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (!magnitudes.length) return { min: -1, max: 1 };
  const percentile = Math.max(0.8, Math.min(1, percentileValue / 100));
  const index = Math.min(magnitudes.length - 1, Math.floor((magnitudes.length - 1) * percentile));
  const domain = Math.max(1, magnitudes[index] || magnitudes.at(-1) || 1) * 1.08;
  return { min: -domain, max: domain };
}

function cumulatePressure(
  pressure: Array<{ time: number; buyVolume: number; sellVolume: number; delta: number }>,
  options: StructuralCvdOptions
): StructuralCvdPoint[] {
  if (!pressure.length) return [];
  const length = options.cumulationLength;
  const buySeries = pressure.map((point) => point.buyVolume);
  const sellSeries = pressure.map((point) => point.sellVolume);
  const cumulativeBuy = cumulateSeries(buySeries, options.cumulationType, length, options.normalizeMovingAverages);
  const cumulativeSell = cumulateSeries(sellSeries, options.cumulationType, length, options.normalizeMovingAverages);
  const deltaCeiling = percentileMagnitude(pressure.map((point) => point.delta), options.outlierPercentile);
  return pressure.map((point, index) => {
    const buy = cumulativeBuy[index] * options.scaleFactor;
    const sell = cumulativeSell[index] * options.scaleFactor;
    return {
      ...point,
      delta: Math.max(-deltaCeiling, Math.min(deltaCeiling, point.delta)),
      cumulativeBuy: buy,
      cumulativeSell: -sell,
      cumulativeDelta: buy - sell
    };
  });
}

function cumulateSeries(values: number[], type: StructuralCvdCumulation, length: number, normalizeMovingAverages: boolean) {
  if (type === "sum") {
    let sum = 0;
    return values.map((value, index) => {
      sum += value;
      if (index >= length) sum -= values[index - length];
      return sum;
    });
  }
  if (type === "sma") {
    let sum = 0;
    return values.map((value, index) => {
      sum += value;
      if (index >= length) sum -= values[index - length];
      const count = Math.min(index + 1, length);
      const average = sum / Math.max(1, count);
      return average * (normalizeMovingAverages ? length : 1);
    });
  }
  const alpha = 2 / (length + 1);
  let ema = values[0] ?? 0;
  return values.map((value, index) => {
    if (index > 0) ema += alpha * (value - ema);
    return ema * (normalizeMovingAverages ? length : 1);
  });
}

function normalizeOptions(options: Partial<StructuralCvdOptions>): StructuralCvdOptions {
  return {
    cumulationType: options.cumulationType === "ema" || options.cumulationType === "sma" ? options.cumulationType : "sum",
    cumulationLength: Math.max(1, Math.min(500, Math.round(options.cumulationLength ?? defaultOptions.cumulationLength))),
    normalizeMovingAverages: options.normalizeMovingAverages ?? defaultOptions.normalizeMovingAverages,
    scaleFactor: Math.max(0, Number(options.scaleFactor ?? defaultOptions.scaleFactor)),
    outlierPercentile: Math.max(80, Math.min(100, Number(options.outlierPercentile ?? defaultOptions.outlierPercentile)))
  };
}

function percentileMagnitude(values: number[], percentileValue: number) {
  const ordered = values.map((value) => Math.abs(value)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!ordered.length) return 1;
  const percentile = Math.max(0.8, Math.min(1, percentileValue / 100));
  return Math.max(Number.EPSILON, ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * percentile))]);
}

function validCandle(candle: Candle) {
  return [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite) && candle.volume >= 0;
}

function normalizeEpochSeconds(time: number) {
  return time > 100_000_000_000 ? Math.floor(time / 1000) : Math.floor(time);
}
