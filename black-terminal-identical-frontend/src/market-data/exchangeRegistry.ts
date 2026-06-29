import { ExchangeId, MarketDataCapabilities, MarketKind } from "./types";
import { binanceMarketDataAdapter } from "./adapters/binance";
import { bybitMarketDataAdapter } from "./adapters/bybit";
import { okxMarketDataAdapter } from "./adapters/okx";

export type ExchangeDefinition = {
  id: ExchangeId;
  label: string;
  website: string;
  defaultMarketKind: MarketKind;
  capabilities: MarketDataCapabilities;
  notes?: string;
};

const cryptoCoreCapabilities: MarketDataCapabilities = {
  historicalCandles: true,
  liveCandles: true,
  trades: true,
  orderBook: true,
  fundingRates: true,
  openInterest: true,
  liquidations: true
};

const spotCoreCapabilities: MarketDataCapabilities = {
  historicalCandles: true,
  liveCandles: true,
  trades: true,
  orderBook: true,
  fundingRates: false,
  openInterest: false,
  liquidations: false
};

export const exchangeRegistry: ExchangeDefinition[] = [
  {
    id: "binance",
    label: "Binance",
    website: "https://www.binance.com",
    defaultMarketKind: "perpetual",
    capabilities: cryptoCoreCapabilities
  },
  {
    id: "bitfinex",
    label: "Bitfinex",
    website: "https://www.bitfinex.com",
    defaultMarketKind: "spot",
    capabilities: spotCoreCapabilities
  },
  {
    id: "okx",
    label: "OKX",
    website: "https://www.okx.com",
    defaultMarketKind: "perpetual",
    capabilities: cryptoCoreCapabilities
  },
  {
    id: "bybit",
    label: "Bybit",
    website: "https://www.bybit.com",
    defaultMarketKind: "perpetual",
    capabilities: cryptoCoreCapabilities
  },
  {
    id: "hyperliquid",
    label: "Hyperliquid",
    website: "https://hyperliquid.xyz",
    defaultMarketKind: "perpetual",
    capabilities: cryptoCoreCapabilities
  },
  {
    id: "coinbase",
    label: "Coinbase",
    website: "https://www.coinbase.com",
    defaultMarketKind: "spot",
    capabilities: spotCoreCapabilities
  },
  {
    id: "kraken",
    label: "Kraken",
    website: "https://www.kraken.com",
    defaultMarketKind: "spot",
    capabilities: spotCoreCapabilities
  },
  {
    id: "bitstamp",
    label: "Bitstamp",
    website: "https://www.bitstamp.net",
    defaultMarketKind: "spot",
    capabilities: spotCoreCapabilities
  },
  {
    id: "deribit",
    label: "Deribit",
    website: "https://www.deribit.com",
    defaultMarketKind: "options",
    capabilities: {
      ...cryptoCoreCapabilities,
      liquidations: false
    }
  },
  {
    id: "bitget",
    label: "Bitget",
    website: "https://www.bitget.com",
    defaultMarketKind: "perpetual",
    capabilities: cryptoCoreCapabilities
  },
  {
    id: "kucoin",
    label: "KuCoin",
    website: "https://www.kucoin.com",
    defaultMarketKind: "spot",
    capabilities: spotCoreCapabilities
  },
  {
    id: "gateio",
    label: "Gate.io",
    website: "https://www.gate.io",
    defaultMarketKind: "perpetual",
    capabilities: cryptoCoreCapabilities
  },
  {
    id: "mexc",
    label: "MEXC",
    website: "https://www.mexc.com",
    defaultMarketKind: "perpetual",
    capabilities: cryptoCoreCapabilities
  },
  {
    id: "bitmex",
    label: "BitMEX",
    website: "https://www.bitmex.com",
    defaultMarketKind: "perpetual",
    capabilities: cryptoCoreCapabilities
  }
];

export function getExchangeDefinition(exchange: ExchangeId) {
  return exchangeRegistry.find((item) => item.id === exchange);
}

export const publicMarketDataAdapters = {
  binance: binanceMarketDataAdapter,
  bybit: bybitMarketDataAdapter,
  okx: okxMarketDataAdapter
} as const;

export function getPublicMarketDataAdapter(exchange: ExchangeId) {
  return publicMarketDataAdapters[exchange as keyof typeof publicMarketDataAdapters];
}
