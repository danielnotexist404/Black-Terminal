import type { Candle } from "../../../chart-engine/types";
import type {
  HorizonBucket,
  HorizonCandleMode,
  HorizonCrosshairSample,
  HorizonResolvedLod,
  HorizonWaveProjection
} from "./types";

const MIN_TICK = 1e-9;
const MAX_CACHE_ENTRIES = 6;

function clamp(value: number, minimum = -1, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteDelta(candle: Candle) {
  return Number.isFinite(candle.delta) ? Number(candle.delta) : null;
}

export function resolveHorizonLod(candlesPerPixel: number, requested: HorizonCandleMode["lodMode"]): HorizonResolvedLod {
  if (requested !== "auto") return requested;
  if (candlesPerPixel <= 1) return "candles";
  if (candlesPerPixel <= 8) return "clusters";
  return "wave";
}

function emptyProjection(firstIndex: number, lastIndex: number, expectedSampleCount: number): HorizonWaveProjection {
  return {
    firstIndex,
    lastIndex,
    bucketSize: 1,
    candlesPerPixel: 1,
    lod: "candles",
    sourceSampleCount: 0,
    expectedSampleCount,
    coverageRatio: 0,
    deltaCoverageRatio: 0,
    buckets: [],
    arrays: {
      centerline: new Float64Array(0),
      upperEnvelope: new Float64Array(0),
      lowerEnvelope: new Float64Array(0),
      directionScore: new Float32Array(0),
      bodyPressure: new Float32Array(0),
      rejectionImbalance: new Float32Array(0),
      compressionExpansion: new Float32Array(0),
      volume: new Float64Array(0),
      delta: new Float64Array(0)
    }
  };
}

/**
 * Converts immutable one-second source candles into viewport-specific render buckets.
 * The source array is never replaced or smoothed; LOD only changes submitted geometry.
 */
export class HorizonWaveEngine {
  private cache = new Map<string, HorizonWaveProjection>();

  project(
    candles: readonly Candle[],
    firstIndex: number,
    lastIndex: number,
    pixelsPerCandle: number,
    settings: HorizonCandleMode
  ): HorizonWaveProjection {
    const expectedSampleCount = Math.max(1, Math.round(settings.displayHorizonMs / 1000));
    if (!candles.length) return emptyProjection(firstIndex, lastIndex, expectedSampleCount);

    const first = Math.max(0, Math.min(candles.length - 1, Math.floor(firstIndex)));
    const last = Math.max(first, Math.min(candles.length - 1, Math.floor(lastIndex)));
    const candlesPerPixel = 1 / Math.max(0.0001, pixelsPerCandle);
    const lod = resolveHorizonLod(candlesPerPixel, settings.lodMode);
    const bucketSize = lod === "candles" ? 1 : lod === "clusters" ? Math.max(2, Math.ceil(candlesPerPixel)) : Math.max(9, Math.ceil(candlesPerPixel));
    const tail = candles[last]!;
    const key = [first, last, bucketSize, lod, tail.time, tail.open, tail.high, tail.low, tail.close, tail.volume, tail.delta ?? "-"].join(":");
    const cached = this.cache.get(key);
    if (cached) return cached;

    const buckets: HorizonBucket[] = [];
    let previousCenterline: number | null = null;
    let previousRange = 0;
    let deltaSamples = 0;

    for (let startIndex = first; startIndex <= last; startIndex += bucketSize) {
      const endIndex = Math.min(last, startIndex + bucketSize - 1);
      const opening = candles[startIndex]!;
      const closing = candles[endIndex]!;
      let high = Number.NEGATIVE_INFINITY;
      let low = Number.POSITIVE_INFINITY;
      let volume = 0;
      let delta = 0;
      let deltaAvailable = false;
      let weightedTypical = 0;
      let weightTotal = 0;
      let pressureTotal = 0;
      let rejectionUpper = 0;
      let rejectionLower = 0;
      let pressureWeight = 0;

      for (let index = startIndex; index <= endIndex; index++) {
        const candle = candles[index]!;
        const range = Math.max(candle.high - candle.low, MIN_TICK);
        const candleVolume = Math.max(0, candle.volume);
        const weight = Math.max(Math.sqrt(candleVolume), 1);
        const typicalPrice = (candle.open + candle.high + candle.low + candle.close) / 4;
        const bodyPressure = clamp((candle.close - candle.open) / range);
        const upperRejection = clamp((candle.high - Math.max(candle.open, candle.close)) / range, 0, 1);
        const lowerRejection = clamp((Math.min(candle.open, candle.close) - candle.low) / range, 0, 1);
        const candleDelta = finiteDelta(candle);

        high = Math.max(high, candle.high);
        low = Math.min(low, candle.low);
        volume += candleVolume;
        weightedTypical += typicalPrice * Math.max(candleVolume, 1);
        weightTotal += Math.max(candleVolume, 1);
        pressureTotal += bodyPressure * weight;
        rejectionUpper += upperRejection * weight;
        rejectionLower += lowerRejection * weight;
        pressureWeight += weight;
        if (candleDelta !== null) {
          delta += candleDelta;
          deltaSamples += 1;
          deltaAvailable = true;
        }
      }

      const centerline = weightedTypical / Math.max(weightTotal, 1);
      const range = Math.max(high - low, MIN_TICK);
      const bodyPressure = clamp(pressureTotal / Math.max(pressureWeight, 1));
      const upperRejection = clamp(rejectionUpper / Math.max(pressureWeight, 1), 0, 1);
      const lowerRejection = clamp(rejectionLower / Math.max(pressureWeight, 1), 0, 1);
      const rejectionImbalance = clamp(lowerRejection - upperRejection);
      const centerlineSlope = previousCenterline === null ? 0 : clamp((centerline - previousCenterline) / range);
      const cvdSlope = deltaAvailable ? clamp(delta / Math.max(volume, MIN_TICK)) : 0;
      const acceptanceMigration = clamp(((centerline - opening.open) + (closing.close - centerline)) / (2 * range));
      const compressionExpansion = previousRange > 0 ? clamp(range / previousRange - 1) : 0;

      const components = deltaAvailable
        ? [[centerlineSlope, 0.35], [cvdSlope, 0.25], [acceptanceMigration, 0.20], [rejectionImbalance, 0.20]] as const
        : [[centerlineSlope, 0.35], [acceptanceMigration, 0.20], [rejectionImbalance, 0.20]] as const;
      const componentWeight = components.reduce((sum, component) => sum + component[1], 0);
      const directionScore = clamp(components.reduce((sum, component) => sum + component[0] * component[1], 0) / Math.max(componentWeight, MIN_TICK));
      const dispersion = Math.max(range * (0.18 + Math.abs(compressionExpansion) * 0.12), MIN_TICK);
      const upperEnvelope = Math.max(centerline + dispersion * (1 + upperRejection), closing.close);
      const lowerEnvelope = Math.min(centerline - dispersion * (1 + lowerRejection), closing.close);

      buckets.push({
        startIndex,
        endIndex,
        centerIndex: (startIndex + endIndex) / 2,
        open: opening.open,
        high,
        low,
        close: closing.close,
        volume,
        delta,
        deltaAvailable,
        bodyPressure,
        upperRejection,
        lowerRejection,
        rejectionImbalance,
        centerline,
        upperEnvelope,
        lowerEnvelope,
        centerlineSlope,
        cvdSlope,
        acceptanceMigration,
        compressionExpansion,
        directionScore
      });
      previousCenterline = centerline;
      previousRange = range;
    }

    const projection: HorizonWaveProjection = {
      firstIndex: first,
      lastIndex: last,
      bucketSize,
      candlesPerPixel,
      lod,
      sourceSampleCount: last - first + 1,
      expectedSampleCount,
      coverageRatio: Math.min(1, (last - first + 1) / expectedSampleCount),
      deltaCoverageRatio: deltaSamples / Math.max(1, last - first + 1),
      buckets,
      arrays: {
        centerline: Float64Array.from(buckets.map((bucket) => bucket.centerline)),
        upperEnvelope: Float64Array.from(buckets.map((bucket) => bucket.upperEnvelope)),
        lowerEnvelope: Float64Array.from(buckets.map((bucket) => bucket.lowerEnvelope)),
        directionScore: Float32Array.from(buckets.map((bucket) => bucket.directionScore)),
        bodyPressure: Float32Array.from(buckets.map((bucket) => bucket.bodyPressure)),
        rejectionImbalance: Float32Array.from(buckets.map((bucket) => bucket.rejectionImbalance)),
        compressionExpansion: Float32Array.from(buckets.map((bucket) => bucket.compressionExpansion)),
        volume: Float64Array.from(buckets.map((bucket) => bucket.volume)),
        delta: Float64Array.from(buckets.map((bucket) => bucket.delta))
      }
    };

    this.cache.set(key, projection);
    while (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    return projection;
  }

  sourceAt(candles: readonly Candle[], projection: HorizonWaveProjection | null, index: number): HorizonCrosshairSample | null {
    const sourceIndex = Math.max(0, Math.min(candles.length - 1, Math.round(index)));
    const candle = candles[sourceIndex];
    if (!candle) return null;
    const bucket = projection?.buckets.find((candidate) => sourceIndex >= candidate.startIndex && sourceIndex <= candidate.endIndex) ?? null;
    return { index: sourceIndex, candle, bucket };
  }

  clear() {
    this.cache.clear();
  }

  cacheSize() {
    return this.cache.size;
  }
}
