import type { Candle } from "../../../chart-engine/types";
import { getPublicMarketDataAdapter } from "../../../market-data/exchangeRegistry";
import type { MarketSymbol, Timeframe } from "../../../market-data/types";

const timeframeSeconds: Record<Timeframe, number> = {
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
  "4h": 14400,
  "6h": 21600,
  "8h": 28800,
  "12h": 43200,
  "1d": 86400,
  "1w": 604800,
  "1M": 2592000,
  "10t": 10,
  "100t": 100
};

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
  const adapter = getPublicMarketDataAdapter(marketSymbol.exchange);
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
    to = oldest - timeframeSeconds[timeframe];
  }

  const history = uniqueSortedCandles(collected).slice(-targetBars);
  if (history.length === 0) {
    throw new Error("No historical candles returned for the Strategy Lab request.");
  }
  return history;
}
