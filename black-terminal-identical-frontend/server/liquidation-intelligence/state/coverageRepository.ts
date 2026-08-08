import type {
  BclifCoverageInterval,
  BclifCoverageSourceName,
  BclifPersistentCoverage,
  BclifTileHorizon,
  BclifWriterFence
} from "../contracts.ts";
import { validateWriterFence, writerFenceColumns } from "./writerFence.ts";

export type BclifCoverageSource = BclifCoverageSourceName;
export interface BclifObservedInterval extends BclifCoverageInterval {}

const SOURCES: BclifCoverageSource[] = ["TRADE", "LIQUIDATION", "OPEN_INTEREST", "BOOK_FRAME", "FUNDING"];
export const BCLIF_MAX_COVERAGE_INTERVALS_PER_SOURCE = 8_192;

/**
 * Tracks source continuity intervals, not event frequency. In particular, an
 * empty-but-connected liquidation stream is valid coverage while a carried
 * forward stale OI sample is not silently counted as observed history.
 */
export class BclifCoverageTracker {
  private readonly intervals = new Map<BclifCoverageSource, BclifObservedInterval[]>();
  private retainedLedgerStart: number | null = null;

  record(source: BclifCoverageSource, start: number, end: number) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("Invalid BCLIF coverage interval");
    const existing = this.intervals.get(source) || [];
    const merged = mergeIntervals([...existing, { start, end }]);
    const bounded = merged.slice(-BCLIF_MAX_COVERAGE_INTERVALS_PER_SOURCE);
    if (merged.length > bounded.length) this.advanceRetainedLedgerStart(bounded[0]!.start);
    this.intervals.set(source, bounded);
  }

  replace(source: BclifCoverageSource, intervals: readonly BclifObservedInterval[]) {
    const merged = mergeIntervals(intervals.map((value) => ({ ...value })));
    const bounded = merged.slice(-BCLIF_MAX_COVERAGE_INTERVALS_PER_SOURCE);
    // A checkpoint with a source at the exact cap cannot prove that an older
    // prefix never existed. Treat its first retained interval as the
    // conservative evidence floor rather than relabeling an evicted prefix.
    if (merged.length >= BCLIF_MAX_COVERAGE_INTERVALS_PER_SOURCE) this.advanceRetainedLedgerStart(bounded[0]!.start);
    this.intervals.set(source, bounded);
  }

  snapshot() {
    return Object.fromEntries(SOURCES.map((source) => [
      source,
      (this.intervals.get(source) || []).slice(-BCLIF_MAX_COVERAGE_INTERVALS_PER_SOURCE).map((interval) => ({ ...interval }))
    ])) as Record<BclifCoverageSource, BclifObservedInterval[]>;
  }

  earliestObservedAt() {
    const starts = [...this.intervals.values()].flat().map((interval) => interval.start);
    if (!starts.length) return null;
    return Math.max(Math.min(...starts), this.retainedLedgerStart ?? Number.NEGATIVE_INFINITY);
  }

  restore(snapshot: Partial<Record<BclifCoverageSource, readonly BclifObservedInterval[]>>) {
    this.intervals.clear();
    this.retainedLedgerStart = null;
    for (const source of SOURCES) this.replace(source, snapshot[source] || []);
  }

  calculate(input: {
    venue: "BYBIT";
    symbol: string;
    horizon: BclifTileHorizon;
    requestedStart: number;
    requestedEnd: number;
    sourceCutoffTimestamp?: number | null;
  }): BclifPersistentCoverage {
    const start = Math.max(input.requestedStart, this.retainedLedgerStart ?? Number.NEGATIVE_INFINITY);
    const end = input.requestedEnd;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("Invalid BCLIF requested coverage range");
    const cutoff = input.sourceCutoffTimestamp ?? null;
    if (cutoff !== null && (!Number.isFinite(cutoff) || cutoff < start || cutoff > end)) {
      throw new Error("BCLIF coverage cutoff is outside the retained evidence range");
    }
    const requestedIntervals = Object.fromEntries(SOURCES.map((source) => [
      source,
      clipped(this.intervals.get(source) || [], start, end)
    ])) as Record<BclifCoverageSource, BclifObservedInterval[]>;
    if (cutoff !== null && SOURCES.some((source) => requestedIntervals[source].some((interval) => interval.end > cutoff))) {
      throw new Error("BCLIF coverage source interval exceeds its causal cutoff");
    }
    const evidenceEnd = cutoff ?? end;
    const evidenceDuration = evidenceEnd - start;
    const fullWindowKnown = evidenceEnd === end;
    const observedBySource = Object.fromEntries(SOURCES.map((source) => [
      source,
      clipped(requestedIntervals[source], start, evidenceEnd)
    ])) as Record<BclifCoverageSource, BclifObservedInterval[]>;
    const hasEvidenceDomain = SOURCES.some((source) => observedBySource[source].length > 0);
    const percentages = new Map<BclifCoverageSource, number | null>();
    for (const source of SOURCES) {
      const observed = observedBySource[source];
      percentages.set(source, evidenceDuration > 0 && observed.length
        ? roundPercent(duration(observed) / evidenceDuration * 100)
        : evidenceDuration > 0 && hasEvidenceDomain ? 0 : null);
    }
    const boundaries = new Set<number>([start, evidenceEnd]);
    for (const source of SOURCES) for (const interval of observedBySource[source]) {
      boundaries.add(interval.start);
      boundaries.add(interval.end);
    }
    const sorted = [...boundaries].sort((a, b) => a - b);
    const gaps = [] as BclifPersistentCoverage["gaps"];
    const validModelIntervals: BclifObservedInterval[] = [];
    // OI is the hard state-formation input. Trades, books and confirmed
    // liquidation transport improve inference/calibration but their outage
    // must not erase already formed exposure state.
    const required: BclifCoverageSource[] = ["OPEN_INTEREST"];
    for (let index = 1; index < sorted.length; index += 1) {
      const segment = { start: sorted[index - 1]!, end: sorted[index]! };
      if (segment.end <= segment.start) continue;
      const midpoint = segment.start + (segment.end - segment.start) / 2;
      const missingSources = SOURCES.filter((source) => !contains(observedBySource[source], midpoint));
      if (missingSources.length) appendGap(gaps, segment, missingSources);
      if (!required.some((source) => missingSources.includes(source))) validModelIntervals.push(segment);
    }
    const continuityPercent = validModelIntervals.length
      ? roundPercent(duration(validModelIntervals) / evidenceDuration * 100)
      : evidenceDuration > 0 && hasEvidenceDomain ? 0 : null;
    if (!fullWindowKnown) appendGap(gaps, { start: evidenceEnd, end }, SOURCES.map((source) => `${source}_COVERAGE_UNKNOWN`));
    const nonNull = [...percentages.values()].filter((value): value is number => value !== null);
    const quality = fullWindowKnown ? coverageQuality(continuityPercent, percentages) : "INSUFFICIENT";
    const calculated: BclifPersistentCoverage = {
      venue: input.venue,
      symbol: input.symbol,
      horizon: input.horizon,
      requestedStart: start,
      requestedEnd: end,
      modelStart: validModelIntervals[0]?.start ?? null,
      modelEnd: validModelIntervals.at(-1)?.end ?? null,
      openInterestCoveragePercent: fullWindowKnown ? percentages.get("OPEN_INTEREST") ?? null : null,
      tradeCoveragePercent: fullWindowKnown ? percentages.get("TRADE") ?? null : null,
      liquidationCoveragePercent: fullWindowKnown ? percentages.get("LIQUIDATION") ?? null : null,
      orderbookCoveragePercent: fullWindowKnown ? percentages.get("BOOK_FRAME") ?? null : null,
      fundingCoveragePercent: fullWindowKnown ? percentages.get("FUNDING") ?? null : null,
      continuityPercent: fullWindowKnown ? continuityPercent : null,
      sourceMode: nonNull.length ? "PERSISTENT_COLLECTOR" : "UNAVAILABLE",
      modelAuthority: nonNull.length ? "PERSISTENT_NODE" : "BROWSER_FALLBACK",
      sourceCutoffTimestamp: input.sourceCutoffTimestamp ?? null,
      quality,
      gaps: conservativelyBoundGaps(gaps, 1_024),
      sourceIntervals: observedBySource
    };
    assertBclifCoverageCutoffCoherent(calculated);
    return calculated;
  }

  private advanceRetainedLedgerStart(start: number) {
    this.retainedLedgerStart = Math.max(this.retainedLedgerStart ?? Number.NEGATIVE_INFINITY, start);
  }
}

