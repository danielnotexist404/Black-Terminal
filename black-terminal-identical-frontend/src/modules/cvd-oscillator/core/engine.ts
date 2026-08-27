import type { Candle } from "../../../chart-engine/types.ts";
import { migrateCvdOscillatorSettings } from "./settings.ts";
import type {
  CvdOscillatorInput,
  CvdOscillatorMaType,
  CvdOscillatorMarketState,
  CvdOscillatorSnapshot
} from "./types.ts";

const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;

function ema(values: readonly number[], length: number) {
  const result = Array<number>(values.length).fill(Number.NaN);
  const alpha = 2 / (Math.max(1, length) + 1);
  let previous = Number.NaN;
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (!Number.isFinite(value)) continue;
    previous = Number.isFinite(previous) ? previous + alpha * (value - previous) : value;
    result[index] = previous;
  }
  return result;
}

function rma(values: readonly number[], length: number) {
  const result = Array<number>(values.length).fill(Number.NaN);
  const alpha = 1 / Math.max(1, length);
  let previous = Number.NaN;
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (!Number.isFinite(value)) continue;
    previous = Number.isFinite(previous) ? previous + alpha * (value - previous) : value;
    result[index] = previous;
  }
  return result;
}

function sma(values: readonly number[], length: number) {
  const result = Array<number>(values.length).fill(Number.NaN);
  let sum = 0;
  let valid = 0;
  for (let index = 0; index < values.length; index++) {
    if (Number.isFinite(values[index])) { sum += values[index]!; valid += 1; }
    if (index >= length && Number.isFinite(values[index - length])) { sum -= values[index - length]!; valid -= 1; }
    if (index >= length - 1 && valid === length) result[index] = sum / length;
  }
  return result;
}

function wma(values: readonly number[], length: number) {
  const result = Array<number>(values.length).fill(Number.NaN);
  const denominator = length * (length + 1) / 2;
  for (let index = length - 1; index < values.length; index++) {
    let sum = 0;
    let valid = true;
    for (let offset = 0; offset < length; offset++) {
      const value = values[index - offset]!;
      if (!Number.isFinite(value)) { valid = false; break; }
      sum += value * (length - offset);
    }
    if (valid) result[index] = sum / denominator;
  }
  return result;
}

function movingAverage(values: readonly number[], length: number, type: CvdOscillatorMaType) {
  if (type === "SMA") return sma(values, length);
  if (type === "WMA") return wma(values, length);
  if (type === "RMA") return rma(values, length);
  return ema(values, length);
}

function rollingDeviation(values: readonly number[], length: number) {
  const result = Array<number>(values.length).fill(Number.NaN);
  for (let index = length - 1; index < values.length; index++) {
    let sum = 0;
    let sumSquares = 0;
    let valid = true;
    for (let offset = 0; offset < length; offset++) {
      const value = values[index - offset]!;
      if (!Number.isFinite(value)) { valid = false; break; }
      sum += value;
      sumSquares += value * value;
    }
    if (!valid) continue;
    const mean = sum / length;
    result[index] = Math.sqrt(Math.max(0, sumSquares / length - mean * mean));
  }
  return result;
}

export function resolveCvdOscillatorAutoLengths(timeframeSeconds: number) {
  if (timeframeSeconds >= 604_800) return { fast: 13, slow: 21 };
  if (timeframeSeconds >= 86_400) return { fast: 34, slow: 55 };
  if (timeframeSeconds >= 14_400) return { fast: 89, slow: 144 };
  if (timeframeSeconds >= 3_600) return { fast: 144, slow: 233 };
  return { fast: 34, slow: 55 };
}

