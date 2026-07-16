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

type BybitResponse<T> = {
  retCode: number;
  retMsg: string;
  result: T;
  time: number;
};

type BybitKlineResult = {
  symbol: string;
  category: string;
  list: string[][];
};

type BybitBookResult = {
  s: string;
  ts: number;
  b: string[][];
  a: string[][];
  u?: number;
  seq?: number;
};

type BybitTradeResult = {
  category: string;
  list: {
    execId: string;
    symbol: string;
    price: string;
    size: string;
    side: "Buy" | "Sell";
    time: string;
  }[];
};

type BybitInstrumentResult = {
  category: string;
  list: {
    symbol: string;
    status: string;
    baseCoin: string;
    quoteCoin: string;
    priceScale?: string;
    lotSizeFilter?: {
      qtyStep?: string;
    };
  }[];
};

type BybitTickerResult = {
  category: string;
  list: {
    symbol: string;
    lastPrice: string;
    bid1Price?: string;
    bid1Size?: string;
    ask1Price?: string;
    ask1Size?: string;
    prevPrice24h?: string;
    price24hPcnt?: string;
    highPrice24h?: string;
    lowPrice24h?: string;
    volume24h?: string;
    turnover24h?: string;
  }[];
};

type BybitOrderBookWs = {
  topic: string;
  type: "snapshot" | "delta";
  ts: number;
  data: {
    s: string;
    b: string[][];
    a: string[][];
    u?: number;
    seq?: number;
  };
};

const BYBIT_REST = "https://api.bybit.com";
const BYBIT_WS_LINEAR = "wss://stream.bybit.com/v5/public/linear";
const BYBIT_WS_SPOT = "wss://stream.bybit.com/v5/public/spot";

const timeframeMap: Partial<Record<Timeframe, string>> = {
  "1m": "1",
  "3m": "3",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "1h": "60",
  "2h": "120",
  "4h": "240",
  "6h": "360",
  "12h": "720",
  "1d": "D",
  "1w": "W",
  "1M": "M"
};

function categoryFor(marketKind: MarketKind) {
  return marketKind === "spot" || marketKind === "margin" ? "spot" : "linear";
}

