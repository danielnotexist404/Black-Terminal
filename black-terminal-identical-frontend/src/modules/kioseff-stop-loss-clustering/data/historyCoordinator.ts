import type { Candle } from "../../../chart-engine/types";
import { requireSymbolMetadata } from "../../../market-data/symbolMetadata.ts";
import type {
  MarketDataAdapter,
  MarketSymbol,
  Timeframe
} from "../../../market-data/types";
import { KioseffHistoryCache } from "./cache.ts";
import {
  aggregateIntrabarCoverage,
  aggregateKioseffQuality,
  groupKioseffIntrabars
} from "./grouping.ts";
import {
  candleSourceVersion,
  normalizeKioseffCandles,
  stableSourceVersion
} from "./normalization.ts";
import { kioseffTimeframeSeconds, validateLowerTimeframe } from "./timeframes.ts";
import {
  KioseffDataUnavailableError,
  type KioseffHistoryProgress,
  type KioseffHistoryResult,
  type KioseffRequestRange,
  type KioseffSourceProvenance,
  type NormalizedCandle
} from "./types.ts";

export type KioseffHistoryRequest = {
  adapter: MarketDataAdapter;
  symbol: MarketSymbol;
  chartCandles: Candle[];
  chartTimeframe: Timeframe;
  lowerTimeframe: Timeframe;
  transport: KioseffSourceProvenance["transport"];
  now?: number;
  signal?: AbortSignal;
  onProgress?: (progress: KioseffHistoryProgress) => void;
  onWarmup?: (result: KioseffHistoryResult) => void | Promise<void>;
};

const KIOSEFF_HISTORY_PAGE_TIMEOUT_MS = 20_000;
const KIOSEFF_HISTORY_CONCURRENCY = 6;

export function shouldRefreshKioseffHistory(
  previousChartBarTime: number | undefined,
  nextChartBarTime: number
) {
  return previousChartBarTime === undefined || nextChartBarTime > previousChartBarTime;
}

export function constructKioseffRequestRange(
  chartCandles: readonly Candle[],
  chartTimeframe: Timeframe,
  lowerTimeframe: Timeframe,
  now = Math.floor(Date.now() / 1000)
): KioseffRequestRange {
  if (!chartCandles.length) {
    throw new KioseffDataUnavailableError("missing-request-range", {
      cause: "empty-chart-history"
    });
  }
  const { chartSeconds, lowerSeconds } = validateLowerTimeframe(
    chartTimeframe,
    lowerTimeframe
  );
  const first = chartCandles[0]?.time;
  const last = chartCandles.at(-1)?.time;
  if (!Number.isFinite(first) || !Number.isFinite(last)) {
    throw new KioseffDataUnavailableError("missing-request-range", {
      cause: "non-finite-chart-time",
      first: first ?? null,
      last: last ?? null
    });
  }
  if (!Number.isInteger(first) || !Number.isInteger(last) || first! > 10_000_000_000 || last! > 10_000_000_000) {
    throw new KioseffDataUnavailableError("invalid-timestamp-units", {
      cause: "chart-time-must-be-integer-seconds",
      first,
      last
    });
  }
  if (first! % lowerSeconds !== 0 || last! % chartSeconds !== 0) {
    throw new KioseffDataUnavailableError("invalid-time-bucketing", {
      cause: "unaligned-chart-range",
      first,
      last,
      chartSeconds,
      lowerSeconds
    });
  }
  const chartEnd = last! + chartSeconds;
  // Use the last closed lower-timeframe boundary. The still-forming minute is
  // not deterministic yet and will replace this revision on the next refresh.
  const currentMinuteBoundary = Math.floor(now / lowerSeconds) * lowerSeconds;
  const end = now < chartEnd ? Math.min(chartEnd, currentMinuteBoundary) : chartEnd;
  if (!(first! < end) || end % lowerSeconds !== 0) {
    throw new KioseffDataUnavailableError("missing-request-range", {
      cause: "invalid-derived-range",
      start: first,
      end,
      now
    });
  }
  return {
    start: first!,
    end,
    intervalSeconds: lowerSeconds,
    expectedIntrabars: Math.ceil((end - first!) / lowerSeconds)
  };
}

