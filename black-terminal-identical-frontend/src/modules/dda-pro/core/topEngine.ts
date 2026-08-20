import type { Candle } from "../../../chart-engine/types.ts";
import { ddaProCalculationSettingsHash } from "./settings.ts";
import { insertSorted, quantile, removeSorted, smoothSeries } from "./statistics.ts";
import type {
  BCRDAMarketRegime,
  BCRDATopEpisode,
  BCRDATopEpisodeState,
  BCRDATopSeries,
  DDAProCalculationInput,
  DDAProEvent,
  DDAProRiskState,
  DDAProSignalEvent,
  DDAProSettings
} from "./types.ts";
import { DDA_PRO_INDICATOR_ID } from "./types.ts";

export const BC_RDA_TOP_ENGINE_VERSION = "BC_RDA_CAUSAL_TOP_V2" as const;

export type BCRDATopEngineResult = {
  series: BCRDATopSeries;
  episodes: BCRDATopEpisode[];
  events: DDAProEvent[];
  candidates: DDAProSignalEvent[];
  confirmedSignals: DDAProSignalEvent[];
};

type ActiveTopEpisode = BCRDATopEpisode & {
  barrier: number;
  bullPersistence: number;
  terminalPersistence: number;
  candidateIndex: number | null;
  confirmedRequiredReversal: number;
};

const clamp = (value: number, minimum = 0, maximum = 100) =>
  Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));

function blankTopSeries(length: number): BCRDATopSeries {
  const numeric = () => new Array<number>(length).fill(0);
  return {
    rawDrawup: numeric(), smoothedDrawup: numeric(), drawupDepth: numeric(), drawupMean: numeric(),
    drawupP50: numeric(), drawupP75: numeric(), drawupP90: numeric(), drawupP95: numeric(), drawupP99: numeric(),
    drawupPercentileRank: numeric(), drawupZScore: numeric(), drawupDuration: numeric(), timeAboveTrough: numeric(),
    drawupVelocity: numeric(), drawupAcceleration: numeric(), drawupVadd: numeric(), distributionWidth: numeric(),
    tailSeverity: numeric(), topRiskScore: numeric(),
    topRiskState: new Array<DDAProRiskState>(length).fill("INSUFFICIENT"),
    adaptiveEntryThreshold: numeric(), dynamicTopBarrier: numeric(), exhaustionEntryBoundary: numeric(),
    reversalConfirmationBoundary: numeric(), candidateInvalidationBoundary: numeric(), bullPersistenceScore: numeric(),
    reversalFromEpisodeHigh: numeric(), requiredTopReversal: numeric(),
    state: new Array<BCRDATopEpisodeState>(length).fill("NEUTRAL"),
    marketRegime: new Array<BCRDAMarketRegime>(length).fill("INSUFFICIENT"),
    episodeId: new Array<string | null>(length).fill(null)
  };
}

const cleanIdentity = (value: string) => value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase() || "unknown";

function episodeIdentity(input: DDAProCalculationInput, anchorTime: number, horizon: number, settingsHash: string) {
  const context = input.signalContext;
  return [
    "bc-rda-top-episode-v2", cleanIdentity(context?.exchange ?? "market"), cleanIdentity(context?.symbol ?? "unknown"),
    cleanIdentity(context?.timeframe ?? `${input.timeframeSeconds ?? 0}s`), horizon, anchorTime,
    BC_RDA_TOP_ENGINE_VERSION.toLowerCase(), settingsHash
  ].join(":");
}

const signalIdentity = (episodeId: string, confirmationTime: number) =>
  episodeId.replace("top-episode-v2", "top-signal-v2") + ":" + confirmationTime;

function percentageReturn(current: number, prior: number) {
  return prior > 0 && current > 0 ? (current / prior - 1) * 100 : 0;
}

