import type { Candle, VwapAnchorMode, VwapSettings } from "../types";

export type InstitutionalVwapPoint = {
  value: number;
  deviation: number;
  upper1: number;
  lower1: number;
  upper2: number;
  lower2: number;
  upper3: number;
  lower3: number;
  previousVwap?: number;
  anchor: boolean;
  anchorIndex: number;
  direction: -1 | 0 | 1;
};

export type InstitutionalVwapResult = {
  points: InstitutionalVwapPoint[];
  anchorIndices: number[];
  activeAnchorIndex: number;
};

type PreparedBar = {
  price: number;
  weight: number;
  trueRange: number;
  atr: number;
  range: number;
  volumeAverage: number;
};

const EMPTY_POINT: InstitutionalVwapPoint = {
  value: Number.NaN,
  deviation: Number.NaN,
  upper1: Number.NaN,
  lower1: Number.NaN,
  upper2: Number.NaN,
  lower2: Number.NaN,
  upper3: Number.NaN,
  lower3: Number.NaN,
  anchor: false,
  anchorIndex: -1,
  direction: 0
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function finite(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function priceFor(candle: Candle, source: VwapSettings["source"]) {
  if (source === "close") return candle.close;
  if (source === "hl2") return (candle.high + candle.low) / 2;
  if (source === "ohlc4") return (candle.open + candle.high + candle.low + candle.close) / 4;
  if (source === "weightedClose") return (candle.high + candle.low + candle.close * 2) / 4;
  return (candle.high + candle.low + candle.close) / 3;
}

function calendarAnchorKey(candle: Candle, mode: VwapAnchorMode, anchorHourUtc: number) {
  const shiftedSeconds = candle.time - clamp(Math.round(anchorHourUtc), 0, 23) * 3600;
  if (mode === "session") return Math.floor(shiftedSeconds / 86_400);
  if (mode === "week") return Math.floor((Math.floor(shiftedSeconds / 86_400) + 3) / 7);
  const date = new Date(shiftedSeconds * 1000);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

function prepareBars(candles: Candle[], settings: VwapSettings) {
  const atrLength = clamp(Math.round(settings.atrLength), 2, 500);
  const atrAlpha = 1 / atrLength;
  const volumeAlpha = 2 / (atrLength + 1);
  const directionalBias = clamp(finite(settings.directionalBias, 1), 0, 5);
  const bars: PreparedBar[] = [];
  let atr = 0;
  let volumeAverage = 0;

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    const range = Math.max(0, candle.high - candle.low);
    const trueRange = previous
      ? Math.max(range, Math.abs(candle.high - previous.close), Math.abs(candle.low - previous.close))
      : range;
    atr = index === 0 ? Math.max(trueRange, Number.EPSILON) : atr + atrAlpha * (trueRange - atr);
    const volume = Math.max(0, finite(candle.volume, 0));
    volumeAverage = index === 0 ? Math.max(volume, 1) : volumeAverage + volumeAlpha * (volume - volumeAverage);
    const atrRatio = clamp(trueRange / Math.max(atr, Number.EPSILON), 0.1, 8);
    const liquidityFactor = clamp(1 / atrRatio, 0.25, 4);
    const location = range > 0
      ? clamp(((candle.close - candle.low) / range) * 2 - 1, -1, 1)
      : 0;
    const convictionFactor = 1 + Math.abs(location) * directionalBias;
    let weight = volume;

    if (settings.weightingModel === "time") {
      weight = 1;
    } else if (settings.weightingModel === "liquidityAdjusted") {
      weight = volume * liquidityFactor;
    } else if (settings.weightingModel === "volatilityParticipation") {
      weight = volume * clamp(atrRatio, 0.35, 3.5);
    } else if (settings.weightingModel === "directionalConviction") {
      weight = volume * convictionFactor;
    } else if (settings.weightingModel === "blackCoreHybrid") {
      const participation = clamp(volume / Math.max(volumeAverage, 1), 0.2, 5);
      weight = volume
        * Math.sqrt(liquidityFactor * clamp(atrRatio, 0.5, 2.5))
        * (1 + Math.abs(location) * directionalBias * 0.5)
        * Math.sqrt(participation);
    }

    bars.push({
      price: priceFor(candle, settings.source),
      weight: Math.max(0, finite(weight, 0)),
      trueRange,
      atr: Math.max(atr, Number.EPSILON),
      range,
      volumeAverage: Math.max(volumeAverage, 1)
    });
  }

  return bars;
}

function staticAnchorIndex(candles: Candle[], bars: PreparedBar[], settings: VwapSettings) {
  const lookback = clamp(Math.round(settings.anchorLookbackBars), 10, Math.max(10, candles.length));
  const start = Math.max(0, candles.length - lookback);
  if (settings.anchorMode === "swingHigh") {
    let best = start;
    for (let index = start + 1; index < candles.length; index += 1) {
      if (candles[index].high >= candles[best].high) best = index;
    }
    return best;
  }
  if (settings.anchorMode === "swingLow") {
    let best = start;
    for (let index = start + 1; index < candles.length; index += 1) {
      if (candles[index].low <= candles[best].low) best = index;
    }
    return best;
  }
  if (settings.anchorMode === "volumeClimax") {
    let best = start;
    for (let index = start + 1; index < candles.length; index += 1) {
      if (candles[index].volume >= candles[best].volume) best = index;
    }
    return best;
  }
  if (settings.anchorMode === "volatilityBreak") {
    let best = start;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = start; index < candles.length; index += 1) {
      const bar = bars[index];
      const participation = candles[index].volume / Math.max(bar.volumeAverage, 1);
      const score = (bar.trueRange / Math.max(bar.atr, Number.EPSILON)) * Math.sqrt(Math.max(0, participation));
      if (score >= bestScore) {
        bestScore = score;
        best = index;
      }
    }
    return best;
  }
  return 0;
}

function deviationFor(
  settings: VwapSettings,
  value: number,
  weightedVariance: number,
  atr: number,
  averageRange: number
) {
  const standardDeviation = Math.sqrt(Math.max(0, weightedVariance));
  if (settings.bandMode === "atr") return Math.max(atr, Number.EPSILON);
  if (settings.bandMode === "percentage") {
    return Math.abs(value) * clamp(finite(settings.bandPercentage, 0.75), 0.01, 25) / 100;
  }
  if (settings.bandMode === "microstructure") {
    return Math.sqrt(standardDeviation ** 2 + (Math.max(0, averageRange) * 0.5) ** 2);
  }
  return standardDeviation;
}

function makePoint(
  value: number,
  deviation: number,
  previousVwap: number | undefined,
  anchor: boolean,
  anchorIndex: number,
  settings: VwapSettings
): InstitutionalVwapPoint {
  const multiplier1 = clamp(finite(settings.band1Multiplier, 1), 0.1, 20);
  const multiplier2 = clamp(finite(settings.band2Multiplier, 2), 0.1, 20);
  const multiplier3 = clamp(finite(settings.band3Multiplier, 3), 0.1, 20);
  return {
    value,
    deviation,
    upper1: value + deviation * multiplier1,
    lower1: value - deviation * multiplier1,
    upper2: value + deviation * multiplier2,
    lower2: value - deviation * multiplier2,
    upper3: value + deviation * multiplier3,
    lower3: value - deviation * multiplier3,
    previousVwap,
    anchor,
    anchorIndex,
    direction: 0
  };
}

function calculateRolling(bars: PreparedBar[], settings: VwapSettings) {
  const window = clamp(Math.round(settings.lookbackBars), 2, Math.max(2, bars.length));
  const prefixWeight = new Float64Array(bars.length + 1);
  const prefixPriceWeight = new Float64Array(bars.length + 1);
  const prefixPriceSquaredWeight = new Float64Array(bars.length + 1);
  const prefixRangeWeight = new Float64Array(bars.length + 1);
  const points = bars.map(() => ({ ...EMPTY_POINT }));

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    prefixWeight[index + 1] = prefixWeight[index] + bar.weight;
    prefixPriceWeight[index + 1] = prefixPriceWeight[index] + bar.price * bar.weight;
    prefixPriceSquaredWeight[index + 1] = prefixPriceSquaredWeight[index] + bar.price ** 2 * bar.weight;
    prefixRangeWeight[index + 1] = prefixRangeWeight[index] + bar.range * bar.weight;
    const start = Math.max(0, index - window + 1);
    const weight = prefixWeight[index + 1] - prefixWeight[start];
    const value = weight > 0
      ? (prefixPriceWeight[index + 1] - prefixPriceWeight[start]) / weight
      : bar.price;
    const secondMoment = weight > 0
      ? (prefixPriceSquaredWeight[index + 1] - prefixPriceSquaredWeight[start]) / weight
      : value ** 2;
    const averageRange = weight > 0
      ? (prefixRangeWeight[index + 1] - prefixRangeWeight[start]) / weight
      : bar.range;
    const deviation = deviationFor(settings, value, secondMoment - value ** 2, bar.atr, averageRange);
    points[index] = makePoint(value, deviation, undefined, index === 0, start, settings);
  }

  return { points, anchorIndices: bars.length ? [0] : [], activeAnchorIndex: Math.max(0, bars.length - window) };
}

