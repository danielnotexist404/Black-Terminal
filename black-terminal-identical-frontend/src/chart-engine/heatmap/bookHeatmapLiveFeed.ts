import type { MarketDataAdapter, MarketDataSubscription, MarketSymbol, OrderBookSnapshot } from "../../market-data/types";
import { classifyBinanceDepthUpdate } from "../../market-data/orderBookIntegrity";
import { marketDataFetchJson } from "../../market-data/transport";

type BinanceDepthStream = {
  E?: number;
  T?: number;
  U?: number;
  u?: number;
  pu?: number;
  b?: [string, string][];
  a?: [string, string][];
};

type BinanceDepthRest = {
  lastUpdateId: number;
  E?: number;
  T?: number;
  bids: [string, string][];
  asks: [string, string][];
};

export type BookHeatmapOrderBookSource = {
  getOrderBookSnapshot?: (symbol: MarketSymbol, limit?: number) => Promise<OrderBookSnapshot>;
  subscribeOrderBook?: (symbol: MarketSymbol, onBook: (book: OrderBookSnapshot) => void) => MarketDataSubscription<OrderBookSnapshot>;
};

function binanceMarket(symbol: MarketSymbol) {
  const spot = symbol.marketKind === "spot" || symbol.marketKind === "margin";
  return {
    normalized: symbol.rawSymbol.replace(/[^a-zA-Z0-9]/g, "").toUpperCase(),
    rest: spot ? "https://api.binance.com/api/v3/depth" : "https://fapi.binance.com/fapi/v1/depth",
    websocket: spot ? "wss://stream.binance.com:9443/ws" : "wss://fstream.binance.com/ws"
  };
}