function sortedPercentileRank(sortedValues: readonly number[], value: number) {
  let lower = 0;
  let upper = sortedValues.length;
  while (lower < upper) {
    const middle = (lower + upper) >>> 1;
    if ((sortedValues[middle] ?? 0) <= value) lower = middle + 1;
    else upper = middle;
  }
  return sortedValues.length ? lower / sortedValues.length * 100 : 0;
}

function rollingMinimumIndices(values: readonly number[], horizon: number) {
  const result = new Array<number>(values.length).fill(0);
  const deque: number[] = [];
  let head = 0;
  for (let index = 0; index < values.length; index++) {
    while (head < deque.length && deque[head]! < index - horizon + 1) head += 1;
    while (deque.length > head && (values[deque.at(-1)!] ?? Number.POSITIVE_INFINITY) >= (values[index] ?? 0)) deque.pop();
    deque.push(index);
    result[index] = deque[head] ?? index;
    if (head > 256 && head * 2 > deque.length) {
      deque.splice(0, head);
      head = 0;
    }
  }
  return result;
}

function riskStateForScore(score: number, previous: DDAProRiskState, settings: DDAProSettings): DDAProRiskState {
  const hysteresis = settings.hysteresisPercent;
  if (previous === "EXTREME" && score >= settings.extremeThreshold - hysteresis) return "EXTREME";
  if (previous === "HIGH" && score >= settings.highThreshold - hysteresis && score < settings.extremeThreshold + hysteresis) return "HIGH";
  if (previous === "MODERATE" && score >= settings.moderateThreshold - hysteresis && score < settings.highThreshold + hysteresis) return "MODERATE";
  if (score >= settings.extremeThreshold) return "EXTREME";
  if (score >= settings.highThreshold) return "HIGH";
  if (score >= settings.moderateThreshold) return "MODERATE";
  return "LOW";
}

function regimeEvidence(
  values: readonly number[],
  index: number,
  localHorizon: number,
  structuralHorizon: number,
  returnPrefix: readonly number[],
  absoluteReturnPrefix: readonly number[],
  atrPercent: number
) {
  if (index < Math.min(20, localHorizon)) return { regime: "INSUFFICIENT" as const, bullEvidence: 0, localSlope: 0, structuralSlope: 0, efficiency: 0 };
  const localStart = Math.max(0, index - localHorizon);
  const structuralStart = Math.max(0, index - structuralHorizon);
  const localBars = Math.max(1, index - localStart);
  const structuralBars = Math.max(1, index - structuralStart);
  const localDisplacement = percentageReturn(values[index] ?? 0, values[localStart] ?? 0);
  const structuralDisplacement = percentageReturn(values[index] ?? 0, values[structuralStart] ?? 0);
  const path = absoluteReturnPrefix[index + 1]! - absoluteReturnPrefix[structuralStart + 1]!;
  const efficiency = Math.abs(structuralDisplacement) / Math.max(path, 1e-9);
  const localSlope = localDisplacement / localBars / Math.max(atrPercent, 1e-6);
  const structuralSlope = structuralDisplacement / structuralBars / Math.max(atrPercent, 1e-6);
  const recentMean = (returnPrefix[index + 1]! - returnPrefix[localStart + 1]!) / localBars;
  const bullEvidence = clamp(
    50 + localSlope * 42 + structuralSlope * 58 + Math.max(0, efficiency - 0.25) * 45 + Math.max(0, recentMean) / Math.max(atrPercent, 1e-6) * 20
  );
  const bearEvidence = clamp(50 - localSlope * 42 - structuralSlope * 58 + Math.max(0, efficiency - 0.25) * 35);
  const regime: BCRDAMarketRegime = bullEvidence >= 72 ? "STRONG_BULL"
    : bullEvidence >= 55 ? "WEAK_BULL"
      : bearEvidence >= 72 ? "STRONG_BEAR"
        : bearEvidence >= 55 ? "WEAK_BEAR"
          : efficiency < 0.28 ? "RANGE" : "TRANSITION";
  return { regime, bullEvidence, localSlope, structuralSlope, efficiency };
}

