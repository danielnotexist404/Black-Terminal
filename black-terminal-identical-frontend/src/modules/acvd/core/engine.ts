import { migrateAcvdSettings, acvdSettingsHash, stableHash } from "./settings.ts";
import {
  ACVD_INDICATOR_ID,
  ACVD_MODEL_VERSION,
  type AcvdCalculationInput,
  type AcvdRegime,
  type AcvdSeries,
  type AcvdSignal,
  type AcvdSnapshot
} from "./types.ts";

const NAN = Number.NaN;
const EPSILON = 1e-12;
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

type RollingMoments = { values: number[]; sum: number; sumSquares: number };
type Candidate = { index: number; expires: number; trigger: number; structure: number; confidence: number; reasons: string[] };

function blankSeries(length: number): AcvdSeries {
  const numbers = () => new Array<number>(length).fill(NAN);
  return {
    cumulativeDelta: numbers(),
    deltaRatio: numbers(),
    deltaImpulse: numbers(),
    adaptivePressure: numbers(),
    center: numbers(),
    upperEnvelope: numbers(),
    lowerEnvelope: numbers(),
    coveragePercent: numbers(),
    upperStructure: numbers(),
    lowerStructure: numbers(),
    atr: numbers(),
    priceEfficiency: numbers(),
    chopProbability: numbers(),
    divergenceScore: numbers(),
    longConfidence: numbers(),
    shortConfidence: numbers(),
    regime: new Array<AcvdRegime>(length).fill("UNAVAILABLE")
  };
}

function pushMoments(state: RollingMoments, value: number, maximum: number) {
  if (!Number.isFinite(value)) return;
  state.values.push(value);
  state.sum += value;
  state.sumSquares += value * value;
  if (state.values.length > maximum) {
    const removed = state.values.shift()!;
    state.sum -= removed;
    state.sumSquares -= removed * removed;
  }
}

function moments(state: RollingMoments) {
  const count = state.values.length;
  if (!count) return { mean: 0, deviation: 0 };
  const mean = state.sum / count;
  const variance = Math.max(0, state.sumSquares / count - mean * mean);
  return { mean, deviation: Math.sqrt(variance) };
}

function trueRange(current: AcvdCalculationInput["candles"][number], previousClose: number | undefined) {
  if (!Number.isFinite(previousClose)) return Math.max(0, current.high - current.low);
  return Math.max(current.high - current.low, Math.abs(current.high - previousClose!), Math.abs(current.low - previousClose!));
}

function priceEfficiency(closes: readonly number[], index: number, length: number) {
  if (index < length) return 0;
  const net = Math.abs(closes[index]! - closes[index - length]!);
  let path = 0;
  for (let cursor = index - length + 1; cursor <= index; cursor++) path += Math.abs(closes[cursor]! - closes[cursor - 1]!);
  return path > EPSILON ? clamp(net / path, 0, 1) : 0;
}

function priorExtreme(values: readonly number[], index: number, length: number, mode: "min" | "max") {
  const start = Math.max(0, index - length);
  let resolved = mode === "min" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  for (let cursor = start; cursor < index; cursor++) {
    const value = values[cursor]!;
    resolved = mode === "min" ? Math.min(resolved, value) : Math.max(resolved, value);
  }
  return Number.isFinite(resolved) ? resolved : NAN;
}

function divergenceScore(
  closes: readonly number[],
  pressure: readonly number[],
  index: number,
  length: number,
  direction: "long" | "short"
) {
  if (index < Math.max(3, length)) return 0;
  const start = Math.max(0, index - length);
  let priceExtreme = direction === "long" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  let pressureExtreme = direction === "long" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  for (let cursor = start; cursor < index; cursor++) {
    if (!Number.isFinite(pressure[cursor])) continue;
    if (direction === "long") {
      priceExtreme = Math.min(priceExtreme, closes[cursor]!);
      pressureExtreme = Math.min(pressureExtreme, pressure[cursor]!);
    } else {
      priceExtreme = Math.max(priceExtreme, closes[cursor]!);
      pressureExtreme = Math.max(pressureExtreme, pressure[cursor]!);
    }
  }
  if (!Number.isFinite(priceExtreme) || !Number.isFinite(pressureExtreme)) return 0;
  const priceExtension = direction === "long"
    ? (priceExtreme - closes[index]!) / Math.max(Math.abs(priceExtreme), EPSILON)
    : (closes[index]! - priceExtreme) / Math.max(Math.abs(priceExtreme), EPSILON);
  const flowDivergence = direction === "long"
    ? pressure[index]! - pressureExtreme
    : pressureExtreme - pressure[index]!;
  return clamp(Math.max(0, priceExtension * 10_000) * 0.9 + Math.max(0, flowDivergence) * 1.15, 0, 100);
}

