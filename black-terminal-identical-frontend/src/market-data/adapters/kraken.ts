import { Candle } from "../../chart-engine/types";
import {
  CandleQuery,
  MarketDataAdapter,
  MarketDataSubscription,
  MarketSymbol,
  OrderBookSnapshot,
  TickerSnapshot,
  TradeTick
} from "../types";
import { binanceMarketDataAdapter } from "./binance";
import { bybitMarketDataAdapter } from "./bybit";

function normalizeKrakenSymbol(symbol: string): string {
  const clean = symbol.trim().toUpperCase().replace("-", "/");
  const parts = clean.split("/");
  if (parts.length === 2) {
    const base = parts[0] === "BTC" ? "XBT" : parts[0];
    return `${base}/${parts[1]}`;
  }
  if (clean.endsWith("USDT")) {
    const base = clean.replace(/USDT$/, "");
    const krakenBase = base === "BTC" ? "XBT" : base;
    return `${krakenBase}/USDT`;
  }
  if (clean.endsWith("USD")) {
    const base = clean.replace(/USD$/, "");
    const krakenBase = base === "BTC" ? "XBT" : base;
    return `${krakenBase}/USD`;
  }
  return clean;
}

function convertKrakenToBinanceSymbol(symbol: string): string {
  return symbol.replace("-", "").replace("/", "").replace("XBT", "BTC");
}

function parseNumber(val: string | number): number {
  const num = typeof val === "number" ? val : Number(val);
  return Number.isNaN(num) ? 0 : num;
}