export function calculateCvdOscillator(input: CvdOscillatorInput): CvdOscillatorSnapshot {
  const settings = migrateCvdOscillatorSettings(input.settings);
  const source = input.candles.slice(-settings.lookback) as Candle[];
  const auto = resolveCvdOscillatorAutoLengths(input.timeframeSeconds);
  const fastLength = settings.parametersMode === "Auto" ? auto.fast : settings.fastLength;
  const slowLength = settings.parametersMode === "Auto" ? auto.slow : settings.slowLength;
  let authority: CvdOscillatorSnapshot["authority"] = "OHLCV_CANDLE_SIGNED_ESTIMATE";
  let warning: string | null = null;
  let coveragePercent = 100;
  let delta: number[];
  let cvd: number[];

  if (settings.useAuthenticAggressorFlow) {
    const authentic = input.authenticSnapshot;
    if (!authentic || authentic.authority !== "EXACT_AGGRESSOR_TRADES") {
      authority = "UNAVAILABLE";
      warning = authentic?.warning ?? "Certified venue-matched aggressor flow is unavailable. OHLCV fallback was not substituted.";
      delta = Array<number>(source.length).fill(Number.NaN);
      cvd = Array<number>(source.length).fill(Number.NaN);
      coveragePercent = 0;
    } else {
      const sourceByTime = new Map<number, { cvd: number; coverage: number }>();
      for (let index = 0; index < authentic.barTimes.length; index++) {
        sourceByTime.set(authentic.barTimes[index]!, {
          cvd: authentic.series.cumulativeDelta[index] ?? Number.NaN,
          coverage: authentic.series.coveragePercent[index] ?? 0
        });
      }
      cvd = source.map((candle) => sourceByTime.get(candle.time)?.cvd ?? Number.NaN);
      const coverage = source.map((candle) => sourceByTime.get(candle.time)?.coverage ?? 0);
      const coveredBars = coverage.filter((value, index) => value > 0 && Number.isFinite(cvd[index]));
      coveragePercent = source.length ? coveredBars.reduce((sum, value) => sum + value, 0) / source.length : 0;
      delta = Array<number>(source.length).fill(Number.NaN);
      let priorCvd = Number.NaN;
      for (let index = 0; index < cvd.length; index++) {
        const value = cvd[index]!;
        if (!Number.isFinite(value)) continue;
        delta[index] = Number.isFinite(priorCvd) ? value - priorCvd : value;
        priorCvd = value;
      }
      if (!cvd.some(Number.isFinite)) {
        authority = "UNAVAILABLE";
        warning = authentic.warning ?? "No certified aggressor-flow bars overlap the active chart history. OHLCV fallback was not substituted.";
      } else {
        authority = "EXACT_AGGRESSOR_TRADES";
        warning = authentic.warning;
      }
    }
  } else {
    delta = source.map((candle) => {
      const range = Math.max(Math.abs(candle.high - candle.low), 1e-12);
      return settings.useVolumeIntegration
        ? finite(candle.volume) * (finite(candle.close) - finite(candle.open))
        : finite(candle.volume) * (finite(candle.close) - finite(candle.open)) / range;
    });
    cvd = Array<number>(source.length).fill(0);
    for (let index = 0; index < delta.length; index++) cvd[index] = (index > 0 ? cvd[index - 1]! : 0) + finite(delta[index]!);
  }
  const fast = movingAverage(cvd, fastLength, settings.fastMaType);
  const slow = movingAverage(cvd, slowLength, settings.slowMaType);
  const deviation = rollingDeviation(cvd, settings.cloudLength);
  const upperCloud = slow.map((value, index) => Number.isFinite(value) && Number.isFinite(deviation[index]) ? value + deviation[index]! * settings.cloudDeviation : Number.NaN);
  const lowerCloud = slow.map((value, index) => Number.isFinite(value) && Number.isFinite(deviation[index]) ? value - deviation[index]! * settings.cloudDeviation : Number.NaN);
  const state = cvd.map<CvdOscillatorMarketState>((value, index) => {
    const fastValue = fast[index]!;
    const slowValue = slow[index]!;
    if (!Number.isFinite(value)) return settings.useAuthenticAggressorFlow ? "UNAVAILABLE" : "SIDEWAYS";
    if (!Number.isFinite(fastValue) || !Number.isFinite(slowValue)) return "SIDEWAYS";
    if (value > fastValue && value > slowValue) return "LONG";
    if (value < fastValue && value < slowValue) return "SHORT";
    return "SIDEWAYS";
  });
  let last = Math.max(0, source.length - 1);
  if (settings.useAuthenticAggressorFlow) {
    while (last > 0 && !Number.isFinite(cvd[last])) last -= 1;
  }
  return {
    authority,
    warning,
    coveragePercent,
    modelVersion: "BC_CVD_OSC_V1",
    inputSize: source.length,
    validFrom: Math.max(fastLength, slowLength, settings.cloudLength) - 1,
    lengths: { fast: fastLength, slow: slowLength },
    series: { delta, cvd, fast, slow, upperCloud, lowerCloud, state },
    latest: {
      state: state[last] ?? "SIDEWAYS",
      delta: delta[last] ?? 0,
      cvd: cvd[last] ?? 0,
      fast: fast[last] ?? Number.NaN,
      slow: slow[last] ?? Number.NaN
    }
  };
}
