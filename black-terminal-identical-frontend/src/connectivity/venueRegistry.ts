import type { ExchangeId, MarketKind } from "../market-data/types";
import type { ConnectionCapability, ConnectionCategory, ConnectionNetwork, ConnectionReadiness, ExecutionMode } from "./types";

export type VenueImplementationStatus =
  | "implemented"
  | "partial"
  | "market-data-only"
  | "signer-only"
  | "blocked"
  | "deferred";

export type VenueCertificationRecord = {
  id: string;
  label: string;
  category: ConnectionCategory;
  executionMode: ExecutionMode;
  defaultNetwork: ConnectionNetwork;
  readiness: ConnectionReadiness;
  status: VenueImplementationStatus;
  connectorVisible: boolean;
  authReady: boolean;
  accountReadReady: boolean;
  executionReady: boolean;
  privateStreamsReady: boolean;
  marketDataReady: boolean;
  mainnetValidated: boolean;
  supportedProducts: MarketKind[];
  connectionCapabilities: ConnectionCapability[];
  supportedOrderTypes: string[];
  limitations: string[];
};

const marketDataCapabilities: ConnectionCapability[] = ["public-websocket", "trades"];
const accountReadCapabilities: ConnectionCapability[] = ["balances", "positions", "orders", "trades"];
const walletSignerCapabilities: ConnectionCapability[] = ["wallet-connect", "transaction-signing", "token-transfers", "network-switching"];
const perpetualExecutionCapabilities: ConnectionCapability[] = [
  "market-orders",
  "limit-orders",
  "conditional-orders",
  "perpetual-orders",
  "modify-orders",
  "cancel-orders",
  "leverage",
  "cross-margin",
  "isolated-margin",
  "funding",
  "liquidation",
  "reduce-only",
  "post-only",
  "balances",
  "positions",
  "orders",
  "trades",
  "public-websocket"
];

function cexMarketDataOnly(id: ExchangeId, label: string, products: MarketKind[]): VenueCertificationRecord {
  return {
    id,
    label,
    category: "centralized-exchange",
    executionMode: "market-data-only",
    defaultNetwork: "mainnet",
    readiness: "execution-blocked",
    status: "market-data-only",
    connectorVisible: true,
    authReady: false,
    accountReadReady: false,
    executionReady: false,
    privateStreamsReady: false,
    marketDataReady: true,
    mainnetValidated: false,
    supportedProducts: products,
    connectionCapabilities: marketDataCapabilities,
    supportedOrderTypes: [],
    limitations: [`${label} currently has public market-data coverage only. Credential validation and live execution adapter are not certified yet.`]
  };
}

