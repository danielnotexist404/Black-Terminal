import type { Candle } from "../../../chart-engine/types.ts";
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

export const BC_RDA_TOP_ENGINE_VERSION = "BC_RDA_MIRRORED_TOP_V1" as const;

export type BCRDATopEngineResult = {
  series: BCRDATopSeries;
  episodes: BCRDATopEpisode[];
  events: DDAProEvent[];
  candidates: DDAProSignalEvent[];
  confirmedSignals: DDAProSignalEvent[];
};

type ActiveTopEpisode = BCRDATopEpisode & {
  barrier: number;
  terminalPersistence: number;
  confirmedRequiredReversal: number;
};

const clamp = (value: number, minimum = 0, maximum = 100) =>
  Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));

function blankTopSeries(length: number): BCRDATopSeries {
  const numeric = () => new Array<number>(length).fill(0);
  return {
    rawDrawup: numeric(),
    smoothedDrawup: numeric(),
    drawupDepth: numeric(),
    drawupMean: numeric(),
    drawupP50: numeric(),
    drawupP75: numeric(),
    drawupP90: numeric(),
    drawupP95: numeric(),
    drawupP99: numeric(),
    drawupPercentileRank: numeric(),
    drawupZScore: numeric(),
    drawupDuration: numeric(),
    timeAboveTrough: numeric(),
    drawupVelocity: numeric(),
    drawupAcceleration: numeric(),
    drawupVadd: numeric(),
    distributionWidth: numeric(),
    tailSeverity: numeric(),
    topRiskScore: numeric(),
    topRiskState: new Array<DDAProRiskState>(length).fill("INSUFFICIENT"),
    adaptiveEntryThreshold: numeric(),
    dynamicTopBarrier: numeric(),
    reversalFromEpisodeHigh: numeric(),
    requiredTopReversal: numeric(),
    state: new Array<BCRDATopEpisodeState>(length).fill("NEUTRAL"),
    marketRegime: new Array<BCRDAMarketRegime>(length).fill("INSUFFICIENT"),
    episodeId: new Array<string | null>(length).fill(null)
  };
}

function cleanIdentity(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase() || "unknown";
}

function episodeIdentity(input: DDAProCalculationInput, troughTime: number) {
  const context = input.signalContext;
  return [
    "bc-rda-top-episode-v1",
    cleanIdentity(context?.exchange ?? "market"),
    cleanIdentity(context?.symbol ?? "unknown"),
    cleanIdentity(context?.timeframe ?? `${input.timeframeSeconds ?? 0}s`),
    troughTime,
    BC_RDA_TOP_ENGINE_VERSION.toLowerCase()
  ].join(":");
}

function signalIdentity(episodeId: string, confirmationTime: number) {
  return episodeId.replace("top-episode-v1", "top-signal-v1") + ":" + confirmationTime;
}

function riskStateForScore(
  score: number,
  previous: DDAProRiskState,
  settings: DDAProSettings
): DDAProRiskState {
  const hysteresis = settings.hysteresisPercent;
  if (previous === "EXTREME" && score >= settings.extremeThreshold - hysteresis) return "EXTREME";
  if (previous === "HIGH" && score >= settings.highThreshold - hysteresis && score < settings.extremeThreshold + hysteresis) return "HIGH";
  if (previous === "MODERATE" && score >= settings.moderateThreshold - hysteresis && score < settings.highThreshold + hysteresis) return "MODERATE";
  if (score >= settings.extremeThreshold) return "EXTREME";
  if (score >= settings.highThreshold) return "HIGH";
  if (score >= settings.moderateThreshold) return "MODERATE";
  return "LOW";
}

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

