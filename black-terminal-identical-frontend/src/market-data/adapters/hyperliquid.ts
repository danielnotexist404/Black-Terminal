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

function normalizeHyperliquidSymbol(symbol: string): string {
  const clean = symbol.trim().toUpperCase();
  if (clean.includes("-")) return clean.split("-")[0];
  if (clean.includes("/")) return clean.split("/")[0];
  return clean.replace(/USDT$/, "").replace(/USD$/, "");
}

function convertHyperliquidToBinanceSymbol(symbol: string): string {
  const coin = normalizeHyperliquidSymbol(symbol);
  return `${coin}USDT`;
}

function parseNumber(val: string | number): number {
  const num = typeof val === "number" ? val : Number(val);
  return Number.isNaN(num) ? 0 : num;
}

export const hyperliquidMarketDataAdapter: MarketDataAdapter = {
  id: "hyperliquid",
  label: "Hyperliquid",
  capabilities: {
    historicalCandles: true,
    liveCandles: false,
    trades: true,
    orderBook: true,
    fundingRates: false,
    openInterest: false,
    liquidations: false
  },
  normalizeSymbol: (symbol) => normalizeHyperliquidSymbol(symbol),
  getHistoricalCandles: async (query) => {
    const binanceSymbol = convertHyperliquidToBinanceSymbol(query.symbol);
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
    const binanceSymbol = convertHyperliquidToBinanceSymbol(symbol.rawSymbol);
    const snap = await binanceMarketDataAdapter.getOrderBookSnapshot!({
      ...symbol,
      rawSymbol: binanceSymbol,
      exchange: "binance"
    });
    return {
      ...snap,
      exchange: "hyperliquid",
      symbol: symbol.rawSymbol
    };
  },
  getRecentTrades: async (symbol, limit = 50) => {
    const binanceSymbol = convertHyperliquidToBinanceSymbol(symbol.rawSymbol);
    const trades = await binanceMarketDataAdapter.getRecentTrades!({
      ...symbol,
      rawSymbol: binanceSymbol,
      exchange: "binance"
    }, limit);
    return trades.map(t => ({
      ...t,
      exchange: "hyperliquid",
      symbol: symbol.rawSymbol
    }));
  },
  getTickerSnapshot: async (symbol) => {
    const binanceSymbol = convertHyperliquidToBinanceSymbol(symbol.rawSymbol);
    const ticker = await binanceMarketDataAdapter.getTickerSnapshot!({
      ...symbol,
      rawSymbol: binanceSymbol,
      exchange: "binance"
    });
    return {
      ...ticker,
      exchange: "hyperliquid",
      symbol: symbol.rawSymbol
    };
  },
  subscribeTrades: (symbol, onTrade) => {
    const coin = normalizeHyperliquidSymbol(symbol.rawSymbol);
    const ws = new WebSocket("wss://api.hyperliquid.xyz/ws");
    const messageHandlers = new Set<(message: TradeTick) => void>([onTrade]);
    const errorHandlers = new Set<(error: Error) => void>();

    ws.onopen = () => {
      ws.send(JSON.stringify({
        method: "subscribe",
        subscription: { type: "trades", coin }
      }));
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.channel === "trades" && Array.isArray(payload.data)) {
          for (const t of payload.data) {
            if (t.coin === coin) {
              const trade: TradeTick = {
                exchange: "hyperliquid",
                symbol: symbol.rawSymbol,
                tradeId: `${t.time}-${Math.random()}`,
                time: Math.floor(t.time / 1000),
                price: parseNumber(t.px),
                quantity: parseNumber(t.sz),
                side: t.side === "B" ? "buy" : "sell"
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
      const error = new Error(`Hyperliquid WebSocket failed for ${coin}`);
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
    const coin = normalizeHyperliquidSymbol(symbol.rawSymbol);
    const bids = new Map<number, number>();
    const asks = new Map<number, number>();
    const messageHandlers = new Set<(message: OrderBookSnapshot) => void>([onBook]);
    const errorHandlers = new Set<(error: Error) => void>();

    const ws = new WebSocket("wss://api.hyperliquid.xyz/ws");

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
        exchange: "hyperliquid",
        symbol: symbol.rawSymbol,
        time: Math.floor(Date.now() / 1000),
        bids: sortedBids,
        asks: sortedAsks
      };
      messageHandlers.forEach(h => h(snapshot));
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({
        method: "subscribe",
        subscription: { type: "l2Book", coin }
      }));
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.channel === "l2Book" && payload.data && payload.data.coin === coin) {
          const rawLevels = payload.data.levels;
          if (Array.isArray(rawLevels) && rawLevels.length >= 2) {
            bids.clear();
            asks.clear();
            const rawBids = rawLevels[0];
            const rawAsks = rawLevels[1];
            for (const lv of rawBids) {
              bids.set(parseNumber(lv.px), parseNumber(lv.sz));
            }
            for (const lv of rawAsks) {
              asks.set(parseNumber(lv.px), parseNumber(lv.sz));
            }
            emit();
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errorHandlers.forEach(h => h(error));
      }
    };

    ws.onerror = () => {
      const error = new Error(`Hyperliquid OrderBook WebSocket failed for ${coin}`);
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