function number(value: string | number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid Binance Book Heatmap numeric value: ${value}`);
  return parsed;
}

function sortedLevels(book: Map<number, number>, side: "bid" | "ask", limit = 1_000) {
  return [...book.entries()]
    .filter(([, quantity]) => quantity > 0)
    .sort(([left], [right]) => side === "bid" ? right - left : left - right)
    .slice(0, limit)
    .map(([price, quantity]) => ({ price, quantity }));
}

function applyLevels(levels: [string, string][] | undefined, book: Map<number, number>) {
  for (const [priceRaw, quantityRaw] of levels ?? []) {
    const price = number(priceRaw);
    const quantity = number(quantityRaw);
    if (quantity <= 0) book.delete(price);
    else book.set(price, quantity);
  }
}

export async function getBinanceBookHeatmapSnapshot(symbol: MarketSymbol, limit = 1_000): Promise<OrderBookSnapshot> {
  const market = binanceMarket(symbol);
  const params = new URLSearchParams({ symbol: market.normalized, limit: String(Math.min(1_000, Math.max(5, limit))) });
  const snapshot = await marketDataFetchJson<BinanceDepthRest>(`${market.rest}?${params}`);
  return {
    exchange: "binance",
    symbol: symbol.rawSymbol,
    time: Math.floor((snapshot.T ?? snapshot.E ?? Date.now()) / 1_000),
    bids: snapshot.bids.map(([price, quantity]) => ({ price: number(price), quantity: number(quantity) })),
    asks: snapshot.asks.map(([price, quantity]) => ({ price: number(price), quantity: number(quantity) })),
    subscribedDepth: Math.min(1_000, Math.max(5, limit)),
    updateId: snapshot.lastUpdateId,
    sequence: snapshot.lastUpdateId
  };
}

export function subscribeBinanceBookHeatmap(
  symbol: MarketSymbol,
  onBook: (book: OrderBookSnapshot) => void
): MarketDataSubscription<OrderBookSnapshot> {
  const market = binanceMarket(symbol);
  const socket = new WebSocket(`${market.websocket}/${market.normalized.toLowerCase()}@depth@100ms`);
  const messageHandlers = new Set<(message: OrderBookSnapshot) => void>([onBook]);
  const errorHandlers = new Set<(error: Error) => void>();
  const bids = new Map<number, number>();
  const asks = new Map<number, number>();
  let lastUpdateId = 0;
  let previousFinalUpdateId = 0;
  let snapshotReady = false;
  let snapshotLoading = false;
  let queuedEvents: BinanceDepthStream[] = [];
  let disposed = false;
  let bootstrapGeneration = 0;
  let resyncPending = false;

  const reportError = (error: unknown) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    errorHandlers.forEach((handler) => handler(normalized));
  };

  const emit = (timeMs = Date.now()) => {
    if (disposed) return;
    const book: OrderBookSnapshot = {
      exchange: "binance",
      symbol: symbol.rawSymbol,
      time: Math.floor(timeMs / 1_000),
      bids: sortedLevels(bids, "bid"),
      asks: sortedLevels(asks, "ask"),
      subscribedDepth: 1_000,
      updateId: lastUpdateId,
      sequence: lastUpdateId || undefined
    };
    messageHandlers.forEach((handler) => handler(book));
  };

  const resync = () => {
    queuedEvents = [];
    snapshotReady = false;
    previousFinalUpdateId = 0;
    if (snapshotLoading) {
      resyncPending = true;
      return;
    }
    void bootstrapSnapshot();
  };

  const applyEvent = (payload: BinanceDepthStream) => {
    const finalUpdateId = payload.u ?? 0;
    const firstUpdateId = payload.U ?? finalUpdateId;
    if (!finalUpdateId) return;
    const continuity = classifyBinanceDepthUpdate(
      { snapshotReady, lastUpdateId, previousFinalUpdateId },
      { firstUpdateId, finalUpdateId, previousFinalUpdateId: payload.pu }
    );
    if (continuity === "buffer") {
      queuedEvents.push(payload);
      if (queuedEvents.length > 2_000) queuedEvents.splice(0, queuedEvents.length - 2_000);
      return;
    }
    if (continuity === "ignore") return;
    if (continuity === "resync") {
      resync();
      return;
    }
    applyLevels(payload.b, bids);
    applyLevels(payload.a, asks);
    previousFinalUpdateId = finalUpdateId;
    lastUpdateId = Math.max(lastUpdateId, finalUpdateId);
    emit(payload.T ?? payload.E ?? Date.now());
  };

  async function bootstrapSnapshot() {
    if (snapshotLoading || disposed) return;
    snapshotLoading = true;
    const generation = ++bootstrapGeneration;
    try {
      const params = new URLSearchParams({ symbol: market.normalized, limit: "1000" });
      const snapshot = await marketDataFetchJson<BinanceDepthRest>(`${market.rest}?${params}`);
      if (disposed || generation !== bootstrapGeneration) return;
      bids.clear();
      asks.clear();
      applyLevels(snapshot.bids, bids);
      applyLevels(snapshot.asks, asks);
      lastUpdateId = snapshot.lastUpdateId;
      previousFinalUpdateId = 0;
      snapshotReady = true;
      const buffered = queuedEvents;
      queuedEvents = [];
      const firstProcessable = buffered.findIndex((event) => (event.u ?? 0) >= lastUpdateId);
      if (firstProcessable >= 0) buffered.slice(firstProcessable).forEach(applyEvent);
      else emit(snapshot.T ?? snapshot.E ?? Date.now());
    } catch (error) {
      if (!disposed) reportError(error);
    } finally {
      if (generation === bootstrapGeneration) {
        snapshotLoading = false;
        if (resyncPending && !disposed) {
          resyncPending = false;
          void bootstrapSnapshot();
        }
      }
    }
  }

  socket.onmessage = (event: MessageEvent<string>) => {
    try {
      applyEvent(JSON.parse(event.data) as BinanceDepthStream);
    } catch (error) {
      reportError(error);
    }
  };
  socket.onerror = () => reportError(new Error(`Binance Book Heatmap WebSocket failed for ${market.normalized}.`));
  void bootstrapSnapshot();

  return {
    unsubscribe: () => {
      disposed = true;
      bootstrapGeneration += 1;
      queuedEvents = [];
      resyncPending = false;
      bids.clear();
      asks.clear();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1_000, "Book Heatmap Binance feed closed");
      }
    },
    onMessage: (handler) => messageHandlers.add(handler),
    onError: (handler) => errorHandlers.add(handler)
  };
}

export function bookHeatmapOrderBookSource(adapter: MarketDataAdapter): BookHeatmapOrderBookSource {
  if (adapter.id === "binance") {
    return {
      getOrderBookSnapshot: getBinanceBookHeatmapSnapshot,
      subscribeOrderBook: subscribeBinanceBookHeatmap
    };
  }
  return {
    getOrderBookSnapshot: adapter.getOrderBookSnapshot?.bind(adapter),
    subscribeOrderBook: adapter.subscribeOrderBook?.bind(adapter)
  };
}
