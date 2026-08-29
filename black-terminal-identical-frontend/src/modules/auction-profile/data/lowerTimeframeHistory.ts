import type { Candle } from "../../../chart-engine/types.ts";
import { getMarketDataEngineAdapter } from "../../../market-data/engine/marketDataEngine.ts";
import type { MarketSymbol, Timeframe } from "../../../market-data/types.ts";
import { AUCTION_TIMEFRAME_SECONDS, auctionProfileNeedsLowerHistory, resolveAuctionLowerSourceTimeframe } from "../core/lowerTimeframe.ts";
import type { AuctionProfileSettings } from "../core/types.ts";

type CachedHistory = { candles: Map<number, Candle>; touchedAt: number };
const historyCache = new Map<string, CachedHistory>();
const MAX_CACHE_KEYS = 6;

function pruneCache() {
  if (historyCache.size <= MAX_CACHE_KEYS) return;
  const oldest = [...historyCache.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0]?.[0];
  if (oldest) historyCache.delete(oldest);
}

export interface AuctionLowerHistoryResult {
  bars: Candle[];
  sourceTimeframe: Timeframe;
  requestedBars: number;
  truncated: boolean;
}

export async function loadAuctionProfileLowerHistory(
  market: MarketSymbol,
  chartTimeframe: Timeframe,
  chartBars: readonly Candle[],
  settings: AuctionProfileSettings,
  signal?: AbortSignal
): Promise<AuctionLowerHistoryResult> {
  const sourceTimeframe = resolveAuctionLowerSourceTimeframe(settings);
  if (!chartBars.length || !auctionProfileNeedsLowerHistory(chartTimeframe, settings)) {
    return { bars: [], sourceTimeframe, requestedBars: 0, truncated: false };
  }
  const adapter = getMarketDataEngineAdapter(market.exchange);
  if (!adapter) throw new Error(`No historical adapter for ${market.exchange}.`);
  const sourceSeconds = AUCTION_TIMEFRAME_SECONDS[sourceTimeframe] ?? 60;
  const chartSeconds = AUCTION_TIMEFRAME_SECONDS[chartTimeframe] ?? sourceSeconds;
  const rangeStart = chartBars[0]!.time;
  const rangeEnd = chartBars.at(-1)!.time + chartSeconds - 1;
  const requiredBars = Math.max(1, Math.ceil((rangeEnd - rangeStart + 1) / sourceSeconds));
  const maximumBars = settings.calculationEngine === "TPO" ? 50_000 : 25_000;
  const targetBars = Math.min(requiredBars, maximumBars);
  const targetStart = Math.max(rangeStart, rangeEnd - targetBars * sourceSeconds + 1);
  const cacheKey = [market.exchange, market.marketKind, market.rawSymbol, sourceTimeframe].join(":");
  const cache = historyCache.get(cacheKey) ?? { candles: new Map<number, Candle>(), touchedAt: Date.now() };
  cache.touchedAt = Date.now();
  historyCache.set(cacheKey, cache);
  pruneCache();

  const complete = () => {
    const retained = [...cache.candles.values()].filter(candle => candle.time >= targetStart && candle.time <= rangeEnd);
    if (!retained.length) return false;
    const oldest = Math.min(...retained.map(candle => candle.time));
    const newest = Math.max(...retained.map(candle => candle.time));
    return oldest <= targetStart + sourceSeconds && newest >= rangeEnd - sourceSeconds;
  };

  let before = rangeEnd;
  const pageSize = market.exchange === "okx" ? 300 : 1000;
  for (let page = 0; page < Math.ceil(targetBars / pageSize) + 3 && !complete(); page += 1) {
    if (signal?.aborted) throw new DOMException("RADAP lower-timeframe history cancelled", "AbortError");
    const batch = await adapter.getHistoricalCandles({
      exchange: market.exchange,
      symbol: market.rawSymbol,
      marketKind: market.marketKind,
      timeframe: sourceTimeframe,
      from: targetStart,
      to: before,
      limit: Math.min(pageSize, targetBars),
      signal
    });
    const eligible = batch.filter(candle => candle.time >= targetStart && candle.time <= rangeEnd);
    let oldest = Number.POSITIVE_INFINITY;
    let added = 0;
    for (const candle of eligible) {
      oldest = Math.min(oldest, candle.time);
      if (!cache.candles.has(candle.time)) added += 1;
      cache.candles.set(candle.time, candle);
    }
    if (!eligible.length || !Number.isFinite(oldest)) break;
    if (complete()) break;
    before = oldest - sourceSeconds;
    if (!added && before <= targetStart) break;
  }

  const sorted = [...cache.candles.values()]
    .filter(candle => candle.time >= targetStart && candle.time <= rangeEnd)
    .sort((left, right) => left.time - right.time)
    .slice(-targetBars);
  if (cache.candles.size > maximumBars * 1.25) {
    const retained = [...cache.candles.values()].sort((left, right) => left.time - right.time).slice(-maximumBars);
    cache.candles = new Map(retained.map(candle => [candle.time, candle]));
  }
  return {
    bars: sorted,
    sourceTimeframe,
    requestedBars: requiredBars,
    truncated: requiredBars > targetBars || sorted.length < Math.max(1, targetBars - 1)
  };
}

export function clearAuctionLowerHistoryCache() {
  historyCache.clear();
}
