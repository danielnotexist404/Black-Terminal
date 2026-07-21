import type { Candle } from "../../../chart-engine/types";
import type { IndicatorName, ScannerOperand, RuleEvaluationContext } from "../types/scanner.types";

function finite(value: number | undefined, fallback = NaN) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function cacheKey(name: string, params: Record<string, unknown>) {
  return `${name}:${JSON.stringify(params)}`;
}

export function sma(values: number[], period: number) {
  const length = Math.max(1, Math.round(period));
  let rolling = 0;
  return values.map((value, index) => {
    rolling += finite(value, 0);
    if (index >= length) rolling -= finite(values[index - length], 0);
    return rolling / Math.min(index + 1, length);
  });
}

export function ema(values: number[], period: number) {
  const length = Math.max(1, Math.round(period));
  const alpha = 2 / (length + 1);
  const out: number[] = [];
  let current = finite(values[0], 0);
  values.forEach((value, index) => {
    current = index === 0 ? finite(value, current) : finite(value, current) * alpha + current * (1 - alpha);
    out.push(current);
  });
  return out;
}

export function rsi(values: number[], period: number) {
  const length = Math.max(1, Math.round(period));
  const out = Array(values.length).fill(50) as number[];
  let avgGain = 0;
  let avgLoss = 0;

  for (let index = 1; index < values.length; index++) {
    const change = finite(values[index], 0) - finite(values[index - 1], 0);
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);

    if (index <= length) {
      avgGain += gain;
      avgLoss += loss;
      if (index === length) {
        avgGain /= length;
        avgLoss /= length;
      }
    } else {
      avgGain = (avgGain * (length - 1) + gain) / length;
      avgLoss = (avgLoss * (length - 1) + loss) / length;
    }

    if (index >= length) {
      const rs = avgLoss === 0 ? 100 : avgGain / Math.max(avgLoss, 1e-8);
      out[index] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

export function atr(candles: Candle[], period: number) {
  const ranges = candles.map((candle, index) => {
    const previous = candles[index - 1];
    return Math.max(
      candle.high - candle.low,
      previous ? Math.abs(candle.high - previous.close) : 0,
      previous ? Math.abs(candle.low - previous.close) : 0,
      candle.close * 0.00001,
      1e-8
    );
  });
  const length = Math.max(1, Math.round(period));
  const out: number[] = [];
  ranges.forEach((range, index) => {
    out[index] = index === 0 ? range : ((out[index - 1] ?? range) * (length - 1) + range) / length;
  });
  return out;
}

export function highest(values: number[], lookback: number, includeCurrent = false) {
  const length = Math.max(1, Math.round(lookback));
  return values.map((_value, index) => {
    const end = includeCurrent ? index : index - 1;
    const start = Math.max(0, end - length + 1);
    if (end < 0) return NaN;
    return Math.max(...values.slice(start, end + 1));
  });
}

export function lowest(values: number[], lookback: number, includeCurrent = false) {
  const length = Math.max(1, Math.round(lookback));
  return values.map((_value, index) => {
    const end = includeCurrent ? index : index - 1;
    const start = Math.max(0, end - length + 1);
    if (end < 0) return NaN;
    return Math.min(...values.slice(start, end + 1));
  });
}

export function roc(values: number[], lookback: number) {
  const length = Math.max(1, Math.round(lookback));
  return values.map((value, index) => {
    const previous = values[index - length];
    if (!previous) return 0;
    return ((value - previous) / Math.abs(previous)) * 100;
  });
}

export function macd(values: number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const line = values.map((_value, index) => (fast[index] ?? 0) - (slow[index] ?? 0));
  const signal = ema(line, signalPeriod);
  const histogram = line.map((value, index) => value - (signal[index] ?? 0));
  return { line, signal, histogram };
}

export function bollinger(values: number[], period: number, mult = 2) {
  const middle = sma(values, period);
  const length = Math.max(1, Math.round(period));
  const deviation = values.map((_value, index) => {
    const start = Math.max(0, index - length + 1);
    const sample = values.slice(start, index + 1);
    const mean = middle[index] ?? 0;
    const variance = sample.reduce((sum, item) => sum + (item - mean) ** 2, 0) / Math.max(1, sample.length);
    return Math.sqrt(variance);
  });
  return {
    upper: middle.map((value, index) => value + (deviation[index] ?? 0) * mult),
    middle,
    lower: middle.map((value, index) => value - (deviation[index] ?? 0) * mult)
  };
}

export function vwap(candles: Candle[]) {
  let pv = 0;
  let volume = 0;
  return candles.map((candle) => {
    const typical = (candle.high + candle.low + candle.close) / 3;
    pv += typical * candle.volume;
    volume += candle.volume;
    return pv / Math.max(1e-8, volume);
  });
}

export function indicatorSeries(ctx: RuleEvaluationContext, name: IndicatorName, params: Record<string, number | string | boolean> = {}) {
  const key = cacheKey(name, params);
  const cached = ctx.indicatorCache.get(key);
  if (cached) return cached;

  const closes = ctx.candles.map((candle) => candle.close);
  const highs = ctx.candles.map((candle) => candle.high);
  const lows = ctx.candles.map((candle) => candle.low);
  const volumes = ctx.candles.map((candle) => candle.volume);
  const period = Number(params.period ?? params.length ?? 14);
  let series: number[];

  switch (name) {
    case "SMA":
      series = sma(closes, period);
      break;
    case "EMA":
      series = ema(closes, period);
      break;
    case "RSI":
      series = rsi(closes, period);
      break;
    case "MACD":
      series = macd(closes, Number(params.fast ?? 12), Number(params.slow ?? 26), Number(params.signal ?? 9)).line;
      break;
    case "ATR":
      series = atr(ctx.candles, period);
      break;
    case "ATR_SMA": {
      const base = atr(ctx.candles, Number(params.atrPeriod ?? 14));
      series = sma(base, period);
      break;
    }
    case "BOLLINGER_UPPER":
      series = bollinger(closes, period, Number(params.mult ?? 2)).upper;
      break;
    case "BOLLINGER_MIDDLE":
      series = bollinger(closes, period, Number(params.mult ?? 2)).middle;
      break;
    case "BOLLINGER_LOWER":
      series = bollinger(closes, period, Number(params.mult ?? 2)).lower;
      break;
    case "VWAP":
      series = vwap(ctx.candles);
      break;
    case "VOLUME_SMA":
      series = sma(volumes, period);
      break;
    case "ROC":
      series = roc(closes, period);
      break;
    case "HIGHEST_HIGH":
      series = highest(highs, period, Boolean(params.includeCurrent));
      break;
    case "LOWEST_LOW":
      series = lowest(lows, period, Boolean(params.includeCurrent));
      break;
    default:
      series = [];
  }

  ctx.indicatorCache.set(key, series);
  return series;
}

export function resolveOperand(ctx: RuleEvaluationContext, operand: ScannerOperand, overrideIndex?: number): number | null {
  const offset = "offset" in operand ? Number(operand.offset ?? 0) : 0;
  const index = Math.max(0, (overrideIndex ?? ctx.index) - Math.max(0, offset));
  const candle = ctx.candles[index];
  if (!candle) return null;

  if (operand.type === "constant") return operand.value;
  if (operand.type === "price") return priceField(candle, ctx.candles[index - 1], operand.field);
  if (operand.type === "previous") return priceField(candleAt(ctx.candles, index - Math.max(1, operand.offset ?? 1)), candleAt(ctx.candles, index - Math.max(2, (operand.offset ?? 1) + 1)), operand.field);
  if (operand.type === "averageVolume") return indicatorAt(sma(ctx.candles.map((item) => item.volume), operand.period), index);
  if (operand.type === "highestHigh") return indicatorAt(highest(ctx.candles.map((item) => item.high), operand.lookback, operand.includeCurrent), index);
  if (operand.type === "lowestLow") return indicatorAt(lowest(ctx.candles.map((item) => item.low), operand.lookback, operand.includeCurrent), index);
  if (operand.type === "percentChange") return indicatorAt(roc(ctx.candles.map((item) => item.close), operand.lookback), index);
  if (operand.type === "indicator") return indicatorAt(indicatorSeries(ctx, operand.name, operand.params), index);
  if (operand.type === "relativeStrength") {
    const own = indicatorAt(roc(ctx.candles.map((item) => item.close), operand.lookback), index);
    if (!ctx.benchmarkCandles?.length) return own;
    const benchmarkIndex = Math.min(ctx.benchmarkCandles.length - 1, index);
    const benchmark = indicatorAt(roc(ctx.benchmarkCandles.map((item) => item.close), operand.lookback), benchmarkIndex);
    return own !== null && benchmark !== null ? own - benchmark : own;
  }
  return null;
}

function candleAt(candles: Candle[], index: number) {
  return candles[Math.max(0, Math.min(candles.length - 1, index))];
}

function indicatorAt(series: number[], index: number) {
  const value = series[Math.max(0, Math.min(series.length - 1, index))];
  return Number.isFinite(value) ? value : null;
}

function priceField(candle: Candle | undefined, previous: Candle | undefined, field: string) {
  if (!candle) return null;
  if (field === "range") return candle.high - candle.low;
  if (field === "changePercent") {
    const base = previous?.close ?? candle.open;
    return base ? ((candle.close - base) / Math.abs(base)) * 100 : 0;
  }
  const value = candle[field as keyof Candle];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
