export const BYBIT_EXECUTION_ENVIRONMENTS = Object.freeze({
  DEMO: "DEMO",
  MAINNET_LIVE: "MAINNET_LIVE"
});

const MAINNET_PROFILES = Object.freeze({
  GLOBAL: profile("GLOBAL", "https://api.bybit.com", "wss://stream.bybit.com"),
  NETHERLANDS: profile("NETHERLANDS", "https://api.bybit.nl", "wss://stream.bybit.com"),
  TURKEY: profile("TURKEY", "https://api.bybit.tr", "wss://stream.bybit.tr"),
  KAZAKHSTAN: profile("KAZAKHSTAN", "https://api.bybit.kz", "wss://stream.bybit.kz"),
  GEORGIA: profile("GEORGIA", "https://api.bybitgeorgia.ge", "wss://stream.bybitgeorgia.ge"),
  UAE: profile("UAE", "https://api.bybit.ae", "wss://stream.bybit.com"),
  EEA: profile("EEA", "https://api.bybit.eu", "wss://stream.bybit.com"),
  INDONESIA: profile("INDONESIA", "https://api.bybit.id", "wss://stream.bybit.id"),
  JAPAN: profile("JAPAN", "https://api.manepa.jp", "wss://stream.manepa.jp")
});

const PUBLIC_WEBSOCKET = Object.freeze({
  linear: "wss://stream.bybit.com/v5/public/linear",
  inverse: "wss://stream.bybit.com/v5/public/inverse",
  spot: "wss://stream.bybit.com/v5/public/spot",
  option: "wss://stream.bybit.com/v5/public/option"
});

export function resolveBybitEndpointSet(input = {}) {
  const environment = normalizeBybitExecutionEnvironment(input.environment ?? input.executionEnvironment ?? input.network);
  if (environment === BYBIT_EXECUTION_ENVIRONMENTS.DEMO) {
    if (input.region && normalizeProfile(input.region) !== "GLOBAL") {
      throw endpointConfigurationError("BYBIT_DEMO_REGION_UNSUPPORTED", "Bybit Demo uses its dedicated global execution endpoints and does not accept a Mainnet regional profile.");
    }
    return Object.freeze({
      environment,
      region: "GLOBAL",
      rest: "https://api-demo.bybit.com",
      publicRest: "https://api.bybit.com",
      privateWebSocket: "wss://stream-demo.bybit.com/v5/private",
      tradeWebSocket: undefined,
      publicWebSocketByCategory: PUBLIC_WEBSOCKET,
      websocketOrderEntrySupported: false,
      simulatedFunds: true,
      realExecution: false
    });
  }

  const region = normalizeProfile(input.region ?? input.endpointProfile ?? "GLOBAL");
  const selected = MAINNET_PROFILES[region];
  if (!selected) {
    throw endpointConfigurationError("BYBIT_REGION_UNSUPPORTED", `Unsupported Bybit Mainnet regional profile: ${region}.`);
  }
  return Object.freeze({
    environment,
    region,
    rest: selected.rest,
    publicRest: selected.rest,
    privateWebSocket: `${selected.stream}/v5/private`,
    tradeWebSocket: `${selected.stream}/v5/trade`,
    publicWebSocketByCategory: PUBLIC_WEBSOCKET,
    websocketOrderEntrySupported: true,
    simulatedFunds: false,
    realExecution: true
  });
}

export function normalizeBybitExecutionEnvironment(value) {
  const normalized = String(value || "MAINNET_LIVE").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (["DEMO", "DEMO_TRADING"].includes(normalized)) return BYBIT_EXECUTION_ENVIRONMENTS.DEMO;
  if (["MAINNET", "LIVE", "MAINNET_LIVE", "PRODUCTION"].includes(normalized)) return BYBIT_EXECUTION_ENVIRONMENTS.MAINNET_LIVE;
  if (["TESTNET", "SANDBOX"].includes(normalized)) {
    throw endpointConfigurationError("BYBIT_TESTNET_NOT_CERTIFIABLE", "Bybit Testnet is not part of the active Phase V certification path. Select DEMO or MAINNET_LIVE.");
  }
  throw endpointConfigurationError("BYBIT_ENVIRONMENT_INVALID", "Bybit execution environment must be DEMO or MAINNET_LIVE.");
}

export function listBybitEndpointProfiles() {
  return Object.values(MAINNET_PROFILES).map(({ id, rest }) => ({ id, restHost: new URL(rest).hostname }));
}

export function assertBybitEndpointSet(endpointSet) {
  const canonical = resolveBybitEndpointSet({ environment: endpointSet?.environment, region: endpointSet?.region });
  for (const key of ["rest", "publicRest", "privateWebSocket"]) {
    if (endpointSet?.[key] && stripSlash(endpointSet[key]) !== stripSlash(canonical[key])) {
      throw endpointConfigurationError("BYBIT_ENDPOINT_MISMATCH", `${key} does not match the selected Bybit environment and regional profile.`);
    }
  }
  if (endpointSet?.tradeWebSocket && stripSlash(endpointSet.tradeWebSocket) !== stripSlash(canonical.tradeWebSocket)) {
    throw endpointConfigurationError("BYBIT_ENDPOINT_MISMATCH", "tradeWebSocket does not match the selected Bybit environment and regional profile.");
  }
  return canonical;
}

function profile(id, rest, stream) { return Object.freeze({ id, rest, stream }); }
function normalizeProfile(value) { return String(value || "GLOBAL").trim().toUpperCase().replace(/[\s-]+/g, "_"); }
function stripSlash(value) { return String(value || "").replace(/\/$/, ""); }
function endpointConfigurationError(code, message) { return Object.assign(new Error(message), { code, statusCode: 400 }); }
