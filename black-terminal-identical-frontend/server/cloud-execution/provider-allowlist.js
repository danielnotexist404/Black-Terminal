const PROVIDER_ENDPOINTS = Object.freeze({
  bybit: {
    mainnet: ["https://api.bybit.com", "https://api.bytick.com", "wss://stream.bybit.com"],
    mainnet_live: [
      "https://api.bybit.com", "https://api.bytick.com", "wss://stream.bybit.com",
      "https://api.bybit.nl", "https://api.bybit.tr", "wss://stream.bybit.tr",
      "https://api.bybit.kz", "wss://stream.bybit.kz",
      "https://api.bybitgeorgia.ge", "wss://stream.bybitgeorgia.ge",
      "https://api.bybit.ae", "https://api.bybit.eu",
      "https://api.bybit.id", "wss://stream.bybit.id",
      "https://api.manepa.jp", "wss://stream.manepa.jp"
    ],
    demo: ["https://api-demo.bybit.com", "https://api.bybit.com", "wss://stream-demo.bybit.com", "wss://stream.bybit.com"],
    testnet: ["https://api-testnet.bybit.com", "wss://stream-testnet.bybit.com"]
  },
  hyperliquid: {
    mainnet: ["https://api.hyperliquid.xyz", "wss://api.hyperliquid.xyz"],
    testnet: ["https://api.hyperliquid-testnet.xyz", "wss://api.hyperliquid-testnet.xyz"]
  },
  binance: { mainnet: ["https://api.binance.com", "wss://stream.binance.com"], testnet: ["https://testnet.binance.vision", "wss://stream.testnet.binance.vision"] },
  okx: { mainnet: ["https://www.okx.com", "wss://ws.okx.com"] },
  bitget: { mainnet: ["https://api.bitget.com", "wss://ws.bitget.com"] },
  coinbase: { mainnet: ["https://api.coinbase.com", "wss://advanced-trade-ws.coinbase.com"] },
  kraken: { mainnet: ["https://api.kraken.com", "wss://ws.kraken.com"] },
  bitfinex: { mainnet: ["https://api-pub.bitfinex.com", "wss://api-pub.bitfinex.com"] },
  bitstamp: { mainnet: ["https://www.bitstamp.net", "wss://ws.bitstamp.net"] },
  kucoin: { mainnet: ["https://api.kucoin.com", "wss://ws-api-spot.kucoin.com"] },
  gateio: { mainnet: ["https://api.gateio.ws", "wss://api.gateio.ws"] },
  mexc: { mainnet: ["https://api.mexc.com", "https://contract.mexc.com", "wss://contract.mexc.com"] },
  deribit: { mainnet: ["https://www.deribit.com", "wss://www.deribit.com"], testnet: ["https://test.deribit.com", "wss://test.deribit.com"] },
  bitmex: { mainnet: ["https://www.bitmex.com", "wss://ws.bitmex.com"], testnet: ["https://testnet.bitmex.com", "wss://ws.testnet.bitmex.com"] }
});

export function listApprovedProviderEndpoints(provider, environment = "mainnet") {
  return [...(PROVIDER_ENDPOINTS[normalize(provider)]?.[normalizeEnvironment(environment)] || [])];
}

export function assertProviderEndpoint({ provider, environment = "mainnet", endpoint, protocol } = {}) {
  const approved = listApprovedProviderEndpoints(provider, environment);
  if (!approved.length) throw endpointError("PROVIDER_NOT_ALLOWLISTED", `No outbound endpoints are approved for ${provider || "this provider"}.`);
  let candidate;
  try { candidate = new URL(String(endpoint)); }
  catch { throw endpointError("ENDPOINT_INVALID", "Provider endpoint is not a valid URL."); }
  if (!new Set(["https:", "wss:"]).has(candidate.protocol)) throw endpointError("ENDPOINT_PROTOCOL_REJECTED", "Only HTTPS and WSS provider endpoints are allowed.");
  if (protocol && candidate.protocol !== `${String(protocol).replace(":", "")}:`) throw endpointError("ENDPOINT_PROTOCOL_MISMATCH", "Provider endpoint protocol does not match the requested transport.");
  if (candidate.username || candidate.password || candidate.port) throw endpointError("ENDPOINT_AUTHORITY_REJECTED", "Provider endpoints cannot include credentials or custom ports.");
  const allowed = approved.some((base) => {
    const url = new URL(base);
    return url.protocol === candidate.protocol && url.hostname === candidate.hostname;
  });
  if (!allowed) throw endpointError("ENDPOINT_NOT_ALLOWLISTED", `The ${candidate.hostname} destination is not approved for ${provider} ${environment}.`);
  return candidate.toString();
}

export function resolveApprovedProviderEndpoint(provider, environment, transport = "https") {
  const prefix = `${String(transport).replace(":", "")}:`;
  const endpoint = listApprovedProviderEndpoints(provider, environment).find((value) => new URL(value).protocol === prefix);
  if (!endpoint) throw endpointError("ENDPOINT_NOT_CONFIGURED", `No ${transport.toUpperCase()} endpoint is configured for ${provider} ${environment}.`);
  return endpoint;
}

export function isProviderEndpointApproved(input) {
  try { assertProviderEndpoint(input); return true; }
  catch { return false; }
}

function normalize(value) { return String(value || "").trim().toLowerCase(); }
function normalizeEnvironment(value) {
  const normalized = normalize(value || "mainnet").replaceAll("-", "_");
  if (normalized === "sandbox") return "testnet";
  if (normalized === "live") return "mainnet_live";
  return normalized;
}
function endpointError(code, message) { return Object.assign(new Error(message), { code, statusCode: 400 }); }
