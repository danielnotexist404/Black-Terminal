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
  for (let index = 0; index < values.length; index++) {
    sum += finite(values[index]!);
    if (index >= length) sum -= finite(values[index - length]!);
    if (index >= length - 1) result[index] = sum / length;
  }
  return result;
}

function wma(values: readonly number[], length: number) {
  const result = Array<number>(values.length).fill(Number.NaN);
  const denominator = length * (length + 1) / 2;
  for (let index = length - 1; index < values.length; index++) {
    let sum = 0;
    for (let offset = 0; offset < length; offset++) sum += finite(values[index - offset]!) * (length - offset);
    result[index] = sum / denominator;
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
    for (let offset = 0; offset < length; offset++) {
      const value = finite(values[index - offset]!);
      sum += value;
      sumSquares += value * value;
    }
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
  const delta = source.map((candle) => {
    const range = Math.max(Math.abs(candle.high - candle.low), 1e-12);
    return settings.useVolumeIntegration
      ? finite(candle.volume) * (finite(candle.close) - finite(candle.open))
      : finite(candle.volume) * (finite(candle.close) - finite(candle.open)) / range;
  });
  const cvd = Array<number>(source.length).fill(0);
  for (let index = 0; index < delta.length; index++) cvd[index] = (index > 0 ? cvd[index - 1]! : 0) + finite(delta[index]!);
  const fast = movingAverage(cvd, fastLength, settings.fastMaType);
  const slow = movingAverage(cvd, slowLength, settings.slowMaType);
  const deviation = rollingDeviation(cvd, settings.cloudLength);
  const upperCloud = slow.map((value, index) => Number.isFinite(value) && Number.isFinite(deviation[index]) ? value + deviation[index]! * settings.cloudDeviation : Number.NaN);
  const lowerCloud = slow.map((value, index) => Number.isFinite(value) && Number.isFinite(deviation[index]) ? value - deviation[index]! * settings.cloudDeviation : Number.NaN);
  const state = cvd.map<CvdOscillatorMarketState>((value, index) => {
    const fastValue = fast[index]!;
    const slowValue = slow[index]!;
    if (!Number.isFinite(fastValue) || !Number.isFinite(slowValue)) return "SIDEWAYS";
    if (value > fastValue && value > slowValue) return "LONG";
    if (value < fastValue && value < slowValue) return "SHORT";
    return "SIDEWAYS";
  });
  const last = Math.max(0, source.length - 1);
  return {
    authority: "OHLCV_CANDLE_SIGNED_ESTIMATE",
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
