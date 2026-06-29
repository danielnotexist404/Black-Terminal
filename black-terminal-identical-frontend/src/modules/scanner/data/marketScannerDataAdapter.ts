import type { Candle } from "../../../chart-engine/types";
import { getPublicMarketDataAdapter } from "../../../market-data/exchangeRegistry";
import type { MarketSymbol, Timeframe } from "../../../market-data/types";
import type { ScannerDataAdapter } from "../types/scanner.types";

export class PublicMarketScannerDataAdapter implements ScannerDataAdapter {
  async fetchCandles(symbol: MarketSymbol, timeframe: Timeframe, limit: number, signal?: AbortSignal): Promise<Candle[]> {
    if (signal?.aborted) throw new DOMException("Scanner cancelled", "AbortError");
    const adapter = getPublicMarketDataAdapter(symbol.exchange);
    if (!adapter) throw new Error(`No market data adapter for ${symbol.exchange}.`);
    const candles = await adapter.getHistoricalCandles({
      exchange: symbol.exchange,
      symbol: symbol.rawSymbol,
      marketKind: symbol.marketKind,
      timeframe,
      limit
    });
    if (signal?.aborted) throw new DOMException("Scanner cancelled", "AbortError");
    return candles;
  }
}
