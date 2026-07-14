import { blackCoreMarketDataEngine } from "../../market-data/engine/marketDataEngine";
import type { MarketDataSubscription, MarketSymbol, OrderBookSnapshot, TickerSnapshot, TradeTick } from "../../market-data/types";
import { blackCorePerformanceMonitor } from "../../performance/performanceMonitor";
import { blackCoreResourceTracker } from "../../performance/resourceTracker";
import { domPerformanceTrace } from "./domPerformanceTrace";

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
  notifyTimer?: number;
  timerReleases: Array<() => void>;
  bookPollInFlight: boolean;
  tradePollInFlight: boolean;
  tickerPollInFlight: boolean;
  lastNotifiedAt: number;
  seenTrades: Set<string>;
  seenTradeOrder: string[];
};

export class DomFeedStore {
  private entries = new Map<string, FeedEntry>();
  private visibilityListenerInstalled = false;
  private releaseVisibilityListener: (() => void) | null = null;

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
      seenTradeOrder: cachedTrades.map((trade) => trade.tradeId).slice(-3000),
      timerReleases: [],
      bookPollInFlight: false,
      tradePollInFlight: false,
      tickerPollInFlight: false,
      lastNotifiedAt: 0
    };
    this.entries.set(key, entry);
    return entry;
  }

  private start(entry: FeedEntry) {
    this.ensureVisibilityListener();
    const adapter = blackCoreMarketDataEngine.getAdapter(entry.snapshot.marketSymbol.exchange);
    if (!entry.bookSubscription && adapter.subscribeOrderBook) {
      entry.bookSubscription = adapter.subscribeOrderBook(entry.snapshot.marketSymbol, (book) => {
        const startedAt = performance.now();
        entry.snapshot = { ...entry.snapshot, book, bookStatus: "LIVE BOOK", updatedAt: Date.now() };
        domPerformanceTrace.record("feed.receive_book", performance.now() - startedAt, book.bids.length + book.asks.length, 1);
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
      entry.timerReleases.push(blackCoreResourceTracker.acquire("interval", `dom-feed:${entry.key}:ticker`));
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
      if (entry.notifyTimer) window.clearTimeout(entry.notifyTimer);
    }
    entry.bookPollTimer = undefined;
    entry.tradePollTimer = undefined;
    entry.tickerPollTimer = undefined;
    entry.notifyTimer = undefined;
    entry.timerReleases.splice(0).forEach((release) => release());
    entry.bookSubscription = undefined;
    entry.tradeSubscription = undefined;
    this.entries.delete(key);
    if (this.entries.size === 0) this.removeVisibilityListener();
  }

  private ensureBookPolling(entry: FeedEntry) {
    if (entry.bookPollTimer || typeof window === "undefined") return;
    entry.timerReleases.push(blackCoreResourceTracker.acquire("interval", `dom-feed:${entry.key}:book`));
    entry.bookPollTimer = window.setInterval(() => this.pollBook(entry), 1000);
  }

  private ensureTradePolling(entry: FeedEntry) {
    if (entry.tradePollTimer || typeof window === "undefined") return;
    entry.timerReleases.push(blackCoreResourceTracker.acquire("interval", `dom-feed:${entry.key}:trades`));
    entry.tradePollTimer = window.setInterval(() => this.pollTrades(entry), 1000);
  }

  private pollBook(entry: FeedEntry) {
    if (entry.bookPollInFlight) return;
    const adapter = blackCoreMarketDataEngine.getAdapter(entry.snapshot.marketSymbol.exchange);
    if (!adapter.getOrderBookSnapshot) {
      entry.snapshot = { ...entry.snapshot, bookStatus: "NO BOOK ADAPTER", updatedAt: Date.now() };
      this.notify(entry);
      return;
    }
    entry.bookPollInFlight = true;
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
        if (!this.entries.has(entry.key)) return;
        entry.snapshot = { ...entry.snapshot, bookStatus: "BOOK UNAVAILABLE", lastError: error instanceof Error ? error.message : String(error), updatedAt: Date.now() };
        this.notify(entry);
      })
      .finally(() => { entry.bookPollInFlight = false; });
  }

  private pollTrades(entry: FeedEntry) {
    if (entry.tradePollInFlight) return;
    const adapter = blackCoreMarketDataEngine.getAdapter(entry.snapshot.marketSymbol.exchange);
    if (!adapter.getRecentTrades) {
      entry.snapshot = { ...entry.snapshot, tradeStatus: "NO TAPE ADAPTER", updatedAt: Date.now() };
      this.notify(entry);
      return;
    }
    entry.tradePollInFlight = true;
    adapter.getRecentTrades(entry.snapshot.marketSymbol, 100)
      .then((trades) => {
        if (!this.entries.has(entry.key)) return;
        this.pushTrades(entry, trades, entry.tradeSubscription ? entry.snapshot.tradeStatus : "REST TRADES");
      })
      .catch((error: unknown) => {
        if (!this.entries.has(entry.key)) return;
        entry.snapshot = { ...entry.snapshot, tradeStatus: "TAPE UNAVAILABLE", lastError: error instanceof Error ? error.message : String(error), updatedAt: Date.now() };
        this.notify(entry);
      })
      .finally(() => { entry.tradePollInFlight = false; });
  }

  private pollTicker(entry: FeedEntry) {
    if (entry.tickerPollInFlight) return;
    const adapter = blackCoreMarketDataEngine.getAdapter(entry.snapshot.marketSymbol.exchange);
    if (!adapter.getTickerSnapshot) {
      entry.snapshot = { ...entry.snapshot, tickerStatus: "DERIVED TICKER", updatedAt: Date.now() };
      this.notify(entry);
      return;
    }
    entry.tickerPollInFlight = true;
    adapter.getTickerSnapshot(entry.snapshot.marketSymbol)
      .then((ticker) => {
        if (!this.entries.has(entry.key)) return;
        entry.snapshot = { ...entry.snapshot, ticker: ticker ?? entry.snapshot.ticker, tickerStatus: "REST TICKER", updatedAt: Date.now() };
        this.notify(entry);
      })
      .catch((error: unknown) => {
        if (!this.entries.has(entry.key)) return;
        entry.snapshot = { ...entry.snapshot, tickerStatus: "TICKER UNAVAILABLE", lastError: error instanceof Error ? error.message : String(error), updatedAt: Date.now() };
        this.notify(entry);
      })
      .finally(() => { entry.tickerPollInFlight = false; });
  }

  private pushTrades(entry: FeedEntry, trades: TradeTick[], status: string) {
    const startedAt = performance.now();
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
    domPerformanceTrace.record("feed.receive_trades", performance.now() - startedAt, trades.length, unseen.length);
    this.notify(entry);
  }

  private notify(entry: FeedEntry) {
    if (!this.entries.has(entry.key)) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    const remaining = Math.max(0, 50 - (performance.now() - entry.lastNotifiedAt));
    if (remaining > 0) {
      if (!entry.notifyTimer) {
        entry.timerReleases.push(blackCoreResourceTracker.acquire("timeout", `dom-feed:${entry.key}:notify`));
        entry.notifyTimer = window.setTimeout(() => {
          entry.notifyTimer = undefined;
          const release = entry.timerReleases.pop();
          release?.();
          this.flushNotify(entry);
        }, remaining);
      }
      return;
    }
    this.flushNotify(entry);
  }

  private flushNotify(entry: FeedEntry) {
    if (!this.entries.has(entry.key)) return;
    entry.lastNotifiedAt = performance.now();
    entry.snapshot.subscriptionCount = entry.listeners.size;
    blackCorePerformanceMonitor.recordMetric("dom_feed.listeners", entry.listeners.size, "count", { feed: entry.key });
    const startedAt = performance.now();
    for (const listener of entry.listeners) listener(entry.snapshot);
    domPerformanceTrace.record("feed.snapshot_publish", performance.now() - startedAt, entry.listeners.size, 1);
  }

  private ensureVisibilityListener() {
    if (this.visibilityListenerInstalled || typeof document === "undefined") return;
    this.visibilityListenerInstalled = true;
    this.releaseVisibilityListener = blackCoreResourceTracker.acquire("listener", "dom-feed:visibility");
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  private removeVisibilityListener() {
    if (!this.visibilityListenerInstalled || typeof document === "undefined") return;
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.visibilityListenerInstalled = false;
    this.releaseVisibilityListener?.();
    this.releaseVisibilityListener = null;
  }

  private handleVisibilityChange = () => {
    if (document.visibilityState !== "visible") return;
    for (const entry of this.entries.values()) this.flushNotify(entry);
  };
}

function feedKey(symbol: MarketSymbol) {
  return [symbol.exchange, symbol.marketKind, symbol.rawSymbol].join(":");
}

export const blackCoreDomFeedStore = new DomFeedStore();
