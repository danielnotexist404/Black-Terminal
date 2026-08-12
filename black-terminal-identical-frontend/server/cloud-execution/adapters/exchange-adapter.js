export const PERSISTENT_ADAPTER_OPERATIONS = Object.freeze([
  "verifyCredentials", "connect", "disconnect", "synchronizeAccount",
  "placeOrder", "modifyOrder", "cancelOrder", "cancelAll",
  "fetchOpenOrders", "fetchPositions", "fetchBalances", "fetchExecutions",
  "subscribeAccountEvents", "getHealth", "getCapabilities"
]);

export class ExchangeAdapter {
  constructor({ credentials, network, executionEnvironment, endpointProfile, connectionId } = {}) {
    this.credentials = credentials;
    this.network = network;
    this.executionEnvironment = executionEnvironment || network;
    this.endpointProfile = endpointProfile || "GLOBAL";
    this.connectionId = connectionId;
  }

  verifyCredentials() { return this.unsupported("verifyCredentials"); }
  validateCredentials(...args) { return this.verifyCredentials(...args); }
  beginAuthorization() { return this.unsupported("beginAuthorization"); }
  completeAuthorization() { return this.unsupported("completeAuthorization"); }
  refreshAuthorization() { return this.unsupported("refreshAuthorization"); }
  connect() { return this.unsupported("connect"); }
  disconnect() { return this.unsupported("disconnect"); }
  synchronizeAccount() { return this.unsupported("synchronizeAccount"); }
  placeOrder() { return this.unsupported("placeOrder"); }
  placeStrategyOrder() { return this.unsupported("placeStrategyOrder"); }
  modifyOrder() { return this.unsupported("modifyOrder"); }
  cancelOrder() { return this.unsupported("cancelOrder"); }
  cancelAll() { return this.unsupported("cancelAll"); }
  validateOrderDraft() { return this.unsupported("validateOrderDraft"); }
  getWalletSnapshot() { return this.unsupported("getWalletSnapshot"); }
  validateProductionGate() { return this.unsupported("validateProductionGate"); }
  validateManagementGate() { return this.unsupported("validateManagementGate"); }
  findOrderByClientOrderId() { return this.unsupported("findOrderByClientOrderId"); }
  fetchOpenOrders() { return this.unsupported("fetchOpenOrders"); }
  fetchPositions() { return this.unsupported("fetchPositions"); }
  fetchBalances() { return this.unsupported("fetchBalances"); }
  fetchExecutions() { return this.unsupported("fetchExecutions"); }
  subscribeAccountEvents() { return this.unsupported("subscribeAccountEvents"); }
  subscribeMarketData() { return this.unsupported("subscribeMarketData"); }
  unsubscribePrivateData(subscription) { return subscription?.close?.(); }
  getInstruments() { return this.unsupported("getInstruments"); }
  getCapabilities() { return { provider: this.provider || "unknown", authorization: {}, products: [], operations: [] }; }
  healthCheck() { return this.getHealth(); }
  reconnect(context = {}) { return this.connect(context); }
  getHealth() { return { provider: this.provider || "unknown", state: "UNAVAILABLE", connected: false, degradationReasons: ["Adapter health is not implemented."] }; }

  // Compatibility aliases for the pre-Chapter-II-B server contract.
  authenticate(...args) { return this.verifyCredentials(...args); }
  getAccount(...args) { return this.synchronizeAccount(...args); }
  getBalances(...args) { return this.fetchBalances(...args); }
  getPositions(...args) { return this.fetchPositions(...args); }
  getOpenOrders(...args) { return this.fetchOpenOrders(...args); }
  getOrders(...args) { return this.fetchOpenOrders(...args); }
  subscribePrivateEvents(options = {}) {
    return this.subscribeAccountEvents((event) => options.onMessage?.(event), options);
  }
  subscribePrivateData(...args) { return this.subscribeAccountEvents(...args); }
  reconcile(...args) { return this.synchronizeAccount(...args); }

  unsupported(operation) {
    throw Object.assign(new Error(`${this.constructor.name} does not implement ${operation}.`), {
      code: "ADAPTER_OPERATION_UNSUPPORTED",
      operation,
      provider: this.provider || "unknown"
    });
  }
}

export function assertExchangeAdapter(adapter) {
  for (const operation of PERSISTENT_ADAPTER_OPERATIONS) {
    if (typeof adapter?.[operation] !== "function") throw new Error(`Persistent exchange adapter is missing ${operation}().`);
  }
  return adapter;
}
