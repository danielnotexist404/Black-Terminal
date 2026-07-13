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
import { blackCorePerformanceMonitor } from "../../performance/performanceMonitor";

export type MarketDataDiagnostics = {
  websocket: ReturnType<WebSocketManager["diagnostics"]>;
  cache: ReturnType<MarketCache["diagnostics"]>;
  sharedSubscriptions: {
    orderBooks: number;
    trades: number;
  };
};

type SharedSubscription<T> = {
  source: MarketDataSubscription<T>;
  handlers: Set<(message: T) => void>;
  errorHandlers: Set<(error: Error) => void>;
};

export class MarketDataEngine {
  readonly cache = new MarketCache();
  readonly websockets = new WebSocketManager();
  readonly aggregator = new CandleAggregationEngine();
  private adapterFacades = new Map<ExchangeId, MarketDataAdapter>();
  private orderBookSubscriptions = new Map<string, SharedSubscription<OrderBookSnapshot>>();
  private tradeSubscriptions = new Map<string, SharedSubscription<TradeTick>>();
  private publicMessageTimes: number[] = [];
  private lastPublicRateMetricAt = 0;

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
      cache: this.cache.diagnostics(),
      sharedSubscriptions: {
        orderBooks: this.orderBookSubscriptions.size,
        trades: this.tradeSubscriptions.size
      }
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
              blackCoreEventBus.publishLatest("orderbook.updated", book, 50);
            }
            return book as OrderBookSnapshot;
          }
        : undefined,
      getRecentTrades: source.getRecentTrades
        ? async (symbol: MarketSymbol, limit?: number) => {
            const trades = await source.getRecentTrades?.(symbol, limit);
            trades?.forEach((trade) => {
              this.cache.appendTrade(trade);
              blackCoreEventBus.publishLatest("trade.received", trade, 50);
            });
            return trades ?? [];
          }
        : undefined,
      getTickerSnapshot: source.getTickerSnapshot
        ? async (symbol: MarketSymbol) => {
            const ticker = await source.getTickerSnapshot?.(symbol);
            if (ticker) {
              this.cache.setTicker(ticker);
              blackCoreEventBus.publishLatest("ticker.updated", ticker, 100);
            }
            return ticker as TickerSnapshot;
          }
        : undefined,
      subscribeCandles: source.subscribeCandles
        ? (query: CandleQuery, onCandle: (candle: Candle) => void) => {
            const symbol = symbolFromQuery(query);
            return source.subscribeCandles?.(query, (candle) => {
              this.recordPublicMessage();
              this.cache.appendCandle(symbol, query.timeframe, candle);
              blackCoreEventBus.publishLatest("candle.updated", { ...candle, symbol }, 100);
              onCandle(candle);
            }) as MarketDataSubscription<Candle>;
          }
        : undefined,
      subscribeTrades: source.subscribeTrades
        ? (symbol: MarketSymbol, onTrade: (trade: TradeTick) => void) => this.subscribeSharedTrade(source, symbol, onTrade)
        : undefined,
      subscribeOrderBook: source.subscribeOrderBook
        ? (symbol: MarketSymbol, onBook: (book: OrderBookSnapshot) => void) => this.subscribeSharedOrderBook(source, symbol, onBook)
        : undefined
    };
  }

  private subscribeSharedTrade(source: MarketDataAdapter, symbol: MarketSymbol, onTrade: (trade: TradeTick) => void): MarketDataSubscription<TradeTick> {
    const key = this.subscriptionKey(source.id, symbol, "trades");
    let shared = this.tradeSubscriptions.get(key);

    if (!shared) {
      const handlers = new Set<(message: TradeTick) => void>();
      const errorHandlers = new Set<(error: Error) => void>();
      const sourceSubscription = source.subscribeTrades?.(symbol, (trade) => {
        this.recordPublicMessage();
        this.cache.appendTrade(trade);
        blackCoreEventBus.publishLatest("trade.received", trade, 50);
        handlers.forEach((handler) => handler(trade));
      }) as MarketDataSubscription<TradeTick>;
      sourceSubscription.onError((error) => errorHandlers.forEach((handler) => handler(error)));
      shared = { source: sourceSubscription, handlers, errorHandlers };
      this.tradeSubscriptions.set(key, shared);
    }

    return this.attachSharedSubscription(this.tradeSubscriptions, key, shared, onTrade);
  }

  private subscribeSharedOrderBook(source: MarketDataAdapter, symbol: MarketSymbol, onBook: (book: OrderBookSnapshot) => void): MarketDataSubscription<OrderBookSnapshot> {
    const key = this.subscriptionKey(source.id, symbol, "orderbook");
    let shared = this.orderBookSubscriptions.get(key);

    if (!shared) {
      const handlers = new Set<(message: OrderBookSnapshot) => void>();
      const errorHandlers = new Set<(error: Error) => void>();
      const sourceSubscription = source.subscribeOrderBook?.(symbol, (book) => {
        this.recordPublicMessage();
        this.cache.setOrderBook(book);
        blackCoreEventBus.publishLatest("orderbook.updated", book, 50);
        handlers.forEach((handler) => handler(book));
      }) as MarketDataSubscription<OrderBookSnapshot>;
      sourceSubscription.onError((error) => errorHandlers.forEach((handler) => handler(error)));
      shared = { source: sourceSubscription, handlers, errorHandlers };
      this.orderBookSubscriptions.set(key, shared);
    }

    return this.attachSharedSubscription(this.orderBookSubscriptions, key, shared, onBook);
  }

  private attachSharedSubscription<T>(
    registry: Map<string, SharedSubscription<T>>,
    key: string,
    shared: SharedSubscription<T>,
    handler: (message: T) => void
  ): MarketDataSubscription<T> {
    const ownedHandlers = new Set<(message: T) => void>([handler]);
    const localErrorHandlers = new Set<(error: Error) => void>();
    const errorBridge = (error: Error) => localErrorHandlers.forEach((item) => item(error));
    shared.handlers.add(handler);
    shared.errorHandlers.add(errorBridge);

    return {
      unsubscribe: () => {
        ownedHandlers.forEach((ownedHandler) => shared.handlers.delete(ownedHandler));
        shared.errorHandlers.delete(errorBridge);
        if (shared.handlers.size === 0) {
          shared.source.unsubscribe();
          registry.delete(key);
        }
      },
      onMessage: (nextHandler) => {
        ownedHandlers.add(nextHandler);
        shared.handlers.add(nextHandler);
      },
      onError: (nextHandler) => {
        localErrorHandlers.add(nextHandler);
      }
    };
  }

  private subscriptionKey(exchange: ExchangeId, symbol: MarketSymbol, stream: string) {
    return [exchange, symbol.marketKind, symbol.rawSymbol, stream].join(":");
  }

  private recordPublicMessage() {
    const now = Date.now();
    this.publicMessageTimes.push(now);
    while (this.publicMessageTimes.length && this.publicMessageTimes[0] < now - 1000) this.publicMessageTimes.shift();
    if (now - this.lastPublicRateMetricAt < 1000) return;
    this.lastPublicRateMetricAt = now;
    blackCorePerformanceMonitor.recordMetric("stream.public_messages_per_second", this.publicMessageTimes.length, "msg/s");
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
