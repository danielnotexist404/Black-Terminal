import type { Candle } from "../../../chart-engine/types";
import type { StrategyRuntimeKind, StrategySettings, StrategySignal } from "../types/strategy.types";

function ema(values: number[], period: number) {
  const alpha = 2 / (Math.max(1, period) + 1);
  const output: number[] = [];
  let current = values[0] ?? 0;
  for (let index = 0; index < values.length; index++) {
    current = index === 0 ? values[index] : values[index] * alpha + current * (1 - alpha);
    output.push(current);
  }
  return output;
}

function trueRange(candle: Candle, previous?: Candle) {
  if (!previous) return candle.high - candle.low;
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previous.close),
    Math.abs(candle.low - previous.close)
  );
}

function atr(candles: Candle[], period: number) {
  const output: number[] = [];
  let current = 0;
  for (let index = 0; index < candles.length; index++) {
    const tr = trueRange(candles[index], candles[index - 1]);
    current = index === 0 ? tr : (current * (Math.max(1, period) - 1) + tr) / Math.max(1, period);
    output.push(current);
  }
  return output;
}

function rsi(values: number[], period: number) {
  const output: number[] = [];
  let avgGain = 0;
  let avgLoss = 0;

  for (let index = 0; index < values.length; index++) {
    const change = index === 0 ? 0 : values[index] - values[index - 1];
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);
    if (index <= period) {
      avgGain += gain / Math.max(1, period);
      avgLoss += loss / Math.max(1, period);
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    output.push(100 - 100 / (1 + rs));
  }
  return output;
}

function highest(candles: Candle[], endIndex: number, length: number, field: "high" | "close" = "high") {
  const start = Math.max(0, endIndex - length + 1);
  let value = Number.NEGATIVE_INFINITY;
  for (let index = start; index <= endIndex; index++) {
    value = Math.max(value, candles[index]?.[field] ?? value);
  }
  return value;
}

function lowest(candles: Candle[], endIndex: number, length: number, field: "low" | "close" = "low") {
  const start = Math.max(0, endIndex - length + 1);
  let value = Number.POSITIVE_INFINITY;
  for (let index = start; index <= endIndex; index++) {
    value = Math.min(value, candles[index]?.[field] ?? value);
  }
  return value;
}

function averageVolume(candles: Candle[], index: number, length: number) {
  const start = Math.max(0, index - length + 1);
  const window = candles.slice(start, index + 1);
  if (window.length === 0) return 0;
  return window.reduce((sum, candle) => sum + candle.volume, 0) / window.length;
}

function inConfiguredSession(candle: Candle, settings: StrategySettings) {
  if (settings.sessionStartHour === undefined || settings.sessionEndHour === undefined) return true;
  const hour = new Date(candle.time * 1000).getUTCHours();
  if (settings.sessionStartHour <= settings.sessionEndHour) {
    return hour >= settings.sessionStartHour && hour < settings.sessionEndHour;
  }
  return hour >= settings.sessionStartHour || hour < settings.sessionEndHour;
}

export function createEmaCrossSignals(candles: Candle[], symbol: string, settings: StrategySettings): StrategySignal[] {
  if (candles.length < Math.max(settings.emaFastLength, settings.emaSlowLength) + 2) return [];

  const closes = candles.map((candle) => candle.close);
  const fast = ema(closes, settings.emaFastLength);
  const slow = ema(closes, settings.emaSlowLength);
  const signals: StrategySignal[] = [];

  for (let index = 1; index < candles.length; index++) {
    const candle = candles[index];
    const previousFast = fast[index - 1];
    const previousSlow = slow[index - 1];
    const currentFast = fast[index];
    const currentSlow = slow[index];
    const volumeOk = settings.minVolumeMultiplier
      ? candle.volume >= averageVolume(candles, index, 50) * settings.minVolumeMultiplier
      : true;
    if (!candle || !inConfiguredSession(candle, settings) || !volumeOk) continue;

    const stopDistance = candle.close * Math.max(0.0001, settings.stopLossPercent / 100);
    const longCross = previousFast <= previousSlow && currentFast > currentSlow;
    const shortCross = previousFast >= previousSlow && currentFast < currentSlow;

    if (longCross) {
      signals.push({
        timestamp: candle.time,
        symbol,
        direction: "long",
        entry: true,
        stopLoss: candle.close - stopDistance,
        takeProfit: candle.close + stopDistance * Math.max(0.1, settings.takeProfitRatio),
        confidence: Math.min(1, Math.abs(currentFast - currentSlow) / Math.max(candle.close * 0.002, 1)),
        signalName: "EMA Bull Cross",
        reason: `EMA ${settings.emaFastLength} crossed above EMA ${settings.emaSlowLength}`,
        metadata: { fast: currentFast, slow: currentSlow }
      });
    }

    if (shortCross) {
      signals.push({
        timestamp: candle.time,
        symbol,
        direction: "short",
        entry: true,
        stopLoss: candle.close + stopDistance,
        takeProfit: candle.close - stopDistance * Math.max(0.1, settings.takeProfitRatio),
        confidence: Math.min(1, Math.abs(currentFast - currentSlow) / Math.max(candle.close * 0.002, 1)),
        signalName: "EMA Bear Cross",
        reason: `EMA ${settings.emaFastLength} crossed below EMA ${settings.emaSlowLength}`,
        metadata: { fast: currentFast, slow: currentSlow }
      });
    }
  }

  return signals;
}

