import { blackCoreMarketDataEngine } from "../../market-data/engine/marketDataEngine";
import type { MarketDataSubscription, MarketSymbol, OrderBookSnapshot, TickerSnapshot, TradeTick } from "../../market-data/types";

export type DomFeedSnapshot = {
  marketSymbol: MarketSymbol;
  book: OrderBookSnapshot | null;
  trades: TradeTick[];
  ticker: TickerSnapshot | null;
  bookStatus: string;
  tradeStatus: string;
  tickerStatus: string;
  lastError?: string;
  subscriptionCount: number;
  updatedAt: number;
};

type DomFeedListener = (snapshot: DomFeedSnapshot) => void;

type FeedEntry = {
  key: string;
  snapshot: DomFeedSnapshot;
  listeners: Set<DomFeedListener>;
  bookSubscription?: MarketDataSubscription<OrderBookSnapshot>;
  tradeSubscription?: MarketDataSubscription<TradeTick>;
  bookPollTimer?: number;
  tradePollTimer?: number;
  tickerPollTimer?: number;
  seenTrades: Set<string>;
  seenTradeOrder: string[];
};

export class DomFeedStore {
  private entries = new Map<string, FeedEntry>();

  subscribe(marketSymbol: MarketSymbol, listener: DomFeedListener) {
    const entry = this.ensureEntry(marketSymbol);
    entry.listeners.add(listener);
    entry.snapshot.subscriptionCount = entry.listeners.size;
    listener(entry.snapshot);
    this.start(entry);

    return () => {
      entry.listeners.delete(listener);
      entry.snapshot.subscriptionCount = entry.listeners.size;
      if (entry.listeners.size === 0) this.stop(entry.key);
      else this.notify(entry);
    };
  }

  getSnapshot(marketSymbol: MarketSymbol) {
    return this.ensureEntry(marketSymbol).snapshot;
  }

  private ensureEntry(marketSymbol: MarketSymbol): FeedEntry {
    const key = feedKey(marketSymbol);
    const existing = this.entries.get(key);
    if (existing) return existing;

    const cachedBook = blackCoreMarketDataEngine.cache.getOrderBook(marketSymbol) ?? null;
    const cachedTrades = blackCoreMarketDataEngine.cache.getTrades(marketSymbol);
    const cachedTicker = blackCoreMarketDataEngine.cache.getTicker(marketSymbol) ?? null;
    const entry: FeedEntry = {
      key,
      snapshot: {
        marketSymbol,
        book: cachedBook,
        trades: cachedTrades.slice(-100).reverse(),
        ticker: cachedTicker,
        bookStatus: cachedBook ? "CACHE BOOK" : "AWAITING BOOK",
        tradeStatus: cachedTrades.length ? "CACHE TRADES" : "AWAITING TAPE",
        tickerStatus: cachedTicker ? "CACHE TICKER" : "AWAITING TICKER",
        subscriptionCount: 0,
        updatedAt: Date.now()
      },
      listeners: new Set(),
      seenTrades: new Set(cachedTrades.map((trade) => trade.tradeId)),
      seenTradeOrder: cachedTrades.map((trade) => trade.tradeId).slice(-3000)
    };
    this.entries.set(key, entry);
    return entry;
  }

  private start(entry: FeedEntry) {
    const adapter = blackCoreMarketDataEngine.getAdapter(entry.snapshot.marketSymbol.exchange);
    if (!entry.bookSubscription && adapter.subscribeOrderBook) {
      entry.bookSubscription = adapter.subscribeOrderBook(entry.snapshot.marketSymbol, (book) => {
        entry.snapshot = { ...entry.snapshot, book, bookStatus: "LIVE BOOK", updatedAt: Date.now() };
        this.notify(entry);
      });
      entry.bookSubscription.onError((error) => {
        entry.snapshot = { ...entry.snapshot, bookStatus: "REST BOOK", lastError: error.message, updatedAt: Date.now() };
        this.notify(entry);
        this.ensureBookPolling(entry);
      });
    }

    if (!entry.tradeSubscription && adapter.subscribeTrades) {
      entry.tradeSubscription = adapter.subscribeTrades(entry.snapshot.marketSymbol, (trade) => {
        this.pushTrades(entry, [trade], "LIVE TRADES");
      });
      entry.tradeSubscription.onError((error) => {
        entry.snapshot = { ...entry.snapshot, tradeStatus: "REST TRADES", lastError: error.message, updatedAt: Date.now() };
        this.notify(entry);
        this.ensureTradePolling(entry);
      });
    }

    this.pollBook(entry);
    this.pollTrades(entry);
    this.pollTicker(entry);
    if (!entry.bookSubscription) this.ensureBookPolling(entry);
    if (!entry.tradeSubscription) this.ensureTradePolling(entry);
    if (!entry.tickerPollTimer && typeof window !== "undefined") {
      entry.tickerPollTimer = window.setInterval(() => this.pollTicker(entry), 2500);
    }
  }