export class BclifCoverageRepository {
  private readonly supabase: any;
  private readonly sourceId: string;
  private readonly fence: BclifWriterFence;
  constructor(supabase: any, sourceId: string, fence: BclifWriterFence) { this.supabase = supabase; this.sourceId = sourceId; this.fence = validateWriterFence(fence); }

  async upsert(coverage: BclifPersistentCoverage) {
    if (coverage.sourceCutoffTimestamp !== null && coverage.modelEnd !== null && coverage.sourceCutoffTimestamp < coverage.modelEnd) {
      throw new Error("BCLIF coverage cutoff precedes the modeled interval");
    }
    const bounded = boundSourceIntervals(
      coverage.sourceIntervals,
      BCLIF_MAX_COVERAGE_INTERVALS_PER_SOURCE,
      coverage.requestedStart,
      coverage.requestedEnd
    );
    const tracker = new BclifCoverageTracker();
    tracker.restore(bounded.intervals);
    const persistedCoverage = tracker.calculate({
      venue: coverage.venue,
      symbol: coverage.symbol,
      horizon: coverage.horizon,
      requestedStart: bounded.ledgerStart,
      requestedEnd: coverage.requestedEnd,
      sourceCutoffTimestamp: coverage.sourceCutoffTimestamp
    });
    assertBclifCoverageCutoffCoherent(persistedCoverage);
    const row = {
      source_id: this.sourceId,
      horizon: persistedCoverage.horizon,
      requested_start: iso(persistedCoverage.requestedStart),
      requested_end: iso(persistedCoverage.requestedEnd),
      available_start: isoOrNull(persistedCoverage.modelStart),
      available_end: isoOrNull(persistedCoverage.modelEnd),
      model_start: isoOrNull(persistedCoverage.modelStart),
      model_end: isoOrNull(persistedCoverage.modelEnd),
      trade_coverage_percent: persistedCoverage.tradeCoveragePercent,
      open_interest_coverage_percent: persistedCoverage.openInterestCoveragePercent,
      liquidation_coverage_percent: persistedCoverage.liquidationCoveragePercent,
      orderbook_coverage_percent: persistedCoverage.orderbookCoveragePercent,
      funding_coverage_percent: persistedCoverage.fundingCoveragePercent,
      model_continuity_percent: persistedCoverage.continuityPercent,
      missing_intervals: persistedCoverage.gaps,
      source_intervals: persistedCoverage.sourceIntervals,
      quality: persistedCoverage.quality,
      source_mode: persistedCoverage.sourceMode,
      model_authority: persistedCoverage.modelAuthority,
      source_cutoff_at: isoOrNull(persistedCoverage.sourceCutoffTimestamp),
      coverage_version: 2,
      updated_at: new Date().toISOString(),
      ...writerFenceColumns(this.fence)
    };
    const result = await this.supabase.from("bclif_coverage").upsert(row, { onConflict: "source_id,horizon" });
    if (result.error) throw result.error;
  }
}