function smoothPoints(points: InstitutionalVwapPoint[], settings: VwapSettings) {
  if (settings.smoothingMethod === "none") return;
  const length = clamp(Math.round(settings.smoothingLength), 1, 100);
  const alpha = settings.smoothingMethod === "ema" ? 2 / (length + 1) : 1 / length;
  let smoothed = Number.NaN;

  for (const point of points) {
    if (!Number.isFinite(point.value)) continue;
    if (point.anchor || !Number.isFinite(smoothed)) {
      smoothed = point.value;
    } else {
      smoothed += alpha * (point.value - smoothed);
    }
    const shift = smoothed - point.value;
    point.value = smoothed;
    point.upper1 += shift;
    point.lower1 += shift;
    point.upper2 += shift;
    point.lower2 += shift;
    point.upper3 += shift;
    point.lower3 += shift;
  }
}

function classifyDirection(points: InstitutionalVwapPoint[], settings: VwapSettings) {
  const lookback = clamp(Math.round(settings.slopeLookback), 1, 100);
  const thresholdBps = clamp(finite(settings.slopeThresholdBps, 0.35), 0, 100);
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!Number.isFinite(point.value)) continue;
    let referenceIndex = Math.max(point.anchorIndex, index - lookback);
    while (referenceIndex < index && !Number.isFinite(points[referenceIndex].value)) referenceIndex += 1;
    const reference = points[referenceIndex]?.value;
    if (!Number.isFinite(reference) || reference === 0) continue;
    const slopeBps = ((point.value - reference) / Math.abs(reference)) * 10_000;
    point.direction = slopeBps > thresholdBps ? 1 : slopeBps < -thresholdBps ? -1 : 0;
  }
}

