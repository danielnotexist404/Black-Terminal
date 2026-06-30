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

// Base prices for simulation
const BASE_PRICES: Record<string, number> = {
  BTC: 66000,
  ETH: 3500,
  SOL: 145,
  XRP: 0.48,
  BNB: 580,
  DOGE: 0.12,
  ADA: 0.38,
  AVAX: 28,
  LINK: 14,
  LTC: 75,
  HYPE: 12
};

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

export function createSimulatedMarketDataAdapter(exchangeId: string): MarketDataAdapter {
  const getBasePrice = (token: string) => BASE_PRICES[token.toUpperCase()] || 100;

  const generateCandles = (query: CandleQuery): Candle[] => {
    const basePrice = getBasePrice(query.symbol.slice(0, 3));
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

  const generateOrderBook = (symbol: string): OrderBookSnapshot => {
    const basePrice = getBasePrice(symbol.slice(0, 3));
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

  const generateTrades = (symbol: string, limit = 50): TradeTick[] => {
    const basePrice = getBasePrice(symbol.slice(0, 3));
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
    getHistoricalCandles: async (query) => generateCandles(query),
    getOrderBookSnapshot: async (symbol) => generateOrderBook(symbol.rawSymbol),
    getRecentTrades: async (symbol, limit) => generateTrades(symbol.rawSymbol, limit),
    getTickerSnapshot: async (symbol) => {
      const price = getBasePrice(symbol.rawSymbol.slice(0, 3));
      return {
        exchange: exchangeId as any,
        symbol: symbol.rawSymbol,
        time: Math.floor(Date.now() / 1000),
        lastPrice: price,
        priceChangePercent: Math.random() * 6 - 3,
        volume: Math.random() * 5000000,
        highPrice: price * 1.05,
        lowPrice: price * 0.95
      };
    },
    subscribeCandles: (query, onCandle) => {
      let lastPrice = getBasePrice(query.symbol.slice(0, 3));
      const intervalSec = timeframeSeconds[query.timeframe] || 60;
      let currentCandleTime = Math.floor(Math.floor(Date.now() / 1000) / intervalSec) * intervalSec;
      let open = lastPrice;
      let high = lastPrice;
      let low = lastPrice;
      let close = lastPrice;

      const interval = setInterval(() => {
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
      const basePrice = getBasePrice(symbol.rawSymbol.slice(0, 3));
      const interval = setInterval(() => {
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
      const interval = setInterval(() => {
        onBook(generateOrderBook(symbol.rawSymbol));
      }, 1500);

      return {
        unsubscribe: () => clearInterval(interval),
        onMessage: () => {},
        onError: () => {}
      };
    }
  };
}
