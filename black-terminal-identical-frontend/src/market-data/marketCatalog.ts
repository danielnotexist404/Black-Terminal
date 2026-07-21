import { ExchangeId, MarketKind, MarketSymbol } from "./types";

export type MarketSymbolOption = MarketSymbol & {
  label: string;
  token: string;
};

export type ExchangeOption = {
  id: ExchangeId;
  label: string;
  status: "REST LIVE" | "NEXT";
  symbols: MarketSymbolOption[];
};

const coreSymbols = ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "ADA", "AVAX", "LINK", "LTC"];

function makeUsdtSymbol(exchange: ExchangeId, baseAsset: string, marketKind: MarketKind, rawSymbol?: string): MarketSymbolOption {
  return {
    exchange,
    rawSymbol: rawSymbol ?? `${baseAsset}USDT`,
    label: `${baseAsset}USDT`,
    token: baseAsset,
    baseAsset,
    quoteAsset: "USDT",
    marketKind
  };
}

function makeOkxSymbol(baseAsset: string): MarketSymbolOption {
  return makeUsdtSymbol("okx", baseAsset, "perpetual", `${baseAsset}-USDT-SWAP`);
}

export const marketCatalog: ExchangeOption[] = [
  {
    id: "binance",
    label: "Binance",
    status: "REST LIVE",
    symbols: coreSymbols.map((base) => makeUsdtSymbol("binance", base, "perpetual"))
  },
  {
    id: "bybit",
    label: "Bybit",
    status: "REST LIVE",
    symbols: coreSymbols.map((base) => makeUsdtSymbol("bybit", base, "perpetual"))
  },
  {
    id: "okx",
    label: "OKX",
    status: "REST LIVE",
    symbols: coreSymbols.filter((base) => base !== "BNB").map(makeOkxSymbol)
  },
  {
    id: "hyperliquid",
    label: "Hyperliquid",
    status: "REST LIVE",
    symbols: ["BTC", "ETH", "SOL", "HYPE"].map((base) => makeUsdtSymbol("hyperliquid", base, "perpetual"))
  },
  {
    id: "bitfinex",
    label: "Bitfinex",
    status: "REST LIVE",
    symbols: ["BTC", "ETH", "SOL", "XRP", "LTC"].map((base) => makeUsdtSymbol("bitfinex", base, "spot"))
  },
  {
    id: "coinbase",
    label: "Coinbase",
    status: "REST LIVE",
    symbols: ["BTC", "ETH", "SOL", "XRP", "ADA", "AVAX", "LINK"].map((base) => makeUsdtSymbol("coinbase", base, "spot"))
  },
  {
    id: "kraken",
    label: "Kraken",
    status: "REST LIVE",
    symbols: ["BTC", "ETH", "SOL", "XRP", "ADA", "LTC"].map((base) => makeUsdtSymbol("kraken", base, "spot"))
  },
  {
    id: "bitstamp",
    label: "Bitstamp",
    status: "REST LIVE",
    symbols: ["BTC", "ETH", "XRP", "LTC", "LINK"].map((base) => makeUsdtSymbol("bitstamp", base, "spot"))
  },
  {
    id: "deribit",
    label: "Deribit",
    status: "REST LIVE",
    symbols: ["BTC", "ETH", "SOL"].map((base) => makeUsdtSymbol("deribit", base, "options"))
  },
  {
    id: "bitget",
    label: "Bitget",
    status: "REST LIVE",
    symbols: coreSymbols.map((base) => makeUsdtSymbol("bitget", base, "perpetual"))
  },
  {
    id: "kucoin",
    label: "KuCoin",
    status: "REST LIVE",
    symbols: ["BTC", "ETH", "SOL", "XRP", "ADA", "AVAX", "LINK", "DOGE"].map((base) => makeUsdtSymbol("kucoin", base, "spot"))
  },
  {
    id: "gateio",
    label: "Gate.io",
    status: "REST LIVE",
    symbols: coreSymbols.map((base) => makeUsdtSymbol("gateio", base, "perpetual"))
  },
  {
    id: "mexc",
    label: "MEXC",
    status: "REST LIVE",
    symbols: coreSymbols.map((base) => makeUsdtSymbol("mexc", base, "perpetual"))
  },
  {
    id: "bitmex",
    label: "BitMEX",
    status: "REST LIVE",
    symbols: ["BTC", "ETH", "SOL", "XRP", "LINK"].map((base) => makeUsdtSymbol("bitmex", base, "perpetual"))
  }
];

export function getExchangeOption(exchange: ExchangeId) {
  return marketCatalog.find((item) => item.id === exchange) ?? marketCatalog[0];
}
