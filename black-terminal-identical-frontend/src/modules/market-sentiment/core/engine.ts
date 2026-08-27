import type { Candle } from "../../../chart-engine/types.ts";
import { migrateMarketSentimentSettings } from "./settings.ts";
import type {
  MarketSentimentComponents,
  MarketSentimentInput,
  MarketSentimentSnapshot,
  MarketSentimentZone
} from "./types.ts";

type NullableSeries = Array<number | null>;

const valid = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);

function sma(values: readonly number[], length: number): NullableSeries {
  const output: NullableSeries = Array(values.length).fill(null);
  let total = 0;
  for (let index = 0; index < values.length; index += 1) {
    total += values[index]!;
    if (index >= length) total -= values[index - length]!;
    if (index >= length - 1) output[index] = total / length;
  }
  return output;
}

function nullableSma(values: readonly (number | null)[], length: number): NullableSeries {
  const output: NullableSeries = Array(values.length).fill(null);
  for (let index = length - 1; index < values.length; index += 1) {
    let total = 0;
    let ready = true;
    for (let offset = 0; offset < length; offset += 1) {
      const value = values[index - offset];
      if (!valid(value)) { ready = false; break; }
      total += value;
    }
    if (ready) output[index] = total / length;
  }
  return output;
}

function ema(values: readonly number[], length: number): number[] {
  if (!values.length) return [];
  const alpha = 2 / (length + 1);
  const output = [values[0]!];
  for (let index = 1; index < values.length; index += 1) output.push(alpha * values[index]! + (1 - alpha) * output[index - 1]!);
  return output;
}

function wmaNullable(values: readonly (number | null)[], length: number): NullableSeries {
  const output: NullableSeries = Array(values.length).fill(null);
  const denominator = length * (length + 1) / 2;
  for (let index = length - 1; index < values.length; index += 1) {
    let total = 0;
    let ready = true;
    for (let offset = 0; offset < length; offset += 1) {
      const value = values[index - offset];
      if (!valid(value)) { ready = false; break; }
      total += value * (length - offset);
    }
    if (ready) output[index] = total / denominator;
  }
  return output;
}

function rma(values: readonly number[], length: number): NullableSeries {
  const output: NullableSeries = Array(values.length).fill(null);
  if (values.length < length) return output;
  let seed = 0;
  for (let index = 0; index < length; index += 1) seed += values[index]!;
  output[length - 1] = seed / length;
  for (let index = length; index < values.length; index += 1) output[index] = (output[index - 1]! * (length - 1) + values[index]!) / length;
  return output;
}

function rsi(values: readonly number[], length: number): NullableSeries {
  const gains = Array(values.length).fill(0);
  const losses = Array(values.length).fill(0);
  for (let index = 1; index < values.length; index += 1) {
    const change = values[index]! - values[index - 1]!;
    gains[index] = Math.max(change, 0);
    losses[index] = Math.max(-change, 0);
  }
  const averageGain = rma(gains, length);
  const averageLoss = rma(losses, length);
  return values.map((_, index) => {
    if (!valid(averageGain[index]) || !valid(averageLoss[index])) return null;
    if (averageLoss[index] === 0) return 100;
    if (averageGain[index] === 0) return 0;
    return 100 - 100 / (1 + averageGain[index]! / averageLoss[index]!);
  });
}

function stochastic(candles: readonly Candle[], length: number): NullableSeries {
  const raw: NullableSeries = Array(candles.length).fill(null);
  for (let index = length - 1; index < candles.length; index += 1) {
    let highest = -Infinity;
    let lowest = Infinity;
    for (let cursor = index - length + 1; cursor <= index; cursor += 1) {
      highest = Math.max(highest, candles[cursor]!.high);
      lowest = Math.min(lowest, candles[cursor]!.low);
    }
    raw[index] = highest === lowest ? 50 : (candles[index]!.close - lowest) / (highest - lowest) * 100;
  }
  return nullableSma(raw, 2);
}

