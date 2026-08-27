import type { Candle } from "../../../chart-engine/types.ts";
import type { MarketSentimentRegime, MarketSentimentSettings } from "./types.ts";

type NullableSeries = Array<number | null>;

type CalibrationEntry = { index: number; value: number };

type CalibrationWindow = {
  entries: CalibrationEntry[];
  sorted: number[];
};

export type AdaptiveMarketSentimentSeries = {
  empiricalPercentile: NullableSeries;
  adaptiveScore: NullableSeries;
  dynamicUpper: NullableSeries;
  dynamicLower: NullableSeries;
  tailProbability: NullableSeries;
  calibrationSamples: number[];
  evtActive: boolean[];
  regime: MarketSentimentRegime[];
  regimeStrength: number[];
};

const valid = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

function ema(values: readonly number[], length: number): number[] {
  if (!values.length) return [];
  const alpha = 2 / (length + 1);
  const output = [values[0]!];
  for (let index = 1; index < values.length; index += 1) {
    output.push(alpha * values[index]! + (1 - alpha) * output[index - 1]!);
  }
  return output;
}

function rma(values: readonly number[], length: number): NullableSeries {
  const output: NullableSeries = Array(values.length).fill(null);
  if (values.length < length) return output;
  let seed = 0;
  for (let index = 0; index < length; index += 1) seed += values[index]!;
  output[length - 1] = seed / length;
  for (let index = length; index < values.length; index += 1) {
    output[index] = (output[index - 1]! * (length - 1) + values[index]!) / length;
  }
  return output;
}

function atr(candles: readonly Candle[], length: number): NullableSeries {
  const trueRange = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1]!.close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  });
  return rma(trueRange, length);
}

function lowerBound(values: readonly number[], target: number) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(values: readonly number[], target: number) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function insertSorted(values: number[], value: number) {
  values.splice(upperBound(values, value), 0, value);
}

function removeSorted(values: number[], value: number) {
  const index = lowerBound(values, value);
  if (index < values.length && values[index] === value) values.splice(index, 1);
}

function prune(window: CalibrationWindow, minimumIndex: number) {
  while (window.entries.length && window.entries[0]!.index < minimumIndex) {
    removeSorted(window.sorted, window.entries.shift()!.value);
  }
}

function append(window: CalibrationWindow, index: number, value: number) {
  window.entries.push({ index, value });
  insertSorted(window.sorted, value);
}

function midRankPercentile(sorted: readonly number[], value: number) {
  if (!sorted.length) return Number.NaN;
  const below = lowerBound(sorted, value);
  const atOrBelow = upperBound(sorted, value);
  return clamp((below + (atOrBelow - below) * 0.5) / sorted.length, 0, 1);
}

