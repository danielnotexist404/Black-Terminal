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

function normalizeCoinbaseSymbol(symbol: string): string {
  const clean = symbol.trim().toUpperCase();
  if (clean.includes("-")) return clean;
  if (clean.includes("/")) return clean.replace("/", "-");
  if (clean.endsWith("USDT")) return `${clean.replace(/USDT$/, "")}-USDT`;
  if (clean.endsWith("USD")) return `${clean.replace(/USD$/, "")}-USD`;
  return `${clean}-USDT`;
}

function convertCoinbaseToBinanceSymbol(symbol: string): string {
  return symbol.replace("-", "").replace("/", "");
}

function parseNumber(val: string | number): number {
  const num = typeof val === "number" ? val : Number(val);
  return Number.isNaN(num) ? 0 : num;
}

export const coinbaseMarketDataAdapter: MarketDataAdapter = {
  id: "coinbase",
  label: "Coinbase",
  capabilities: {
    historicalCandles: true,
    liveCandles: false,
    trades: true,
    orderBook: true,
    fundingRates: false,
    openInterest: false,
    liquidations: false
  },
  normalizeSymbol: (symbol) => normalizeCoinbaseSymbol(symbol),
  getHistoricalCandles: async (query) => {
    const binanceSymbol = convertCoinbaseToBinanceSymbol(query.symbol);
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
    const binanceSymbol = convertCoinbaseToBinanceSymbol(symbol.rawSymbol);
    const snap = await binanceMarketDataAdapter.getOrderBookSnapshot!({
      ...symbol,
      rawSymbol: binanceSymbol,
      exchange: "binance"
    });
    return {
      ...snap,
      exchange: "coinbase",
      symbol: symbol.rawSymbol
    };
  },
  getRecentTrades: async (symbol, limit = 50) => {
    const binanceSymbol = convertCoinbaseToBinanceSymbol(symbol.rawSymbol);
    const trades = await binanceMarketDataAdapter.getRecentTrades!({
      ...symbol,
      rawSymbol: binanceSymbol,
      exchange: "binance"
    }, limit);
    return trades.map(t => ({
      ...t,
      exchange: "coinbase",
      symbol: symbol.rawSymbol
    }));
  },
  getTickerSnapshot: async (symbol) => {
    const binanceSymbol = convertCoinbaseToBinanceSymbol(symbol.rawSymbol);
    const ticker = await binanceMarketDataAdapter.getTickerSnapshot!({
      ...symbol,
      rawSymbol: binanceSymbol,
      exchange: "binance"
    });
    return {
      ...ticker,
      exchange: "coinbase",
      symbol: symbol.rawSymbol
    };
  },
  subscribeTrades: (symbol, onTrade) => {
    const cbSymbol = normalizeCoinbaseSymbol(symbol.rawSymbol);
    const ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");
    const messageHandlers = new Set<(message: TradeTick) => void>([onTrade]);
    const errorHandlers = new Set<(error: Error) => void>();

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "subscribe",
        product_ids: [cbSymbol],
        channels: ["matches"]
      }));
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "match" || payload.type === "last_match") {
          const trade: TradeTick = {
            exchange: "coinbase",
            symbol: payload.product_id,
            tradeId: String(payload.trade_id || payload.sequence),
            time: Math.floor(new Date(payload.time).getTime() / 1000),
            price: parseNumber(payload.price),
            quantity: parseNumber(payload.size),
            side: payload.side === "buy" ? "buy" : "sell"
          };
          messageHandlers.forEach(h => h(trade));
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errorHandlers.forEach(h => h(error));
      }
    };

    ws.onerror = () => {
      const error = new Error(`Coinbase WebSocket failed for ${cbSymbol}`);
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
    const cbSymbol = normalizeCoinbaseSymbol(symbol.rawSymbol);
    const bids = new Map<number, number>();
    const asks = new Map<number, number>();
    const messageHandlers = new Set<(message: OrderBookSnapshot) => void>([onBook]);
    const errorHandlers = new Set<(error: Error) => void>();

    const ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");

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
        exchange: "coinbase",
        symbol: symbol.rawSymbol,
        time: Math.floor(Date.now() / 1000),
        bids: sortedBids,
        asks: sortedAsks
      };
      messageHandlers.forEach(h => h(snapshot));
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "subscribe",
        product_ids: [cbSymbol],
        channels: ["level2"]
      }));
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "snapshot") {
          bids.clear();
          asks.clear();
          for (const [priceRaw, sizeRaw] of payload.bids) {
            bids.set(parseNumber(priceRaw), parseNumber(sizeRaw));
          }
          for (const [priceRaw, sizeRaw] of payload.asks) {
            asks.set(parseNumber(priceRaw), parseNumber(sizeRaw));
          }
          emit();
        } else if (payload.type === "l2update" && payload.changes) {
          for (const [side, priceRaw, sizeRaw] of payload.changes) {
            const price = parseNumber(priceRaw);
            const size = parseNumber(sizeRaw);
            if (side === "buy") {
              if (size <= 0) bids.delete(price);
              else bids.set(price, size);
            } else {
              if (size <= 0) asks.delete(price);
              else asks.set(price, size);
            }
          }
          emit();
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errorHandlers.forEach(h => h(error));
      }
    };

    ws.onerror = () => {
      const error = new Error(`Coinbase OrderBook WebSocket failed for ${cbSymbol}`);
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