function mfi(candles: readonly Candle[], length: number): NullableSeries {
  const output: NullableSeries = Array(candles.length).fill(null);
  const positive = Array(candles.length).fill(0);
  const negative = Array(candles.length).fill(0);
  for (let index = 1; index < candles.length; index += 1) {
    const flow = candles[index]!.close * Math.max(0, candles[index]!.volume);
    if (candles[index]!.close > candles[index - 1]!.close) positive[index] = flow;
    else if (candles[index]!.close < candles[index - 1]!.close) negative[index] = flow;
  }
  for (let index = length; index < candles.length; index += 1) {
    let up = 0;
    let down = 0;
    for (let cursor = index - length + 1; cursor <= index; cursor += 1) { up += positive[cursor]!; down += negative[cursor]!; }
    output[index] = down === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / down);
  }
  return output;
}

function cci(values: readonly number[], length: number): NullableSeries {
  const basis = sma(values, length);
  return values.map((value, index) => {
    if (!valid(basis[index])) return null;
    let deviation = 0;
    for (let cursor = index - length + 1; cursor <= index; cursor += 1) deviation += Math.abs(values[cursor]! - basis[index]!);
    deviation /= length;
    return deviation === 0 ? 0 : (value - basis[index]!) / (0.015 * deviation);
  });
}

function thresholdScore(value: number | null, low: number, high: number): number | null {
  if (!valid(value)) return null;
  return value < low ? 0 : value > high ? 1 : 0.5;
}

function zone(score: number | null, oversold: number, overbought: number): MarketSentimentZone {
  if (!valid(score)) return "INSUFFICIENT";
  if (score >= overbought) return "OVERBOUGHT";
  if (score <= oversold) return "OVERSOLD";
  return "NEUTRAL";
}