function quantile(sorted: readonly number[], probability: number) {
  if (!sorted.length) return Number.NaN;
  const position = clamp(probability, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function fitGpd(exceedances: readonly number[]) {
  if (exceedances.length < 2) return null;
  const mean = exceedances.reduce((total, value) => total + value, 0) / exceedances.length;
  if (!(mean > 1e-12)) return null;
  const variance = exceedances.reduce((total, value) => total + (value - mean) ** 2, 0) / Math.max(1, exceedances.length - 1);
  if (!(variance > 1e-18)) return null;
  const shape = clamp(0.5 * (1 - mean * mean / variance), -0.35, 0.45);
  const scale = mean * (1 - shape);
  return scale > 1e-12 && Number.isFinite(scale) ? { shape, scale } : null;
}

function gpdSurvival(exceedance: number, fit: { shape: number; scale: number }) {
  if (exceedance <= 0) return 1;
  if (Math.abs(fit.shape) < 1e-7) return Math.exp(-exceedance / fit.scale);
  const base = 1 + fit.shape * exceedance / fit.scale;
  return base <= 0 ? 0 : clamp(base ** (-1 / fit.shape), 0, 1);
}

function evtAdjustedPercentile(
  sorted: readonly number[],
  value: number,
  empirical: number,
  settings: MarketSentimentSettings
) {
  const thresholdProbability = settings.evtThresholdPercentile / 100;
  if (empirical >= thresholdProbability) {
    const threshold = quantile(sorted, thresholdProbability);
    const exceedances = sorted.filter((sample) => sample > threshold).map((sample) => sample - threshold);
    if (exceedances.length >= settings.evtMinimumTailSamples) {
      const fit = fitGpd(exceedances);
      if (fit) {
        const tailProbability = clamp(exceedances.length / sorted.length * gpdSurvival(Math.max(0, value - threshold), fit), 1e-6, 0.5);
        return { percentile: 1 - tailProbability, tailProbability, active: true };
      }
    }
  }
  if (empirical <= 1 - thresholdProbability) {
    const threshold = quantile(sorted, 1 - thresholdProbability);
    const exceedances = sorted.filter((sample) => sample < threshold).map((sample) => threshold - sample);
    if (exceedances.length >= settings.evtMinimumTailSamples) {
      const fit = fitGpd(exceedances);
      if (fit) {
        const tailProbability = clamp(exceedances.length / sorted.length * gpdSurvival(Math.max(0, threshold - value), fit), 1e-6, 0.5);
        return { percentile: tailProbability, tailProbability, active: true };
      }
    }
  }
  return { percentile: empirical, tailProbability: Math.min(empirical, 1 - empirical), active: false };
}

export function calculateMarketSentimentRegimes(candles: readonly Candle[], settings: MarketSentimentSettings) {
  const closes = candles.map((candle) => candle.close);
  const macro = ema(closes, settings.regimeLength);
  const volatility = atr(candles, settings.atrLength);
  const regime: MarketSentimentRegime[] = Array(candles.length).fill("INSUFFICIENT");
  const strength = Array(candles.length).fill(0);
  let active: MarketSentimentRegime = "ROTATION";
  for (let index = settings.regimeSlopeLength; index < candles.length; index += 1) {
    const currentAtr = volatility[index];
    if (!valid(currentAtr) || currentAtr <= 1e-12) continue;
    const velocity = (macro[index]! - macro[index - settings.regimeSlopeLength]!) / (currentAtr * Math.sqrt(settings.regimeSlopeLength));
    const enter = settings.regimeThreshold;
    const exit = enter * 0.65;
    if (active === "UPTREND") {
      active = velocity <= -enter ? "DOWNTREND" : velocity < exit ? "ROTATION" : "UPTREND";
    } else if (active === "DOWNTREND") {
      active = velocity >= enter ? "UPTREND" : velocity > -exit ? "ROTATION" : "DOWNTREND";
    } else {
      active = velocity >= enter ? "UPTREND" : velocity <= -enter ? "DOWNTREND" : "ROTATION";
    }
    regime[index] = active;
    strength[index] = active === "ROTATION" ? 0 : clamp((Math.abs(velocity) - enter) / Math.max(0.25, 2.5 - enter), 0, 1);
  }
  return { regime, strength };
}

export function calculateAdaptiveMarketSentiment(
  candles: readonly Candle[],
  latentSentiment: readonly (number | null)[],
  settings: MarketSentimentSettings
): AdaptiveMarketSentimentSeries {
  const count = candles.length;
  const empiricalPercentile: NullableSeries = Array(count).fill(null);
  const adaptiveScore: NullableSeries = Array(count).fill(null);
  const dynamicUpper: NullableSeries = Array(count).fill(null);
  const dynamicLower: NullableSeries = Array(count).fill(null);
  const tailProbability: NullableSeries = Array(count).fill(null);
  const calibrationSamples = Array(count).fill(0);
  const evtActive = Array(count).fill(false);
  const { regime, strength: regimeStrength } = calculateMarketSentimentRegimes(candles, settings);
  const globalWindow: CalibrationWindow = { entries: [], sorted: [] };
  const regimeWindows: Record<"UPTREND" | "DOWNTREND" | "ROTATION", CalibrationWindow> = {
    UPTREND: { entries: [], sorted: [] },
    DOWNTREND: { entries: [], sorted: [] },
    ROTATION: { entries: [], sorted: [] }
  };

  for (let index = 0; index < count; index += 1) {
    const minimumIndex = index - settings.adaptiveWindow;
    prune(globalWindow, minimumIndex);
    for (const window of Object.values(regimeWindows)) prune(window, minimumIndex);
    const value = latentSentiment[index];
    const currentRegime = regime[index];
    if (valid(value) && currentRegime !== "INSUFFICIENT") {
      const regimeWindow = regimeWindows[currentRegime];
      const selected = regimeWindow.sorted.length >= settings.minimumCalibrationSamples ? regimeWindow.sorted : globalWindow.sorted;
      calibrationSamples[index] = selected.length;
      if (selected.length >= settings.minimumCalibrationSamples) {
        const empirical = midRankPercentile(selected, value);
        empiricalPercentile[index] = empirical;
        const adjusted = settings.calculationMode === "ADAPTIVE_EVT"
          ? evtAdjustedPercentile(selected, value, empirical, settings)
          : { percentile: empirical, tailProbability: Math.min(empirical, 1 - empirical), active: false };
        adaptiveScore[index] = clamp(adjusted.percentile * 10, 0, 10);
        tailProbability[index] = adjusted.tailProbability;
        evtActive[index] = adjusted.active;
        const expansion = settings.trendExpansion * regimeStrength[index]!;
        dynamicUpper[index] = clamp((settings.tailConfidence + (currentRegime === "UPTREND" ? expansion : 0)) / 10, 5.05, 9.99);
        dynamicLower[index] = clamp((100 - settings.tailConfidence - (currentRegime === "DOWNTREND" ? expansion : 0)) / 10, 0.01, 4.95);
      }
      append(globalWindow, index, value);
      append(regimeWindow, index, value);
    }
  }

  return {
    empiricalPercentile,
    adaptiveScore,
    dynamicUpper,
    dynamicLower,
    tailProbability,
    calibrationSamples,
    evtActive,
    regime,
    regimeStrength
  };
}
