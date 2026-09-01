import type { Candle } from "../../../chart-engine/types";
import { getMarketDataEngineAdapter } from "../../../market-data/engine/marketDataEngine";
import type { MarketSymbol, Timeframe } from "../../../market-data/types";

export const strategyTimeframeSeconds: Record<Timeframe, number> = {
  "1s": 1,
  "10s": 10,
  "30s": 30,
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "2h": 7200,
  "3h": 10800,
  "4h": 14400,
  "6h": 21600,
  "8h": 28800,
  "12h": 43200,
  "1d": 86400,
  "1w": 604800,
  "1M": 2592000,
  "1t": 1,
  "10t": 10,
  "100t": 100
};

const magnifierTimeframes: Partial<Record<Timeframe, Timeframe>> = {
  "3m": "1m",
  "5m": "1m",
  "15m": "3m",
  "30m": "5m",
  "1h": "15m",
  "2h": "30m",
  "3h": "30m",
  "4h": "30m",
  "6h": "1h",
  "8h": "1h",
  "12h": "1h",
  "1d": "1h",
  "1w": "1d",
  "1M": "1d",
};

export function strategyMagnifierTimeframe(timeframe: Timeframe) {
  return magnifierTimeframes[timeframe] ?? null;
}

function uniqueSortedCandles(candles: Candle[]) {
  const byTime = new Map<number, Candle>();
  candles.forEach((candle) => byTime.set(candle.time, candle));
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export async function fetchStrategyLabCandles(
  marketSymbol: MarketSymbol,
  timeframe: Timeframe,
  startDate: string,
  endDate: string,
  targetBars = 1500
) {
  const adapter = getMarketDataEngineAdapter(marketSymbol.exchange);
  if (!adapter) {
    throw new Error(`${marketSymbol.exchange} does not have an enabled public market adapter yet.`);
  }

  const from = startDate ? Math.floor(new Date(startDate).getTime() / 1000) : undefined;
  let to = endDate ? Math.floor(new Date(endDate).getTime() / 1000) : Math.floor(Date.now() / 1000);
  const collected: Candle[] = [];
  const pageLimit = marketSymbol.exchange === "okx" ? 300 : 1000;
  const maxPages = Math.ceil(targetBars / pageLimit) + 2;

  for (let page = 0; page < maxPages && collected.length < targetBars; page++) {
    const candles = await adapter.getHistoricalCandles({
      exchange: marketSymbol.exchange,
      symbol: marketSymbol.rawSymbol,
      marketKind: marketSymbol.marketKind,
      timeframe,
      limit: Math.min(pageLimit, targetBars - collected.length),
      from,
      to
    });
    if (candles.length === 0) break;
    collected.push(...candles.filter((candle) => candle.time >= (from ?? 0) && candle.time <= (to ?? Number.POSITIVE_INFINITY)));
    const oldest = Math.min(...candles.map((candle) => candle.time));
    if (!Number.isFinite(oldest) || (from && oldest <= from)) break;
    to = oldest - 1;
  }

  const history = uniqueSortedCandles(collected).slice(-targetBars);
  if (history.length === 0) {
    throw new Error("No historical candles returned for the Strategy Lab request.");
  }
  return history;
}

export async function fetchStrategyLabIntrabars(
  marketSymbol: MarketSymbol,
  chartTimeframe: Timeframe,
  chartCandles: readonly Candle[],
) {
  const lowerTimeframe = strategyMagnifierTimeframe(chartTimeframe);
  if (!lowerTimeframe || chartCandles.length === 0) {
    return { lowerTimeframe, intrabars: chartCandles.map(() => [] as Candle[]), coveredBars: 0, requestedBars: chartCandles.length };
  }
  const chartSeconds = strategyTimeframeSeconds[chartTimeframe];
  const lowerSeconds = strategyTimeframeSeconds[lowerTimeframe];
  const start = chartCandles[0]!.time;
  const end = chartCandles.at(-1)!.time + chartSeconds;
  // Match TradingView's documented maximum lower-timeframe request size.
  // When the history exceeds it, the most recent bars receive magnification
  // and older bars deterministically fall back to the four-tick parent path.
  const targetBars = Math.min(200_000, Math.max(1, Math.ceil((end - start) / lowerSeconds)));
  const lowerCandles = await fetchStrategyLabCandles(
    marketSymbol,
    lowerTimeframe,
    new Date(start * 1000).toISOString(),
    new Date(end * 1000).toISOString(),
    targetBars,
  );
  const grouped = new Map<number, Candle[]>();
  for (const candle of lowerCandles) {
    const parentTime = Math.floor(candle.time / chartSeconds) * chartSeconds;
    if (parentTime < start || parentTime >= end) continue;
    const bucket = grouped.get(parentTime);
    if (bucket) bucket.push(candle);
    else grouped.set(parentTime, [candle]);
  }
  const intrabars = chartCandles.map((candle) => (grouped.get(candle.time) || []).sort((left, right) => left.time - right.time));
  return {
    lowerTimeframe,
    intrabars,
    coveredBars: intrabars.filter((candles) => candles.length > 0).length,
    requestedBars: chartCandles.length,
  };
}
