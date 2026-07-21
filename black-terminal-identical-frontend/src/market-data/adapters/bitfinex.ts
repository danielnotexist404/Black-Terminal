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

function normalizeBitfinexSymbol(symbol: string): string {
  const clean = symbol.trim().toUpperCase().replace("-", "").replace("/", "");
  const base = clean.replace(/USDT$/, "UST");
  return `t${base}`;
}

function convertBitfinexToBinanceSymbol(symbol: string): string {
  return symbol.replace("t", "").replace("UST", "USDT");
}

function parseNumber(val: string | number): number {
  const num = typeof val === "number" ? val : Number(val);
  return Number.isNaN(num) ? 0 : num;
}

export const bitfinexMarketDataAdapter: MarketDataAdapter = {
  id: "bitfinex",
  label: "Bitfinex",
  capabilities: {
    historicalCandles: true,
    liveCandles: false,
    trades: true,
    orderBook: true,
    fundingRates: false,
    openInterest: false,
    liquidations: false
  },
  normalizeSymbol: (symbol) => normalizeBitfinexSymbol(symbol),
  getHistoricalCandles: async (query) => {
    const binanceSymbol = convertBitfinexToBinanceSymbol(query.symbol);
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
    const binanceSymbol = convertBitfinexToBinanceSymbol(symbol.rawSymbol);
    const snap = await binanceMarketDataAdapter.getOrderBookSnapshot!({
      ...symbol,
      rawSymbol: binanceSymbol,
      exchange: "binance"
    });
    return {
      ...snap,
      exchange: "bitfinex",
      symbol: symbol.rawSymbol
    };
  },
  getRecentTrades: async (symbol, limit = 50) => {
    const binanceSymbol = convertBitfinexToBinanceSymbol(symbol.rawSymbol);
    const trades = await binanceMarketDataAdapter.getRecentTrades!({
      ...symbol,
      rawSymbol: binanceSymbol,
      exchange: "binance"
    }, limit);
    return trades.map(t => ({
      ...t,
      exchange: "bitfinex",
      symbol: symbol.rawSymbol
    }));
  },
  getTickerSnapshot: async (symbol) => {
    const binanceSymbol = convertBitfinexToBinanceSymbol(symbol.rawSymbol);
    const ticker = await binanceMarketDataAdapter.getTickerSnapshot!({
      ...symbol,
      rawSymbol: binanceSymbol,
      exchange: "binance"
    });
    return {
      ...ticker,
      exchange: "bitfinex",
      symbol: symbol.rawSymbol
    };
  },
  subscribeTrades: (symbol, onTrade) => {
    const bfxSymbol = normalizeBitfinexSymbol(symbol.rawSymbol);
    const ws = new WebSocket("wss://api-pub.bitfinex.com/ws/2");
    const messageHandlers = new Set<(message: TradeTick) => void>([onTrade]);
    const errorHandlers = new Set<(error: Error) => void>();
    let myChanId: number | null = null;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        event: "subscribe",
        channel: "trades",
        symbol: bfxSymbol
      }));
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.event === "subscribed" && payload.channel === "trades") {
          myChanId = payload.chanId;
        }
        if (myChanId !== null && Array.isArray(payload) && payload[0] === myChanId) {
          const type = payload[1];
          if (type === "te" && Array.isArray(payload[2])) {
            const [id, time, amount, price] = payload[2];
            const trade: TradeTick = {
              exchange: "bitfinex",
              symbol: symbol.rawSymbol,
              tradeId: String(id),
              time: Math.floor(time / 1000),
              price: parseNumber(price),
              quantity: Math.abs(parseNumber(amount)),
              side: amount > 0 ? "buy" : "sell"
            };
            messageHandlers.forEach(h => h(trade));
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errorHandlers.forEach(h => h(error));
      }
    };

    ws.onerror = () => {
      const error = new Error(`Bitfinex WebSocket failed for ${bfxSymbol}`);
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
    const bfxSymbol = normalizeBitfinexSymbol(symbol.rawSymbol);
    const bids = new Map<number, number>();
    const asks = new Map<number, number>();
    const messageHandlers = new Set<(message: OrderBookSnapshot) => void>([onBook]);
    const errorHandlers = new Set<(error: Error) => void>();
    let myChanId: number | null = null;

    const ws = new WebSocket("wss://api-pub.bitfinex.com/ws/2");

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
        exchange: "bitfinex",
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
        channel: "book",
        symbol: bfxSymbol,
        prec: "P0",
        freq: "F0",
        len: "25"
      }));
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.event === "subscribed" && payload.channel === "book") {
          myChanId = payload.chanId;
        }
        if (myChanId !== null && Array.isArray(payload) && payload[0] === myChanId) {
          const data = payload[1];
          if (Array.isArray(data)) {
            let changed = false;
            if (Array.isArray(data[0])) {
              bids.clear();
              asks.clear();
              for (const [priceRaw, countRaw, amountRaw] of data) {
                const price = parseNumber(priceRaw);
                const count = parseNumber(countRaw);
                const amount = parseNumber(amountRaw);
                if (count > 0) {
                  if (amount > 0) bids.set(price, amount);
                  else asks.set(price, Math.abs(amount));
                }
              }
              changed = true;
            } else {
              const [priceRaw, countRaw, amountRaw] = data;
              const price = parseNumber(priceRaw);
              const count = parseNumber(countRaw);
              const amount = parseNumber(amountRaw);
              if (count === 0) {
                bids.delete(price);
                asks.delete(price);
              } else {
                if (amount > 0) bids.set(price, amount);
                else asks.set(price, Math.abs(amount));
              }
              changed = true;
            }
            if (changed) emit();
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errorHandlers.forEach(h => h(error));
      }
    };

    ws.onerror = () => {
      const error = new Error(`Bitfinex OrderBook WebSocket failed for ${bfxSymbol}`);
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