function emptySnapshot(input: AcvdCalculationInput, warning: string): AcvdSnapshot {
  const settings = migrateAcvdSettings(input.settings);
  const inputSize = input.candles.length;
  return {
    schemaVersion: 1,
    modelVersion: ACVD_MODEL_VERSION,
    indicatorId: ACVD_INDICATOR_ID,
    inputSize,
    authority: "UNAVAILABLE",
    warning,
    marketIdentity: input.marketIdentity ?? "unknown",
    settingsHash: acvdSettingsHash(settings),
    dataHash: stableHash(input.candles.map((candle) => [candle.time, candle.close])),
    series: blankSeries(inputSize),
    signals: [],
    latest: {
      state: "UNAVAILABLE", pressure: NAN, deltaRatio: NAN, cumulativeDelta: NAN,
      coveragePercent: 0, regime: "UNAVAILABLE", chopProbability: 100,
      longConfidence: 0, shortConfidence: 0
    },
    integrity: {
      causal: true, currentBar: input.lastBarConfirmed === false ? "DEVELOPING" : "FINAL",
      closedBarSignalsOnly: true, futureBarsConsumed: 0, source: "UNAVAILABLE", signalCount: 0
    }
  };
}

export function calculateAcvd(input: AcvdCalculationInput): AcvdSnapshot {
  const settings = migrateAcvdSettings(input.settings);
  const candles = input.candles.slice(-settings.lookback);
  const flowBars = input.flowBars?.slice(-settings.lookback);
  const length = candles.length;
  const scopedInput = { ...input, candles, flowBars, settings };
  if (!length) return emptySnapshot(scopedInput, "BC-ACVD is waiting for chart history.");
  if (input.flowAuthority !== "EXACT_AGGRESSOR_TRADES" || !flowBars || flowBars.length !== length) {
    return emptySnapshot(scopedInput, input.flowWarning ?? "BC-ACVD requires continuous venue-matched aggressor trades. Synthetic candle delta is never substituted.");
  }

  const series = blankSeries(length);
  const closes = candles.map((candle) => candle.close);
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const deltaMoments: RollingMoments = { values: [], sum: 0, sumSquares: 0 };
  const envelopeMoments: RollingMoments = { values: [], sum: 0, sumSquares: 0 };
  const signals: AcvdSignal[] = [];
  const timeframeSeconds = Math.max(1, Math.round(input.timeframeSeconds ?? (candles[1]?.time ?? candles[0]!.time + 60) - candles[0]!.time));
  const lastFinalIndex = input.lastBarConfirmed === false ? length - 2 : length - 1;
  let cumulativeDelta = 0;
  let smoothed: number | null = null;
  let atrValue = 0;
  let ema = closes[0]!;
  const emaAlpha = 2 / (settings.trendLength + 1);
  const emaHistory = new Array<number>(length).fill(NAN);
  let longArmed = false;
  let shortArmed = false;
  let longLocked = false;
  let shortLocked = false;
  let longCandidate: Candidate | null = null;
  let shortCandidate: Candidate | null = null;
  let cooldownUntil = -1;

  for (let index = 0; index < length; index++) {
    const candle = candles[index]!;
    const bar = flowBars[index]!;
    const buy = settings.deltaBasis === "NOTIONAL" ? bar.buyNotional : bar.buyVolume;
    const sell = settings.deltaBasis === "NOTIONAL" ? bar.sellNotional : bar.sellVolume;
    const unknown = settings.deltaBasis === "NOTIONAL" ? bar.unknownNotional : bar.unknownVolume;
    const exact = buy + sell;
    const total = exact + unknown;
    const coverage = total > 0 ? exact / total * 100 : 0;
    series.coveragePercent[index] = coverage;

    const tr = trueRange(candle, closes[index - 1]);
    atrValue = index === 0 ? tr : (atrValue * (settings.atrLength - 1) + tr) / settings.atrLength;
    series.atr[index] = atrValue;
    ema = index === 0 ? candle.close : ema + emaAlpha * (candle.close - ema);
    emaHistory[index] = ema;
    const efficiency = priceEfficiency(closes, index, settings.trendLength);
    series.priceEfficiency[index] = efficiency;
    const chop = clamp(100 * (1 - efficiency), 0, 100);
    series.chopProbability[index] = chop;
    const emaSlope = index >= 5 ? (ema - emaHistory[index - 5]!) / Math.max(Math.abs(emaHistory[index - 5]!), EPSILON) : 0;
    const regime: AcvdRegime = efficiency < settings.trendEfficiencyThreshold * 0.62
      ? "ROTATION"
      : efficiency < settings.trendEfficiencyThreshold
        ? "TRANSITION"
        : emaSlope > 0 && candle.close >= ema
          ? "UPTREND"
          : emaSlope < 0 && candle.close <= ema
            ? "DOWNTREND"
            : "TRANSITION";
    series.regime[index] = regime;
    series.upperStructure[index] = priorExtreme(highs, index, settings.structureLookback, "max");
    series.lowerStructure[index] = priorExtreme(lows, index, settings.structureLookback, "min");

    if (!bar.deliveryComplete || exact <= 0 || coverage < settings.minimumCoveragePercent) {
      smoothed = null;
      longArmed = false;
      shortArmed = false;
      longCandidate = null;
      shortCandidate = null;
      continue;
    }

    const delta = buy - sell;
    const ratio = delta / Math.max(exact, EPSILON);
    cumulativeDelta += delta;
    series.cumulativeDelta[index] = cumulativeDelta;
    series.deltaRatio[index] = ratio;
    pushMoments(deltaMoments, ratio, settings.normalizationLookback);
    const deltaStats = moments(deltaMoments);
    const normalized = deltaStats.deviation > 1e-8 ? (ratio - deltaStats.mean) / deltaStats.deviation : 0;
    const rawPressure = clamp(normalized * 25, -100, 100);
    const previousPressure = series.adaptivePressure[index - 1];

    if (settings.smoothingMode === "ADAPTIVE_KAMA") {
      const efficiencyLength = Math.max(2, settings.smoothingLength);
      const change = index >= efficiencyLength && Number.isFinite(series.deltaRatio[index - efficiencyLength])
        ? Math.abs(ratio - series.deltaRatio[index - efficiencyLength]!) : 0;
      let path = 0;
      for (let cursor = Math.max(1, index - efficiencyLength + 1); cursor <= index; cursor++) {
        if (Number.isFinite(series.deltaRatio[cursor]) && Number.isFinite(series.deltaRatio[cursor - 1])) {
          path += Math.abs(series.deltaRatio[cursor]! - series.deltaRatio[cursor - 1]!);
        }
      }
      const er = path > EPSILON ? clamp(change / path, 0, 1) : 0;
      const fast = 2 / (settings.adaptiveFastLength + 1);
      const slow = 2 / (settings.adaptiveSlowLength + 1);
      const alpha = Math.pow(er * (fast - slow) + slow, 2);
      smoothed = smoothed === null ? rawPressure : smoothed + alpha * (rawPressure - smoothed);
    } else {
      const alpha = settings.smoothingMode === "RMA" ? 1 / settings.smoothingLength : 2 / (settings.smoothingLength + 1);
      smoothed = smoothed === null ? rawPressure : smoothed + alpha * (rawPressure - smoothed);
    }
    const pressure = clamp(smoothed, -100, 100);
    series.adaptivePressure[index] = pressure;
    const impulse = Number.isFinite(previousPressure) ? pressure - previousPressure! : 0;
    series.deltaImpulse[index] = impulse;
    pushMoments(envelopeMoments, pressure, settings.envelopeLookback);
    const envelope = moments(envelopeMoments);
    const width = Math.max(settings.minimumEnvelopeWidth, envelope.deviation * settings.envelopeDeviation);
    series.center[index] = clamp(envelope.mean, -80, 80);
    series.upperEnvelope[index] = clamp(envelope.mean + width, -95, 100);
    series.lowerEnvelope[index] = clamp(envelope.mean - width, -100, 95);

    const upperStructure = series.upperStructure[index];
    const lowerStructure = series.lowerStructure[index];
    const range = Math.max(candle.high - candle.low, EPSILON);
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const shortStructureTest = Number.isFinite(upperStructure)
      && candle.high >= upperStructure! - atrValue * settings.structureToleranceAtr
      && candle.close < upperStructure!
      && upperWick / range >= settings.minimumRejectionWickRatio;
    const longStructureTest = Number.isFinite(lowerStructure)
      && candle.low <= lowerStructure! + atrValue * settings.structureToleranceAtr
      && candle.close > lowerStructure!
      && lowerWick / range >= settings.minimumRejectionWickRatio;
    const longDivergence = divergenceScore(closes, series.adaptivePressure, index, settings.divergenceLookback, "long");
    const shortDivergence = divergenceScore(closes, series.adaptivePressure, index, settings.divergenceLookback, "short");
    series.divergenceScore[index] = Math.max(longDivergence, shortDivergence);

    if (longLocked && pressure >= -settings.resetThreshold) longLocked = false;
    if (shortLocked && pressure <= settings.resetThreshold) shortLocked = false;
    if (!longLocked && index >= cooldownUntil && pressure <= series.lowerEnvelope[index]! && pressure <= -settings.minimumExtremeScore) longArmed = true;
    if (!shortLocked && index >= cooldownUntil && pressure >= series.upperEnvelope[index]! && pressure >= settings.minimumExtremeScore) shortArmed = true;

    const trendConflictLong = settings.trendProtection && regime === "DOWNTREND";
    const trendConflictShort = settings.trendProtection && regime === "UPTREND";
    const highChop = chop > settings.maximumChopProbability;
    const longReversal = impulse >= settings.minimumReversalImpulse && pressure > (previousPressure ?? pressure);
    const shortReversal = impulse <= -settings.minimumReversalImpulse && pressure < (previousPressure ?? pressure);
    const longContextPass = (!trendConflictLong || longDivergence >= settings.minimumDivergenceScore)
      && (!highChop || longDivergence >= settings.minimumDivergenceScore * 1.2);
    const shortContextPass = (!trendConflictShort || shortDivergence >= settings.minimumDivergenceScore)
      && (!highChop || shortDivergence >= settings.minimumDivergenceScore * 1.2);

    const confidence = (structure: boolean, divergence: number) => {
      const extreme = clamp(Math.abs(pressure), 0, 100);
      const reversal = clamp(Math.abs(impulse) / Math.max(settings.minimumReversalImpulse, 1) * 35, 0, 100);
      const regimeQuality = regime === "ROTATION" ? 88 : regime === "TRANSITION" ? 78 : 62;
      return clamp(extreme * 0.28 + reversal * 0.22 + (structure ? 100 : 0) * 0.25 + divergence * 0.15 + regimeQuality * 0.10, 0, 100);
    };

    const longConfidence = confidence(longStructureTest, longDivergence);
    const shortConfidence = confidence(shortStructureTest, shortDivergence);
    series.longConfidence[index] = longConfidence;
    series.shortConfidence[index] = shortConfidence;

    if (longArmed && longReversal && longStructureTest && longContextPass && !longCandidate) {
      longCandidate = {
        index, expires: index + settings.confirmationBars, trigger: candle.high,
        structure: lowerStructure!, confidence: longConfidence,
        reasons: ["SELLING_EXHAUSTION", "DELTA_STRENGTHENING", "LOWER_STRUCTURE_RECLAIM", regime]
      };
    }
    if (shortArmed && shortReversal && shortStructureTest && shortContextPass && !shortCandidate) {
      shortCandidate = {
        index, expires: index + settings.confirmationBars, trigger: candle.low,
        structure: upperStructure!, confidence: shortConfidence,
        reasons: ["BUYING_EXHAUSTION", "DELTA_WEAKENING", "UPPER_STRUCTURE_REJECTION", regime]
      };
    }

    const emit = (direction: "long" | "short", candidate: Candidate, finalConfidence: number) => {
      if (index > lastFinalIndex || finalConfidence < settings.minimumSignalConfidence) return false;
      const signal: AcvdSignal = {
        id: `bc-acvd:${input.marketIdentity ?? "market"}:${timeframeSeconds}:${direction}:${candle.time}`,
        indicatorId: ACVD_INDICATOR_ID,
        modelVersion: ACVD_MODEL_VERSION,
        direction,
        index,
        time: candle.time,
        executionEligibleTimestamp: candle.time + timeframeSeconds,
        confidence: finalConfidence,
        pressure,
        deltaRatio: ratio,
        cumulativeDelta,
        structurePrice: candidate.structure,
        regime,
        reasonCodes: [...candidate.reasons, "CLOSED_BAR_DISPLACEMENT_CONFIRMED"],
        finalized: true,
        markerTone: direction === "long" ? "silver-white" : "blood-red"
      };
      signals.push(signal);
      cooldownUntil = index + settings.cooldownBars;
      if (direction === "long") { longLocked = true; longArmed = false; shortArmed = false; }
      else { shortLocked = true; shortArmed = false; longArmed = false; }
      return true;
    };

    if (longCandidate && index > longCandidate.index) {
      const confirmed = candle.close > longCandidate.trigger && impulse > 0;
      if (confirmed && emit("long", longCandidate, Math.max(longCandidate.confidence, longConfidence))) longCandidate = null;
      else if (index >= longCandidate.expires || pressure < series.lowerEnvelope[index]!) longCandidate = null;
    }
    if (shortCandidate && index > shortCandidate.index) {
      const confirmed = candle.close < shortCandidate.trigger && impulse < 0;
      if (confirmed && emit("short", shortCandidate, Math.max(shortCandidate.confidence, shortConfidence))) shortCandidate = null;
      else if (index >= shortCandidate.expires || pressure > series.upperEnvelope[index]!) shortCandidate = null;
    }
  }

  const latestIndex = (() => {
    for (let index = length - 1; index >= 0; index--) if (Number.isFinite(series.adaptivePressure[index])) return index;
    return -1;
  })();
  if (latestIndex < 0) return emptySnapshot(scopedInput, input.flowWarning ?? "BC-ACVD is warming until a complete interval contains genuine classified aggressor trades.");
  const latestPressure = series.adaptivePressure[latestIndex]!;
  const latestState = latestPressure > series.upperEnvelope[latestIndex]! ? "BULLISH"
    : latestPressure < series.lowerEnvelope[latestIndex]! ? "BEARISH" : "NEUTRAL";
  const dataHash = stableHash(candles.map((candle, index) => [
    candle.time, candle.open, candle.high, candle.low, candle.close,
    flowBars[index]!.buyNotional, flowBars[index]!.sellNotional, flowBars[index]!.exactTradeCount
  ]));

  return {
    schemaVersion: 1,
    modelVersion: ACVD_MODEL_VERSION,
    indicatorId: ACVD_INDICATOR_ID,
    inputSize: length,
    authority: "EXACT_AGGRESSOR_TRADES",
    warning: input.flowWarning ?? null,
    marketIdentity: input.marketIdentity ?? "unknown",
    settingsHash: acvdSettingsHash(settings),
    dataHash,
    series,
    signals,
    latest: {
      state: latestState,
      pressure: latestPressure,
      deltaRatio: series.deltaRatio[latestIndex]!,
      cumulativeDelta: series.cumulativeDelta[latestIndex]!,
      coveragePercent: series.coveragePercent[latestIndex]!,
      regime: series.regime[latestIndex]!,
      chopProbability: series.chopProbability[latestIndex]!,
      longConfidence: series.longConfidence[latestIndex]!,
      shortConfidence: series.shortConfidence[latestIndex]!
    },
    integrity: {
      causal: true,
      currentBar: input.lastBarConfirmed === false ? "DEVELOPING" : "FINAL",
      closedBarSignalsOnly: true,
      futureBarsConsumed: 0,
      source: "EXACT_AGGRESSOR_TRADES",
      signalCount: signals.length
    }
  };
}