export const venueCertificationRegistry: VenueCertificationRecord[] = [
  {
    id: "bybit",
    label: "Bybit",
    category: "centralized-exchange",
    executionMode: "full-live",
    defaultNetwork: "mainnet",
    readiness: "execution-blocked",
    status: "partial",
    connectorVisible: true,
    authReady: true,
    accountReadReady: true,
    executionReady: false,
    privateStreamsReady: false,
    marketDataReady: true,
    mainnetValidated: false,
    supportedProducts: ["spot", "perpetual"],
    connectionCapabilities: [...accountReadCapabilities, ...marketDataCapabilities, "market-orders", "limit-orders", "strategy-orders", "chase-limit", "twap", "iceberg", "pov", "cancel-orders", "modify-orders", "reduce-only", "post-only", "leverage", "cross-margin", "isolated-margin", "private-websocket"],
    supportedOrderTypes: ["market", "limit", "stop-market", "stop-limit", "chase-limit", "twap", "iceberg", "pov", "post-only", "reduce-only", "gtc", "ioc", "fok"],
    limitations: [
      "Bybit credentials are validated against the mainnet account endpoint and account balances/positions can sync.",
      "Bybit order, cancel, modify, close, TP/SL, leverage, and explicit mode-control primitives exist behind controlled mainnet validation gates.",
      "Production certification remains blocked until private stream runtime is live, reconnect reconciliation is validated, and small-order mainnet evidence is recorded."
    ]
  },
  cexMarketDataOnly("binance", "Binance", ["spot", "perpetual"]),
  cexMarketDataOnly("okx", "OKX", ["spot", "perpetual"]),
  cexMarketDataOnly("bitget", "Bitget", ["spot", "perpetual"]),
  cexMarketDataOnly("coinbase", "Coinbase Advanced", ["spot"]),
  cexMarketDataOnly("kraken", "Kraken", ["spot"]),
  cexMarketDataOnly("bitfinex", "Bitfinex", ["spot"]),
  cexMarketDataOnly("bitstamp", "Bitstamp", ["spot"]),
  cexMarketDataOnly("deribit", "Deribit", ["options"]),
  cexMarketDataOnly("kucoin", "KuCoin", ["spot"]),
  cexMarketDataOnly("gateio", "Gate.io", ["spot", "perpetual"]),
  cexMarketDataOnly("mexc", "MEXC", ["spot", "perpetual"]),
  cexMarketDataOnly("bitmex", "BitMEX", ["perpetual"]),
  {
    id: "hyperliquid",
    label: "Hyperliquid",
    category: "protocol",
    executionMode: "full-live",
    defaultNetwork: "mainnet",
    readiness: "execution-blocked",
    status: "partial",
    connectorVisible: true,
    authReady: true,
    accountReadReady: true,
    executionReady: false,
    privateStreamsReady: false,
    marketDataReady: true,
    mainnetValidated: false,
    supportedProducts: ["perpetual"],
    connectionCapabilities: perpetualExecutionCapabilities,
    supportedOrderTypes: ["market", "limit", "stop-market", "stop-limit"],
    limitations: [
      "Hyperliquid is relay-capable through MetaMask plus an authorized agent wallet.",
      "Execution becomes ready only after relay enablement, metadata, nonce, authorization, risk controls, and Developer Mainnet Validation Mode pass.",
      "Production certification still requires recorded testnet and small-order mainnet validation."
    ]
  },
  {
    id: "metamask",
    label: "MetaMask",
    category: "wallet",
    executionMode: "signer-only",
    defaultNetwork: "mainnet",
    readiness: "execution-blocked",
    status: "signer-only",
    connectorVisible: true,
    authReady: true,
    accountReadReady: false,
    executionReady: false,
    privateStreamsReady: false,
    marketDataReady: false,
    mainnetValidated: false,
    supportedProducts: ["swap"],
    connectionCapabilities: walletSignerCapabilities,
    supportedOrderTypes: [],
    limitations: ["MetaMask is a signer. It does not execute futures unless paired with a protocol adapter such as Hyperliquid."]
  },
  {
    id: "phantom",
    label: "Phantom",
    category: "wallet",
    executionMode: "signer-only",
    defaultNetwork: "mainnet",
    readiness: "execution-blocked",
    status: "signer-only",
    connectorVisible: true,
    authReady: true,
    accountReadReady: false,
    executionReady: false,
    privateStreamsReady: false,
    marketDataReady: false,
    mainnetValidated: false,
    supportedProducts: ["swap"],
    connectionCapabilities: walletSignerCapabilities,
    supportedOrderTypes: [],
    limitations: ["Phantom is a Solana signer. Drift/Jupiter/Raydium execution adapters are not certified yet."]
  },
  signerProtocol("uniswap", "Uniswap", "MetaMask signer can connect, but quote/approval/swap execution is not certified yet."),
  signerProtocol("jupiter", "Jupiter", "Phantom signer can connect, but Jupiter quote/sign/submit execution is not certified yet."),
  signerProtocol("raydium", "Raydium", "Phantom signer can connect, but Raydium swap execution is not certified yet."),
  signerProtocol("pancakeswap", "PancakeSwap", "MetaMask signer can connect, but PancakeSwap quote/approval/swap execution is not certified yet."),
  deferredProtocol("gmx", "GMX", "GMX perpetual execution is deferred until the protocol router adapter is implemented."),
  deferredProtocol("dydx", "dYdX", "dYdX execution is deferred until wallet, subaccount, and protocol signing are implemented."),
  deferredProtocol("vertex", "Vertex", "Vertex execution is deferred until protocol signing and account state adapters are implemented."),
  deferredProtocol("drift", "Drift", "Drift execution is deferred until Phantom/Solana protocol signing and account state adapters are implemented."),
  deferredProtocol("walletconnect", "WalletConnect", "WalletConnect is future-ready but not implemented in this browser build."),
  deferredInstitutional("fix", "FIX Gateway"),
  deferredInstitutional("interactive-brokers", "Interactive Brokers"),
  deferredInstitutional("tradovate", "Tradovate"),
  deferredInstitutional("rithmic", "Rithmic"),
  deferredInstitutional("cqg", "CQG"),
  deferredInstitutional("prime-broker", "Prime Broker")
];

export function getVenueCertification(id: string): VenueCertificationRecord | undefined {
  return venueCertificationRegistry.find((item) => item.id === id);
}

export function getConnectionCapabilitiesForVenue(id: string): ConnectionCapability[] {
  return getVenueCertification(id)?.connectionCapabilities ?? [];
}

export function formatExecutionMode(mode: ExecutionMode) {
  return mode.replace(/-/g, " ").toUpperCase();
}

function signerProtocol(id: string, label: string, reason: string): VenueCertificationRecord {
  return {
    id,
    label,
    category: "protocol",
    executionMode: "signer-only",
    defaultNetwork: "mainnet",
    readiness: "execution-blocked",
    status: "signer-only",
    connectorVisible: true,
    authReady: true,
    accountReadReady: false,
    executionReady: false,
    privateStreamsReady: false,
    marketDataReady: false,
    mainnetValidated: false,
    supportedProducts: ["swap"],
    connectionCapabilities: walletSignerCapabilities,
    supportedOrderTypes: [],
    limitations: [reason]
  };
}

function deferredProtocol(id: string, label: string, reason: string): VenueCertificationRecord {
  return {
    id,
    label,
    category: "protocol",
    executionMode: "unavailable",
    defaultNetwork: "unsupported",
    readiness: "disconnected",
    status: "deferred",
    connectorVisible: false,
    authReady: false,
    accountReadReady: false,
    executionReady: false,
    privateStreamsReady: false,
    marketDataReady: false,
    mainnetValidated: false,
    supportedProducts: [],
    connectionCapabilities: [],
    supportedOrderTypes: [],
    limitations: [reason]
  };
}

function deferredInstitutional(id: string, label: string): VenueCertificationRecord {
  return {
    id,
    label,
    category: "institutional",
    executionMode: "unavailable",
    defaultNetwork: "unsupported",
    readiness: "disconnected",
    status: "deferred",
    connectorVisible: false,
    authReady: false,
    accountReadReady: false,
    executionReady: false,
    privateStreamsReady: false,
    marketDataReady: false,
    mainnetValidated: false,
    supportedProducts: [],
    connectionCapabilities: [],
    supportedOrderTypes: [],
    limitations: [`${label} is an institutional adapter boundary and is not implemented in the browser/Vercel build yet.`]
  };
}