export function createAdaptiveSwingSignals(candles: Candle[], symbol: string, settings: StrategySettings): StrategySignal[] {
  const lookback = Math.max(16, Math.round(settings.swingLookback ?? 36));
  const atrLength = Math.max(8, Math.round(settings.atrLength ?? 21));
  const rsiLength = Math.max(5, Math.round(settings.rsiLength ?? 14));
  const regimeLength = Math.max(34, Math.round(settings.regimeEmaLength ?? 200));
  const fastTrendLength = Math.max(12, Math.round(lookback / 2));
  const midTrendLength = Math.max(24, lookback * 2);
  const warmup = Math.max(lookback * 3, atrLength + 4, rsiLength + 4, regimeLength + 4);
  if (candles.length < warmup + 2) return [];

  const closes = candles.map((candle) => candle.close);
  const regimeEma = ema(closes, regimeLength);
  const fastTrendEma = ema(closes, fastTrendLength);
  const midTrendEma = ema(closes, midTrendLength);
  const atrValues = atr(candles, atrLength);
  const rsiValues = rsi(closes, rsiLength);
  const signals: StrategySignal[] = [];
  const minTrendQuality = Math.max(0, Math.min(1, settings.minTrendQuality ?? 0.16));
  const maxChopRatio = Math.max(0.05, Math.min(1, settings.maxChopRatio ?? 0.24));
  const retestAtr = Math.max(0.05, settings.swingRetestAtr ?? 0.8);
  const oversold = Math.max(5, Math.min(50, settings.rsiOversold ?? 42));
  const overbought = Math.max(50, Math.min(95, settings.rsiOverbought ?? 58));
  const volumeLookback = Math.max(5, Math.round(settings.volumeLookback ?? 50));
  const minVolumeMultiplier = Math.max(0, settings.minVolumeMultiplier ?? 0.5);
  const cooldownBars = Math.max(12, Math.round(lookback / 2));
  const slopeThreshold = Math.max(0.04, minTrendQuality * 0.5);
  let virtualPosition: { direction: "long" | "short"; stopLoss: number; takeProfit: number } | undefined;
  let lastExitIndex = Number.NEGATIVE_INFINITY;

  for (let index = warmup; index < candles.length; index++) {
    const candle = candles[index];
    const previous = candles[index - 1];
    if (!candle || !previous || !inConfiguredSession(candle, settings)) continue;

    const currentAtr = Math.max(atrValues[index], candle.close * 0.0001);
    if (virtualPosition) {
      const stopped = virtualPosition.direction === "long"
        ? candle.low <= virtualPosition.stopLoss
        : candle.high >= virtualPosition.stopLoss;
      const targeted = virtualPosition.direction === "long"
        ? candle.high >= virtualPosition.takeProfit
        : candle.low <= virtualPosition.takeProfit;
      if (stopped || targeted) {
        virtualPosition = undefined;
        lastExitIndex = index;
      } else {
        continue;
      }
    }

    if (index - lastExitIndex < cooldownBars) continue;

    const priorSwingLow = lowest(candles, index - 1, lookback, "low");
    const priorSwingHigh = highest(candles, index - 1, lookback, "high");
    const rangeHigh = highest(candles, index - 1, lookback * 3, "high");
    const rangeLow = lowest(candles, index - 1, lookback * 3, "low");
    const range = Math.max(rangeHigh - rangeLow, currentAtr);
    const netMove = Math.abs(candle.close - candles[Math.max(0, index - lookback * 3)]!.close);
    const efficiency = netMove / range;
    const trendBars = Math.min(lookback * 2, index);
    const trendSlope = (regimeEma[index] - regimeEma[index - trendBars]) / currentAtr;
    const atrPercent = currentAtr / Math.max(candle.close, 1);
    const compressionRatio = range / Math.max(currentAtr * lookback * 1.3, candle.close * 0.0001);
    const trendQuality = Math.min(1, (Math.abs(trendSlope) / 2.6) * 0.55 + efficiency * 0.45);
    const chopDetected = trendQuality < minTrendQuality || compressionRatio < maxChopRatio || atrPercent < 0.0012;
    const volumeOk = candle.volume >= averageVolume(candles, index, volumeLookback) * minVolumeMultiplier;
    if (chopDetected || !volumeOk) continue;

    const rsiNow = rsiValues[index];
    const rsiPrevious = rsiValues[index - 1];
    const upRegime = (
      candle.close > regimeEma[index] &&
      fastTrendEma[index] > regimeEma[index] &&
      trendSlope > slopeThreshold
    ) || (
      candle.close > regimeEma[index] &&
      trendSlope > slopeThreshold * 1.8
    );
    const downRegime = (
      candle.close < regimeEma[index] &&
      fastTrendEma[index] < regimeEma[index] &&
      trendSlope < -slopeThreshold
    ) || (
      candle.close < regimeEma[index] &&
      trendSlope < -slopeThreshold * 1.8
    );
    const sweptLow = candle.low <= priorSwingLow + currentAtr * retestAtr && candle.close > priorSwingLow;
    const sweptHigh = candle.high >= priorSwingHigh - currentAtr * retestAtr && candle.close < priorSwingHigh;
    const pullbackLong = candle.low <= midTrendEma[index] + currentAtr * 1.35 && candle.close > fastTrendEma[index] && candle.close > previous.close;
    const pullbackShort = candle.high >= midTrendEma[index] - currentAtr * 1.35 && candle.close < fastTrendEma[index] && candle.close < previous.close;
    const bullishReclaim = candle.close > candle.open && rsiNow > rsiPrevious && candle.close > fastTrendEma[index];
    const bearishRejection = candle.close < candle.open && rsiNow < rsiPrevious && candle.close < fastTrendEma[index];
    const bottomSetup = upRegime && (sweptLow || pullbackLong) && bullishReclaim && rsiNow <= oversold + 16;
    const topSetup = downRegime && (sweptHigh || pullbackShort) && bearishRejection && rsiNow >= overbought - 16;

    if (bottomSetup) {
      const stopDistance = Math.max(currentAtr * (settings.atrStopMultiplier ?? 1.55), candle.close * (settings.stopLossPercent / 100));
      const takeProfit = candle.close + stopDistance * Math.max(1, settings.takeProfitRatio);
      const stopLoss = candle.close - stopDistance;
      signals.push({
        timestamp: candle.time,
        symbol,
        direction: "long",
        entry: true,
        stopLoss,
        takeProfit,
        confidence: Math.min(1, 0.35 + trendQuality * 0.45 + Math.min(0.2, Math.max(0, (oversold + 16 - rsiNow) / 100))),
        signalName: "Trend Swing Bottom",
        reason: "Trend-aligned pullback or liquidity sweep reclaimed above fast trend EMA",
        metadata: {
          regime: "bullish-trend",
          trendQuality,
          trendSlope,
          rsi: rsiNow,
          atr: currentAtr,
          priorSwingLow,
          fastTrendEma: fastTrendEma[index],
          midTrendEma: midTrendEma[index],
          regimeEma: regimeEma[index]
        }
      });
      virtualPosition = { direction: "long", stopLoss, takeProfit };
    }

    if (topSetup) {
      const stopDistance = Math.max(currentAtr * (settings.atrStopMultiplier ?? 1.55), candle.close * (settings.stopLossPercent / 100));
      const takeProfit = candle.close - stopDistance * Math.max(1, settings.takeProfitRatio);
      const stopLoss = candle.close + stopDistance;
      signals.push({
        timestamp: candle.time,
        symbol,
        direction: "short",
        entry: true,
        stopLoss,
        takeProfit,
        confidence: Math.min(1, 0.35 + trendQuality * 0.45 + Math.min(0.2, Math.max(0, (rsiNow - (overbought - 16)) / 100))),
        signalName: "Trend Swing Top",
        reason: "Trend-aligned relief rally or liquidity sweep rejected below fast trend EMA",
        metadata: {
          regime: "bearish-trend",
          trendQuality,
          trendSlope,
          rsi: rsiNow,
          atr: currentAtr,
          priorSwingHigh,
          fastTrendEma: fastTrendEma[index],
          midTrendEma: midTrendEma[index],
          regimeEma: regimeEma[index]
        }
      });
      virtualPosition = { direction: "short", stopLoss, takeProfit };
    }
  }

  return signals;
}

export function createStrategySignals(
  strategyKind: StrategyRuntimeKind,
  candles: Candle[],
  symbol: string,
  settings: StrategySettings
) {
  if (strategyKind === "builtin-adaptive-swing") {
    return createAdaptiveSwingSignals(candles, symbol, settings);
  }
  return createEmaCrossSignals(candles, symbol, settings);
}
