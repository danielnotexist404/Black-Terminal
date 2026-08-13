import { ddaProSettingsHash, migrateDDAProSettings, resolveDDAProBarsPerYear } from "./settings.ts";
import { insertSorted, mean, removeSorted, rollingDistribution, rollingMaximum, smoothSeries } from "./statistics.ts";
import {
  blankSeries,
  buildEpisodes,
  calculationHash,
  ddaProDataHash,
  ddaProOutputHash,
  deriveEvents,
  latestFromSeries,
  performanceMetrics,
  sourceValues
} from "./engineShared.ts";
import type { DDAProCalculationInput, DDAProRiskState, DDAProSnapshot } from "./types.ts";

const clamp = (value: number, minimum = 0, maximum = 100) => Math.max(minimum, Math.min(maximum, value));

function stateForScore(score: number, previous: DDAProRiskState, hysteresis: number, moderate: number, high: number, extreme: number): DDAProRiskState {
  if (previous === "EXTREME" && score >= extreme - hysteresis) return "EXTREME";
  if (previous === "HIGH" && score >= high - hysteresis && score < extreme + hysteresis) return "HIGH";
  if (previous === "MODERATE" && score >= moderate - hysteresis && score < high + hysteresis) return "MODERATE";
  if (score >= extreme) return "EXTREME";
  if (score >= high) return "HIGH";
  if (score >= moderate) return "MODERATE";
  return "LOW";
}

function allHistoryMaximum(values: readonly number[]) {
  const result = new Array<number>(values.length).fill(0);
  let maximum = 0;
  for (let index = 0; index < values.length; index++) {
    maximum = Math.max(maximum, values[index] ?? 0);
    result[index] = maximum;
  }
  return result;
}

function rollingConditionalTailMean(values: readonly number[], thresholds: readonly number[], lookback: number) {
  const result = new Array<number>(values.length).fill(0);
  const sorted: number[] = [];
  for (let index = 0; index < values.length; index++) {
    insertSorted(sorted, values[index] ?? 0);
    if (index >= lookback) removeSorted(sorted, values[index - lookback] ?? 0);
    const threshold = thresholds[index] ?? 0;
    let lower = 0;
    let upper = sorted.length;
    while (lower < upper) {
      const middle = (lower + upper) >>> 1;
      if ((sorted[middle] ?? 0) < threshold) lower = middle + 1;
      else upper = middle;
    }
    result[index] = mean(sorted.slice(lower));
  }
  return result;
}

