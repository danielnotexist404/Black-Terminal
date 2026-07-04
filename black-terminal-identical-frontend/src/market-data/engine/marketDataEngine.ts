import { blackCoreEventBus } from "../../core/blackCore";
import type { Candle } from "../../chart-engine/types";
import { getPublicMarketDataAdapter } from "../exchangeRegistry";
import type {
  CandleQuery,
  ExchangeId,
  MarketDataAdapter,
  MarketDataCapabilities,
  MarketDataSubscription,
  MarketKind,
  MarketSymbol,
  OrderBookSnapshot,
  TickerSnapshot,
  TradeTick
} from "../types";
import { CandleAggregationEngine } from "../aggregation/candleAggregator";
import { MarketCache } from "../cache/marketCache";
import { WebSocketManager } from "../websocket/webSocketManager";

export type MarketDataDiagnostics = {
  websocket: ReturnType<WebSocketManager["diagnostics"]>;
  cacheKeys: number;
};

export class MarketDataEngine {
  readonly cache = new MarketCache();
  readonly websockets = new WebSocketManager();
  readonly aggregator = new CandleAggregationEngine();
  private adapterFacades = new Map<ExchangeId, MarketDataAdapter>();

  getAdapter(exchange: ExchangeId): MarketDataAdapter {
    const existing = this.adapterFacades.get(exchange);
    if (existing) return existing;

    const source = getPublicMarketDataAdapter(exchange);
    const facade = this.createAdapterFacade(source);
    this.adapterFacades.set(exchange, facade);
    return facade;
  }

  diagnostics(): MarketDataDiagnostics {
    return {
      websocket: this.websockets.diagnostics(),
      cacheKeys: 0
    };
  }

  private createAdapterFacade(source: MarketDataAdapter): MarketDataAdapter {
    return {
      id: source.id,
      label: source.label,
      capabilities: source.capabilities,
      normalizeSymbol: (symbol: string, marketKind: MarketKind) => source.normalizeSymbol(symbol, marketKind),
      getSymbols: source.getSymbols ? (marketKind?: MarketKind) => source.getSymbols?.(marketKind) ?? Promise.resolve([]) : undefined,
      getHistoricalCandles: async (query: CandleQuery) => {
        const candles = await source.getHistoricalCandles(query);
        const symbol = symbolFromQuery(query);
        this.cache.setCandles(symbol, query.timeframe, candles);
        return candles;
      },
      getOrderBookSnapshot: source.getOrderBookSnapshot
        ? async (symbol: MarketSymbol, limit?: number) => {
            const book = await source.getOrderBookSnapshot?.(symbol, limit);
            if (book) {
              this.cache.setOrderBook(book);
              blackCoreEventBus.publish("orderbook.updated", book);
            }
            return book as OrderBookSnapshot;
          }
        : undefined,
      getRecentTrades: source.getRecentTrades
        ? async (symbol: MarketSymbol, limit?: number) => {
            const trades = await source.getRecentTrades?.(symbol, limit);
            trades?.forEach((trade) => {
              this.cache.appendTrade(trade);
              blackCoreEventBus.publish("trade.received", trade);
            });
            return trades ?? [];
          }
        : undefined,
      getTickerSnapshot: source.getTickerSnapshot
        ? async (symbol: MarketSymbol) => {
            const ticker = await source.getTickerSnapshot?.(symbol);
            if (ticker) {
              this.cache.setTicker(ticker);
              blackCoreEventBus.publish("ticker.updated", ticker);
            }
            return ticker as TickerSnapshot;
          }
        : undefined,
      subscribeCandles: source.subscribeCandles
        ? (query: CandleQuery, onCandle: (candle: Candle) => void) => {
            const symbol = symbolFromQuery(query);
            return source.subscribeCandles?.(query, (candle) => {
              this.cache.appendCandle(symbol, query.timeframe, candle);
              blackCoreEventBus.publish("candle.updated", { ...candle, symbol });
              onCandle(candle);
            }) as MarketDataSubscription<Candle>;
          }
        : undefined,
      subscribeTrades: source.subscribeTrades
        ? (symbol: MarketSymbol, onTrade: (trade: TradeTick) => void) => {
            return source.subscribeTrades?.(symbol, (trade) => {
              this.cache.appendTrade(trade);
              blackCoreEventBus.publish("trade.received", trade);
              onTrade(trade);
            }) as MarketDataSubscription<TradeTick>;
          }
        : undefined,
      subscribeOrderBook: source.subscribeOrderBook
        ? (symbol: MarketSymbol, onBook: (book: OrderBookSnapshot) => void) => {
            return source.subscribeOrderBook?.(symbol, (book) => {
              this.cache.setOrderBook(book);
              blackCoreEventBus.publish("orderbook.updated", book);
              onBook(book);
            }) as MarketDataSubscription<OrderBookSnapshot>;
          }
        : undefined
    };
  }
}

function symbolFromQuery(query: CandleQuery): MarketSymbol {
  return {
    exchange: query.exchange,
    rawSymbol: query.symbol,
    baseAsset: query.symbol.replace(/[-_/]?USDT.*$/i, "").replace(/[-_/]?USD.*$/i, ""),
    quoteAsset: query.symbol.includes("USD") ? "USDT" : "",
    marketKind: query.marketKind
  };
}

export const blackCoreMarketDataEngine = new MarketDataEngine();

export function getMarketDataEngineAdapter(exchange: ExchangeId) {
  return blackCoreMarketDataEngine.getAdapter(exchange);
}

export const marketDataEngineCapabilities: MarketDataCapabilities = {
  historicalCandles: true,
  liveCandles: true,
  trades: true,
  orderBook: true,
  fundingRates: true,
  openInterest: true,
  liquidations: true
};