  private stop(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.bookSubscription?.unsubscribe();
    entry.tradeSubscription?.unsubscribe();
    if (typeof window !== "undefined") {
      if (entry.bookPollTimer) window.clearInterval(entry.bookPollTimer);
      if (entry.tradePollTimer) window.clearInterval(entry.tradePollTimer);
      if (entry.tickerPollTimer) window.clearInterval(entry.tickerPollTimer);
    }
    this.entries.delete(key);
  }

  private ensureBookPolling(entry: FeedEntry) {
    if (entry.bookPollTimer || typeof window === "undefined") return;
    entry.bookPollTimer = window.setInterval(() => this.pollBook(entry), 1000);
  }

  private ensureTradePolling(entry: FeedEntry) {
    if (entry.tradePollTimer || typeof window === "undefined") return;
    entry.tradePollTimer = window.setInterval(() => this.pollTrades(entry), 1000);
  }

  private pollBook(entry: FeedEntry) {
    const adapter = blackCoreMarketDataEngine.getAdapter(entry.snapshot.marketSymbol.exchange);
    if (!adapter.getOrderBookSnapshot) {
      entry.snapshot = { ...entry.snapshot, bookStatus: "NO BOOK ADAPTER", updatedAt: Date.now() };
      this.notify(entry);
      return;
    }
    adapter.getOrderBookSnapshot(entry.snapshot.marketSymbol, 1000)
      .then((book) => {
        if (!this.entries.has(entry.key)) return;
        entry.snapshot = {
          ...entry.snapshot,
          book: book ?? entry.snapshot.book,
          bookStatus: entry.bookSubscription ? entry.snapshot.bookStatus : "REST BOOK",
          updatedAt: Date.now()
        };
        this.notify(entry);
      })
      .catch((error: unknown) => {
        entry.snapshot = { ...entry.snapshot, bookStatus: "BOOK UNAVAILABLE", lastError: error instanceof Error ? error.message : String(error), updatedAt: Date.now() };
        this.notify(entry);
      });
  }

  private pollTrades(entry: FeedEntry) {
    const adapter = blackCoreMarketDataEngine.getAdapter(entry.snapshot.marketSymbol.exchange);
    if (!adapter.getRecentTrades) {
      entry.snapshot = { ...entry.snapshot, tradeStatus: "NO TAPE ADAPTER", updatedAt: Date.now() };
      this.notify(entry);
      return;
    }
    adapter.getRecentTrades(entry.snapshot.marketSymbol, 100)
      .then((trades) => {
        if (!this.entries.has(entry.key)) return;
        this.pushTrades(entry, trades, entry.tradeSubscription ? entry.snapshot.tradeStatus : "REST TRADES");
      })
      .catch((error: unknown) => {
        entry.snapshot = { ...entry.snapshot, tradeStatus: "TAPE UNAVAILABLE", lastError: error instanceof Error ? error.message : String(error), updatedAt: Date.now() };
        this.notify(entry);
      });
  }

  private pollTicker(entry: FeedEntry) {
    const adapter = blackCoreMarketDataEngine.getAdapter(entry.snapshot.marketSymbol.exchange);
    if (!adapter.getTickerSnapshot) {
      entry.snapshot = { ...entry.snapshot, tickerStatus: "DERIVED TICKER", updatedAt: Date.now() };
      this.notify(entry);
      return;
    }
    adapter.getTickerSnapshot(entry.snapshot.marketSymbol)
      .then((ticker) => {
        if (!this.entries.has(entry.key)) return;
        entry.snapshot = { ...entry.snapshot, ticker: ticker ?? entry.snapshot.ticker, tickerStatus: "REST TICKER", updatedAt: Date.now() };
        this.notify(entry);
      })
      .catch((error: unknown) => {
        entry.snapshot = { ...entry.snapshot, tickerStatus: "TICKER UNAVAILABLE", lastError: error instanceof Error ? error.message : String(error), updatedAt: Date.now() };
        this.notify(entry);
      });
  }

  private pushTrades(entry: FeedEntry, trades: TradeTick[], status: string) {
    const unseen = trades.filter((trade) => {
      if (entry.seenTrades.has(trade.tradeId)) return false;
      entry.seenTrades.add(trade.tradeId);
      entry.seenTradeOrder.push(trade.tradeId);
      if (entry.seenTradeOrder.length > 3000) {
        const expired = entry.seenTradeOrder.shift();
        if (expired) entry.seenTrades.delete(expired);
      }
      return true;
    });
    if (!unseen.length) return;

    entry.snapshot = {
      ...entry.snapshot,
      trades: [...unseen, ...entry.snapshot.trades].sort((a, b) => b.time - a.time).slice(0, 200),
      tradeStatus: status,
      updatedAt: Date.now()
    };
    this.notify(entry);
  }

  private notify(entry: FeedEntry) {
    entry.snapshot.subscriptionCount = entry.listeners.size;
    for (const listener of entry.listeners) listener(entry.snapshot);
  }
}

function feedKey(symbol: MarketSymbol) {
  return [symbol.exchange, symbol.marketKind, symbol.rawSymbol].join(":");
}

export const blackCoreDomFeedStore = new DomFeedStore();
