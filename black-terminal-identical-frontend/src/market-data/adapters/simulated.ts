import { Candle } from "../../chart-engine/types";
import {
  CandleQuery,
  MarketDataAdapter,
  MarketDataSubscription,
  MarketKind,
  MarketSymbol,
  OrderBookLevel,
  OrderBookSnapshot,
  TickerSnapshot,
  Timeframe,
  TradeTick
} from "../types";
import { binanceMarketDataAdapter } from "./binance";
import { bybitMarketDataAdapter } from "./bybit";

// Base prices for simulation fallback
const BASE_PRICES: Record<string, number> = {
  BTC: 58000,
  ETH: 3100,
  SOL: 135,
  XRP: 0.48,
  BNB: 530,
  DOGE: 0.11,
  ADA: 0.35,
  AVAX: 26,
  LINK: 13,
  LTC: 70,
  HYPE: 12
};

const priceCache: Record<string, number> = { ...BASE_PRICES };

const timeframeSeconds: Record<string, number> = {
  "1s": 1,
  "10s": 10,
  "30s": 30,
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "2h": 7200,
  "4h": 14400,
  "6h": 21600,
  "8h": 28800,
  "12h": 43200,
  "1d": 86400,
  "1w": 604800,
  "1M": 2592000
};

export function extractBaseToken(symbol: string): string {
  const clean = symbol.trim().toUpperCase();
  if (clean.includes("-")) return clean.split("-")[0];
  if (clean.includes("/")) return clean.split("/")[0];
  if (clean.includes("_")) return clean.split("_")[0];
  if (clean.endsWith("USDT")) return clean.replace(/USDT$/, "");
  if (clean.endsWith("USD")) return clean.replace(/USD$/, "");
  return clean.slice(0, 3);
}

async function fetchRealPrice(token: string): Promise<number> {
  const t = token.toUpperCase();
  if (t === "USDT" || t === "USD") return 1;
  const symbolStr = `${t}USDT`;

  try {
    if (binanceMarketDataAdapter.getTickerSnapshot) {
      const ticker = await binanceMarketDataAdapter.getTickerSnapshot({
        exchange: "binance",
        rawSymbol: symbolStr,
        baseAsset: t,
        quoteAsset: "USDT",
        marketKind: "spot"
      });
      if (ticker && ticker.lastPrice > 0) {
        priceCache[t] = ticker.lastPrice;
        return ticker.lastPrice;
      }
    }
  } catch (e) {
    try {
      if (bybitMarketDataAdapter.getTickerSnapshot) {
        const ticker = await bybitMarketDataAdapter.getTickerSnapshot({
          exchange: "bybit",
          rawSymbol: symbolStr,
          baseAsset: t,
          quoteAsset: "USDT",
          marketKind: "spot"
        });
        if (ticker && ticker.lastPrice > 0) {
          priceCache[t] = ticker.lastPrice;
          return ticker.lastPrice;
        }
      }
    } catch (err) {}
  }
  return priceCache[t] || BASE_PRICES[t] || 100;
}