async function withHistoryPageTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  outerSignal: AbortSignal,
  timeoutMs = KIOSEFF_HISTORY_PAGE_TIMEOUT_MS
) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(outerSignal.reason);
  outerSignal.addEventListener("abort", abort, { once: true });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort("history-page-timeout");
  }, timeoutMs);
  try {
    return await request(controller.signal);
  } catch (error) {
    if (timedOut) {
      throw new KioseffDataUnavailableError("missing-intrabar-history", {
        cause: "history-page-timeout",
        timeoutMs
      });
    }
    if (outerSignal.aborted) {
      throw new KioseffDataUnavailableError("stale-source-generation", {
        cause: "history-request-aborted"
      });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    outerSignal.removeEventListener("abort", abort);
  }
}

type RawHistoryCollection = {
  candles: Candle[];
  duplicateTimes: number[];
  outOfOrderTimes: number[];
  conflictingTimes: number[];
};

function uniqueTimes(values: readonly number[]) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function sameCandle(left: Candle, right: Candle) {
  return (
    left.open === right.open &&
    left.high === right.high &&
    left.low === right.low &&
    left.close === right.close &&
    left.volume === right.volume
  );
}

export class KioseffHistoryCoordinator {
  private generation = 0;
  private cache = new KioseffHistoryCache(4);
  private activeAbort: AbortController | null = null;

