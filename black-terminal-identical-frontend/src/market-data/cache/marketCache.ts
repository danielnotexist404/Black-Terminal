import type { Candle } from "../../chart-engine/types";
import type { FundingRate, MarketSymbol, OpenInterest, OrderBookSnapshot, TickerSnapshot, TradeTick } from "../types";

const maxCandlesPerKey = 5000;
const maxTradesPerKey = 1000;

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
    this.candles.set(this.key(symbol, timeframe), candles.slice(-maxCandlesPerKey));
  }

  appendCandle(symbol: MarketSymbol, timeframe: string, candle: Candle) {
    const key = this.key(symbol, timeframe);
    const current = this.candles.get(key) ?? [];
    const last = current[current.length - 1];
    const next = last?.time === candle.time ? [...current.slice(0, -1), candle] : [...current, candle];
    this.candles.set(key, next.slice(-maxCandlesPerKey));
  }

  getCandles(symbol: MarketSymbol, timeframe: string) {
    return this.candles.get(this.key(symbol, timeframe)) ?? [];
  }

  appendTrade(trade: TradeTick) {
    const key = `${trade.exchange}:${trade.symbol}:trades`;
    const current = this.trades.get(key) ?? [];
    this.trades.set(key, [...current, trade].slice(-maxTradesPerKey));
  }

  getTrades(symbol: MarketSymbol) {
    return this.trades.get(`${symbol.exchange}:${symbol.rawSymbol}:trades`) ?? [];
  }

  setTicker(ticker: TickerSnapshot) {
    this.tickers.set(`${ticker.exchange}:${ticker.symbol}`, ticker);
  }

  getTicker(symbol: MarketSymbol) {
    return this.tickers.get(`${symbol.exchange}:${symbol.rawSymbol}`);
  }

  setOrderBook(book: OrderBookSnapshot) {
    this.orderBooks.set(`${book.exchange}:${book.symbol}`, book);
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
    this.funding.set(`${rate.exchange}:${rate.symbol}`, rate);
  }

  setOpenInterest(value: OpenInterest) {
    this.openInterest.set(`${value.exchange}:${value.symbol}`, value);
  }

  setMarkPrice(symbol: MarketSymbol, price: number) {
    this.markPrices.set(this.key(symbol), price);
  }
}
