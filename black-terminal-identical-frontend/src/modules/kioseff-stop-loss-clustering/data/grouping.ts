import type { Timeframe } from "../../../market-data/types";
import { candleSourceVersion } from "./normalization.ts";
import { validateLowerTimeframe } from "./timeframes.ts";
import type {
  IntrabarQualityReport,
  KioseffChartBarInput,
  NormalizedCandle
} from "./types.ts";

export type GroupIntrabarOptions = {
  chartTimeframe: Timeframe;
  lowerTimeframe: Timeframe;
  now: number;
  sourceMismatch?: boolean;
  duplicateTimes?: number[];
  outOfOrderTimes?: number[];
  conflictingTimes?: number[];
};

export function groupKioseffIntrabars(
  chartCandles: readonly NormalizedCandle[],
  intrabars: readonly NormalizedCandle[],
  options: GroupIntrabarOptions
): KioseffChartBarInput[] {
  const { chartSeconds, lowerSeconds } = validateLowerTimeframe(
    options.chartTimeframe,
    options.lowerTimeframe
  );
  const byBucket = new Map<number, NormalizedCandle[]>();
  for (const intrabar of intrabars) {
    const bucket = Math.floor(intrabar.time / chartSeconds) * chartSeconds;
    const grouped = byBucket.get(bucket);
    if (grouped) grouped.push(intrabar);
    else byBucket.set(bucket, [intrabar]);
  }

  return chartCandles.map((chartBar) => {
    const bucketEnd = chartBar.time + chartSeconds;
    const chartBarClosed = options.now >= bucketEnd;
    const coverageEnd = chartBarClosed
      ? bucketEnd
      : Math.max(chartBar.time, Math.min(bucketEnd, Math.floor(options.now / lowerSeconds) * lowerSeconds));
    const grouped = (byBucket.get(chartBar.time) ?? [])
      .filter((candle) => candle.time >= chartBar.time && candle.time < bucketEnd)
      .sort((left, right) => left.time - right.time);
    const expectedTimes: number[] = [];
    for (let time = chartBar.time; time < coverageEnd; time += lowerSeconds) expectedTimes.push(time);
    const present = new Set(grouped.map((candle) => candle.time));
    const missingTimes = expectedTimes.filter((time) => !present.has(time));
    const duplicateTimes = within(options.duplicateTimes, chartBar.time, bucketEnd);
    const outOfOrderTimes = within(options.outOfOrderTimes, chartBar.time, bucketEnd);
    const conflictingTimes = within(options.conflictingTimes, chartBar.time, bucketEnd);
    const flags = [
      ...(options.sourceMismatch ? ["source-history-live-mismatch" as const] : []),
      ...(missingTimes.length > 0 ? ["incomplete-intrabar-coverage" as const] : [])
    ];
    const quality: IntrabarQualityReport = {
      complete: flags.length === 0 && conflictingTimes.length === 0,
      partial: !chartBarClosed,
      expectedIntervalSeconds: lowerSeconds,
      expectedCount: expectedTimes.length,
      actualCount: grouped.length,
      coverageStart: grouped[0]?.time ?? null,
      coverageEnd: grouped.at(-1)?.time ?? null,
      missingTimes,
      duplicateTimes,
      outOfOrderTimes,
      conflictingTimes,
      sourceMismatch: Boolean(options.sourceMismatch),
      flags,
      notes: [
        ...(duplicateTimes.length ? ["Duplicate timestamps were deterministically deduplicated."] : []),
        ...(outOfOrderTimes.length ? ["Out-of-order input was detected and chronologically sorted."] : []),
        ...(conflictingTimes.length ? ["Conflicting revisions used the latest supplied record."] : [])
      ]
    };
    return {
      chartBar,
      intrabars: grouped,
      chartBarClosed,
      sourceVersion: candleSourceVersion(grouped, `${chartBar.time}:${options.lowerTimeframe}`),
      quality
    };
  });
}

function within(values: number[] | undefined, start: number, end: number) {
  return (values ?? []).filter((time) => time >= start && time < end);
}

export function aggregateKioseffQuality(chartBars: readonly KioseffChartBarInput[]): IntrabarQualityReport {
  const missingTimes = unique(chartBars.flatMap((bar) => bar.quality.missingTimes));
  const duplicateTimes = unique(chartBars.flatMap((bar) => bar.quality.duplicateTimes));
  const outOfOrderTimes = unique(chartBars.flatMap((bar) => bar.quality.outOfOrderTimes));
  const conflictingTimes = unique(chartBars.flatMap((bar) => bar.quality.conflictingTimes));
  const flags = [...new Set(chartBars.flatMap((bar) => bar.quality.flags))];
  const actual = chartBars.reduce((sum, bar) => sum + bar.quality.actualCount, 0);
  const expected = chartBars.reduce((sum, bar) => sum + bar.quality.expectedCount, 0);
  const times = chartBars.flatMap((bar) => bar.intrabars.map((candle) => candle.time));
  return {
    complete: chartBars.every((bar) => bar.quality.complete),
    partial: chartBars.some((bar) => bar.quality.partial),
    expectedIntervalSeconds: chartBars[0]?.quality.expectedIntervalSeconds ?? 0,
    expectedCount: expected,
    actualCount: actual,
    coverageStart: times.length ? Math.min(...times) : null,
    coverageEnd: times.length ? Math.max(...times) : null,
    missingTimes,
    duplicateTimes,
    outOfOrderTimes,
    conflictingTimes,
    sourceMismatch: chartBars.some((bar) => bar.quality.sourceMismatch),
    flags,
    notes: [...new Set(chartBars.flatMap((bar) => bar.quality.notes))]
  };
}

function unique(values: number[]) {
  return [...new Set(values)].sort((left, right) => left - right);
}