export function calculateMarketSentiment(input: MarketSentimentInput): MarketSentimentSnapshot {
  const settings = migrateMarketSentimentSettings(input.settings);
  const sourceOffset = Math.max(0, input.candles.length - settings.lookback);
  const candles = input.candles.slice(sourceOffset);
  const closes = candles.map((candle) => candle.close);
  const count = candles.length;

  const haClose = candles.map((candle) => (candle.open + candle.high + candle.low + candle.close) / 4);
  const haOpen = Array<number>(count).fill(0);
  for (let index = 0; index < count; index += 1) haOpen[index] = index === 0 ? (candles[index]!.open + candles[index]!.close) / 2 : (haOpen[index - 1]! + haClose[index - 1]!) / 2;
  const haScore: NullableSeries = candles.map((_, index) => haOpen[index]! < haClose[index]! ? 1 : 0);

  const ema20 = ema(closes, 20);
  const ocDifference = ema20.map((value, index) => index === 0 ? 0 : value - ema20[index - 1]!);
  const ocTrend = sma(ocDifference, 2);
  const ocScore = ocTrend.map((value) => valid(value) ? (value > 0 ? 1 : 0) : null);

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const emaScore: NullableSeries = closes.map((_, index) => ema9[index]! > ema21[index]! ? 1 : 0);
  const sma13 = sma(closes, 13);
  const sma48 = sma(closes, 48);
  const smaScore: NullableSeries = closes.map((_, index) => valid(sma13[index]) && valid(sma48[index]) ? (sma13[index]! > sma48[index]! ? 1 : 0) : null);

  const rsiValue = rsi(closes, 14);
  const rsiScore = rsiValue.map((value) => thresholdScore(value, 30, 70));

  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12.map((value, index) => value - ema26[index]!);
  const signalLine = ema(macdLine, 9);
  const histogram = macdLine.map((value, index) => value - signalLine[index]!);
  const macdScore: NullableSeries = macdLine.map((value, index) => value > signalLine[index]! ? 0.5 : 0);
  const histogramScore: NullableSeries = histogram.map((value, index) => {
    if (index === 0) return null;
    const rising = histogram[index - 1]! < value;
    return value >= 0 ? (rising ? 0.5 : 0.25) : (rising ? 0.25 : 0);
  });

  const stochasticValue = stochastic(candles, 14);
  const stochasticScore = stochasticValue.map((value) => thresholdScore(value, 20, 80));
  const sma200 = sma(closes, 200);
  const ma200Score: NullableSeries = closes.map((close, index) => valid(sma200[index]) ? (close > sma200[index]! ? 1 : 0) : null);
  const mfiValue = mfi(candles, 14);
  const mfiScore = mfiValue.map((value) => thresholdScore(value, 20, 80));
  const cciValue = cci(closes, 20);
  const cciScore = cciValue.map((value) => thresholdScore(value, -100, 100));

  const componentSeries: NullableSeries[] = [emaScore, smaScore, rsiScore, macdScore, histogramScore, stochasticScore, ma200Score, mfiScore, cciScore, ocScore, haScore];
  const rawSentiment: NullableSeries = closes.map((_, index) => componentSeries.every((series) => valid(series[index]))
    ? componentSeries.reduce((total, series) => total + series[index]!, 0)
    : null);
  const sentiment = settings.smoothingEnabled && settings.smoothingLength > 1 ? wmaNullable(rawSentiment, settings.smoothingLength) : [...rawSentiment];

  const transformedOpen = nullableSma(sentiment.map((_, index) => index > 0 ? sentiment[index - 1]! : null), settings.candleTransform);
  const transformedClose = nullableSma(sentiment, settings.candleTransform);
  const candleHigh: NullableSeries = [...sentiment];
  const candleLow: NullableSeries = [...sentiment];
  const candleOpen: NullableSeries = Array(count).fill(null);
  const candleClose: NullableSeries = Array(count).fill(null);
  for (let index = 0; index < count; index += 1) {
    if (![transformedOpen[index], candleHigh[index], candleLow[index], transformedClose[index]].every(valid)) continue;
    if (!settings.heikinAshi) {
      candleOpen[index] = transformedOpen[index];
      candleClose[index] = transformedClose[index];
      continue;
    }
    const close = (transformedOpen[index]! + candleHigh[index]! + candleLow[index]! + transformedClose[index]!) / 4;
    const open = index === 0 || !valid(candleOpen[index - 1]) || !valid(candleClose[index - 1])
      ? (transformedOpen[index]! + transformedClose[index]!) / 2
      : (candleOpen[index - 1]! + candleClose[index - 1]!) / 2;
    candleOpen[index] = open;
    candleClose[index] = close;
    candleHigh[index] = Math.max(candleHigh[index]!, open, close);
    candleLow[index] = Math.min(candleLow[index]!, open, close);
  }
  const candleDirection = sentiment.map((value, index): -1 | 0 | 1 => !valid(value) || index === 0 || !valid(sentiment[index - 1]) ? 0 : sentiment[index - 1]! > value ? -1 : 1);

  const lastEventIndex = input.lastBarConfirmed === false ? count - 2 : count - 1;
  const events: MarketSentimentSnapshot["events"] = [];
  for (let index = 1; index <= lastEventIndex; index += 1) {
    const previous = sentiment[index - 1];
    const current = sentiment[index];
    if (!valid(previous) || !valid(current)) continue;
    if (previous < settings.overbought && current >= settings.overbought) events.push({ index, time: candles[index]!.time, score: current, kind: "ENTER_OVERBOUGHT" });
    if (previous >= settings.overbought && current < settings.overbought) events.push({ index, time: candles[index]!.time, score: current, kind: "EXIT_OVERBOUGHT" });
    if (previous > settings.oversold && current <= settings.oversold) events.push({ index, time: candles[index]!.time, score: current, kind: "ENTER_OVERSOLD" });
    if (previous <= settings.oversold && current > settings.oversold) events.push({ index, time: candles[index]!.time, score: current, kind: "EXIT_OVERSOLD" });
  }

  const latestScore = count ? sentiment[count - 1]! : null;
  const components: MarketSentimentComponents = {
    heikinAshi: haScore,
    emaVelocity: ocScore,
    emaRegime: emaScore,
    smaRegime: smaScore,
    rsi: rsiScore,
    macd: macdScore,
    histogram: histogramScore,
    stochastic: stochasticScore,
    ma200: ma200Score,
    mfi: mfiScore,
    cci: cciScore
  };
  return {
    schemaVersion: 1,
    modelVersion: "BC-MSO-PYTHON-V1",
    authority: "CAUSAL_OHLCV_COMPOSITE",
    inputSize: count,
    sourceOffset,
    settings,
    series: { rawSentiment, sentiment, candleOpen, candleHigh, candleLow, candleClose, candleDirection },
    components,
    events,
    latest: { score: valid(latestScore) ? latestScore : null, zone: zone(latestScore, settings.oversold, settings.overbought) },
    integrity: { causal: true, finalizedBarEventsOnly: true, futureBarsConsumed: 0 }
  };
}
