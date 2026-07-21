import { Candle } from "../../chart-engine/types";
import {
  CandleQuery,
  MarketDataAdapter,
  MarketDataSubscription,
  MarketKind,
  MarketSymbol,
  OrderBookSnapshot,
  TickerSnapshot,
  Timeframe,
  TradeTick
} from "../types";
import { marketDataFetchJson } from "../transport";

type BinanceKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string
];

type BinanceStreamEnvelope<T> = T | { stream: string; data: T };

type BinanceKlineStream = {
  e: "kline";
  E: number;
  s: string;
  k: {
    t: number;
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
  };
};

type BinanceTradeStream = {
  e: "trade" | "aggTrade";
  E: number;
  s: string;
  t?: number;
  a?: number;
  T: number;
  p: string;
  q: string;
  m: boolean;
};

type BinanceDepthStream = {
  e?: "depthUpdate";
  E?: number;
  s?: string;
  U?: number;
  u?: number;
  pu?: number;
  lastUpdateId?: number;
  T?: number;
  bids?: [string, string][];
  asks?: [string, string][];
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

type BinanceRecentTradeRest = {
  id: number;
  price: string;
  qty: string;
  time: number;
  isBuyerMaker: boolean;
};

type BinanceExchangeInfo = {
  symbols: {
    symbol: string;
    status: string;
    baseAsset: string;
    quoteAsset: string;
    contractType?: string;
    pricePrecision?: number;
    quantityPrecision?: number;
  }[];
};

type BinanceTickerRest = {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  lastPrice: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
  bidPrice?: string;
  bidQty?: string;
  askPrice?: string;
  askQty?: string;
  closeTime?: number;
};

const BINANCE_SPOT_REST = "https://api.binance.com";
const BINANCE_USDM_REST = "https://fapi.binance.com";
const BINANCE_SPOT_WS = "wss://stream.binance.com:9443/ws";
const BINANCE_USDM_WS = "wss://fstream.binance.com/ws";

const supportedTimeframes: Timeframe[] = [
  "1s",
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "8h",
  "12h",
  "1d",
  "1w",
  "1M"
];

function restBaseFor(marketKind: MarketKind) {
  return marketKind === "spot" || marketKind === "margin" ? BINANCE_SPOT_REST : BINANCE_USDM_REST;
}

function wsBaseFor(marketKind: MarketKind) {
  return marketKind === "spot" || marketKind === "margin" ? BINANCE_SPOT_WS : BINANCE_USDM_WS;
}

function klinePathFor(marketKind: MarketKind) {
  return marketKind === "spot" || marketKind === "margin" ? "/api/v3/klines" : "/fapi/v1/klines";
}

function depthPathFor(marketKind: MarketKind) {
  return marketKind === "spot" || marketKind === "margin" ? "/api/v3/depth" : "/fapi/v1/depth";
}

function tradesPathFor(marketKind: MarketKind) {
  return marketKind === "spot" || marketKind === "margin" ? "/api/v3/trades" : "/fapi/v1/trades";
}

function tickerPathFor(marketKind: MarketKind) {
  return marketKind === "spot" || marketKind === "margin" ? "/api/v3/ticker/24hr" : "/fapi/v1/ticker/24hr";
}

function normalizeBinanceSymbol(symbol: string) {
  return symbol.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function parseNumber(value: string | number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid Binance numeric value: ${value}`);
  }
  return parsed;
}

function mapKline(row: BinanceKline): Candle {
  return {
    time: Math.floor(row[0] / 1000),
    open: parseNumber(row[1]),
    high: parseNumber(row[2]),
    low: parseNumber(row[3]),
    close: parseNumber(row[4]),
    volume: parseNumber(row[5])
  };
}

function mapKlineStream(payload: BinanceKlineStream): Candle {
  return {
    time: Math.floor(payload.k.t / 1000),
    open: parseNumber(payload.k.o),
    high: parseNumber(payload.k.h),
    low: parseNumber(payload.k.l),
    close: parseNumber(payload.k.c),
    volume: parseNumber(payload.k.v)
  };
}

function mapDepthSnapshot(symbol: MarketSymbol, payload: BinanceDepthRest): OrderBookSnapshot {
  return {
    exchange: "binance",
    symbol: symbol.rawSymbol,
    time: Math.floor((payload.T ?? payload.E ?? Date.now()) / 1000),
    bids: payload.bids.map(([price, quantity]) => ({ price: parseNumber(price), quantity: parseNumber(quantity) })),
    asks: payload.asks.map(([price, quantity]) => ({ price: parseNumber(price), quantity: parseNumber(quantity) }))
  };
}

function mapRecentTrade(symbol: MarketSymbol, payload: BinanceRecentTradeRest): TradeTick {
  return {
    exchange: "binance",
    symbol: symbol.rawSymbol,
    tradeId: String(payload.id),
    time: Math.floor(payload.time / 1000),
    price: parseNumber(payload.price),
    quantity: parseNumber(payload.qty),
    side: payload.isBuyerMaker ? "sell" : "buy"
  };
}

function mapTicker(symbol: MarketSymbol, payload: BinanceTickerRest): TickerSnapshot {
  return {
    exchange: "binance",
    symbol: symbol.rawSymbol,
    time: Math.floor((payload.closeTime ?? Date.now()) / 1000),
    lastPrice: parseNumber(payload.lastPrice),
    bidPrice: payload.bidPrice ? parseNumber(payload.bidPrice) : undefined,
    askPrice: payload.askPrice ? parseNumber(payload.askPrice) : undefined,
    bidQuantity: payload.bidQty ? parseNumber(payload.bidQty) : undefined,
    askQuantity: payload.askQty ? parseNumber(payload.askQty) : undefined,
    openPrice: parseNumber(payload.openPrice),
    highPrice: parseNumber(payload.highPrice),
    lowPrice: parseNumber(payload.lowPrice),
    volume: parseNumber(payload.volume),
    quoteVolume: parseNumber(payload.quoteVolume),
    priceChange: parseNumber(payload.priceChange),
    priceChangePercent: parseNumber(payload.priceChangePercent)
  };
}

function readEnvelope<T extends object>(event: MessageEvent<string>) {
  const parsed = JSON.parse(event.data) as BinanceStreamEnvelope<T>;
  return "data" in parsed ? parsed.data : parsed;
}

function createSubscription<T>(
  url: string,
  mapMessage: (event: MessageEvent<string>) => T | undefined,
  initialHandler: (message: T) => void
): MarketDataSubscription<T> {
  const ws = new WebSocket(url);
  const messageHandlers = new Set<(message: T) => void>([initialHandler]);
  const errorHandlers = new Set<(error: Error) => void>();

  ws.onmessage = (event: MessageEvent<string>) => {
    try {
      const message = mapMessage(event);
      if (!message) return;
      messageHandlers.forEach((handler) => handler(message));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      errorHandlers.forEach((handler) => handler(error));
    }
  };

  ws.onerror = () => {
    const error = new Error(`Binance WebSocket failed: ${url}`);
    errorHandlers.forEach((handler) => handler(error));
  };

  return {
    unsubscribe: () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, "Black-Terminal subscription closed");
      }
    },
    onMessage: (handler) => {
      messageHandlers.add(handler);
    },
    onError: (handler) => {
      errorHandlers.add(handler);
    }
  };
}

function sortedLevels(book: Map<number, number>, side: "bid" | "ask", limit = 1000) {
  return [...book.entries()]
    .filter(([, quantity]) => quantity > 0)
    .sort(([a], [b]) => side === "bid" ? b - a : a - b)
    .slice(0, limit)
    .map(([price, quantity]) => ({ price, quantity }));
}

function createBinanceOrderBookSubscription(
  symbol: MarketSymbol,
  onBook: (book: OrderBookSnapshot) => void
): MarketDataSubscription<OrderBookSnapshot> {
  const normalizedSymbol = normalizeBinanceSymbol(symbol.rawSymbol);
  const streamName = `${normalizedSymbol.toLowerCase()}@depth@100ms`;
  const ws = new WebSocket(`${wsBaseFor(symbol.marketKind)}/${streamName}`);
  const messageHandlers = new Set<(message: OrderBookSnapshot) => void>([onBook]);
  const errorHandlers = new Set<(error: Error) => void>();
  const bids = new Map<number, number>();
  const asks = new Map<number, number>();
  let lastUpdateId = 0;
  let previousFinalUpdateId = 0;
  let snapshotReady = false;
  let snapshotLoading = false;
  let queuedEvents: BinanceDepthStream[] = [];

  const emit = (timeMs = Date.now()) => {
    const book: OrderBookSnapshot = {
      exchange: "binance",
      symbol: symbol.rawSymbol,
      time: Math.floor(timeMs / 1000),
      bids: sortedLevels(bids, "bid"),
      asks: sortedLevels(asks, "ask")
    };
    messageHandlers.forEach((handler) => handler(book));
  };

  const applyLevels = (levels: [string, string][] | undefined, book: Map<number, number>) => {
    for (const [priceRaw, quantityRaw] of levels ?? []) {
      const price = parseNumber(priceRaw);
      const quantity = parseNumber(quantityRaw);
      if (quantity <= 0) book.delete(price);
      else book.set(price, quantity);
    }
  };

  const reportError = (err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    errorHandlers.forEach((handler) => handler(error));
  };

  const bootstrapSnapshot = async () => {
    if (snapshotLoading) return;
    snapshotLoading = true;
    snapshotReady = false;
    previousFinalUpdateId = 0;

    try {
      const params = new URLSearchParams({
        symbol: normalizedSymbol,
        limit: "1000"
      });
      const snapshot = await marketDataFetchJson<BinanceDepthRest>(
        `${restBaseFor(symbol.marketKind)}${depthPathFor(symbol.marketKind)}?${params}`
      );

      bids.clear();
      asks.clear();
      applyLevels(snapshot.bids, bids);
      applyLevels(snapshot.asks, asks);
      lastUpdateId = snapshot.lastUpdateId;
      snapshotReady = true;
      snapshotLoading = false;

      const buffered = queuedEvents;
      queuedEvents = [];
      const firstProcessable = buffered.findIndex((event) => (event.u ?? 0) >= lastUpdateId);
      if (firstProcessable >= 0) {
        buffered.slice(firstProcessable).forEach((event) => applyEvent(event));
      } else {
        emit(snapshot.T ?? snapshot.E ?? Date.now());
      }
    } catch (err) {
      snapshotLoading = false;
      reportError(err);
    }
  };

  const resync = () => {
    queuedEvents = [];
    void bootstrapSnapshot();
  };

  const applyEvent = (payload: BinanceDepthStream) => {
    const finalUpdateId = payload.u ?? payload.lastUpdateId ?? 0;
    const firstUpdateId = payload.U ?? finalUpdateId;
    if (!finalUpdateId) return;
    if (!snapshotReady) {
      queuedEvents.push(payload);
      return;
    }
    if (finalUpdateId < lastUpdateId) return;

    if (previousFinalUpdateId > 0 && payload.pu && payload.pu !== previousFinalUpdateId) {
      resync();
      return;
    }

    if (previousFinalUpdateId === 0 && firstUpdateId > lastUpdateId + 1) {
      resync();
      return;
    }

    applyLevels(payload.b, bids);
    applyLevels(payload.a, asks);
    previousFinalUpdateId = finalUpdateId;
    lastUpdateId = Math.max(lastUpdateId, finalUpdateId);
    emit(payload.T ?? payload.E ?? Date.now());
  };

  ws.onmessage = (event: MessageEvent<string>) => {
    try {
      const payload = readEnvelope<BinanceDepthStream>(event);
      applyEvent(payload);
    } catch (err) {
      reportError(err);
    }
  };

  ws.onerror = () => {
    reportError(new Error(`Binance order book WebSocket failed: ${streamName}`));
  };

  void bootstrapSnapshot();

  return {
    unsubscribe: () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, "Black-Terminal order book closed");
      }
    },
    onMessage: (handler) => {
      messageHandlers.add(handler);
    },
    onError: (handler) => {
      errorHandlers.add(handler);
    }
  };
}

export const binanceMarketDataAdapter: MarketDataAdapter = {
  id: "binance",
  label: "Binance",
  capabilities: {
    historicalCandles: true,
    liveCandles: true,
    trades: true,
    orderBook: true,
    fundingRates: true,
    openInterest: true,
    liquidations: true
  },
  normalizeSymbol: (symbol) => normalizeBinanceSymbol(symbol),
  getSymbols: async (marketKind = "perpetual") => {
    const payload = await marketDataFetchJson<BinanceExchangeInfo>(
      `${restBaseFor(marketKind)}${marketKind === "spot" || marketKind === "margin" ? "/api/v3/exchangeInfo" : "/fapi/v1/exchangeInfo"}`
    );
    return payload.symbols
      .filter((item) => {
        const isTrading = item.status === "TRADING";
        const isUsdt = item.quoteAsset === "USDT";
        const isPerpetual = marketKind === "spot" || marketKind === "margin" || item.contractType === "PERPETUAL";
        return isTrading && isUsdt && isPerpetual;
      })
      .map((item) => ({
        exchange: "binance",
        rawSymbol: item.symbol,
        baseAsset: item.baseAsset,
        quoteAsset: item.quoteAsset,
        marketKind,
        pricePrecision: item.pricePrecision,
        quantityPrecision: item.quantityPrecision
      }));
  },
  getHistoricalCandles: async (query: CandleQuery) => {
    if (!supportedTimeframes.includes(query.timeframe)) {
      throw new Error(`Unsupported Binance timeframe: ${query.timeframe}`);
    }

    const params = new URLSearchParams({
      symbol: normalizeBinanceSymbol(query.symbol),
      interval: query.timeframe,
      limit: String(Math.min(query.limit ?? 500, 1000))
    });

    if (query.from) params.set("startTime", String(query.from * 1000));
    if (query.to) params.set("endTime", String(query.to * 1000));

    const payload = await marketDataFetchJson<BinanceKline[]>(
      `${restBaseFor(query.marketKind)}${klinePathFor(query.marketKind)}?${params}`
    );
    return payload.map(mapKline);
  },
  getOrderBookSnapshot: async (symbol, limit = 20) => {
    const params = new URLSearchParams({
      symbol: normalizeBinanceSymbol(symbol.rawSymbol),
      limit: String(Math.min(Math.max(limit, 5), 1000))
    });
    const payload = await marketDataFetchJson<BinanceDepthRest>(
      `${restBaseFor(symbol.marketKind)}${depthPathFor(symbol.marketKind)}?${params}`
    );
    return mapDepthSnapshot(symbol, payload);
  },
  getRecentTrades: async (symbol, limit = 50) => {
    const params = new URLSearchParams({
      symbol: normalizeBinanceSymbol(symbol.rawSymbol),
      limit: String(Math.min(Math.max(limit, 1), 1000))
    });
    const payload = await marketDataFetchJson<BinanceRecentTradeRest[]>(
      `${restBaseFor(symbol.marketKind)}${tradesPathFor(symbol.marketKind)}?${params}`
    );
    return payload.map((trade) => mapRecentTrade(symbol, trade));
  },
  getTickerSnapshot: async (symbol) => {
    const params = new URLSearchParams({
      symbol: normalizeBinanceSymbol(symbol.rawSymbol)
    });
    const payload = await marketDataFetchJson<BinanceTickerRest>(
      `${restBaseFor(symbol.marketKind)}${tickerPathFor(symbol.marketKind)}?${params}`
    );
    return mapTicker(symbol, payload);
  },
  subscribeCandles: (query, onCandle) => {
    const streamName = `${normalizeBinanceSymbol(query.symbol).toLowerCase()}@kline_${query.timeframe}`;
    return createSubscription<Candle>(
      `${wsBaseFor(query.marketKind)}/${streamName}`,
      (event) => mapKlineStream(readEnvelope<BinanceKlineStream>(event)),
      onCandle
    );
  },
  subscribeTrades: (symbol: MarketSymbol, onTrade) => {
    const tradeStream = symbol.marketKind === "spot" || symbol.marketKind === "margin" ? "trade" : "aggTrade";
    const streamName = `${normalizeBinanceSymbol(symbol.rawSymbol).toLowerCase()}@${tradeStream}`;
    return createSubscription<TradeTick>(
      `${wsBaseFor(symbol.marketKind)}/${streamName}`,
      (event) => {
        const payload = readEnvelope<BinanceTradeStream>(event);
        return {
          exchange: "binance",
          symbol: payload.s,
          tradeId: String(payload.t ?? payload.a ?? payload.T),
          time: Math.floor(payload.T / 1000),
          price: parseNumber(payload.p),
          quantity: parseNumber(payload.q),
          side: payload.m ? "sell" : "buy"
        };
      },
      onTrade
    );
  },
  subscribeOrderBook: (symbol: MarketSymbol, onBook) => {
    return createBinanceOrderBookSubscription(symbol, onBook);
  }
};
