const definitions = new Map();

registerBrokerAdapterDefinition({
  id: "bybit",
  label: "Bybit",
  category: "centralized-exchange",
  authorization: {
    oauthAuthorization: true,
    apiCredentials: true,
    walletConnection: false,
    institutionalSession: false,
    readOnlyConnection: true,
    tradingConnection: true
  },
  products: ["spot", "perpetual"],
  operations: [
    "validateCredentials", "getAccount", "getBalances", "getPositions",
    "getOpenOrders", "placeOrder", "cancelOrder", "modifyOrder",
    "subscribePrivateData", "healthCheck", "reconnect"
  ]
});

export function registerBrokerAdapterDefinition(definition) {
  if (!definition?.id) throw new Error("Broker adapter definition requires an id.");
  definitions.set(String(definition.id).toLowerCase(), Object.freeze({ ...definition }));
}

export function getBrokerAdapterDefinition(provider) {
  return definitions.get(String(provider || "").toLowerCase()) || null;
}

export function listBrokerAdapterDefinitions() {
  return [...definitions.values()].map((definition) => ({
    ...definition,
    authorization: {
      ...definition.authorization,
      oauthConfigured: definition.id === "bybit" && bybitOAuthConfigured(),
      oauthUnavailableReason: definition.id === "bybit" && !bybitOAuthConfigured()
        ? "Bybit authorization requires an approved API Broker application and server-side OAuth credentials."
        : null
    }
  }));
}

export function bybitOAuthConfigured() {
  return Boolean(
    process.env.BYBIT_OAUTH_CLIENT_ID &&
    process.env.BYBIT_OAUTH_CLIENT_SECRET &&
    process.env.BYBIT_OAUTH_REDIRECT_URI &&
    process.env.PUBLIC_APP_URL
  );
}
