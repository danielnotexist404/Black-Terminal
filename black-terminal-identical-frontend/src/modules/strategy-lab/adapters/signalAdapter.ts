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

function sma(values: number[], period: number) {
  const length = Math.max(1, Math.round(period));
  const output: number[] = [];
  let sum = 0;
  for (let index = 0; index < values.length; index++) {
    sum += Number(values[index] || 0);
    if (index >= length) sum -= Number(values[index - length] || 0);
    output.push(sum / Math.min(index + 1, length));
  }
  return output;
}

function rollingStdev(values: number[], period: number) {
  const length = Math.max(1, Math.round(period));
  return values.map((_, index) => {
    const start = Math.max(0, index - length + 1);
    const window = values.slice(start, index + 1);
    const average = window.reduce((sum, value) => sum + value, 0) / Math.max(1, window.length);
    return Math.sqrt(window.reduce((sum, value) => sum + (value - average) ** 2, 0) / Math.max(1, window.length));
  });
}

/**
 * Pine-compatible rolling primitives used by certified strategy adapters.
 * Unlike the chart helpers above, these do not emit partial-window values.
 * TradingView keeps the series `na` until the requested lookback is present;
 * emitting partial values changes the first position carried into a visible
 * chart window and therefore changes every later reversal marker.
 */
function pineSma(values: number[], period: number) {
  const length = Math.max(1, Math.round(period));
  return values.map((_, index) => {
    if (index < length - 1) return Number.NaN;
    let sum = 0;
    for (let cursor = index - length + 1; cursor <= index; cursor += 1) {
      const value = values[cursor];
      if (!Number.isFinite(value)) return Number.NaN;
      sum += value;
    }
    return sum / length;
  });
}

function pineStdev(values: number[], period: number) {
  const length = Math.max(1, Math.round(period));
  return values.map((_, index) => {
    if (index < length - 1) return Number.NaN;
    const start = index - length + 1;
    let sum = 0;
    for (let cursor = start; cursor <= index; cursor += 1) {
      const value = values[cursor];
      if (!Number.isFinite(value)) return Number.NaN;
      sum += value;
    }
    const average = sum / length;
    let squared = 0;
    for (let cursor = start; cursor <= index; cursor += 1) squared += (values[cursor]! - average) ** 2;
    // ta.stdev(source, length) is biased by default.
    return Math.sqrt(squared / length);
  });
}

function pineRma(values: number[], period: number) {
  const length = Math.max(1, Math.round(period));
  const output = Array<number>(values.length).fill(Number.NaN);
  const seed: number[] = [];
  let current = Number.NaN;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) continue;
    if (!Number.isFinite(current)) {
      seed.push(value);
      if (seed.length < length) continue;
      current = seed.slice(-length).reduce((sum, item) => sum + item, 0) / length;
    } else {
      current = (current * (length - 1) + value) / length;
    }
    output[index] = current;
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

