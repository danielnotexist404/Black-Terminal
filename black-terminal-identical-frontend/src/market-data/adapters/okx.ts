import { Candle } from "../../chart-engine/types";
import {
  CandleQuery,
  MarketDataAdapter,
  MarketDataSubscription,
  MarketSymbol,
  OrderBookSnapshot,
  TickerSnapshot,
  Timeframe,
  TradeTick
} from "../types";
import { marketDataFetchJson } from "../transport";

type OkxResponse<T> = {
  code: string;
  msg: string;
  data: T;
};

type OkxBook = {
  asks: string[][];
  bids: string[][];
  ts: string;
};

type OkxTrade = {
  instId: string;
  tradeId: string;
  px: string;
  sz: string;
  side: "buy" | "sell";
  ts: string;
};

type OkxInstrument = {
  instId: string;
  state: string;
  baseCcy: string;
  quoteCcy: string;
  instType: string;
  settleCcy?: string;
};

type OkxTicker = {
  instId: string;
  last: string;
  bidPx: string;
  bidSz: string;
  askPx: string;
  askSz: string;
  open24h: string;
  high24h: string;
  low24h: string;
  vol24h: string;
  volCcy24h: string;
  ts: string;
};

type OkxBookWs = {
  arg?: {
    channel: string;
    instId: string;
  };
  action?: "snapshot" | "update";
  data?: OkxBook[];
  event?: string;
  msg?: string;
};

const OKX_REST = "https://www.okx.com";
const OKX_WS = "wss://ws.okx.com:8443/ws/v5/public";

const timeframeMap: Partial<Record<Timeframe, string>> = {
  "1m": "1m",
  "3m": "3m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1H",
  "2h": "2H",
  "4h": "4H",
  "6h": "6H",
  "12h": "12H",
  "1d": "1D",
  "1w": "1W",
  "1M": "1M"
};

function normalizeOkxSymbol(symbol: string) {
  const normalized = symbol.trim().toUpperCase();
  if (normalized.includes("-")) return normalized;
  if (normalized.endsWith("USDT")) {
    return `${normalized.replace(/USDT$/, "")}-USDT-SWAP`;
  }
  return normalized;
}

