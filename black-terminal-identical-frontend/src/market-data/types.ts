import { Candle } from "../chart-engine/types";

export type ExchangeId =
  | "binance"
  | "binance-us"
  | "bitfinex"
  | "okx"
  | "bybit"
  | "hyperliquid"
  | "coinbase"
  | "kraken"
  | "bitstamp"
  | "deribit"
  | "bitget"
  | "kucoin"
  | "gateio"
  | "mexc"
  | "bitmex"
  | "mock";

export type MarketKind = "spot" | "margin" | "perpetual" | "futures" | "options" | "swap";

export type Timeframe =
  | "1s"
  | "10s"
  | "30s"
  | "1m"
  | "3m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "2h"
  | "4h"
  | "6h"
  | "8h"
  | "12h"
  | "1d"
  | "1w"
  | "1M"
  | "10t"
  | "100t";

export type MarketSymbol = {
  exchange: ExchangeId;
  rawSymbol: string;
  baseAsset: string;
  quoteAsset: string;
  marketKind: MarketKind;
  pricePrecision?: number;
  quantityPrecision?: number;
  minNotional?: number;
};

export type MarketDataCapabilities = {
  historicalCandles: boolean;
  liveCandles: boolean;
  trades: boolean;
  orderBook: boolean;
  fundingRates: boolean;
  openInterest: boolean;
  liquidations: boolean;
};

export type TradeTick = {
  exchange: ExchangeId;
  symbol: string;
  tradeId: string;
  time: number;
  price: number;
  quantity: number;
  side: "buy" | "sell" | "unknown";
};

export type OrderBookLevel = {
  price: number;
  quantity: number;
};

export type OrderBookSnapshot = {
  exchange: ExchangeId;
  symbol: string;
  time: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  subscribedDepth?: number;
  updateId?: number;
  sequence?: number;
};

export type TickerSnapshot = {
  exchange: ExchangeId;
  symbol: string;
  time: number;
  lastPrice: number;
  bidPrice?: number;
  askPrice?: number;
  bidQuantity?: number;
  askQuantity?: number;
  openPrice?: number;
  highPrice?: number;
  lowPrice?: number;
  volume?: number;
  quoteVolume?: number;
  priceChange?: number;
  priceChangePercent?: number;
};

export type FundingRate = {
  exchange: ExchangeId;
  symbol: string;
  time: number;
  rate: number;
  nextFundingTime?: number;
};

export type OpenInterest = {
  exchange: ExchangeId;
  symbol: string;
  time: number;
  value: number;
  valueUsd?: number;
};

export type MarketDataSubscription<T> = {
  unsubscribe: () => void;
  onMessage: (handler: (message: T) => void) => void;
  onError: (handler: (error: Error) => void) => void;
};

export type CandleQuery = {
  exchange: ExchangeId;
  symbol: string;
  timeframe: Timeframe;
  marketKind: MarketKind;
  limit?: number;
  from?: number;
  to?: number;
};

export type MarketDataAdapter = {
  id: ExchangeId;
  label: string;
  capabilities: MarketDataCapabilities;
  normalizeSymbol: (symbol: string, marketKind: MarketKind) => string;
  getSymbols?: (marketKind?: MarketKind) => Promise<MarketSymbol[]>;
  getHistoricalCandles: (query: CandleQuery) => Promise<Candle[]>;
  getOrderBookSnapshot?: (symbol: MarketSymbol, limit?: number) => Promise<OrderBookSnapshot>;
  getRecentTrades?: (symbol: MarketSymbol, limit?: number) => Promise<TradeTick[]>;
  getTickerSnapshot?: (symbol: MarketSymbol) => Promise<TickerSnapshot>;
  subscribeCandles?: (
    query: CandleQuery,
    onCandle: (candle: Candle) => void
  ) => MarketDataSubscription<Candle>;
  subscribeTrades?: (
    symbol: MarketSymbol,
    onTrade: (trade: TradeTick) => void
  ) => MarketDataSubscription<TradeTick>;
  subscribeOrderBook?: (
    symbol: MarketSymbol,
    onBook: (book: OrderBookSnapshot) => void
  ) => MarketDataSubscription<OrderBookSnapshot>;
};