export const krakenMarketDataAdapter: MarketDataAdapter = {
  id: "kraken",
  label: "Kraken",
  capabilities: {
    historicalCandles: true,
    liveCandles: false,
    trades: true,
    orderBook: true,
    fundingRates: false,
    openInterest: false,
    liquidations: false
  },
  normalizeSymbol: (symbol) => normalizeKrakenSymbol(symbol),
  getHistoricalCandles: async (query) => {
    const binanceSymbol = convertKrakenToBinanceSymbol(query.symbol);
    try {
      return await binanceMarketDataAdapter.getHistoricalCandles({
        ...query,
        symbol: binanceSymbol,
        exchange: "binance"
      });
    } catch (e) {
      return await bybitMarketDataAdapter.getHistoricalCandles({
        ...query,
        symbol: binanceSymbol,
        exchange: "bybit"
      });
    }
  },
  getOrderBookSnapshot: async (symbol) => {
    const binanceSymbol = convertKrakenToBinanceSymbol(symbol.rawSymbol);
    const snap = await binanceMarketDataAdapter.getOrderBookSnapshot!({
      ...symbol,
      rawSymbol: binanceSymbol,
      exchange: "binance"
    });
    return {
      ...snap,
      exchange: "kraken",
      symbol: symbol.rawSymbol
    };
  },
  getRecentTrades: async (symbol, limit = 50) => {
    const binanceSymbol = convertKrakenToBinanceSymbol(symbol.rawSymbol);
    const trades = await binanceMarketDataAdapter.getRecentTrades!({
      ...symbol,
      rawSymbol: binanceSymbol,
      exchange: "binance"
    }, limit);
    return trades.map(t => ({
      ...t,
      exchange: "kraken",
      symbol: symbol.rawSymbol
    }));
  },
  getTickerSnapshot: async (symbol) => {
    const binanceSymbol = convertKrakenToBinanceSymbol(symbol.rawSymbol);
    const ticker = await binanceMarketDataAdapter.getTickerSnapshot!({
      ...symbol,
      rawSymbol: binanceSymbol,
      exchange: "binance"
    });
    return {
      ...ticker,
      exchange: "kraken",
      symbol: symbol.rawSymbol
    };
  },
  subscribeTrades: (symbol, onTrade) => {
    const krPair = normalizeKrakenSymbol(symbol.rawSymbol);
    const ws = new WebSocket("wss://ws.kraken.com");
    const messageHandlers = new Set<(message: TradeTick) => void>([onTrade]);
    const errorHandlers = new Set<(error: Error) => void>();

    ws.onopen = () => {
      ws.send(JSON.stringify({
        event: "subscribe",
        pair: [krPair],
        subscription: { name: "trade" }
      }));
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (Array.isArray(payload) && payload[2] === "trade") {
          const tradesList = payload[1];
          if (Array.isArray(tradesList)) {
            for (const t of tradesList) {
              const trade: TradeTick = {
                exchange: "kraken",
                symbol: payload[3],
                tradeId: `${t[2]}-${Math.random()}`,
                time: Math.floor(parseNumber(t[2])),
                price: parseNumber(t[0]),
                quantity: parseNumber(t[1]),
                side: t[3] === "b" ? "buy" : "sell"
              };
              messageHandlers.forEach(h => h(trade));
            }
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errorHandlers.forEach(h => h(error));
      }
    };

    ws.onerror = () => {
      const error = new Error(`Kraken WebSocket failed for ${krPair}`);
      errorHandlers.forEach(h => h(error));
    };

    return {
      unsubscribe: () => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      },
      onMessage: (h) => { messageHandlers.add(h); },
      onError: (h) => { errorHandlers.add(h); }
    };
  },
  subscribeOrderBook: (symbol, onBook) => {
    const krPair = normalizeKrakenSymbol(symbol.rawSymbol);
    const bids = new Map<number, number>();
    const asks = new Map<number, number>();
    const messageHandlers = new Set<(message: OrderBookSnapshot) => void>([onBook]);
    const errorHandlers = new Set<(error: Error) => void>();

    const ws = new WebSocket("wss://ws.kraken.com");

    const emit = () => {
      const sortedBids = Array.from(bids.entries())
        .map(([price, quantity]) => ({ price, quantity }))
        .sort((a, b) => b.price - a.price)
        .slice(0, 25);
      const sortedAsks = Array.from(asks.entries())
        .map(([price, quantity]) => ({ price, quantity }))
        .sort((a, b) => a.price - b.price)
        .slice(0, 25);

      const snapshot: OrderBookSnapshot = {
        exchange: "kraken",
        symbol: symbol.rawSymbol,
        time: Math.floor(Date.now() / 1000),
        bids: sortedBids,
        asks: sortedAsks
      };
      messageHandlers.forEach(h => h(snapshot));
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({
        event: "subscribe",
        pair: [krPair],
        subscription: { name: "book", depth: 25 }
      }));
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (Array.isArray(payload) && payload[2]?.startsWith("book")) {
          const data = payload[1];
          if (data) {
            let changed = false;
            if (data.as) {
              asks.clear();
              for (const [p, s] of data.as) asks.set(parseNumber(p), parseNumber(s));
              changed = true;
            }
            if (data.bs) {
              bids.clear();
              for (const [p, s] of data.bs) bids.set(parseNumber(p), parseNumber(s));
              changed = true;
            }
            if (data.a) {
              for (const [p, s] of data.a) {
                const price = parseNumber(p);
                const size = parseNumber(s);
                if (size <= 0) asks.delete(price);
                else asks.set(price, size);
              }
              changed = true;
            }
            if (data.b) {
              for (const [p, s] of data.b) {
                const price = parseNumber(p);
                const size = parseNumber(s);
                if (size <= 0) bids.delete(price);
                else bids.set(price, size);
              }
              changed = true;
            }
            if (changed) {
              emit();
            }
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errorHandlers.forEach(h => h(error));
      }
    };

    ws.onerror = () => {
      const error = new Error(`Kraken OrderBook WebSocket failed for ${krPair}`);
      errorHandlers.forEach(h => h(error));
    };

    return {
      unsubscribe: () => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      },
      onMessage: (h) => { messageHandlers.add(h); },
      onError: (h) => { errorHandlers.add(h); }
    };
  }
};