function marketRegime(
  values: readonly number[],
  index: number,
  returnPrefix: readonly number[],
  returnSquaresPrefix: readonly number[],
  absoluteReturnPrefix: readonly number[]
): BCRDAMarketRegime {
  const window = 20;
  if (index < window) return "INSUFFICIENT";
  const start = index - window;
  const count = index - start;
  const sum = returnPrefix[index + 1]! - returnPrefix[start + 1]!;
  const squareSum = returnSquaresPrefix[index + 1]! - returnSquaresPrefix[start + 1]!;
  const path = absoluteReturnPrefix[index + 1]! - absoluteReturnPrefix[start + 1]!;
  const mean = sum / Math.max(1, count);
  const deviation = Math.sqrt(Math.max(0, squareSum / Math.max(1, count) - mean * mean));
  const displacement = percentageReturn(values[index] ?? 0, values[start] ?? 0);
  const efficiency = Math.abs(displacement) / Math.max(path, 1e-9);
  const driftToVolatility = mean / Math.max(deviation, 1e-6) * Math.sqrt(count);
  if (driftToVolatility >= 1.25 && efficiency >= 0.55) return "STRONG_BULL";
  if (driftToVolatility >= 0.35 && displacement > 0) return "WEAK_BULL";
  if (driftToVolatility <= -1.25 && efficiency >= 0.55) return "STRONG_BEAR";
  if (driftToVolatility <= -0.35 && displacement < 0) return "WEAK_BEAR";
  if (Math.abs(driftToVolatility) < 0.35 && efficiency < 0.35) return "RANGE";
  return "TRANSITION";
}

function bearishChangePoint(
  values: readonly number[],
  index: number,
  atrPercent: number,
  sensitivity: number
) {
  if (index < 8) return false;
  const returns: number[] = [];
  for (let cursor = index - 7; cursor <= index; cursor++) {
    returns.push(percentageReturn(values[cursor] ?? 0, values[cursor - 1] ?? 0));
  }
  const recent = (returns.at(-1)! + returns.at(-2)! + returns.at(-3)!) / 3;
  const baseline = returns.slice(0, 5).reduce((sum, value) => sum + value, 0) / 5;
  const sensitivityScale = 0.035 + (100 - sensitivity) * 0.001;
  const requiredShift = Math.max(0.01, atrPercent * sensitivityScale);
  return recent < -requiredShift && recent < baseline - requiredShift;
}

function bearishStructureBreak(candles: readonly Candle[], values: readonly number[], index: number) {
  if (index < 4) return false;
  const priorCloses = values.slice(index - 3, index);
  const current = values[index] ?? 0;
  const currentCandle = candles[index];
  const priorLows = candles.slice(index - 3, index).map((candle) => candle.low);
  const closedBelowStructure = current < Math.min(...priorCloses) && (currentCandle?.close ?? current) < Math.min(...priorLows);
  const priorSwingHigh = Math.max(...candles.slice(index - 4, index - 1).map((candle) => candle.high));
  const lowerHigh = (currentCandle?.high ?? current) < priorSwingHigh;
  return closedBelowStructure && lowerHigh;
}

function exactBearishFlow(input: DDAProCalculationInput, index: number) {
  const bar = input.flowBars?.[index];
  return input.flowAuthority === "EXACT_AGGRESSOR_TRADES" &&
    bar?.deliveryComplete === true &&
    bar.totalTradeCount > 0 &&
    bar.sellNotional > bar.buyNotional;
}

function trueRangePercent(candles: readonly Candle[], values: readonly number[], index: number, priceAuthority: boolean) {
  if (index <= 0) return 0;
  const prior = values[index - 1] ?? 0;
  if (prior <= 0) return 0;
  if (!priceAuthority) return Math.abs(percentageReturn(values[index] ?? prior, prior));
  const candle = candles[index];
  if (!candle) return 0;
  const range = Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - prior),
    Math.abs(candle.low - prior)
  );
  return Math.max(0, range / prior * 100);
}

/**
 * Independent causal upside engine. Downside arrays are intentionally neither
 * imported nor sign-inverted here so anchor and signal provenance stay explicit.
 */
