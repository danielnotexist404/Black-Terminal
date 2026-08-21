import type { Candle } from "./types";

export const CHART_LOD_MIN_PIXEL_SPACING = 1;

export type CandleRenderBucket = {
  startIndex: number;
  endIndex: number;
  centerIndex: number;
  candle: Candle;
};

export function chartRenderStride(timeStep: number, minimumPixelSpacing = CHART_LOD_MIN_PIXEL_SPACING) {
  if (!Number.isFinite(timeStep) || timeStep <= 0) return 1;
  return Math.max(1, Math.ceil(Math.max(0.25, minimumPixelSpacing) / timeStep));
}

export function chartRenderIndices(firstIndex: number, lastIndex: number, stride: number) {
  const first = Math.max(0, Math.floor(firstIndex));
  const last = Math.max(first, Math.floor(lastIndex));
  const step = Math.max(1, Math.floor(stride));
  const indices: number[] = [];
  for (let index = first; index <= last; index += step) indices.push(index);
  if (indices.at(-1) !== last) indices.push(last);
  return indices;
}

export function aggregateCandleRenderBuckets(
  candles: readonly Candle[],
  firstIndex: number,
  lastIndex: number,
  stride: number
): CandleRenderBucket[] {
  if (candles.length === 0) return [];
  const first = Math.max(0, Math.min(candles.length - 1, Math.floor(firstIndex)));
  const last = Math.max(first, Math.min(candles.length - 1, Math.floor(lastIndex)));
  const step = Math.max(1, Math.floor(stride));
  const buckets: CandleRenderBucket[] = [];

  for (let startIndex = first; startIndex <= last; startIndex += step) {
    const endIndex = Math.min(last, startIndex + step - 1);
    const opening = candles[startIndex];
    const closing = candles[endIndex];
    if (!opening || !closing) continue;

    let high = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    let volume = 0;
    for (let index = startIndex; index <= endIndex; index++) {
      const candle = candles[index];
      if (!candle) continue;
      high = Math.max(high, candle.high);
      low = Math.min(low, candle.low);
      volume += candle.volume;
    }

    buckets.push({
      startIndex,
      endIndex,
      centerIndex: (startIndex + endIndex) / 2,
      candle: {
        time: closing.time,
        open: opening.open,
        high: Number.isFinite(high) ? high : Math.max(opening.open, closing.close),
        low: Number.isFinite(low) ? low : Math.min(opening.open, closing.close),
        close: closing.close,
        volume
      }
    });
  }

  return buckets;
}

export function visibleCandleDomain(candles: readonly Candle[], firstIndex: number, lastIndex: number) {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  let maximumVolume = 1;
  const first = Math.max(0, Math.floor(firstIndex));
  const last = Math.min(candles.length - 1, Math.floor(lastIndex));
  for (let index = first; index <= last; index++) {
    const candle = candles[index];
    if (!candle) continue;
    minimum = Math.min(minimum, candle.low);
    maximum = Math.max(maximum, candle.high);
    maximumVolume = Math.max(maximumVolume, candle.volume);
  }
  return { minimum, maximum, maximumVolume };
}