  async load(request: KioseffHistoryRequest): Promise<KioseffHistoryResult> {
    // A 300K intrabar load can cross one or more minute boundaries. Freeze the
    // request clock so range construction and every warmup grouping generation
    // certify the same immutable interval.
    request = {
      ...request,
      now: request.now ?? Math.floor(Date.now() / 1000)
    };
    this.activeAbort?.abort("superseded");
    const abort = new AbortController();
    this.activeAbort = abort;
    const forwardAbort = () => abort.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", forwardAbort, { once: true });
    const generation = ++this.generation;
    try {
      const sortedChart = [...request.chartCandles].sort(
        (left, right) => left.time - right.time
      );
      const range = constructKioseffRequestRange(
        sortedChart,
        request.chartTimeframe,
        request.lowerTimeframe,
        request.now
      );
      request.onProgress?.({
        stage: "requesting-symbol-metadata",
        loaded: 0,
        target: 0
      });
      const metadata = requireSymbolMetadata(
        request.symbol.metadata ??
          (await request.adapter.getSymbolMetadata?.(request.symbol))
      );
      this.assertCurrent(generation);
      const normalizedSymbol = request.adapter.normalizeSymbol(
        request.symbol.rawSymbol,
        request.symbol.marketKind
      );
      if (
        request.adapter.id !== request.symbol.exchange ||
        metadata.exchange !== request.symbol.exchange ||
        metadata.normalizedSymbol !== normalizedSymbol ||
        metadata.marketKind !== request.symbol.marketKind
      ) {
        throw new KioseffDataUnavailableError("adapter-symbol-category-mismatch", {
          adapter: request.adapter.id,
          symbolExchange: request.symbol.exchange,
          metadataExchange: metadata.exchange,
          marketKind: request.symbol.marketKind,
          metadataMarketKind: metadata.marketKind,
          normalizedSymbol,
          metadataSymbol: metadata.normalizedSymbol
        });
      }
      const cacheKey = stableSourceVersion([
        request.adapter.id,
        request.symbol.rawSymbol,
        request.symbol.marketKind,
        request.chartTimeframe,
        request.lowerTimeframe,
        metadata.tickSize,
        range.start,
        range.end,
        sortedChart.length
      ]);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const result = { ...cached, generation };
        request.onProgress?.({
          stage: "grouping-intrabars",
          bars: result.chartBars.length,
          intrabars: result.coverage.receivedIntrabars,
          requestRange: range
        });
        await request.onWarmup?.(result);
        return result;
      }
      const { chartSeconds, lowerSeconds } = validateLowerTimeframe(
        request.chartTimeframe,
        request.lowerTimeframe
      );
      const milestones = [
        Math.min(100, sortedChart.length),
        Math.min(500, sortedChart.length),
        Math.min(1000, sortedChart.length),
        Math.min(2500, sortedChart.length),
        sortedChart.length
      ].filter((value, index, values) => value > 0 && values.indexOf(value) === index);
      let nextMilestone = 0;
      const rawIntrabars = await this.fetchRange(
        generation,
        request.adapter,
        request.symbol,
        request.lowerTimeframe,
        range,
        abort.signal,
        request.onProgress,
        async (raw, continuousStart) => {
          const firstFullChartTime =
            Math.ceil(continuousStart / chartSeconds) * chartSeconds;
          const warmChart = sortedChart.filter(
            (bar) => bar.time >= firstFullChartTime && bar.time < range.end
          );
          const crossedMilestone =
            warmChart.length >= (milestones[nextMilestone] ?? sortedChart.length);
          const full = continuousStart <= range.start;
          if (!crossedMilestone && !full) return;
          while (
            nextMilestone < milestones.length &&
            warmChart.length >= milestones[nextMilestone]!
          ) {
            nextMilestone += 1;
          }
          const warmResult = this.buildResult({
            generation,
            request,
            metadata,
            normalizedSymbol,
            cacheKey,
            range,
            raw,
            chartCandles: full ? sortedChart : warmChart,
            targetChartBars: sortedChart.length,
            full
          });
          await request.onWarmup?.(warmResult);
        }
      );
      this.assertCurrent(generation);
      const result = this.buildResult({
        generation,
        request,
        metadata,
        normalizedSymbol,
        cacheKey,
        range,
        raw: rawIntrabars,
        chartCandles: sortedChart,
        targetChartBars: sortedChart.length,
        full: true
      });
      this.cache.set(cacheKey, result);
      return result;
    } finally {
      request.signal?.removeEventListener("abort", forwardAbort);
      if (this.activeAbort === abort) this.activeAbort = null;
    }
  }

  private buildResult(input: {
    generation: number;
    request: KioseffHistoryRequest;
    metadata: KioseffSourceProvenance["metadata"];
    normalizedSymbol: string;
    cacheKey: string;
    range: KioseffRequestRange;
    raw: RawHistoryCollection;
    chartCandles: Candle[];
    targetChartBars: number;
    full: boolean;
  }): KioseffHistoryResult {
    const {
      generation,
      request,
      metadata,
      normalizedSymbol,
      cacheKey,
      range,
      raw,
      chartCandles,
      targetChartBars,
      full
    } = input;
    const sourceRevision = stableSourceVersion([
      metadata.source,
      metadata.sourceRevision,
      request.adapter.id,
      request.symbol.rawSymbol,
      request.lowerTimeframe,
      raw.candles.length,
      raw.candles[0]?.time,
      raw.candles.at(-1)?.time,
      raw.duplicateTimes.length,
      raw.conflictingTimes.length
    ]);
    const normalizedIntrabars = normalizeKioseffCandles(raw.candles, {
      source: `${request.adapter.id}:historical`,
      sourceRevision
    });
    const normalizedChart = normalizeKioseffCandles(chartCandles, {
      source: `${request.adapter.id}:chart`,
      sourceRevision
    }).candles;
    request.onProgress?.({
      stage: "grouping-intrabars",
      bars: normalizedChart.length,
      intrabars: normalizedIntrabars.candles.length,
      requestRange: range
    });
    const grouped = groupKioseffIntrabars(normalizedChart, normalizedIntrabars.candles, {
      chartTimeframe: request.chartTimeframe,
      lowerTimeframe: request.lowerTimeframe,
      now: request.now ?? Math.floor(Date.now() / 1000),
      duplicateTimes: uniqueTimes([
        ...raw.duplicateTimes,
        ...normalizedIntrabars.duplicateTimes
      ]),
      outOfOrderTimes: uniqueTimes([
        ...raw.outOfOrderTimes,
        ...normalizedIntrabars.outOfOrderTimes
      ]),
      conflictingTimes: uniqueTimes([
        ...raw.conflictingTimes,
        ...normalizedIntrabars.conflictingTimes
      ])
    });
    const quality = aggregateKioseffQuality(grouped);
    if (!normalizedIntrabars.candles.length) {
      quality.flags.push("missing-intrabar-history");
      quality.complete = false;
    }
    const provenance: KioseffSourceProvenance = {
      exchange: request.symbol.exchange,
      rawSymbol: request.symbol.rawSymbol,
      normalizedSymbol,
      assetClass: metadata.assetClass,
      marketKind: request.symbol.marketKind,
      chartTimeframe: request.chartTimeframe,
      lowerTimeframe: request.lowerTimeframe,
      historicalSource: request.adapter.id,
      realtimeSource: request.adapter.id,
      transport: request.transport,
      metadata
    };
    return {
      generation,
      sourceVersion: candleSourceVersion(
        normalizedIntrabars.candles,
        `${cacheKey}:${sourceRevision}`
      ),
      chartBars: grouped,
      provenance,
      quality,
      coverage: aggregateIntrabarCoverage(
        grouped,
        targetChartBars,
        range.start,
        range.end
      ),
      requestRange: range,
      warmup: {
        completedChartBars: grouped.length,
        targetChartBars,
        full
      }
    };
  }

  reset() {
    this.activeAbort?.abort("reset");
    this.activeAbort = null;
    this.generation += 1;
    this.cache.clear();
  }

  private assertCurrent(generation: number) {
    if (generation !== this.generation) {
      throw new KioseffDataUnavailableError("stale-source-generation", {
        generation,
        currentGeneration: this.generation
      });
    }
  }

  private async fetchRange(
    generation: number,
    adapter: MarketDataAdapter,
    symbol: MarketSymbol,
    timeframe: Timeframe,
    range: KioseffRequestRange,
    signal: AbortSignal,
    onProgress?: (progress: KioseffHistoryProgress) => void,
    onBatch?: (
      collection: RawHistoryCollection,
      continuousStart: number
    ) => void | Promise<void>
  ): Promise<RawHistoryCollection> {
    const byTime = new Map<number, Candle>();
    const duplicateTimes: number[] = [];
    const outOfOrderTimes: number[] = [];
    const conflictingTimes: number[] = [];
    const { start: from, end: to, intervalSeconds } = range;
    const expected = range.expectedIntrabars;
    const pageLimit = adapter.id === "okx" ? 300 : 1000;
    const pageSpan = pageLimit * intervalSeconds;
    const ranges: Array<{ from: number; to: number }> = [];
    for (let rangeFrom = from; rangeFrom < to; rangeFrom += pageSpan) {
      ranges.push({ from: rangeFrom, to: Math.min(to, rangeFrom + pageSpan) });
    }
    ranges.reverse();
    for (let offset = 0; offset < ranges.length; offset += KIOSEFF_HISTORY_CONCURRENCY) {
      const batch = ranges.slice(offset, offset + KIOSEFF_HISTORY_CONCURRENCY);
      const pages = await Promise.all(
        batch.map(async (pageRange) => {
          let lastError: unknown;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              return await withHistoryPageTimeout(
                (pageSignal) =>
                  adapter.getHistoricalCandles({
                    exchange: symbol.exchange,
                    symbol: symbol.rawSymbol,
                    marketKind: symbol.marketKind,
                    timeframe,
                    from: pageRange.from,
                    to: pageRange.to - 1,
                    limit: pageLimit,
                    signal: pageSignal
                  }),
                signal
              );
            } catch (error) {
              lastError = error;
              const message = error instanceof Error ? error.message : String(error);
              const rateLimited = /\b429\b|rate.?limit|too many requests|10006/i.test(message);
              if (!rateLimited) throw error;
              if (attempt === 2) {
                throw new KioseffDataUnavailableError("rate-limited", {
                  adapter: adapter.id,
                  pageFrom: pageRange.from,
                  pageTo: pageRange.to,
                  attempts: attempt + 1,
                  cause: message
                });
              }
              await new Promise<void>((resolve, reject) => {
                const finishRetry = () => {
                  signal.removeEventListener("abort", abortRetry);
                  resolve();
                };
                const timeout = setTimeout(finishRetry, 250 * 2 ** attempt);
                const abortRetry = () => {
                  clearTimeout(timeout);
                  signal.removeEventListener("abort", abortRetry);
                  reject(
                    new KioseffDataUnavailableError("stale-source-generation", {
                      cause: "rate-limit-retry-aborted"
                    })
                  );
                };
                signal.addEventListener("abort", abortRetry, { once: true });
                if (signal.aborted) abortRetry();
              });
            }
          }
          throw lastError;
        })
      );
      this.assertCurrent(generation);
      for (let pageIndex = 0; pageIndex < batch.length; pageIndex += 1) {
        const pageRange = batch[pageIndex]!;
        const candles = pages[pageIndex] ?? [];
        let prior = Number.NEGATIVE_INFINITY;
        for (const candle of candles) {
          if (
            !Number.isInteger(candle.time) ||
            candle.time > 10_000_000_000
          ) {
            throw new KioseffDataUnavailableError("invalid-timestamp-units", {
              time: candle.time,
              pageFrom: pageRange.from,
              pageTo: pageRange.to
            });
          }
          if (candle.time % intervalSeconds !== 0) {
            throw new KioseffDataUnavailableError("invalid-time-bucketing", {
              cause: "unaligned-intrabar",
              time: candle.time,
              intervalSeconds
            });
          }
          if (candle.time < prior) outOfOrderTimes.push(candle.time);
          prior = candle.time;
          if (candle.time < pageRange.from || candle.time >= pageRange.to) continue;
          const existing = byTime.get(candle.time);
          if (existing) {
            duplicateTimes.push(candle.time);
            if (!sameCandle(existing, candle)) conflictingTimes.push(candle.time);
          }
          byTime.set(candle.time, candle);
        }
      }
      const completedPages = Math.min(offset + batch.length, ranges.length);
      onProgress?.({
        stage: "fetching-intrabar-history",
        loaded: byTime.size,
        target: expected,
        completedPages,
        targetPages: ranges.length,
        requestRange: range
      });
      const collection = (): RawHistoryCollection => ({
        candles: [...byTime.values()].sort((left, right) => left.time - right.time),
        duplicateTimes: uniqueTimes(duplicateTimes),
        outOfOrderTimes: uniqueTimes(outOfOrderTimes),
        conflictingTimes: uniqueTimes(conflictingTimes)
      });
      const oldestBatchRange = batch.at(-1);
      if (oldestBatchRange) await onBatch?.(collection(), oldestBatchRange.from);
    }
    this.assertCurrent(generation);
    if (byTime.size > expected) {
      throw new KioseffDataUnavailableError("invalid-time-bucketing", {
        expected,
        actual: byTime.size,
        from,
        to,
        intervalSeconds
      });
    }
    return {
      candles: [...byTime.values()].sort((left, right) => left.time - right.time),
      duplicateTimes: uniqueTimes(duplicateTimes),
      outOfOrderTimes: uniqueTimes(outOfOrderTimes),
      conflictingTimes: uniqueTimes(conflictingTimes)
    };
  }
}

export class KioseffRealtimeIntrabarReconciler {
  private historical: NormalizedCandle[] = [];
  private realtime: NormalizedCandle[] = [];

  setHistorical(candles: NormalizedCandle[]) {
    this.historical = [...candles];
  }

  replaceRealtime(candles: readonly Candle[], source: string, sourceRevision: string) {
    this.realtime = normalizeKioseffCandles(candles, { source, sourceRevision }).candles;
  }

  snapshot() {
    return normalizeKioseffCandles([...this.historical, ...this.realtime], {
      source: this.realtime.at(-1)?.source ?? this.historical.at(-1)?.source ?? "unavailable",
      sourceRevision:
        this.realtime.at(-1)?.sourceRevision ??
        this.historical.at(-1)?.sourceRevision ??
        "unavailable"
    });
  }

  reset() {
    this.historical = [];
    this.realtime = [];
  }
}
