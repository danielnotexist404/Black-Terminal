import type { Candle } from "../../../chart-engine/types";
import { requireSymbolMetadata } from "../../../market-data/symbolMetadata.ts";
import type {
  MarketDataAdapter,
  MarketSymbol,
  Timeframe
} from "../../../market-data/types";
import { KioseffHistoryCache } from "./cache.ts";
import { aggregateKioseffQuality, groupKioseffIntrabars } from "./grouping.ts";
import {
  candleSourceVersion,
  normalizeKioseffCandles,
  stableSourceVersion
} from "./normalization.ts";
import { kioseffTimeframeSeconds, validateLowerTimeframe } from "./timeframes.ts";
import {
  KioseffDataUnavailableError,
  type KioseffHistoryResult,
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
};

export class KioseffHistoryCoordinator {
  private generation = 0;
  private cache = new KioseffHistoryCache(4);

  async load(request: KioseffHistoryRequest): Promise<KioseffHistoryResult> {
    const generation = ++this.generation;
    if (!request.chartCandles.length) {
      throw new KioseffDataUnavailableError("missing-intrabar-history", { chartBars: 0 });
    }
    const metadata = requireSymbolMetadata(
      request.symbol.metadata ?? (await request.adapter.getSymbolMetadata?.(request.symbol))
    );
    this.assertCurrent(generation);
    const normalizedSymbol = request.adapter.normalizeSymbol(
      request.symbol.rawSymbol,
      request.symbol.marketKind
    );
    if (
      request.adapter.id !== request.symbol.exchange ||
      metadata.exchange !== request.symbol.exchange ||
      metadata.normalizedSymbol !== normalizedSymbol
    ) {
      throw new KioseffDataUnavailableError("source-history-live-mismatch", {
        adapter: request.adapter.id,
        symbolExchange: request.symbol.exchange,
        metadataExchange: metadata.exchange,
        normalizedSymbol,
        metadataSymbol: metadata.normalizedSymbol
      });
    }
    const { chartSeconds, lowerSeconds } = validateLowerTimeframe(
      request.chartTimeframe,
      request.lowerTimeframe
    );
    const sortedChart = [...request.chartCandles].sort((left, right) => left.time - right.time);
    const from = sortedChart[0]!.time;
    const to = sortedChart.at(-1)!.time + chartSeconds;
    const cacheKey = stableSourceVersion([
      request.adapter.id,
      request.symbol.rawSymbol,
      request.chartTimeframe,
      request.lowerTimeframe,
      metadata.tickSize,
      from,
      to,
      sortedChart.length
    ]);
    const cached = this.cache.get(cacheKey);
    if (cached) return { ...cached, generation };

    const rawIntrabars = await this.fetchRange(
      generation,
      request.adapter,
      request.symbol,
      request.lowerTimeframe,
      from,
      to,
      lowerSeconds
    );
    this.assertCurrent(generation);
    const sourceRevision = stableSourceVersion([
      metadata.source,
      metadata.sourceRevision,
      request.adapter.id,
      request.symbol.rawSymbol,
      request.lowerTimeframe,
      rawIntrabars.length,
      rawIntrabars[0]?.time,
      rawIntrabars.at(-1)?.time
    ]);
    const normalizedIntrabars = normalizeKioseffCandles(rawIntrabars, {
      source: `${request.adapter.id}:historical`,
      sourceRevision
    });
    const normalizedChart = normalizeKioseffCandles(sortedChart, {
      source: `${request.adapter.id}:chart`,
      sourceRevision
    }).candles;
    const grouped = groupKioseffIntrabars(normalizedChart, normalizedIntrabars.candles, {
      chartTimeframe: request.chartTimeframe,
      lowerTimeframe: request.lowerTimeframe,
      now: request.now ?? Math.floor(Date.now() / 1000),
      duplicateTimes: normalizedIntrabars.duplicateTimes,
      outOfOrderTimes: normalizedIntrabars.outOfOrderTimes,
      conflictingTimes: normalizedIntrabars.conflictingTimes
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
    const result: KioseffHistoryResult = {
      generation,
      sourceVersion: candleSourceVersion(
        normalizedIntrabars.candles,
        `${cacheKey}:${sourceRevision}`
      ),
      chartBars: grouped,
      provenance,
      quality
    };
    this.cache.set(cacheKey, result);
    return result;
  }

  reset() {
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
    from: number,
    to: number,
    intervalSeconds: number
  ) {
    const byTime = new Map<number, Candle>();
    let cursor = to;
    const expected = Math.max(1, Math.ceil((to - from) / intervalSeconds));
    const pageLimit = adapter.id === "okx" ? 300 : 1000;
    const maxPages = Math.ceil(expected / pageLimit) + 3;
    for (let page = 0; page < maxPages && cursor > from; page += 1) {
      const candles = await adapter.getHistoricalCandles({
        exchange: symbol.exchange,
        symbol: symbol.rawSymbol,
        marketKind: symbol.marketKind,
        timeframe,
        from,
        to: cursor - 1,
        limit: pageLimit
      });
      this.assertCurrent(generation);
      const eligible = candles.filter((candle) => candle.time >= from && candle.time < cursor);
      for (const candle of eligible) byTime.set(candle.time, candle);
      const oldest = eligible.reduce(
        (minimum, candle) => Math.min(minimum, candle.time),
        Number.POSITIVE_INFINITY
      );
      if (!Number.isFinite(oldest) || oldest <= from || eligible.length < pageLimit) break;
      cursor = oldest;
    }
    return [...byTime.values()].sort((left, right) => left.time - right.time);
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