export function calculateDDAProNative(rawInput: DDAProCalculationInput): DDAProSnapshot {
  const settings = migrateDDAProSettings({ ...rawInput.settings, engineMode: "black-core-native" });
  const input = { ...rawInput, settings };
  const suppliedCandles = input.candles.slice(-20_000);
  const candles = suppliedCandles.filter((candle) =>
    Number.isFinite(candle.time) && Number.isFinite(candle.open) && Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) && Number.isFinite(candle.close) && candle.close > 0
  );
  for (let index = 1; index < candles.length; index++) {
    if ((candles[index]?.time ?? 0) <= (candles[index - 1]?.time ?? 0)) throw new Error("DDA_SOURCE_TIMESTAMPS_INVALID");
  }
  const sourceCompleteness = suppliedCandles.length ? candles.length / suppliedCandles.length : 0;
  const normalized = { ...input, candles };
  const source = sourceValues(normalized);
  const values = source.values;
  const length = values.length;
  const lookback = Math.max(2, Math.min(settings.lookback, length || settings.lookback));
  const series = blankSeries(length);
  const resolvedBarsPerYear = resolveDDAProBarsPerYear(settings, input.timeframeSeconds ?? 86_400);
  const peak = settings.peakMode === "rolling" ? rollingMaximum(values, lookback) : allHistoryMaximum(values);

  for (let index = 0; index < length; index++) {
    const value = values[index] ?? 0;
    const anchor = Math.max(peak[index] ?? value, Number.EPSILON);
    const drawdown = (value / anchor - 1) * 100;
    series.rawDrawdown[index] = Math.min(0, drawdown);
    series.depth[index] = Math.max(0, -drawdown);
  }
  series.smoothedDrawdown = smoothSeries(series.rawDrawdown, settings.smoothingMethod, settings.smoothingLength);

  const depthDistribution = rollingDistribution(series.depth, lookback, settings.quantileMethod, settings.zScoreMethod === "robust");
  const drawdownDistribution = rollingDistribution(series.rawDrawdown, lookback, settings.quantileMethod, false);
  const returnSumPrefix = new Array<number>(length + 1).fill(0);
  const returnSquaresPrefix = new Array<number>(length + 1).fill(0);
  for (let index = 1; index < length; index++) {
    const prior = values[index - 1] ?? 0;
    const current = values[index] ?? 0;
    const value = prior > 0 && current > 0 ? Math.log(current / prior) : 0;
    returnSumPrefix[index + 1] = returnSumPrefix[index]! + value;
    returnSquaresPrefix[index + 1] = returnSquaresPrefix[index]! + value * value;
  }

  let episodeMaximumDepth = 0;
  for (let index = 0; index < length; index++) {
    const depthPoint = depthDistribution[index]!;
    const drawdownPoint = drawdownDistribution[index]!;
    const [p05, p10, p25, p50, p75, p90, p95, p99] = depthPoint.quantiles;
    series.mean[index] = drawdownPoint.mean;
    series.sigmaUpper[index] = settings.downsideOnlySigma
      ? Math.min(0, drawdownPoint.mean + drawdownPoint.deviation * settings.sigmaMultiplier)
      : drawdownPoint.mean + drawdownPoint.deviation * settings.sigmaMultiplier;
    series.sigmaLower[index] = drawdownPoint.mean - drawdownPoint.deviation * settings.sigmaMultiplier;
    series.p05[index] = -p05;
    series.p10[index] = -p10;
    series.p25[index] = -p25;
    series.p50[index] = -p50;
    series.p75[index] = -p75;
    series.p90[index] = -p90;
    series.p95[index] = -p95;
    series.p99[index] = -p99;
    series.percentileRank[index] = depthPoint.rank;
    series.zScore[index] = depthPoint.deviation > 1e-12
      ? (series.depth[index]! - depthPoint.mean) / depthPoint.deviation
      : 0;

    const depth = series.depth[index]!;
    const underWater = depth > 1e-9;
    const priorDuration = index ? series.duration[index - 1]! : 0;
    const priorUnderWater = index ? series.timeUnderWater[index - 1]! : 0;
    series.duration[index] = depth >= settings.drawdownEpisodeThresholdPercent ? priorDuration + 1 : 0;
    series.timeUnderWater[index] = underWater ? priorUnderWater + 1 : 0;
    episodeMaximumDepth = underWater ? Math.max(episodeMaximumDepth, depth) : 0;
    series.recoveryProgress[index] = underWater && episodeMaximumDepth > 1e-12
      ? clamp((episodeMaximumDepth - depth) / episodeMaximumDepth * 100)
      : 100;
    series.velocity[index] = index ? depth - series.depth[index - 1]! : 0;
    series.acceleration[index] = index ? series.velocity[index]! - series.velocity[index - 1]! : 0;

    const returnsStart = Math.max(1, index - lookback + 1);
    const returnCount = Math.max(0, index - returnsStart + 1);
    const returnSum = returnSumPrefix[index + 1]! - returnSumPrefix[returnsStart]!;
    const squareSum = returnSquaresPrefix[index + 1]! - returnSquaresPrefix[returnsStart]!;
    const returnMean = returnCount ? returnSum / returnCount : 0;
    const returnVariance = returnCount ? Math.max(0, squareSum / returnCount - returnMean * returnMean) : 0;
    const annualizedVolatilityPercent = Math.sqrt(returnVariance) * Math.sqrt(resolvedBarsPerYear) * 100;
    series.vadd[index] = depth / Math.max(annualizedVolatilityPercent, settings.vaddVolatilityFloorPercent);
  }

  const worseningVelocity = series.velocity.map((value) => Math.max(0, value));
  const durationDistribution = rollingDistribution(series.duration, lookback, settings.quantileMethod, false);
  const velocityDistribution = rollingDistribution(worseningVelocity, lookback, settings.quantileMethod, false);
  const vaddDistribution = rollingDistribution(series.vadd, lookback, settings.quantileMethod, false);
  const cdarSeries = rollingConditionalTailMean(series.depth, depthDistribution.map((point) => point.quantiles[6]), lookback);
  const riskStates = new Array<DDAProRiskState>(length).fill("INSUFFICIENT");
  const weightTotal = Math.max(1e-12, settings.depthWeight + settings.durationWeight + settings.velocityWeight + settings.volatilityWeight + settings.tailWeight);
  let state: DDAProRiskState = "INSUFFICIENT";

  for (let index = 0; index < length; index++) {
    const depth = series.depth[index] ?? 0;
    const duration = series.duration[index] ?? 0;
    const velocity = worseningVelocity[index] ?? 0;
    const vadd = series.vadd[index] ?? 0;
    const depthComponent = depth > 0 ? depthDistribution[index]!.rank : 0;
    const durationComponent = duration > 0 ? durationDistribution[index]!.rank : 0;
    const velocityComponent = velocity > 0 ? velocityDistribution[index]!.rank : 0;
    const volatilityComponent = vadd > 0 ? vaddDistribution[index]!.rank : 0;
    const tailComponent = depth > 0 ? clamp(depth / Math.max(cdarSeries[index] ?? 0, 0.25) * 100) : 0;
    series.riskScore[index] = clamp((
      depthComponent * settings.depthWeight +
      durationComponent * settings.durationWeight +
      velocityComponent * settings.velocityWeight +
      volatilityComponent * settings.volatilityWeight +
      tailComponent * settings.tailWeight
    ) / weightTotal);
    const validCount = Math.min(index + 1, lookback);
    if (validCount >= Math.min(100, lookback)) {
      state = stateForScore(series.riskScore[index]!, state, settings.hysteresisPercent, settings.moderateThreshold, settings.highThreshold, settings.extremeThreshold);
      riskStates[index] = state;
    }
  }

  const episodes = buildEpisodes(candles, series.depth, settings.drawdownEpisodeThresholdPercent);
  const index = Math.max(0, length - 1);
  const tailStart = Math.max(0, length - lookback);
  const dar95 = depthDistribution[index]?.quantiles[6] ?? 0;
  const cdar95 = cdarSeries[index] ?? 0;
  const timeframeSeconds = input.timeframeSeconds ?? Math.max(1, (candles.at(-1)?.time ?? 0) - (candles.at(-2)?.time ?? -86_400));
  const tailValues = values.slice(tailStart);
  const tailDepth = series.depth.slice(tailStart);
  const metrics = performanceMetrics(tailValues, tailDepth, settings, timeframeSeconds, dar95, cdar95);
  const sampleConfidence = Math.min(1, length / Math.max(100, settings.lookback));
  const returnConfidence = Math.min(1, Math.max(0, length - 1) / 250);
  const episodeConfidence = Math.min(1, episodes.length / 5);
  const authorityConfidence = source.authority === "UNAVAILABLE" ? 0 : 1;
  const confidence = clamp((sampleConfidence * 0.55 + returnConfidence * 0.25 + episodeConfidence * 0.10 + authorityConfidence * 0.10) * sourceCompleteness * 100);
  series.riskState = riskStates;
  const latestState = riskStates[index] ?? "INSUFFICIENT";
  const events = deriveEvents(candles, riskStates, series.depth, episodes);
  for (let eventIndex = 1; eventIndex < length; eventIndex++) {
    const depth = series.depth[eventIndex] ?? 0;
    const priorDepth = series.depth[eventIndex - 1] ?? 0;
    const tailThreshold = depthDistribution[eventIndex]?.quantiles[5] ?? Number.POSITIVE_INFINITY;
    const priorTailThreshold = depthDistribution[eventIndex - 1]?.quantiles[5] ?? Number.POSITIVE_INFINITY;
    const time = candles[eventIndex]?.time ?? 0;
    const eventState = riskStates[eventIndex] ?? "INSUFFICIENT";
    const pushSignal = (type: import("./types.ts").DDAProEventType, value: number, suffix: string) => events.push({ id: `dda-${suffix}-${time || eventIndex}`, type, index: eventIndex, time, state: eventState, value });
    for (const [threshold, type, suffix] of [[50, "DDA_RISK_SCORE_CROSSED_50", "risk-50"], [75, "DDA_RISK_SCORE_CROSSED_75", "risk-75"], [90, "DDA_RISK_SCORE_CROSSED_90", "risk-90"]] as const) {
      if ((series.riskScore[eventIndex] ?? 0) >= threshold && (series.riskScore[eventIndex - 1] ?? 0) < threshold) pushSignal(type, series.riskScore[eventIndex] ?? 0, suffix);
    }
    for (const [quantileIndex, type, suffix] of [[5, "DDA_P90_ENTERED", "p90"], [6, "DDA_P95_ENTERED", "p95"], [7, "DDA_P99_ENTERED", "p99"]] as const) {
      const threshold = depthDistribution[eventIndex]?.quantiles[quantileIndex] ?? Number.POSITIVE_INFINITY;
      const priorThreshold = depthDistribution[eventIndex - 1]?.quantiles[quantileIndex] ?? Number.POSITIVE_INFINITY;
      if (depth > threshold && priorDepth <= priorThreshold) pushSignal(type, depth, suffix);
    }
    const durationRank = durationDistribution[eventIndex]?.rank ?? 0;
    const priorDurationRank = durationDistribution[eventIndex - 1]?.rank ?? 0;
    if (durationRank >= 90 && priorDurationRank < 90) pushSignal("DDA_DURATION_P90_EXCEEDED", series.duration[eventIndex] ?? 0, "duration-p90");
    if (durationRank >= 95 && priorDurationRank < 95) pushSignal("DDA_DURATION_P95_EXCEEDED", series.duration[eventIndex] ?? 0, "duration-p95");
    if ((vaddDistribution[eventIndex]?.rank ?? 0) >= 95 && (vaddDistribution[eventIndex - 1]?.rank ?? 0) < 95) pushSignal("DDA_VADD_EXTREME", series.vadd[eventIndex] ?? 0, "vadd");
    if ((velocityDistribution[eventIndex]?.rank ?? 0) >= 90 && (series.acceleration[eventIndex] ?? 0) > 0 && !((velocityDistribution[eventIndex - 1]?.rank ?? 0) >= 90 && (series.acceleration[eventIndex - 1] ?? 0) > 0)) pushSignal("DDA_RISK_DETERIORATION_ACCELERATED", series.acceleration[eventIndex] ?? 0, "acceleration");
    if (depth > tailThreshold && priorDepth <= priorTailThreshold) events.push({ id: "dda-tail-" + (candles[eventIndex]?.time ?? eventIndex), type: "DDA_TAIL_BAND_ENTERED", index: eventIndex, time, state: eventState, value: depth });
    if ((durationDistribution[eventIndex]?.rank ?? 0) >= 90 && (durationDistribution[eventIndex - 1]?.rank ?? 0) < 90) events.push({ id: "dda-duration-" + (candles[eventIndex]?.time ?? eventIndex), type: "DDA_DURATION_EXTREME", index: eventIndex, time: candles[eventIndex]?.time ?? 0, state: riskStates[eventIndex] ?? "INSUFFICIENT", value: series.duration[eventIndex] ?? 0 });
    if (depth > (cdarSeries[eventIndex] ?? Number.POSITIVE_INFINITY) && priorDepth <= (cdarSeries[eventIndex - 1] ?? Number.POSITIVE_INFINITY)) events.push({ id: "dda-cdar-" + (candles[eventIndex]?.time ?? eventIndex), type: "DDA_CDAR_BREACHED", index: eventIndex, time: candles[eventIndex]?.time ?? 0, state: riskStates[eventIndex] ?? "INSUFFICIENT", value: depth });
  }
  if (confidence < 50 && length) events.push({ id: "dda-confidence-" + (candles[index]?.time ?? index), type: "DDA_CONFIDENCE_DEGRADED", index, time: candles[index]?.time ?? 0, state: latestState, value: confidence });
  for (const event of events) Object.assign(event, { engineMode: "black-core-native", sourceAuthority: source.authority, lookback, riskScore: series.riskScore[event.index] ?? 0, confidence, drawdownPercent: series.rawDrawdown[event.index] ?? 0 });
  const dataHash = ddaProDataHash(normalized);
  const settingsHash = ddaProSettingsHash(settings);
  const latest = latestFromSeries(series, latestState, confidence, metrics, Math.max(...tailDepth, 0));

  return {
    schemaVersion: 1,
    engineMode: "black-core-native",
    calculationHash: calculationHash(normalized, "black-core-native", dataHash),
    engineVersion: "BC_DDA_NATIVE_V1",
    dataHash,
    settingsHash,
    outputHash: ddaProOutputHash(series, latest),
    calculatedAt: Date.now(),
    inputSize: length,
    validFromIndex: Math.min(length, Math.min(100, lookback) - 1),
    barsPerYear: metrics.barsPerYear,
    sourceAuthority: source.authority,
    sourceWarning: [source.warning, suppliedCandles.length !== candles.length ? (suppliedCandles.length - candles.length) + " malformed source bar(s) were excluded; confidence was reduced." : null].filter(Boolean).join(" ") || null,
    series,
    episodes,
    events,
    latest
  };
}