function pineAtr(candles: Candle[], period: number) {
  const ranges = candles.map((candle, index) => index === 0
    ? candle.high - candle.low
    : trueRange(candle, candles[index - 1]));
  return pineRma(ranges, period);
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

export function superAtrRequiredSeedBars(settings: StrategySettings) {
  const shortPeriod = Math.max(1, Math.round(settings.superAtrShortPeriod ?? 30));
  const longPeriod = Math.max(1, Math.round(settings.superAtrLongPeriod ?? 70));
  const momentumPeriod = Math.max(1, Math.round(settings.superAtrMomentumPeriod ?? 7));
  const confirmationPeriod = Math.max(1, Math.round(settings.superAtrConfirmationPeriod ?? 7));
  const takeProfitAtrLength = Math.max(1, Math.round(settings.superAtrTakeProfitAtrLength ?? 100));
  const signalReady = Math.max(shortPeriod, longPeriod, momentumPeriod + 1)
    + Math.max(momentumPeriod, confirmationPeriod);
  return Math.max(signalReady + 2, takeProfitAtrLength + 2);
}

/**
 * Applies TradingView's strategy.entry position contract to closed-bar setup
 * events. With pyramiding=1, repeated calls in the already-open direction do
 * not create trades; an opposite call closes and reverses the position.
 */
export function positionAwareStrategyEntries(signals: readonly StrategySignal[], pyramiding = 1) {
  const maximumEntries = Math.max(1, Math.round(pyramiding));
  const transitions: StrategySignal[] = [];
  let direction: "long" | "short" | null = null;
  let openEntries = 0;
  for (const signal of [...signals].filter((item) => item.entry).sort((left, right) => left.timestamp - right.timestamp)) {
    if (signal.direction !== "long" && signal.direction !== "short") continue;
    if (signal.direction === direction) {
      if (openEntries >= maximumEntries) continue;
      openEntries += 1;
      transitions.push({ ...signal, metadata: { ...signal.metadata, previousDirection: direction, positionTransition: "PYRAMID" } });
      continue;
    }
    const previousDirection = direction;
    direction = signal.direction;
    openEntries = 1;
    transitions.push({
      ...signal,
      metadata: {
        ...signal.metadata,
        previousDirection: previousDirection || "flat",
        positionTransition: previousDirection ? "REVERSE" : "ENTRY",
      },
    });
  }
  return transitions;
}

export function superAtrTakeProfitPlan(
  candles: Candle[],
  direction: "long" | "short",
  entryPrice: number,
  settings: StrategySettings,
) {
  if (settings.superAtrMultiStepTakeProfit === false || !candles.length || !(entryPrice > 0)) return [];
  const takeProfitAtr = superAtrTakeProfitAtrSeries(candles, settings).at(-1);
  return superAtrTakeProfitPlanFromAtr(direction, entryPrice, takeProfitAtr, settings);
}

/** Precomputes Pine ta.atr() once for historical order emulation. */
export function superAtrTakeProfitAtrSeries(candles: Candle[], settings: StrategySettings) {
  const takeProfitAtrLength = Math.max(1, Math.round(settings.superAtrTakeProfitAtrLength ?? 100));
  return pineAtr(candles, takeProfitAtrLength);
}

/** Builds the seven Pine strategy.exit prices from the ATR known at bar close. */
export function superAtrTakeProfitPlanFromAtr(
  direction: "long" | "short",
  entryPrice: number,
  takeProfitAtr: number | undefined,
  settings: StrategySettings,
) {
  if (settings.superAtrMultiStepTakeProfit === false || !(entryPrice > 0) || !Number.isFinite(takeProfitAtr)) return [];
  const atrMultipliers = normalizeNumberList(settings.superAtrAtrMultipliers, [100, 70, 120, 300], 4);
  const fixedPercentages = normalizeNumberList(settings.superAtrFixedPercentages, [21, 21, 75], 3);
  const atrExitPercent = Math.max(0.1, Math.min(100, settings.superAtrAtrExitPercent ?? 10));
  const fixedExitPercent = Math.max(0.1, Math.min(100, settings.superAtrFixedExitPercent ?? 10));
  const sign = direction === "long" ? 1 : -1;
  return [
    ...atrMultipliers.map((multiplier, targetIndex) => ({ id: `TP${targetIndex + 1}`, price: entryPrice + sign * takeProfitAtr! * multiplier, quantityPercent: atrExitPercent })),
    ...fixedPercentages.map((percentage, targetIndex) => ({ id: `TP${targetIndex + 5}`, price: entryPrice * (1 + sign * percentage / 100), quantityPercent: fixedExitPercent })),
  ];
}

export function createSuperAtrSevenStepSignals(candles: Candle[], symbol: string, settings: StrategySettings): StrategySignal[] {
  const shortPeriod = Math.max(1, Math.round(settings.superAtrShortPeriod ?? 30));
  const longPeriod = Math.max(1, Math.round(settings.superAtrLongPeriod ?? 70));
  const momentumPeriod = Math.max(1, Math.round(settings.superAtrMomentumPeriod ?? 7));
  const confirmationPeriod = Math.max(1, Math.round(settings.superAtrConfirmationPeriod ?? 7));
  const threshold = Math.max(0, settings.superAtrTrendStrengthThreshold ?? 3.1);
  const takeProfitAtrLength = Math.max(1, Math.round(settings.superAtrTakeProfitAtrLength ?? 100));
  const atrMultipliers = normalizeNumberList(settings.superAtrAtrMultipliers, [100, 70, 120, 300], 4);
  const fixedPercentages = normalizeNumberList(settings.superAtrFixedPercentages, [21, 21, 75], 3);
  const atrExitPercent = Math.max(0.1, Math.min(100, settings.superAtrAtrExitPercent ?? 10));
  const fixedExitPercent = Math.max(0.1, Math.min(100, settings.superAtrFixedExitPercent ?? 10));
  const multiStep = settings.superAtrMultiStepTakeProfit !== false;
  if (candles.length < 2) return [];

  const closes = candles.map((candle) => candle.close);
  // The Pine source explicitly uses close[1], so its custom true-range series
  // is `na` on the first candle. Do not replace it with high-low here.
  const ranges = candles.map((candle, index) => index === 0 ? Number.NaN : trueRange(candle, candles[index - 1]));
  const shortAtr = pineSma(ranges, shortPeriod);
  const longAtr = pineSma(ranges, longPeriod);
  // Pine's ta.atr uses Wilder's RMA, while the strategy's short/long ATR inputs
  // deliberately use ta.sma(true_range). Keep those two smoothing contracts distinct.
  const takeProfitAtr = pineAtr(candles, takeProfitAtrLength);
  const momentum = closes.map((value, index) => index >= momentumPeriod ? value - closes[index - momentumPeriod]! : Number.NaN);
  const momentumDeviation = pineStdev(closes, momentumPeriod);
  const momentumFactor = momentum.map((value, index) => {
    const deviation = momentumDeviation[index];
    if (!Number.isFinite(value) || !Number.isFinite(deviation)) return Number.NaN;
    return deviation === 0 ? 0 : Math.abs(value / deviation);
  });
  const adaptiveAtr = ranges.map((_, index) => {
    if (![shortAtr[index], longAtr[index], momentumFactor[index]].every(Number.isFinite)) return Number.NaN;
    return (shortAtr[index]! * momentumFactor[index]! + longAtr[index]!) / (1 + momentumFactor[index]!);
  });
  const atrMultiple = momentum.map((priceChange, index) => {
    if (!Number.isFinite(priceChange) || !Number.isFinite(adaptiveAtr[index])) return Number.NaN;
    return adaptiveAtr[index] === 0 ? 0 : priceChange / adaptiveAtr[index]!;
  });
  const trendStrength = pineSma(atrMultiple, momentumPeriod);
  const shortMa = pineSma(closes, shortPeriod);
  const longMa = pineSma(closes, longPeriod);
  const adaptiveAtrConfirmation = pineSma(adaptiveAtr, confirmationPeriod);
  const signals: StrategySignal[] = [];

  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index]!;
    if (!inConfiguredSession(candle, settings)) continue;
    if (![shortMa[index], longMa[index], trendStrength[index], adaptiveAtr[index], adaptiveAtrConfirmation[index]].every(Number.isFinite)) continue;
    const longSetup = shortMa[index]! > longMa[index]!
      && trendStrength[index]! > threshold
      && candle.close > shortMa[index]!
      && adaptiveAtr[index]! > adaptiveAtrConfirmation[index]!;
    const shortSetup = shortMa[index]! < longMa[index]!
      && trendStrength[index]! < -threshold
      && candle.close < shortMa[index]!
      && adaptiveAtr[index]! > adaptiveAtrConfirmation[index]!;
    if (!longSetup && !shortSetup) continue;
    const direction = longSetup ? "long" as const : "short" as const;
    const sign = direction === "long" ? 1 : -1;
    const takeProfits = multiStep && Number.isFinite(takeProfitAtr[index]) ? [
      ...atrMultipliers.map((multiplier, targetIndex) => ({ id: `TP${targetIndex + 1}`, price: candle.close + sign * takeProfitAtr[index]! * multiplier, quantityPercent: atrExitPercent })),
      ...fixedPercentages.map((percentage, targetIndex) => ({ id: `TP${targetIndex + 5}`, price: candle.close * (1 + sign * percentage / 100), quantityPercent: fixedExitPercent })),
    ] : [];
    signals.push({
      timestamp: candle.time,
      symbol,
      direction,
      entry: true,
      takeProfit: takeProfits[0]?.price,
      takeProfits,
      confidence: Math.min(1, Math.abs(trendStrength[index]!) / Math.max(threshold * 2, 1e-12)),
      signalName: direction === "long" ? "SuperATR Long" : "SuperATR Short",
      reason: `Adaptive ATR trend strength ${trendStrength[index]!.toFixed(3)} confirmed by price structure`,
      metadata: { shortMa: shortMa[index], longMa: longMa[index], adaptiveAtr: adaptiveAtr[index], trendStrength: trendStrength[index], takeProfitAtr: takeProfitAtr[index] },
    });
  }
  return signals;
}

function normalizeNumberList(value: unknown, fallback: number[], length: number) {
  const source = Array.isArray(value) ? value : fallback;
  return Array.from({ length }, (_, index) => {
    const parsed = Number(source[index] ?? fallback[index] ?? 1);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : Number(fallback[index] || 1);
  });
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
  if (strategyKind === "builtin-ema-cross") {
    return createEmaCrossSignals(candles, symbol, settings);
  }
  if (strategyKind === "builtin-superatr-seven-step") {
    return createSuperAtrSevenStepSignals(candles, symbol, settings);
  }
  throw new Error(
    `${strategyKind} does not have a certified Strategy Lab signal adapter.`,
  );
}