export function createSimulatedMarketDataAdapter(exchangeId: string): MarketDataAdapter {
  const getBasePrice = (token: string) => priceCache[token.toUpperCase()] || BASE_PRICES[token.toUpperCase()] || 100;

  const generateCandles = (query: CandleQuery, basePrice: number): Candle[] => {
    const tfSec = timeframeSeconds[query.timeframe] || 60;
    const limit = query.limit || 500;
    const to = query.to || Math.floor(Date.now() / 1000);
    const toAligned = Math.floor(to / tfSec) * tfSec;
    const from = query.from || (toAligned - limit * tfSec);

    const candles: Candle[] = [];
    let currentPrice = basePrice;
    let time = toAligned;

    for (let i = 0; i < limit; i++) {
      const change = currentPrice * (Math.random() - 0.5) * 0.015;
      const open = currentPrice;
      const close = currentPrice + change;
      const high = Math.max(open, close) + currentPrice * Math.random() * 0.008;
      const low = Math.min(open, close) - currentPrice * Math.random() * 0.008;
      const volume = Math.random() * 150 + 20;

      candles.push({
        time,
        open,
        high,
        low,
        close,
        volume
      });

      currentPrice = close;
      time -= tfSec;
      if (time < from) break;
    }

    return candles.reverse();
  };

  const generateOrderBook = (symbol: string, basePrice: number): OrderBookSnapshot => {
    const bids: OrderBookLevel[] = [];
    const asks: OrderBookLevel[] = [];

    for (let i = 1; i <= 20; i++) {
      const bidPrice = basePrice - i * (basePrice * 0.0005);
      const askPrice = basePrice + i * (basePrice * 0.0005);
      const bidSize = Math.random() * 5 + 0.1;
      const askSize = Math.random() * 5 + 0.1;
      bids.push({ price: bidPrice, quantity: bidSize });
      asks.push({ price: askPrice, quantity: askSize });
    }

    return {
      exchange: exchangeId as any,
      symbol,
      time: Math.floor(Date.now() / 1000),
      bids,
      asks
    };
  };

  const generateTrades = (symbol: string, basePrice: number, limit = 50): TradeTick[] => {
    const trades: TradeTick[] = [];
    let timeSec = Math.floor(Date.now() / 1000);

    for (let i = 0; i < limit; i++) {
      const price = basePrice + basePrice * (Math.random() - 0.5) * 0.008;
      const quantity = Math.random() * 2 + 0.05;
      trades.push({
        exchange: exchangeId as any,
        symbol,
        tradeId: `sim-${timeSec}-${i}`,
        price,
        quantity,
        time: timeSec,
        side: Math.random() > 0.5 ? "buy" : "sell"
      });
      timeSec -= Math.floor(Math.random() * 2) + 1;
    }
    return trades;
  };

  const label = exchangeId.charAt(0).toUpperCase() + exchangeId.slice(1);

  return {
    id: exchangeId as any,
    label,
    capabilities: {
      historicalCandles: true,
      liveCandles: true,
      trades: true,
      orderBook: true,
      fundingRates: true,
      openInterest: true,
      liquidations: true
    },
    normalizeSymbol: (symbol) => symbol,
    getHistoricalCandles: async (query) => {
      const baseToken = extractBaseToken(query.symbol);
      const basePrice = await fetchRealPrice(baseToken);
      return generateCandles(query, basePrice);
    },
    getOrderBookSnapshot: async (symbol) => {
      const baseToken = extractBaseToken(symbol.rawSymbol);
      const basePrice = await fetchRealPrice(baseToken);
      return generateOrderBook(symbol.rawSymbol, basePrice);
    },
    getRecentTrades: async (symbol, limit) => {
      const baseToken = extractBaseToken(symbol.rawSymbol);
      const basePrice = await fetchRealPrice(baseToken);
      return generateTrades(symbol.rawSymbol, basePrice, limit);
    },
    getTickerSnapshot: async (symbol) => {
      const baseToken = extractBaseToken(symbol.rawSymbol);
      const basePrice = await fetchRealPrice(baseToken);
      return {
        exchange: exchangeId as any,
        symbol: symbol.rawSymbol,
        time: Math.floor(Date.now() / 1000),
        lastPrice: basePrice,
        priceChangePercent: Math.random() * 6 - 3,
        volume: Math.random() * 5000000,
        highPrice: basePrice * 1.05,
        lowPrice: basePrice * 0.95
      };
    },
    subscribeCandles: (query, onCandle) => {
      const baseToken = extractBaseToken(query.symbol);
      let lastPrice = getBasePrice(baseToken);
      const intervalSec = timeframeSeconds[query.timeframe] || 60;
      let currentCandleTime = Math.floor(Math.floor(Date.now() / 1000) / intervalSec) * intervalSec;
      let open = lastPrice;
      let high = lastPrice;
      let low = lastPrice;
      let close = lastPrice;

      const interval = setInterval(() => {
        const latestPrice = getBasePrice(baseToken);
        if (Math.abs(close - latestPrice) / latestPrice > 0.05) {
          close = latestPrice;
        }

        const nowSec = Math.floor(Date.now() / 1000);
        const candleTime = Math.floor(nowSec / intervalSec) * intervalSec;

        const change = close * (Math.random() - 0.5) * 0.003;
        close = close + change;

        if (candleTime !== currentCandleTime) {
          currentCandleTime = candleTime;
          open = close;
          high = close;
          low = close;
        } else {
          high = Math.max(high, close);
          low = Math.min(low, close);
        }
        
        onCandle({
          time: candleTime,
          open,
          high,
          low,
          close,
          volume: Math.random() * 5 + 0.1
        });
      }, 1000);

      return {
        unsubscribe: () => clearInterval(interval),
        onMessage: () => {},
        onError: () => {}
      };
    },
    subscribeTrades: (symbol, onTrade) => {
      const baseToken = extractBaseToken(symbol.rawSymbol);
      const interval = setInterval(() => {
        const basePrice = getBasePrice(baseToken);
        onTrade({
          exchange: exchangeId as any,
          symbol: symbol.rawSymbol,
          tradeId: `sim-live-${Date.now()}`,
          price: basePrice + basePrice * (Math.random() - 0.5) * 0.003,
          quantity: Math.random() * 1.5 + 0.01,
          time: Math.floor(Date.now() / 1000),
          side: Math.random() > 0.5 ? "buy" : "sell"
        });
      }, 1200);

      return {
        unsubscribe: () => clearInterval(interval),
        onMessage: () => {},
        onError: () => {}
      };
    },
    subscribeOrderBook: (symbol, onBook) => {
      const baseToken = extractBaseToken(symbol.rawSymbol);
      const interval = setInterval(() => {
        const basePrice = getBasePrice(baseToken);
        onBook(generateOrderBook(symbol.rawSymbol, basePrice));
      }, 1500);

      return {
        unsubscribe: () => clearInterval(interval),
        onMessage: () => {},
        onError: () => {}
      };
    }
  };
}