function normalizeBybitSymbol(symbol: string) {
  return symbol.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function parseNumber(value: string | number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid Bybit numeric value: ${value}`);
  }
  return parsed;
}

async function bybitGet<T>(path: string, params: URLSearchParams) {
  const payload = await marketDataFetchJson<BybitResponse<T>>(`${BYBIT_REST}${path}?${params}`);
  if (payload.retCode !== 0) {
    throw new Error(`Bybit request failed: ${payload.retMsg}`);
  }
  return payload.result;
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

function mapBook(symbol: MarketSymbol, result: BybitBookResult): OrderBookSnapshot {
  return {
    exchange: "bybit",
    symbol: symbol.rawSymbol,
    time: Math.floor(result.ts / 1000),
    bids: result.b.map(([price, quantity]) => ({ price: parseNumber(price), quantity: parseNumber(quantity) })),
    asks: result.a.map(([price, quantity]) => ({ price: parseNumber(price), quantity: parseNumber(quantity) })),
    subscribedDepth: Math.max(result.b.length, result.a.length),
    updateId: result.u,
    sequence: result.seq
  };
}

function mapTrade(symbol: MarketSymbol, trade: BybitTradeResult["list"][number]): TradeTick {
  return {
    exchange: "bybit",
    symbol: symbol.rawSymbol,
    tradeId: trade.execId,
    time: Math.floor(parseNumber(trade.time) / 1000),
    price: parseNumber(trade.price),
    quantity: parseNumber(trade.size),
    side: trade.side === "Sell" ? "sell" : "buy"
  };
}

function mapTicker(symbol: MarketSymbol, item: BybitTickerResult["list"][number]): TickerSnapshot {
  const lastPrice = parseNumber(item.lastPrice);
  const openPrice = item.prevPrice24h ? parseNumber(item.prevPrice24h) : undefined;
  return {
    exchange: "bybit",
    symbol: symbol.rawSymbol,
    time: Math.floor(Date.now() / 1000),
    lastPrice,
    bidPrice: item.bid1Price ? parseNumber(item.bid1Price) : undefined,
    askPrice: item.ask1Price ? parseNumber(item.ask1Price) : undefined,
    bidQuantity: item.bid1Size ? parseNumber(item.bid1Size) : undefined,
    askQuantity: item.ask1Size ? parseNumber(item.ask1Size) : undefined,
    openPrice,
    highPrice: item.highPrice24h ? parseNumber(item.highPrice24h) : undefined,
    lowPrice: item.lowPrice24h ? parseNumber(item.lowPrice24h) : undefined,
    volume: item.volume24h ? parseNumber(item.volume24h) : undefined,
    quoteVolume: item.turnover24h ? parseNumber(item.turnover24h) : undefined,
    priceChange: openPrice ? lastPrice - openPrice : undefined,
    priceChangePercent: item.price24hPcnt ? parseNumber(item.price24hPcnt) * 100 : undefined
  };
}

function sortedLevels(book: Map<number, number>, side: "bid" | "ask", limit = 200) {
  return [...book.entries()]
    .filter(([, quantity]) => quantity > 0)
    .sort(([a], [b]) => side === "bid" ? b - a : a - b)
    .slice(0, limit)
    .map(([price, quantity]) => ({ price, quantity }));
}

function createBybitOrderBookSubscription(
  symbol: MarketSymbol,
  onBook: (book: OrderBookSnapshot) => void
): MarketDataSubscription<OrderBookSnapshot> {
  const bids = new Map<number, number>();
  const asks = new Map<number, number>();
  const messageHandlers = new Set<(message: OrderBookSnapshot) => void>([onBook]);
  const errorHandlers = new Set<(error: Error) => void>();
  const depth = symbol.marketKind === "spot" || symbol.marketKind === "margin" ? 50 : 200;
  let updateId: number | undefined;
  let sequence: number | undefined;
  const ws = new WebSocket(categoryFor(symbol.marketKind) === "spot" ? BYBIT_WS_SPOT : BYBIT_WS_LINEAR);
  const topic = `orderbook.${depth}.${normalizeBybitSymbol(symbol.rawSymbol)}`;

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
      exchange: "bybit",
      symbol: symbol.rawSymbol,
      time: Math.floor(timeMs / 1000),
      bids: sortedLevels(bids, "bid", depth),
      asks: sortedLevels(asks, "ask", depth),
      subscribedDepth: depth,
      updateId,
      sequence
    };
    messageHandlers.forEach((handler) => handler(snapshot));
  };

  const reportError = (err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    errorHandlers.forEach((handler) => handler(error));
  };

  ws.onopen = () => {
    ws.send(JSON.stringify({ op: "subscribe", args: [topic] }));
  };

  ws.onmessage = (event: MessageEvent<string>) => {
    try {
      const payload = JSON.parse(event.data) as Partial<BybitOrderBookWs> & { success?: boolean; ret_msg?: string };
      if (payload.success === false) {
        throw new Error(`Bybit order book subscription failed: ${payload.ret_msg ?? topic}`);
      }
      if (!payload.topic?.startsWith("orderbook.") || !payload.data) return;

      if (payload.type === "snapshot") {
        bids.clear();
        asks.clear();
      }

      applyLevels(payload.data.b ?? [], bids);
      applyLevels(payload.data.a ?? [], asks);
      updateId = payload.data.u;
      sequence = payload.data.seq;
      emit(payload.ts ?? Date.now());
    } catch (err) {
      reportError(err);
    }
  };

  ws.onerror = () => reportError(new Error(`Bybit order book WebSocket failed: ${topic}`));

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

export const bybitMarketDataAdapter: MarketDataAdapter = {
  id: "bybit",
  label: "Bybit",
  capabilities: {
    historicalCandles: true,
    liveCandles: false,
    trades: true,
    orderBook: true,
    fundingRates: true,
    openInterest: true,
    liquidations: true
  },
  normalizeSymbol: (symbol) => normalizeBybitSymbol(symbol),
  getSymbols: async (marketKind = "perpetual") => {
    const params = new URLSearchParams({
      category: categoryFor(marketKind),
      limit: "1000"
    });
    const result = await bybitGet<BybitInstrumentResult>("/v5/market/instruments-info", params);
    return result.list
      .filter((item) => item.status === "Trading" && item.quoteCoin === "USDT")
      .map((item) => ({
        exchange: "bybit",
        rawSymbol: item.symbol,
        baseAsset: item.baseCoin,
        quoteAsset: item.quoteCoin,
        marketKind,
        pricePrecision: item.priceScale ? Number(item.priceScale) : undefined
      }));
  },
  getHistoricalCandles: async (query: CandleQuery) => {
    const interval = timeframeMap[query.timeframe];
    if (!interval) {
      throw new Error(`Unsupported Bybit timeframe: ${query.timeframe}`);
    }

    const params = new URLSearchParams({
      category: categoryFor(query.marketKind),
      symbol: normalizeBybitSymbol(query.symbol),
      interval,
      limit: String(Math.min(query.limit ?? 500, 1000))
    });

    if (query.from) params.set("start", String(query.from * 1000));
    if (query.to) params.set("end", String(query.to * 1000));

    const result = await bybitGet<BybitKlineResult>("/v5/market/kline", params);
    return result.list.map(mapKline).sort((a, b) => a.time - b.time);
  },
  getOrderBookSnapshot: async (symbol, limit = 25) => {
    const params = new URLSearchParams({
      category: categoryFor(symbol.marketKind),
      symbol: normalizeBybitSymbol(symbol.rawSymbol),
      limit: String(Math.min(Math.max(limit, 1), 200))
    });
    const result = await bybitGet<BybitBookResult>("/v5/market/orderbook", params);
    return mapBook(symbol, result);
  },
  getRecentTrades: async (symbol, limit = 50) => {
    const params = new URLSearchParams({
      category: categoryFor(symbol.marketKind),
      symbol: normalizeBybitSymbol(symbol.rawSymbol),
      limit: String(Math.min(Math.max(limit, 1), 1000))
    });
    const result = await bybitGet<BybitTradeResult>("/v5/market/recent-trade", params);
    return result.list.map((trade) => mapTrade(symbol, trade)).sort((a, b) => a.time - b.time);
  },
  getTickerSnapshot: async (symbol) => {
    const params = new URLSearchParams({
      category: categoryFor(symbol.marketKind),
      symbol: normalizeBybitSymbol(symbol.rawSymbol)
    });
    const result = await bybitGet<BybitTickerResult>("/v5/market/tickers", params);
    const ticker = result.list[0];
    if (!ticker) {
      throw new Error("Bybit ticker response was empty");
    }
    return mapTicker(symbol, ticker);
  },
  subscribeOrderBook: (symbol, onBook) => createBybitOrderBookSubscription(symbol, onBook)
};
