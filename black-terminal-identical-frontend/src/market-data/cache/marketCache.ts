import type { Candle } from "../../chart-engine/types";
import type { FundingRate, MarketSymbol, OpenInterest, OrderBookSnapshot, TickerSnapshot, TradeTick } from "../types";

const maxCandlesPerKey = 5000;
const maxTradesPerKey = 1000;
const maxCandleKeys = 24;
const maxTradeKeys = 16;
const maxSnapshotKeys = 32;

export class MarketCache {
  private candles = new Map<string, Candle[]>();
  private trades = new Map<string, TradeTick[]>();
  private tickers = new Map<string, TickerSnapshot>();
  private orderBooks = new Map<string, OrderBookSnapshot>();
  private funding = new Map<string, FundingRate>();
  private openInterest = new Map<string, OpenInterest>();
  private markPrices = new Map<string, number>();

  key(symbol: Pick<MarketSymbol, "exchange" | "rawSymbol" | "marketKind">, timeframe?: string) {
    return [symbol.exchange, symbol.marketKind, symbol.rawSymbol, timeframe].filter(Boolean).join(":");
  }

  setCandles(symbol: MarketSymbol, timeframe: string, candles: Candle[]) {
    setBoundedMap(this.candles, this.key(symbol, timeframe), candles.slice(-maxCandlesPerKey), maxCandleKeys);
  }

  appendCandle(symbol: MarketSymbol, timeframe: string, candle: Candle) {
    const key = this.key(symbol, timeframe);
    const current = this.candles.get(key) ?? [];
    const last = current[current.length - 1];
    if (last?.time === candle.time) current[current.length - 1] = candle;
    else current.push(candle);
    if (current.length > maxCandlesPerKey) current.splice(0, current.length - maxCandlesPerKey);
    setBoundedMap(this.candles, key, current, maxCandleKeys);
  }

  getCandles(symbol: MarketSymbol, timeframe: string) {
    return this.candles.get(this.key(symbol, timeframe)) ?? [];
  }

  appendTrade(trade: TradeTick) {
    const key = `${trade.exchange}:${trade.symbol}:trades`;
    const current = this.trades.get(key) ?? [];
    current.push(trade);
    if (current.length > maxTradesPerKey) current.splice(0, current.length - maxTradesPerKey);
    setBoundedMap(this.trades, key, current, maxTradeKeys);
  }

  getTrades(symbol: MarketSymbol) {
    return this.trades.get(`${symbol.exchange}:${symbol.rawSymbol}:trades`) ?? [];
  }

  setTicker(ticker: TickerSnapshot) {
    setBoundedMap(this.tickers, `${ticker.exchange}:${ticker.symbol}`, ticker, maxSnapshotKeys);
  }

  getTicker(symbol: MarketSymbol) {
    return this.tickers.get(`${symbol.exchange}:${symbol.rawSymbol}`);
  }

  setOrderBook(book: OrderBookSnapshot) {
    setBoundedMap(this.orderBooks, `${book.exchange}:${book.symbol}`, book, maxSnapshotKeys);
  }

  getOrderBook(symbol: MarketSymbol) {
    return this.orderBooks.get(`${symbol.exchange}:${symbol.rawSymbol}`);
  }

  diagnostics() {
    return {
      candles: this.candles.size,
      trades: this.trades.size,
      tickers: this.tickers.size,
      orderBooks: this.orderBooks.size,
      funding: this.funding.size,
      openInterest: this.openInterest.size,
      markPrices: this.markPrices.size,
      totalKeys: this.candles.size + this.trades.size + this.tickers.size + this.orderBooks.size + this.funding.size + this.openInterest.size + this.markPrices.size
    };
  }

  setFunding(rate: FundingRate) {
    setBoundedMap(this.funding, `${rate.exchange}:${rate.symbol}`, rate, maxSnapshotKeys);
  }

  setOpenInterest(value: OpenInterest) {
    setBoundedMap(this.openInterest, `${value.exchange}:${value.symbol}`, value, maxSnapshotKeys);
  }

  setMarkPrice(symbol: MarketSymbol, price: number) {
    setBoundedMap(this.markPrices, this.key(symbol), price, maxSnapshotKeys);
  }
}

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, limit: number) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