function bearishChangePoint(values: readonly number[], index: number, atrPercent: number, sensitivity: number) {
  if (index < 10) return false;
  const recent = [index - 2, index - 1, index]
    .map((cursor) => percentageReturn(values[cursor] ?? 0, values[cursor - 1] ?? 0))
    .reduce((sum, value) => sum + value, 0) / 3;
  const baseline = Array.from({ length: 7 }, (_, offset) => index - 9 + offset)
    .map((cursor) => percentageReturn(values[cursor] ?? 0, values[cursor - 1] ?? 0))
    .reduce((sum, value) => sum + value, 0) / 7;
  const requiredShift = Math.max(0.02, atrPercent * (0.06 + (100 - sensitivity) * 0.0012));
  return recent < -requiredShift && recent < baseline - requiredShift;
}

function bearishStructureBreak(candles: readonly Candle[], values: readonly number[], index: number, localHorizon: number) {
  const window = Math.max(6, Math.min(14, Math.floor(localHorizon / 2)));
  if (index < window + 2) return false;
  const start = index - window;
  const structureLows = candles.slice(start, index - 1).map((candle) => candle.low).filter(Number.isFinite);
  const priorHighs = candles.slice(Math.max(0, index - 5), index).map((candle) => candle.high).filter(Number.isFinite);
  if (!structureLows.length || !priorHighs.length) return false;
  const current = candles[index];
  return (current?.close ?? values[index] ?? 0) < Math.min(...structureLows) &&
    (current?.high ?? values[index] ?? 0) < Math.max(...priorHighs);
}

function exactBearishFlow(input: DDAProCalculationInput, index: number) {
  const bar = input.flowBars?.[index];
  return input.flowAuthority === "EXACT_AGGRESSOR_TRADES" && bar?.deliveryComplete === true &&
    bar.totalTradeCount > 0 && bar.sellNotional > bar.buyNotional;
}

function trueRangePercent(candles: readonly Candle[], values: readonly number[], index: number, priceAuthority: boolean) {
  if (index <= 0) return 0;
  const prior = values[index - 1] ?? 0;
  if (prior <= 0) return 0;
  if (!priceAuthority) return Math.abs(percentageReturn(values[index] ?? prior, prior));
  const candle = candles[index];
  if (!candle) return 0;
  return Math.max(candle.high - candle.low, Math.abs(candle.high - prior), Math.abs(candle.low - prior)) / prior * 100;
}