export function assertBclifCoverageCutoffCoherent(coverage: Pick<
  BclifPersistentCoverage,
  "requestedStart" | "requestedEnd" | "modelEnd" | "sourceCutoffTimestamp" | "sourceIntervals"
>) {
  const cutoff = coverage.sourceCutoffTimestamp;
  if (cutoff === null) return;
  if (!Number.isFinite(cutoff) || cutoff < coverage.requestedStart || cutoff > coverage.requestedEnd) {
    throw new Error("BCLIF coverage cutoff is outside the retained evidence range");
  }
  if (coverage.modelEnd !== null && cutoff < coverage.modelEnd) {
    throw new Error("BCLIF coverage cutoff precedes the recomputed model interval");
  }
  for (const intervals of Object.values(coverage.sourceIntervals)) {
    if (intervals.some((interval) => interval.end > cutoff)) {
      throw new Error("BCLIF coverage source interval exceeds its causal cutoff");
    }
  }
}

function mergeIntervals(source: readonly BclifObservedInterval[]) {
  const ordered = source
    .filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end > interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const output: BclifObservedInterval[] = [];
  for (const interval of ordered) {
    const previous = output.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else output.push({ ...interval });
  }
  return output;
}

function clipped(source: readonly BclifObservedInterval[], start: number, end: number) {
  return mergeIntervals(source.map((interval) => ({ start: Math.max(start, interval.start), end: Math.min(end, interval.end) })));
}
function duration(source: readonly BclifObservedInterval[]) { return source.reduce((sum, interval) => sum + Math.max(0, interval.end - interval.start), 0); }
function contains(source: readonly BclifObservedInterval[], timestamp: number) { return source.some((interval) => timestamp >= interval.start && timestamp < interval.end); }
function roundPercent(value: number) { return Math.round(Math.max(0, Math.min(100, value)) * 1_000) / 1_000; }
function appendGap(gaps: BclifPersistentCoverage["gaps"], segment: BclifObservedInterval, missingSources: string[]) {
  const previous = gaps.at(-1);
  if (previous && previous.end === segment.start && previous.missingSources.join("|") === missingSources.join("|")) previous.end = segment.end;
  else gaps.push({ ...segment, missingSources });
}
function conservativelyBoundGaps(gaps: BclifPersistentCoverage["gaps"], maximum: number) {
  if (gaps.length <= maximum) return gaps;
  const groupSize = Math.ceil(gaps.length / maximum);
  const output: BclifPersistentCoverage["gaps"] = [];
  for (let index = 0; index < gaps.length; index += groupSize) {
    const group = gaps.slice(index, index + groupSize);
    output.push({
      start: group[0]!.start,
      end: group.at(-1)!.end,
      missingSources: [...new Set(group.flatMap((gap) => gap.missingSources))].sort()
    });
  }
  return output;
}
function boundSourceIntervals(
  intervals: Record<BclifCoverageSourceName, BclifCoverageInterval[]>,
  maximumPerSource: number,
  requestedStart: number,
  requestedEnd: number
) {
  const normalized = Object.fromEntries(SOURCES.map((source) => [
    source,
    clipped(intervals[source] || [], requestedStart, requestedEnd)
  ])) as Record<BclifCoverageSourceName, BclifCoverageInterval[]>;
  const truncatedSources = SOURCES.filter((source) => normalized[source].length > maximumPerSource);
  const retained = Object.fromEntries(SOURCES.map((source) => [
    source,
    normalized[source].slice(-maximumPerSource)
  ])) as Record<BclifCoverageSourceName, BclifCoverageInterval[]>;
  const retainedStarts = truncatedSources
    .map((source) => retained[source][0]?.start)
    .filter((value): value is number => typeof value === "number");
  const ledgerStart = retainedStarts.length
    ? Math.max(requestedStart, ...retainedStarts)
    : requestedStart;
  return {
    ledgerStart,
    intervals: Object.fromEntries(SOURCES.map((source) => [
      source,
      clipped(retained[source], ledgerStart, requestedEnd)
    ])) as Record<BclifCoverageSourceName, BclifCoverageInterval[]>
  };
}
function coverageQuality(continuity: number | null, values: Map<BclifCoverageSource, number | null>): BclifPersistentCoverage["quality"] {
  if (continuity === null) return "INSUFFICIENT";
  const openInterest = values.get("OPEN_INTEREST");
  if (openInterest == null || continuity <= 0) return "INSUFFICIENT";
  const secondaryWeights: Array<[BclifCoverageSource, number]> = [
    ["TRADE", 0.35],
    ["BOOK_FRAME", 0.25],
    ["LIQUIDATION", 0.25],
    ["FUNDING", 0.15]
  ];
  const secondaryScore = secondaryWeights.reduce((sum, [source, weight]) => sum + (values.get(source) ?? 0) * weight, 0);
  const minimumSecondary = Math.min(...secondaryWeights.map(([source]) => values.get(source) ?? 0));
  if (continuity >= 99.5 && openInterest >= 99.5 && minimumSecondary >= 95) return "EXCELLENT";
  if (continuity >= 95 && openInterest >= 95 && secondaryScore >= 80 && minimumSecondary >= 50) return "HIGH";
  if (continuity >= 75 && openInterest >= 75 && secondaryScore >= 35) return "MIXED";
  if (continuity > 0) return "LOW";
  return "INSUFFICIENT";
}
function iso(value: number) { return new Date(value).toISOString(); }
function isoOrNull(value: number | null) { return value === null ? null : iso(value); }
