import { ddaProSettingsHash, migrateDDAProSettings } from "./settings.ts";
import { rollingDistribution, rollingMinimum, smoothSeries, mean } from "./statistics.ts";
import {
  blankSeries,
  buildEpisodes,
  calculationHash,
  ddaProDataHash,
  ddaProOutputHash,
  deriveCausalDDAProSignalCandidates,
  deriveDDAProSignals,
  deriveEvents,
  latestFromSeries,
  performanceMetrics,
  sourceValues
} from "./engineShared.ts";
import type { DDAProCalculationInput, DDAProRiskState, DDAProSnapshot } from "./types.ts";
import { applyDDAProSignalIntelligence } from "./signalIntelligence.ts";
import { calculateDDAProFlowPressure } from "./flowPressure.ts";
import { calculateBCRDATopEngine } from "./topEngine.ts";

export function calculateDDAProCompatibility(rawInput: DDAProCalculationInput): DDAProSnapshot {
  const settings = migrateDDAProSettings({
    ...rawInput.settings,
    engineMode: "pine-compatibility",
    smoothingMethod: "ema",
    quantileMethod: "nearest-rank",
    annualizationMode: "traditional-252"
  });
  const candles = rawInput.candles.slice(-20_000);
  const input = { ...rawInput, candles, settings };
  const source = sourceValues(input);
  const values = source.values;
  const length = values.length;
  const lookback = Math.max(2, Math.min(settings.lookback, Math.max(2, length)));
  const series = blankSeries(length);
  let runningPeak = 0;
  for (let index = 0; index < length; index++) {
    runningPeak = Math.max(runningPeak, values[index] ?? 0);
    series.rawDrawdown[index] = runningPeak > 0 ? ((values[index]! - runningPeak) / runningPeak) * 100 : 0;
    series.depth[index] = Math.max(0, -series.rawDrawdown[index]!);
  }
  series.smoothedDrawdown = smoothSeries(series.rawDrawdown, "ema", settings.smoothingLength);
  const distribution = rollingDistribution(series.smoothedDrawdown, lookback, "nearest-rank", false);
  const rollingLow = rollingMinimum(values, lookback);
  const returns = new Array<number>(length).fill(0);
  const returnSumPrefix = new Array<number>(length + 1).fill(0);
  const returnSquaresPrefix = new Array<number>(length + 1).fill(0);
  for (let index = 1; index < length; index++) {
    returns[index] = (values[index - 1] ?? 0) > 0 && (values[index] ?? 0) > 0
      ? Math.log(values[index]! / values[index - 1]!)
      : 0;
    returnSumPrefix[index + 1] = returnSumPrefix[index]! + returns[index]!;
    returnSquaresPrefix[index + 1] = returnSquaresPrefix[index]! + returns[index]! * returns[index]!;
  }
  const riskStates = new Array<DDAProRiskState>(length).fill("INSUFFICIENT");
  let duration = 0;
  let inDrawdown = false;
  for (let index = 0; index < length; index++) {
    const point = distribution[index]!;
    const [p05, p10, p25, p50, p75, p90, p95, p99] = point.quantiles;
    series.mean[index] = point.mean;
    series.sigmaUpper[index] = point.mean + point.deviation;
    series.sigmaLower[index] = point.mean - point.deviation;
    series.p05[index] = p05; series.p10[index] = p10; series.p25[index] = p25; series.p50[index] = p50;
    series.p75[index] = p75; series.p90[index] = p90; series.p95[index] = p95; series.p99[index] = p99;
    series.percentileRank[index] = point.rank;
    series.zScore[index] = point.deviation > 1e-12 ? (series.smoothedDrawdown[index]! - point.mean) / point.deviation : 0;
    if (index < lookback) {
      series.mean[index] = Number.NaN;
      series.sigmaUpper[index] = Number.NaN;
      series.sigmaLower[index] = Number.NaN;
      series.p05[index] = Number.NaN; series.p10[index] = Number.NaN; series.p25[index] = Number.NaN; series.p50[index] = Number.NaN;
      series.p75[index] = Number.NaN; series.p90[index] = Number.NaN; series.p95[index] = Number.NaN; series.p99[index] = Number.NaN;
      series.percentileRank[index] = Number.NaN;
      series.zScore[index] = Number.NaN;
    }
    if (index >= lookback) {
      const rank = series.percentileRank[index]!;
      riskStates[index] = rank >= 50 ? "LOW" : rank >= 25 ? "MODERATE" : rank >= 10 ? "HIGH" : "EXTREME";
    }
    const drawdownActive = index >= lookback && series.smoothedDrawdown[index]! < -1;
    if (drawdownActive) {
      duration = inDrawdown ? duration + 1 : 1;
      inDrawdown = true;
    } else {
      inDrawdown = false;
    }
    series.duration[index] = duration;
    series.timeUnderWater[index] = series.depth[index]! > 0 ? (index ? series.timeUnderWater[index - 1]! : 0) + 1 : 0;
    const low = rollingLow[index] ?? 0;
    series.recoveryProgress[index] = low > 0 ? ((values[index]! - low) / low) * 100 : 0;
    series.velocity[index] = index ? series.smoothedDrawdown[index]! - series.smoothedDrawdown[index - 1]! : 0;
    series.acceleration[index] = index ? series.velocity[index]! - series.velocity[index - 1]! : 0;
    const returnStart = Math.max(1, index - lookback + 1);
    const returnCount = Math.max(1, index - returnStart + 1);
    const returnSum = returnSumPrefix[index + 1]! - returnSumPrefix[returnStart]!;
    const returnSquareSum = returnSquaresPrefix[index + 1]! - returnSquaresPrefix[returnStart]!;
    const returnMean = returnSum / returnCount;
    const volatility = Math.sqrt(Math.max(0, returnSquareSum / returnCount - returnMean * returnMean)) * Math.sqrt(252) * 100;
    series.vadd[index] = volatility > 1e-12 ? series.smoothedDrawdown[index]! / (volatility / 20) : series.smoothedDrawdown[index]!;
    const annualizedReturn = returnMean * 252 * 100;
    const sharpe = volatility > 1e-12 ? (annualizedReturn - settings.riskFreeRatePercent) / volatility : 0;
    series.riskScore[index] = index >= lookback ? Math.max(0, Math.min(100, (sharpe * 10 + point.rank) / 2)) : 0;
  }
  const episodes = buildEpisodes(candles, series.depth, 1);
  const index = Math.max(0, length - 1);
  const tailStart = Math.max(0, length - lookback);
  const tail = series.smoothedDrawdown.slice(tailStart).sort((left, right) => left - right);
  const dar95 = Math.abs(distribution[index]?.quantiles[0] ?? 0);
  const cdarValues = tail.filter((value) => value <= -dar95);
  const cdar95 = Math.abs(mean(cdarValues));
  const metrics = performanceMetrics(values.slice(tailStart), series.depth.slice(tailStart), settings, rawInput.timeframeSeconds ?? 86_400, dar95, cdar95);
  const confidence = Math.max(0, Math.min(100, length / settings.lookback * 100));
  series.riskState = riskStates;
  const flow = calculateDDAProFlowPressure(input, series);
  const latestState = riskStates[index] ?? "INSUFFICIENT";
  const events = deriveEvents(candles, riskStates, series.depth, episodes);
  const topResult = calculateBCRDATopEngine(input, values, metrics.barsPerYear);
  events.push(...topResult.events);
  for (const event of events) Object.assign(event, { engineMode: "pine-compatibility", sourceAuthority: source.authority, lookback, riskScore: series.riskScore[event.index] ?? 0, confidence, drawdownPercent: series.rawDrawdown[event.index] ?? 0 });
  const bottomSignals = deriveDDAProSignals(events);
  const rawSignals = [...bottomSignals, ...topResult.confirmedSignals].sort((left, right) => left.index - right.index || left.direction.localeCompare(right.direction));
  const intelligenceCandidates = settings.signalIntelligenceMode === "RAW"
    ? rawSignals
    : deriveCausalDDAProSignalCandidates(candles, series.depth, settings.drawdownEpisodeThresholdPercent);
  const intelligenceResult = applyDDAProSignalIntelligence(input, series, intelligenceCandidates);
  const signals = settings.signalIntelligenceMode === "RAW"
    ? intelligenceResult.signals
    : [...intelligenceResult.signals, ...topResult.confirmedSignals].sort((left, right) => left.index - right.index || left.direction.localeCompare(right.direction));
  const dataHash = ddaProDataHash(input);
  const settingsHash = ddaProSettingsHash(settings);
  const latest = latestFromSeries(series, latestState, confidence, metrics);
  return {
    schemaVersion: 1,
    engineMode: "pine-compatibility",
    calculationHash: calculationHash(input, "pine-compatibility", dataHash),
    engineVersion: "DDA_PINE_COMPAT_V1+BC_RDA_MIRRORED_TOP_V1",
    dataHash,
    settingsHash,
    outputHash: ddaProOutputHash(series, latest, topResult.series, signals),
    calculatedAt: Date.now(),
    inputSize: length,
    validFromIndex: Math.min(length, lookback),
    barsPerYear: 252,
    sourceAuthority: source.authority,
    sourceWarning: source.warning,
    flowAuthority: flow.authority,
    flowWarning: flow.warning,
    series,
    topSeries: topResult.series,
    episodes,
    topEpisodes: topResult.episodes,
    events,
    topCandidates: topResult.candidates,
    rawSignals,
    signals,
    signalIntelligence: intelligenceResult.intelligence,
    latest
  };
}