export function calculateBCRDATopEngine(
  input: DDAProCalculationInput,
  values: readonly number[],
  barsPerYear: number
): BCRDATopEngineResult {
  const { settings, candles } = input;
  const length = Math.min(values.length, candles.length);
  const series = blankTopSeries(length);
  const episodes: BCRDATopEpisode[] = [];
  const events: DDAProEvent[] = [];
  const confirmedSignals: DDAProSignalEvent[] = [];
  if (!settings.enableMirroredTopEngine || settings.topEngineMode === "disabled" || length === 0) {
    return { series, episodes, events, candidates: [], confirmedSignals };
  }

  const trueRanges = new Array<number>(length).fill(0);
  const absoluteReturns = new Array<number>(length).fill(0);
  const percentageReturns = new Array<number>(length).fill(0);
  const logReturns = new Array<number>(length).fill(0);
  const trueRangePrefix = new Array<number>(length + 1).fill(0);
  const percentageReturnPrefix = new Array<number>(length + 1).fill(0);
  const percentageReturnSquaresPrefix = new Array<number>(length + 1).fill(0);
  const absoluteReturnPrefix = new Array<number>(length + 1).fill(0);
  const returnSumPrefix = new Array<number>(length + 1).fill(0);
  const returnSquaresPrefix = new Array<number>(length + 1).fill(0);
  const priceAuthority = settings.equitySource === "price";
  for (let index = 1; index < length; index++) {
    trueRanges[index] = trueRangePercent(candles, values, index, priceAuthority);
    percentageReturns[index] = percentageReturn(values[index] ?? 0, values[index - 1] ?? 0);
    absoluteReturns[index] = Math.abs(percentageReturns[index]!);
    logReturns[index] = (values[index - 1] ?? 0) > 0 && (values[index] ?? 0) > 0
      ? Math.log(values[index]! / values[index - 1]!)
      : 0;
    trueRangePrefix[index + 1] = trueRangePrefix[index]! + trueRanges[index]!;
    percentageReturnPrefix[index + 1] = percentageReturnPrefix[index]! + percentageReturns[index]!;
    percentageReturnSquaresPrefix[index + 1] = percentageReturnSquaresPrefix[index]! + percentageReturns[index]! * percentageReturns[index]!;
    absoluteReturnPrefix[index + 1] = absoluteReturnPrefix[index]! + absoluteReturns[index]!;
    returnSumPrefix[index + 1] = returnSumPrefix[index]! + logReturns[index]!;
    returnSquaresPrefix[index + 1] = returnSquaresPrefix[index]! + logReturns[index]! * logReturns[index]!;
  }

  let candidateTroughPrice = values[0] ?? 0;
  let candidateTroughIndex = 0;
  let active: ActiveTopEpisode | null = null;
  let topRiskState: DDAProRiskState = "INSUFFICIENT";
  let resetOnPriorBar = false;
  const returnDistribution: number[] = [];
  const drawupDistribution: number[] = [];
  let activeBarrierDistribution: number[] = [];
  let drawupDistributionSum = 0;

  for (let index = 0; index < length; index++) {
    const price = values[index] ?? 0;
    const time = candles[index]?.time ?? 0;
    const atrStart = Math.max(1, index - settings.topAtrLookback);
    const atrCount = Math.max(0, index - atrStart);
    const atrPercent = atrCount
      ? (trueRangePrefix[index]! - trueRangePrefix[atrStart]!) / atrCount
      : 0;
    const returnThreshold = quantile(returnDistribution, settings.topReturnQuantile, settings.quantileMethod);
    const minimumEntry = settings.topEpisodeMinimumThresholdPercent;
    const maximumEntry = Math.max(minimumEntry, settings.topEpisodeMaximumThresholdPercent);
    const adaptiveEntry = clamp(Math.max(
      minimumEntry,
      atrPercent * settings.topAtrMultiplier,
      returnThreshold * settings.topQuantileMultiplier
    ), minimumEntry, maximumEntry);
    series.adaptiveEntryThreshold[index] = adaptiveEntry;
    series.marketRegime[index] = marketRegime(
      values,
      index,
      percentageReturnPrefix,
      percentageReturnSquaresPrefix,
      absoluteReturnPrefix
    );

    if (resetOnPriorBar) {
      resetOnPriorBar = false;
      candidateTroughPrice = price;
      candidateTroughIndex = index;
    }

    if (!active) {
      if (price <= candidateTroughPrice || candidateTroughPrice <= 0) {
        candidateTroughPrice = price;
        candidateTroughIndex = index;
      }
      const candidateDrawup = candidateTroughPrice > 0
        ? Math.max(0, percentageReturn(price, candidateTroughPrice))
        : 0;
      series.rawDrawup[index] = candidateDrawup;
      const warmup = Math.max(settings.topAtrLookback, Math.min(settings.topReturnQuantileLookback, 50));
      if (index >= warmup && candidateDrawup >= adaptiveEntry) {
        const id = episodeIdentity(input, candles[candidateTroughIndex]?.time ?? candidateTroughIndex);
        active = {
          id,
          troughIndex: candidateTroughIndex,
          troughTime: candles[candidateTroughIndex]?.time ?? 0,
          troughPrice: candidateTroughPrice,
          startIndex: index,
          entryThresholdPercent: adaptiveEntry,
          maximumIndex: index,
          maximumTime: time,
          maximumPrice: price,
          maximumDrawupPercent: candidateDrawup,
          terminalTouches: 0,
          confirmedIndex: null,
          resetIndex: null,
          state: "EXPANDING",
          barrier: Math.max(adaptiveEntry * 1.05, candidateDrawup),
          terminalPersistence: 0,
          confirmedRequiredReversal: 0
        };
        episodes.push(active);
        activeBarrierDistribution = series.rawDrawup
          .slice(Math.max(active.troughIndex, index - settings.topReturnQuantileLookback), index)
          .sort((left, right) => left - right);
      }
    }

    if (active) {
      let state = active.state;
      if (state === "TOP_CONFIRMED") {
        state = "COOLDOWN";
        active.state = state;
      }
      const drawup = active.troughPrice > 0 ? Math.max(0, percentageReturn(price, active.troughPrice)) : 0;
      series.rawDrawup[index] = drawup;
      if (price > active.maximumPrice + Number.EPSILON) {
        active.maximumPrice = price;
        active.maximumIndex = index;
        active.maximumTime = time;
        active.maximumDrawupPercent = drawup;
      }
      const reversal = active.maximumPrice > 0
        ? Math.max(0, (active.maximumPrice - price) / active.maximumPrice * 100)
        : 0;
      const requiredReversal = Math.max(
        settings.topMinimumReversalPercent,
        atrPercent * settings.topReversalAtrMultiplier,
        returnThreshold * settings.topQuantileMultiplier
      );
      series.reversalFromEpisodeHigh[index] = reversal;
      series.requiredTopReversal[index] = requiredReversal;
      series.drawupDuration[index] = index - active.startIndex + 1;
      series.episodeId[index] = active.id;

      const p25 = quantile(activeBarrierDistribution, 0.25, settings.quantileMethod);
      const p75 = quantile(activeBarrierDistribution, 0.75, settings.quantileMethod);
      const robustDispersion = Math.max(0, (p75 - p25) / 1.349);
      const upperQuantile = quantile(activeBarrierDistribution, settings.topExtremityPercentile, settings.quantileMethod);
      const targetBarrier = Math.max(
        active.entryThresholdPercent * 1.05,
        upperQuantile + robustDispersion * settings.topBarrierDispersionMultiplier
      );
      if (state !== "TOP_BUILDING" && state !== "TOP_ARMED" && state !== "COOLDOWN") {
        const smoothedTarget = active.barrier + (targetBarrier - active.barrier) * 0.18;
        active.barrier = Math.max(active.barrier, smoothedTarget);
      }
      series.dynamicTopBarrier[index] = active.barrier;

      const maturity = index - active.startIndex + 1;
      const inTerminalZone = drawup >= active.barrier * 0.985;
      active.terminalPersistence = inTerminalZone ? active.terminalPersistence + 1 : 0;
      if (inTerminalZone && (index === active.maximumIndex || reversal > 0)) active.terminalTouches += 1;
      const recentVelocity = index ? drawup - (series.rawDrawup[index - 1] ?? drawup) : 0;
      const recentMaximumVelocity = Math.max(
        0,
        ...series.drawupVelocity.slice(Math.max(0, index - 5), index)
      );
      const weakeningProgress = reversal > 0 ||
        recentVelocity < 0 ||
        (recentMaximumVelocity > 0 && recentVelocity <= recentMaximumVelocity * 0.75);

      if (state === "EXPANDING" &&
          maturity >= settings.topMinimumMaturityBars &&
          active.maximumDrawupPercent >= active.barrier &&
          inTerminalZone) {
        state = "TOP_WATCH";
        active.state = state;
        events.push({
          id: `bc-rda-top-candidate-event-v1:${active.id}:${time}`,
          type: "BC_RDA_TOP_CANDIDATE",
          index,
          time,
          state: "HIGH",
          value: active.maximumDrawupPercent,
          confirmed: false
        });
      } else if (state === "TOP_WATCH" &&
          maturity >= settings.topMinimumMaturityBars &&
          (active.terminalPersistence >= 2 || active.terminalTouches >= 2) &&
          weakeningProgress) {
        state = "TOP_BUILDING";
        active.state = state;
      } else if (state === "TOP_BUILDING" &&
          reversal >= requiredReversal * 0.45 &&
          recentVelocity < 0 &&
          drawup < active.barrier) {
        state = "TOP_ARMED";
        active.state = state;
      } else if (state === "TOP_ARMED") {
        const structure = bearishStructureBreak(candles, values, index);
        const changePoint = bearishChangePoint(values, index, atrPercent, settings.topChangePointSensitivity);
        const priorRegime = series.marketRegime[Math.max(0, index - 1)] ?? "INSUFFICIENT";
        const strongBull = settings.strongBullProtection && priorRegime === "STRONG_BULL";
        const reversalMultiplier = strongBull ? 1.5 : 1;
        const reversalConfirmed = reversal >= requiredReversal * reversalMultiplier;
        const flowConfirmed = exactBearishFlow(input, index);
        const dataQualityValid = Number.isFinite(price) && price > 0;
        const eligible = reversalConfirmed &&
          changePoint &&
          (!settings.topStructureConfirmation || structure) &&
          (!settings.topRequireExactBearishFlow || flowConfirmed) &&
          dataQualityValid &&
          (!settings.oneShortPerTopEpisode || active.confirmedIndex === null);
        if (eligible) {
          state = "TOP_CONFIRMED";
          active.state = state;
          active.confirmedIndex = index;
          active.confirmedRequiredReversal = requiredReversal;
          const confidence = clamp(
            55 +
            Math.min(15, maturity / Math.max(1, settings.topMinimumMaturityBars) * 5) +
            Math.min(15, reversal / Math.max(requiredReversal, 1e-9) * 6) +
            (structure ? 8 : 0) +
            (changePoint ? 7 : 0) -
            (input.flowAuthority === "EXACT_AGGRESSOR_TRADES" ? 0 : 8)
          );
          const signal: DDAProSignalEvent = {
            id: signalIdentity(active.id, time),
            indicatorId: DDA_PRO_INDICATOR_ID,
            direction: "short",
            index,
            time,
            value: active.maximumDrawupPercent,
            sourceEventType: "BC_RDA_TOP_CONFIRMED",
            markerTone: "blood-red",
            classification: "confirmed",
            confidence,
            episodeId: active.id,
            reasonCodes: ["SIGNAL_CONFIRMED"],
            episodeExtremityIndex: active.maximumIndex,
            episodeExtremityTime: active.maximumTime
          };
          confirmedSignals.push(signal);
          events.push({
            id: `bc-rda-top-confirmed-event-v1:${active.id}:${time}`,
            type: "BC_RDA_TOP_CONFIRMED",
            index,
            time,
            state: "EXTREME",
            value: active.maximumDrawupPercent,
            confidence,
            confirmed: true
          });
        }
      }

      if (state === "COOLDOWN" && active.confirmedIndex !== null) {
        const cooldownComplete = index - active.confirmedIndex >= settings.topCooldownBars;
        const meaningfulReorganization = reversal >= Math.max(
          active.confirmedRequiredReversal * 1.5,
          active.entryThresholdPercent * 2
        );
        if (cooldownComplete && meaningfulReorganization) {
          active.state = "RESET";
          active.resetIndex = index;
          state = "RESET";
          active = null;
          activeBarrierDistribution = [];
          resetOnPriorBar = true;
        }
      } else if (
        active.confirmedIndex === null &&
        maturity >= settings.topMinimumMaturityBars &&
        drawup <= active.entryThresholdPercent * 0.20 &&
        reversal >= requiredReversal
      ) {
        active.state = "RESET";
        active.resetIndex = index;
        state = "RESET";
        active = null;
        activeBarrierDistribution = [];
        resetOnPriorBar = true;
      }
      series.state[index] = state;
    }

    if (!active && series.state[index] === "NEUTRAL" && resetOnPriorBar) {
      series.state[index] = "RESET";
    }

    const drawup = series.rawDrawup[index] ?? 0;
    insertSorted(drawupDistribution, drawup);
    drawupDistributionSum += drawup;
    if (index >= settings.topReturnQuantileLookback) {
      const expiredDrawup = series.rawDrawup[index - settings.topReturnQuantileLookback] ?? 0;
      removeSorted(drawupDistribution, expiredDrawup);
      drawupDistributionSum -= expiredDrawup;
    }
    const distributionMean = drawupDistributionSum / Math.max(1, drawupDistribution.length);
    const p50 = quantile(drawupDistribution, 0.50, settings.quantileMethod);
    const p75 = quantile(drawupDistribution, 0.75, settings.quantileMethod);
    const p90 = quantile(drawupDistribution, 0.90, settings.quantileMethod);
    const p95 = quantile(drawupDistribution, 0.95, settings.quantileMethod);
    const p99 = quantile(drawupDistribution, 0.99, settings.quantileMethod);
    const p25 = quantile(drawupDistribution, 0.25, settings.quantileMethod);
    const robustDeviation = Math.max((p75 - p25) / 1.349, 1e-9);
    series.drawupMean[index] = distributionMean;
    series.drawupP50[index] = p50;
    series.drawupP75[index] = p75;
    series.drawupP90[index] = p90;
    series.drawupP95[index] = p95;
    series.drawupP99[index] = p99;
    series.drawupPercentileRank[index] = sortedPercentileRank(drawupDistribution, drawup);
    series.drawupZScore[index] = (drawup - p50) / robustDeviation;
    series.distributionWidth[index] = Math.max(0, p95 - p50);
    series.tailSeverity[index] = p95 > 1e-9 ? clamp(drawup / p95 * 100) : 0;
    series.drawupDepth[index] = drawup;
    series.drawupVelocity[index] = index ? drawup - (series.drawupDepth[index - 1] ?? 0) : 0;
    series.drawupAcceleration[index] = index ? series.drawupVelocity[index]! - (series.drawupVelocity[index - 1] ?? 0) : 0;
    const aboveTrough = drawup > 1e-9;
    series.timeAboveTrough[index] = aboveTrough ? (index ? series.timeAboveTrough[index - 1]! : 0) + 1 : 0;

    const returnsStart = Math.max(1, index - settings.topReturnQuantileLookback + 1);
    const returnCount = Math.max(0, index - returnsStart + 1);
    const returnSum = returnSumPrefix[index + 1]! - returnSumPrefix[returnsStart]!;
    const squareSum = returnSquaresPrefix[index + 1]! - returnSquaresPrefix[returnsStart]!;
    const returnMean = returnCount ? returnSum / returnCount : 0;
    const returnVariance = returnCount ? Math.max(0, squareSum / returnCount - returnMean * returnMean) : 0;
    const annualizedVolatility = Math.sqrt(returnVariance) * Math.sqrt(Math.max(1, barsPerYear)) * 100;
    series.drawupVadd[index] = drawup / Math.max(annualizedVolatility, settings.vaddVolatilityFloorPercent);
    const maturityScore = clamp((series.drawupDuration[index] ?? 0) / Math.max(1, settings.topMinimumMaturityBars) * 100);
    const reversalScore = clamp(
      (series.reversalFromEpisodeHigh[index] ?? 0) /
      Math.max(series.requiredTopReversal[index] ?? settings.topMinimumReversalPercent, 1e-9) * 100
    );
    const stateScore: Record<BCRDATopEpisodeState, number> = {
      NEUTRAL: 0, EXPANDING: 25, TOP_WATCH: 55, TOP_BUILDING: 70,
      TOP_ARMED: 85, TOP_CONFIRMED: 100, COOLDOWN: 80, RESET: 10
    };
    series.topRiskScore[index] = clamp(
      series.drawupPercentileRank[index]! * 0.30 +
      series.tailSeverity[index]! * 0.25 +
      maturityScore * 0.15 +
      reversalScore * 0.15 +
      stateScore[series.state[index]!] * 0.15
    );
    const validCount = Math.min(index + 1, settings.topReturnQuantileLookback);
    if (validCount >= Math.min(50, settings.topReturnQuantileLookback)) {
      topRiskState = riskStateForScore(series.topRiskScore[index]!, topRiskState, settings);
      series.topRiskState[index] = topRiskState;
    }
    if (active) {
      insertSorted(activeBarrierDistribution, drawup);
      const expiredIndex = index - settings.topReturnQuantileLookback;
      if (expiredIndex >= active.troughIndex) {
        removeSorted(activeBarrierDistribution, series.rawDrawup[expiredIndex] ?? 0);
      }
    }
    insertSorted(returnDistribution, absoluteReturns[index] ?? 0);
    if (index >= settings.topReturnQuantileLookback) {
      removeSorted(returnDistribution, absoluteReturns[index - settings.topReturnQuantileLookback] ?? 0);
    }
  }

  series.smoothedDrawup = smoothSeries(
    series.rawDrawup,
    settings.smoothingMethod,
    settings.smoothingLength
  );

  const candidates: DDAProSignalEvent[] = [];
  const unresolved = episodes.at(-1);
  if (unresolved && unresolved.confirmedIndex === null &&
      (unresolved.state === "TOP_WATCH" || unresolved.state === "TOP_BUILDING" || unresolved.state === "TOP_ARMED")) {
    candidates.push({
      id: unresolved.id.replace("top-episode-v1", "top-provisional-v1"),
      indicatorId: DDA_PRO_INDICATOR_ID,
      direction: "short",
      index: unresolved.maximumIndex,
      time: unresolved.maximumTime,
      value: unresolved.maximumDrawupPercent,
      sourceEventType: "BC_RDA_TOP_CANDIDATE",
      markerTone: "blood-red",
      classification: "provisional",
      episodeId: unresolved.id,
      episodeExtremityIndex: unresolved.maximumIndex,
      episodeExtremityTime: unresolved.maximumTime
    });
  }

  return { series, episodes, events, candidates, confirmedSignals };
}