export function calculateInstitutionalVwap(
  candles: Candle[],
  settings: VwapSettings
): InstitutionalVwapResult {
  if (candles.length === 0) return { points: [], anchorIndices: [], activeAnchorIndex: -1 };
  const bars = prepareBars(candles, settings);

  if (settings.anchorMode === "rolling" && settings.weightingModel !== "exponentialVolume") {
    const result = calculateRolling(bars, settings);
    smoothPoints(result.points, settings);
    classifyDirection(result.points, settings);
    return result;
  }

  const points = bars.map(() => ({ ...EMPTY_POINT }));
  const anchorIndices: number[] = [];
  const staticModes: VwapAnchorMode[] = ["swingHigh", "swingLow", "volumeClimax", "volatilityBreak"];
  const staticAnchor = staticModes.includes(settings.anchorMode)
    ? staticAnchorIndex(candles, bars, settings)
    : 0;
  const minimumBars = clamp(Math.round(settings.minimumBarsBetweenAnchors), 2, 5_000);
  const regimeSensitivity = clamp(finite(settings.regimeSensitivity, 2.2), 0.5, 10);
  const volumeThreshold = clamp(finite(settings.volumeThreshold, 1.8), 0.25, 10);
  const decay = settings.weightingModel === "exponentialVolume" || settings.anchorMode === "rolling"
    ? Math.pow(0.5, 1 / clamp(finite(settings.decayHalfLife, 72), 2, 5_000))
    : 1;
  let cumulativeWeight = 0;
  let cumulativePriceWeight = 0;
  let cumulativePriceSquaredWeight = 0;
  let cumulativeRangeWeight = 0;
  let currentAnchor = -1;
  let currentCalendarKey: number | undefined;
  let previousVwap: number | undefined;
  let lastValue = Number.NaN;

  for (let index = 0; index < bars.length; index += 1) {
    if (index < staticAnchor) continue;
    const bar = bars[index];
    let reset = index === staticAnchor;

    if (settings.anchorMode === "session" || settings.anchorMode === "week" || settings.anchorMode === "month") {
      const key = calendarAnchorKey(candles[index], settings.anchorMode, settings.sessionAnchorHourUtc);
      reset = currentCalendarKey === undefined || key !== currentCalendarKey;
      currentCalendarKey = key;
    } else if (settings.anchorMode === "autoRegime" && index > 0) {
      const rangeShock = bar.trueRange / Math.max(bar.atr, Number.EPSILON);
      const volumeShock = candles[index].volume / Math.max(bar.volumeAverage, 1);
      reset = currentAnchor < 0
        || (index - currentAnchor >= minimumBars && rangeShock >= regimeSensitivity && volumeShock >= volumeThreshold);
    } else if (settings.anchorMode === "rolling" && index === 0) {
      reset = true;
    }

    if (reset) {
      if (Number.isFinite(lastValue)) previousVwap = lastValue;
      cumulativeWeight = 0;
      cumulativePriceWeight = 0;
      cumulativePriceSquaredWeight = 0;
      cumulativeRangeWeight = 0;
      currentAnchor = index;
      anchorIndices.push(index);
    } else if (decay < 1) {
      cumulativeWeight *= decay;
      cumulativePriceWeight *= decay;
      cumulativePriceSquaredWeight *= decay;
      cumulativeRangeWeight *= decay;
    }

    cumulativeWeight += bar.weight;
    cumulativePriceWeight += bar.price * bar.weight;
    cumulativePriceSquaredWeight += bar.price ** 2 * bar.weight;
    cumulativeRangeWeight += bar.range * bar.weight;
    const value = cumulativeWeight > 0 ? cumulativePriceWeight / cumulativeWeight : bar.price;
    const secondMoment = cumulativeWeight > 0 ? cumulativePriceSquaredWeight / cumulativeWeight : value ** 2;
    const averageRange = cumulativeWeight > 0 ? cumulativeRangeWeight / cumulativeWeight : bar.range;
    const deviation = deviationFor(settings, value, secondMoment - value ** 2, bar.atr, averageRange);
    points[index] = makePoint(value, deviation, previousVwap, reset, currentAnchor, settings);
    lastValue = value;
  }

  smoothPoints(points, settings);
  classifyDirection(points, settings);
  return {
    points,
    anchorIndices,
    activeAnchorIndex: anchorIndices[anchorIndices.length - 1] ?? -1
  };
}