/** Independent, bounded, causal and re-armable upside-exhaustion engine. */
export function calculateBCRDATopEngine(input: DDAProCalculationInput, values: readonly number[], barsPerYear: number): BCRDATopEngineResult {
  const { settings, candles } = input;
  const length = Math.min(values.length, candles.length);
  const series = blankTopSeries(length);
  const episodes: BCRDATopEpisode[] = [];
  const events: DDAProEvent[] = [];
  const confirmedSignals: DDAProSignalEvent[] = [];
  if (settings.modelVersion !== "v2-causal" || !settings.enableMirroredTopEngine || settings.topEngineMode === "disabled" || length === 0) {
    return { series, episodes, events, candidates: [], confirmedSignals };
  }

  const analyticalHorizon = Math.max(settings.topStructuralHorizon, Math.min(settings.lookback, settings.topRegimeHorizon));
  const regimeHorizon = Math.min(settings.topRegimeHorizon, analyticalHorizon);
  const structuralHorizon = Math.min(settings.topStructuralHorizon, regimeHorizon);
  const localHorizon = Math.min(settings.topLocalSwingHorizon, structuralHorizon);
  const primaryMinimum = rollingMinimumIndices(values, analyticalHorizon);
  const swingMinimum = rollingMinimumIndices(values, localHorizon);
  const settingsHash = ddaProCalculationSettingsHash(settings);
  const trueRanges = new Array<number>(length).fill(0);
  const absoluteReturns = new Array<number>(length).fill(0);
  const percentageReturns = new Array<number>(length).fill(0);
  const logReturns = new Array<number>(length).fill(0);
  const trueRangePrefix = new Array<number>(length + 1).fill(0);
  const percentageReturnPrefix = new Array<number>(length + 1).fill(0);
  const absoluteReturnPrefix = new Array<number>(length + 1).fill(0);
  const returnSumPrefix = new Array<number>(length + 1).fill(0);
  const returnSquaresPrefix = new Array<number>(length + 1).fill(0);
  const priceAuthority = settings.equitySource === "price";
  for (let index = 1; index < length; index++) {
    trueRanges[index] = trueRangePercent(candles, values, index, priceAuthority);
    percentageReturns[index] = percentageReturn(values[index] ?? 0, values[index - 1] ?? 0);
    absoluteReturns[index] = Math.abs(percentageReturns[index]!);
    logReturns[index] = values[index - 1]! > 0 && values[index]! > 0 ? Math.log(values[index]! / values[index - 1]!) : 0;
    trueRangePrefix[index + 1] = trueRangePrefix[index]! + trueRanges[index]!;
    percentageReturnPrefix[index + 1] = percentageReturnPrefix[index]! + percentageReturns[index]!;
    absoluteReturnPrefix[index + 1] = absoluteReturnPrefix[index]! + absoluteReturns[index]!;
    returnSumPrefix[index + 1] = returnSumPrefix[index]! + logReturns[index]!;
    returnSquaresPrefix[index + 1] = returnSquaresPrefix[index]! + logReturns[index]! * logReturns[index]!;
  }

  let active: ActiveTopEpisode | null = null;
  let topRiskState: DDAProRiskState = "INSUFFICIENT";
  let resetOnNextBar = false;
  let rearmAfterConfirmedTop = false;
  let confirmedTopPrice = 0;
  let confirmedTopIndex = Number.NEGATIVE_INFINITY;
  let persistentBullScore = 0;
  let positiveRun = 0;
  const returnDistribution: number[] = [];
  const drawupDistribution: number[] = [];
  const barrierDistribution: number[] = [];
  let drawupDistributionSum = 0;

  for (let index = 0; index < length; index++) {
    const price = values[index] ?? 0;
    const time = candles[index]?.time ?? 0;
    if (resetOnNextBar) {
      resetOnNextBar = false;
      active = null;
      barrierDistribution.length = 0;
      series.state[index] = "RESET";
    }
    const atrStart = Math.max(1, index - settings.topAtrLookback);
    const atrCount = Math.max(0, index - atrStart);
    const atrPercent = atrCount ? (trueRangePrefix[index]! - trueRangePrefix[atrStart]!) / atrCount : 0;
    const returnThreshold = quantile(returnDistribution, settings.topReturnQuantile, settings.quantileMethod);
    const minimumEntry = settings.topEpisodeMinimumThresholdPercent;
    const maximumEntry = Math.max(minimumEntry, settings.topEpisodeMaximumThresholdPercent);
    const adaptiveEntry = clamp(Math.max(minimumEntry, atrPercent * settings.topAtrMultiplier, returnThreshold * settings.topQuantileMultiplier), minimumEntry, maximumEntry);
    series.adaptiveEntryThreshold[index] = adaptiveEntry;

    const regime = regimeEvidence(values, index, localHorizon, regimeHorizon, percentageReturnPrefix, absoluteReturnPrefix, atrPercent);
    series.marketRegime[index] = regime.regime;
    const persistenceStep = 100 / Math.max(2, settings.topBullPersistenceBars);
    persistentBullScore = regime.bullEvidence >= 55
      ? Math.min(100, persistentBullScore + persistenceStep)
      : Math.max(0, persistentBullScore - persistenceStep * 0.5);
    series.bullPersistenceScore[index] = persistentBullScore;
    positiveRun = (percentageReturns[index] ?? 0) > 0 ? positiveRun + 1 : 0;

    const primaryIndex = primaryMinimum[index] ?? index;
    const swingIndex = swingMinimum[index] ?? index;
    const candidateDrawup = Math.max(0, percentageReturn(price, values[primaryIndex] ?? price));
    const topCooldownElapsed = index - confirmedTopIndex >= settings.topCooldownBars;
    if (rearmAfterConfirmedTop && topCooldownElapsed &&
        (candidateDrawup <= adaptiveEntry * 0.35 || price > confirmedTopPrice * (1 + adaptiveEntry / 100))) {
      rearmAfterConfirmedTop = false;
    }
    if (!active) {
      series.rawDrawup[index] = candidateDrawup;
      const warmup = Math.max(settings.topAtrLookback, Math.min(settings.topReturnQuantileLookback, 50));
      if (!rearmAfterConfirmedTop && index >= warmup && candidateDrawup >= adaptiveEntry) {
        const id = episodeIdentity(input, candles[primaryIndex]?.time ?? primaryIndex, analyticalHorizon, settingsHash);
        active = {
          id, troughIndex: primaryIndex, troughTime: candles[primaryIndex]?.time ?? 0, troughPrice: values[primaryIndex] ?? price,
          startIndex: index, entryThresholdPercent: adaptiveEntry, analyticalHorizon, settingsHash,
          primaryAnchorIndex: primaryIndex, primaryAnchorTime: candles[primaryIndex]?.time ?? 0,
          swingAnchorIndex: swingIndex, swingAnchorTime: candles[swingIndex]?.time ?? 0,
          maximumIndex: index, maximumTime: time, maximumPrice: price, maximumDrawupPercent: candidateDrawup,
          terminalTouches: 0, confirmedIndex: null, resetIndex: null, state: "BULL_ADVANCE",
          barrier: Math.max(adaptiveEntry * 1.05, candidateDrawup), bullPersistence: persistentBullScore,
          terminalPersistence: 0, candidateIndex: null, confirmedRequiredReversal: 0
        };
        episodes.push(active);
        for (const value of series.rawDrawup.slice(Math.max(primaryIndex, index - structuralHorizon), index)) insertSorted(barrierDistribution, value);
      }
    }

    if (active) {
      let state = active.state;
      const drawup = Math.max(0, percentageReturn(price, active.troughPrice));
        series.rawDrawup[index] = drawup;
        const priorMaximumIndex = active.maximumIndex;
        const newHigh = price > active.maximumPrice + Number.EPSILON;
        if (newHigh) {
          active.maximumPrice = price;
          active.maximumIndex = index;
          active.maximumTime = time;
          active.maximumDrawupPercent = drawup;
          active.swingAnchorIndex = swingIndex;
          active.swingAnchorTime = candles[swingIndex]?.time ?? 0;
          if (state === "REVERSAL_CANDIDATE") {
            state = "BULL_REACCELERATION";
            active.candidateIndex = null;
            active.terminalPersistence = 0;
          } else if (state === "EXHAUSTION_WATCH") {
            active.candidateIndex = index;
          }
        }
        insertSorted(barrierDistribution, drawup);
        const expiredIndex = index - structuralHorizon;
        if (expiredIndex >= active.primaryAnchorIndex) removeSorted(barrierDistribution, series.rawDrawup[expiredIndex] ?? 0);
        const p25 = quantile(barrierDistribution, 0.25, settings.quantileMethod);
        const p75 = quantile(barrierDistribution, 0.75, settings.quantileMethod);
        const robustDispersion = Math.max(0, (p75 - p25) / 1.349);
        const upperQuantile = quantile(barrierDistribution, settings.topExtremityPercentile, settings.quantileMethod);
        const targetBarrier = Math.max(
          active.entryThresholdPercent * 1.05,
          upperQuantile + robustDispersion * settings.topBarrierDispersionMultiplier,
          adaptiveEntry + Math.max(atrPercent, returnThreshold) * 1.5
        );
        const alpha = targetBarrier >= active.barrier ? 0.28 : 0.08;
        active.barrier += (targetBarrier - active.barrier) * alpha;
        const reversal = active.maximumPrice > 0 ? Math.max(0, (active.maximumPrice - price) / active.maximumPrice * 100) : 0;
        const requiredReversal = Math.max(settings.topMinimumReversalPercent, atrPercent * settings.topReversalAtrMultiplier, returnThreshold * settings.topQuantileMultiplier);
        const invalidationBuffer = Math.max(0.05, atrPercent * 0.25);
        series.dynamicTopBarrier[index] = active.barrier;
        series.exhaustionEntryBoundary[index] = active.barrier;
        series.reversalConfirmationBoundary[index] = Math.max(0, active.maximumDrawupPercent - requiredReversal);
        series.candidateInvalidationBoundary[index] = active.maximumDrawupPercent + invalidationBuffer;
        series.reversalFromEpisodeHigh[index] = reversal;
        series.requiredTopReversal[index] = requiredReversal;
        series.drawupDuration[index] = index - active.startIndex + 1;
        series.episodeId[index] = active.id;
        const priorDrawup = series.rawDrawup[index - 1] ?? drawup;
        const priorVelocity = series.drawupVelocity[index - 1] ?? 0;
        const velocity = drawup - priorDrawup;
        const acceleration = velocity - priorVelocity;
        const terminalZone = drawup >= active.barrier * 0.985 && sortedPercentileRank(barrierDistribution, drawup) >= settings.topExtremityPercentile * 100;
        const paceStart = Math.max(1, index - localHorizon);
        const paceCount = Math.max(1, index - paceStart);
        const priorPace = (percentageReturnPrefix[index]! - percentageReturnPrefix[paceStart]!) / paceCount;
        const paceWeakening = priorPace > 0 && (percentageReturns[index] ?? 0) < priorPace * 0.72;
        const decelerating = acceleration < 0 || velocity < Math.max(0, priorVelocity) * 0.55 || paceWeakening;
        active.terminalPersistence = terminalZone && decelerating ? active.terminalPersistence + 1 : Math.max(0, active.terminalPersistence - 1);
        if (terminalZone && (newHigh || reversal > 0)) active.terminalTouches += 1;
        const maturity = index - active.startIndex + 1;
        const bearishMomentum = index >= 3 && percentageReturns.slice(index - 2, index + 1).reduce((sum, value) => sum + value, 0) < -Math.max(0.05, atrPercent * 0.35);
        const bullProtected = settings.strongBullProtection && persistentBullScore >= 50;

        if (state === "BULL_REACCELERATION") {
          if (positiveRun >= settings.topReaccelerationBars || index > priorMaximumIndex) {
            state = "BULL_ADVANCE";
            active.candidateIndex = null;
          }
        }
        if (state === "BULL_ADVANCE" && maturity >= settings.topMinimumMaturityBars && active.terminalPersistence >= 2 && terminalZone) {
          state = "EXHAUSTION_WATCH";
          active.candidateIndex = active.maximumIndex;
          events.push({
            id: `bc-rda-top-exhaustion-v2:${active.id}:${time}`, type: "TOP_EXHAUSTION_CANDIDATE", index: active.maximumIndex,
            time: active.maximumTime, state: "HIGH", value: active.maximumDrawupPercent, confirmed: false
          });
        } else if (state === "EXHAUSTION_WATCH") {
          if (positiveRun >= settings.topReaccelerationBars && drawup >= active.maximumDrawupPercent * 0.995) state = "BULL_REACCELERATION";
          else if (reversal >= requiredReversal * 0.45 && bearishMomentum) {
            state = "REVERSAL_CANDIDATE";
            active.candidateIndex = index;
          }
        } else if (state === "REVERSAL_CANDIDATE") {
          if (newHigh || positiveRun >= settings.topReaccelerationBars) {
            state = "BULL_REACCELERATION";
            active.candidateIndex = null;
          } else {
            const changePoint = bearishChangePoint(values, index, atrPercent, settings.topChangePointSensitivity);
            const structure = bearishStructureBreak(candles, values, index, localHorizon);
            const persistentWeakening = regime.localSlope < -0.06 && regime.structuralSlope < 0.18 && regime.efficiency < 0.82;
            const failedRecovery = active.candidateIndex !== null && index - active.candidateIndex >= 2 &&
              price <= active.maximumPrice * (1 - requiredReversal * 0.35 / 100);
            const reversalMultiplier = bullProtected ? 1.75 : 1;
            const deepReversalOverride = reversal >= requiredReversal * 2.5;
            const eligible = reversal >= requiredReversal * reversalMultiplier && changePoint && structure && failedRecovery &&
              (persistentWeakening || deepReversalOverride) &&
              (!settings.topRequireExactBearishFlow || exactBearishFlow(input, index)) &&
              Number.isFinite(price) && price > 0 && (!settings.oneShortPerTopEpisode || active.confirmedIndex === null);
            if (eligible) {
              state = "CONFIRMED_TOP";
              active.confirmedIndex = index;
              active.confirmedRequiredReversal = requiredReversal;
              const confidence = clamp(50 + Math.min(18, reversal / Math.max(requiredReversal, 1e-9) * 7) +
                (structure ? 10 : 0) + (changePoint ? 8 : 0) + (persistentWeakening ? 8 : 0) -
                (input.flowAuthority === "EXACT_AGGRESSOR_TRADES" ? 0 : 6));
              const signal: DDAProSignalEvent = {
                id: signalIdentity(active.id, time), indicatorId: DDA_PRO_INDICATOR_ID, direction: "short", index, time,
                value: active.maximumDrawupPercent, sourceEventType: "TOP_REVERSAL_CONFIRMED", markerTone: "blood-red",
                classification: "confirmed", confidence, episodeId: active.id, reasonCodes: ["SIGNAL_CONFIRMED"],
                episodeExtremityIndex: active.maximumIndex, episodeExtremityTime: active.maximumTime
              };
              confirmedSignals.push(signal);
              rearmAfterConfirmedTop = true;
              confirmedTopPrice = active.maximumPrice;
              confirmedTopIndex = index;
              events.push({
                id: `bc-rda-top-confirmed-v2:${active.id}:${time}`, type: "TOP_REVERSAL_CONFIRMED", index, time,
                state: "EXTREME", value: active.maximumDrawupPercent, confidence, confirmed: true
              });
              resetOnNextBar = true;
            }
          }
        }
        if (state !== "CONFIRMED_TOP" && maturity >= settings.topMinimumMaturityBars && drawup <= active.entryThresholdPercent * 0.20 && reversal >= requiredReversal) {
          state = "RESET";
          active.resetIndex = index;
          resetOnNextBar = true;
        }
      active.state = state;
      series.state[index] = state;
    }

    const drawup = series.rawDrawup[index] ?? 0;
    insertSorted(drawupDistribution, drawup);
    drawupDistributionSum += drawup;
    if (index >= structuralHorizon) {
      const expired = series.rawDrawup[index - structuralHorizon] ?? 0;
      removeSorted(drawupDistribution, expired);
      drawupDistributionSum -= expired;
    }
    const p50 = quantile(drawupDistribution, 0.50, settings.quantileMethod);
    const p75 = quantile(drawupDistribution, 0.75, settings.quantileMethod);
    const p90 = quantile(drawupDistribution, 0.90, settings.quantileMethod);
    const p95 = quantile(drawupDistribution, 0.95, settings.quantileMethod);
    const p99 = quantile(drawupDistribution, 0.99, settings.quantileMethod);
    const p25 = quantile(drawupDistribution, 0.25, settings.quantileMethod);
    const robustDeviation = Math.max((p75 - p25) / 1.349, 1e-9);
    series.drawupMean[index] = drawupDistributionSum / Math.max(1, drawupDistribution.length);
    series.drawupP50[index] = p50; series.drawupP75[index] = p75; series.drawupP90[index] = p90;
    series.drawupP95[index] = p95; series.drawupP99[index] = p99;
    series.drawupPercentileRank[index] = sortedPercentileRank(drawupDistribution, drawup);
    series.drawupZScore[index] = (drawup - p50) / robustDeviation;
    series.distributionWidth[index] = Math.max(0, p95 - p50);
    series.tailSeverity[index] = p95 > 1e-9 ? clamp(drawup / p95 * 100) : 0;
    series.drawupDepth[index] = drawup;
    series.drawupVelocity[index] = index ? drawup - (series.drawupDepth[index - 1] ?? 0) : 0;
    series.drawupAcceleration[index] = index ? series.drawupVelocity[index]! - (series.drawupVelocity[index - 1] ?? 0) : 0;
    series.timeAboveTrough[index] = drawup > 1e-9 ? (series.timeAboveTrough[index - 1] ?? 0) + 1 : 0;
    const returnsStart = Math.max(1, index - structuralHorizon + 1);
    const returnCount = Math.max(0, index - returnsStart + 1);
    const returnSum = returnSumPrefix[index + 1]! - returnSumPrefix[returnsStart]!;
    const squareSum = returnSquaresPrefix[index + 1]! - returnSquaresPrefix[returnsStart]!;
    const returnMean = returnCount ? returnSum / returnCount : 0;
    const volatility = Math.sqrt(returnCount ? Math.max(0, squareSum / returnCount - returnMean * returnMean) : 0) * Math.sqrt(Math.max(1, barsPerYear)) * 100;
    series.drawupVadd[index] = drawup / Math.max(volatility, settings.vaddVolatilityFloorPercent);
    const stateScore: Record<BCRDATopEpisodeState, number> = {
      NEUTRAL: 0, BULL_ADVANCE: 25, EXHAUSTION_WATCH: 58, REVERSAL_CANDIDATE: 82,
      BULL_REACCELERATION: 35, CONFIRMED_TOP: 100, RESET: 10
    };
    series.topRiskScore[index] = clamp(series.drawupPercentileRank[index]! * 0.32 + series.tailSeverity[index]! * 0.25 +
      clamp((series.drawupDuration[index] ?? 0) / Math.max(1, settings.topMinimumMaturityBars) * 100) * 0.15 +
      clamp((series.reversalFromEpisodeHigh[index] ?? 0) / Math.max(series.requiredTopReversal[index] ?? settings.topMinimumReversalPercent, 1e-9) * 100) * 0.13 +
      stateScore[series.state[index]!] * 0.15);
    if (drawupDistribution.length >= Math.min(50, structuralHorizon)) {
      topRiskState = riskStateForScore(series.topRiskScore[index]!, topRiskState, settings);
      series.topRiskState[index] = topRiskState;
    }
    insertSorted(returnDistribution, absoluteReturns[index] ?? 0);
    if (index >= settings.topReturnQuantileLookback) removeSorted(returnDistribution, absoluteReturns[index - settings.topReturnQuantileLookback] ?? 0);
  }

  series.smoothedDrawup = smoothSeries(series.rawDrawup, settings.smoothingMethod, settings.smoothingLength);
  const candidates: DDAProSignalEvent[] = [];
  const unresolved = active;
  if (unresolved && unresolved.confirmedIndex === null && unresolved.candidateIndex !== null &&
      (unresolved.state === "EXHAUSTION_WATCH" || unresolved.state === "REVERSAL_CANDIDATE" || unresolved.state === "BULL_REACCELERATION")) {
    candidates.push({
      id: unresolved.id.replace("top-episode-v2", "top-provisional-v2"), indicatorId: DDA_PRO_INDICATOR_ID,
      direction: "short", index: unresolved.maximumIndex, time: unresolved.maximumTime, value: unresolved.maximumDrawupPercent,
      sourceEventType: "TOP_EXHAUSTION_CANDIDATE", markerTone: "blood-red", classification: "provisional",
      episodeId: unresolved.id, episodeExtremityIndex: unresolved.maximumIndex, episodeExtremityTime: unresolved.maximumTime
    });
  }
  return { series, episodes, events, candidates, confirmedSignals };
}
