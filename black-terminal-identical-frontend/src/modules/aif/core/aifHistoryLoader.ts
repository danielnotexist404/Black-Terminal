import type { Candle } from "../../../chart-engine/types";
import { getMarketDataEngineAdapter } from "../../../market-data/engine/marketDataEngine";
import type { MarketSymbol, Timeframe } from "../../../market-data/types";
import { selectCompletedAifCandles, timeframeSeconds } from "./aifTime";

export async function loadAifHistory(marketSymbol: MarketSymbol, timeframe: Timeframe, requestedBars: number, onProgress?: (loaded: number) => void) {
  const adapter = getMarketDataEngineAdapter(marketSymbol.exchange);
  if (!adapter) throw new Error(`No historical adapter for ${marketSymbol.exchange}`);
  const pageSize = marketSymbol.exchange === "okx" ? 300 : 1000;
  const collected = new Map<number, Candle>();
  let before: number | undefined;
  const interval = timeframeSeconds(timeframe);
  const target = Math.max(1, Math.min(100_000, Math.round(requestedBars)));
  const collectionTarget = Math.min(100_001, target + 1);
  for (let page = 0; page < Math.ceil(collectionTarget / pageSize) + 3 && collected.size < collectionTarget; page += 1) {
    const limit = Math.min(pageSize, collectionTarget - collected.size);
    const batch = await adapter.getHistoricalCandles({ exchange: marketSymbol.exchange, symbol: marketSymbol.rawSymbol, timeframe, marketKind: marketSymbol.marketKind, limit, to: before ? before - interval : undefined });
    let added = 0;
    let oldest = Number.POSITIVE_INFINITY;
    for (const candle of batch) {
      oldest = Math.min(oldest, candle.time);
      if (!collected.has(candle.time)) { collected.set(candle.time, candle); added += 1; }
    }
    onProgress?.(Math.min(target, collected.size));
    if (!added || batch.length < limit || !Number.isFinite(oldest)) break;
    before = oldest;
  }
  const sorted = [...collected.values()].sort((a, b) => a.time - b.time);
  return selectCompletedAifCandles(sorted, timeframe).slice(-target);
}