function parseNumber(value: string | number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid OKX numeric value: ${value}`);
  }
  return parsed;
}

async function okxGet<T>(path: string, params: URLSearchParams) {
  const payload = await marketDataFetchJson<OkxResponse<T>>(`${OKX_REST}${path}?${params}`);
  if (payload.code !== "0") {
    throw new Error(`OKX request failed: ${payload.msg}`);
  }
  return payload.data;
}

function mapKline(row: string[]): Candle {
  return {
    time: Math.floor(parseNumber(row[0]) / 1000),
    open: parseNumber(row[1]),
    high: parseNumber(row[2]),
    low: parseNumber(row[3]),
    close: parseNumber(row[4]),
    volume: parseNumber(row[5])
  };
}

function mapBook(symbol: MarketSymbol, book: OkxBook): OrderBookSnapshot {
  return {
    exchange: "okx",
    symbol: symbol.rawSymbol,
    time: Math.floor(parseNumber(book.ts) / 1000),
    bids: book.bids.map(([price, quantity]) => ({ price: parseNumber(price), quantity: parseNumber(quantity) })),
    asks: book.asks.map(([price, quantity]) => ({ price: parseNumber(price), quantity: parseNumber(quantity) }))
  };
}

function mapTrade(symbol: MarketSymbol, trade: OkxTrade): TradeTick {
  return {
    exchange: "okx",
    symbol: symbol.rawSymbol,
    tradeId: trade.tradeId,
    time: Math.floor(parseNumber(trade.ts) / 1000),
    price: parseNumber(trade.px),
    quantity: parseNumber(trade.sz),
    side: trade.side
  };
}

function mapTicker(symbol: MarketSymbol, ticker: OkxTicker): TickerSnapshot {
  const lastPrice = parseNumber(ticker.last);
  const openPrice = parseNumber(ticker.open24h);
  return {
    exchange: "okx",
    symbol: symbol.rawSymbol,
    time: Math.floor(parseNumber(ticker.ts) / 1000),
    lastPrice,
    bidPrice: parseNumber(ticker.bidPx),
    askPrice: parseNumber(ticker.askPx),
    bidQuantity: parseNumber(ticker.bidSz),
    askQuantity: parseNumber(ticker.askSz),
    openPrice,
    highPrice: parseNumber(ticker.high24h),
    lowPrice: parseNumber(ticker.low24h),
    volume: parseNumber(ticker.vol24h),
    quoteVolume: parseNumber(ticker.volCcy24h),
    priceChange: lastPrice - openPrice,
    priceChangePercent: openPrice ? ((lastPrice - openPrice) / openPrice) * 100 : 0
  };
}

function sortedLevels(book: Map<number, number>, side: "bid" | "ask", limit = 400) {
  return [...book.entries()]
    .filter(([, quantity]) => quantity > 0)
    .sort(([a], [b]) => side === "bid" ? b - a : a - b)
    .slice(0, limit)
    .map(([price, quantity]) => ({ price, quantity }));
}

function createOkxOrderBookSubscription(
  symbol: MarketSymbol,
  onBook: (book: OrderBookSnapshot) => void
): MarketDataSubscription<OrderBookSnapshot> {
  const bids = new Map<number, number>();
  const asks = new Map<number, number>();
  const messageHandlers = new Set<(message: OrderBookSnapshot) => void>([onBook]);
  const errorHandlers = new Set<(error: Error) => void>();
  const ws = new WebSocket(OKX_WS);
  const instId = normalizeOkxSymbol(symbol.rawSymbol);

  const applyLevels = (levels: string[][], book: Map<number, number>) => {
    for (const [priceRaw, quantityRaw] of levels) {
      const price = parseNumber(priceRaw);
      const quantity = parseNumber(quantityRaw);
      if (quantity <= 0) book.delete(price);
      else book.set(price, quantity);
    }
  };

  const emit = (timeMs = Date.now()) => {
    const snapshot: OrderBookSnapshot = {
      exchange: "okx",
      symbol: symbol.rawSymbol,
      time: Math.floor(timeMs / 1000),
      bids: sortedLevels(bids, "bid"),
      asks: sortedLevels(asks, "ask")
    };
    messageHandlers.forEach((handler) => handler(snapshot));
  };

  const reportError = (err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    errorHandlers.forEach((handler) => handler(error));
  };

  ws.onopen = () => {
    ws.send(JSON.stringify({
      op: "subscribe",
      args: [{ channel: "books", instId }]
    }));
  };

  ws.onmessage = (event: MessageEvent<string>) => {
    try {
      const payload = JSON.parse(event.data) as OkxBookWs;
      if (payload.event === "error") {
        throw new Error(`OKX order book subscription failed: ${payload.msg ?? instId}`);
      }
      const book = payload.data?.[0];
      if (!book) return;

      if (payload.action === "snapshot") {
        bids.clear();
        asks.clear();
      }

      applyLevels(book.bids ?? [], bids);
      applyLevels(book.asks ?? [], asks);
      emit(parseNumber(book.ts));
    } catch (err) {
      reportError(err);
    }
  };

  ws.onerror = () => reportError(new Error(`OKX order book WebSocket failed: ${instId}`));

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

export const okxMarketDataAdapter: MarketDataAdapter = {
  id: "okx",
  label: "OKX",
  capabilities: {
    historicalCandles: true,
    liveCandles: false,
    trades: true,
    orderBook: true,
    fundingRates: true,
    openInterest: true,
    liquidations: true
  },
  normalizeSymbol: (symbol) => normalizeOkxSymbol(symbol),
  getSymbols: async () => {
    const params = new URLSearchParams({
      instType: "SWAP"
    });
    const data = await okxGet<OkxInstrument[]>("/api/v5/public/instruments", params);
    return data
      .filter((item) => item.state === "live" && item.instId.endsWith("-USDT-SWAP"))
      .map((item) => {
        const [baseAsset, quoteAsset] = item.instId.split("-");
        return {
          exchange: "okx",
          rawSymbol: item.instId,
          baseAsset: item.baseCcy || baseAsset,
          quoteAsset: item.quoteCcy || quoteAsset,
          marketKind: "perpetual"
        };
      });
  },
  getHistoricalCandles: async (query: CandleQuery) => {
    const bar = timeframeMap[query.timeframe];
    if (!bar) {
      throw new Error(`Unsupported OKX timeframe: ${query.timeframe}`);
    }

    const params = new URLSearchParams({
      instId: normalizeOkxSymbol(query.symbol),
      bar,
      limit: String(Math.min(query.limit ?? 300, 300))
    });
    if (query.to) params.set("after", String(query.to * 1000));
    if (query.from) params.set("before", String(query.from * 1000));

    const data = await okxGet<string[][]>("/api/v5/market/candles", params);
    return data.map(mapKline).sort((a, b) => a.time - b.time);
  },
  getOrderBookSnapshot: async (symbol, limit = 20) => {
    const params = new URLSearchParams({
      instId: normalizeOkxSymbol(symbol.rawSymbol),
      sz: String(Math.min(Math.max(limit, 1), 400))
    });
    const data = await okxGet<OkxBook[]>("/api/v5/market/books", params);
    if (!data[0]) {
      throw new Error("OKX order book response was empty");
    }
    return mapBook(symbol, data[0]);
  },
  getRecentTrades: async (symbol, limit = 50) => {
    const params = new URLSearchParams({
      instId: normalizeOkxSymbol(symbol.rawSymbol),
      limit: String(Math.min(Math.max(limit, 1), 100))
    });
    const data = await okxGet<OkxTrade[]>("/api/v5/market/trades", params);
    return data.map((trade) => mapTrade(symbol, trade)).sort((a, b) => a.time - b.time);
  },
  getTickerSnapshot: async (symbol) => {
    const params = new URLSearchParams({
      instId: normalizeOkxSymbol(symbol.rawSymbol)
    });
    const data = await okxGet<OkxTicker[]>("/api/v5/market/ticker", params);
    if (!data[0]) {
      throw new Error("OKX ticker response was empty");
    }
    return mapTicker(symbol, data[0]);
  },
  subscribeOrderBook: (symbol, onBook) => createOkxOrderBookSubscription(symbol, onBook)
};
