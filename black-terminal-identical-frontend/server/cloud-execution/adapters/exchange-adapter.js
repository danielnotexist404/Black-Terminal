export const PERSISTENT_ADAPTER_OPERATIONS = Object.freeze([
  "verifyCredentials", "connect", "disconnect", "synchronizeAccount",
  "placeOrder", "modifyOrder", "cancelOrder", "cancelAll",
  "fetchOpenOrders", "fetchPositions", "fetchBalances", "fetchExecutions",
  "subscribeAccountEvents", "getHealth"
]);

export class ExchangeAdapter {
  constructor({ credentials, network, connectionId } = {}) {
    this.credentials = credentials;
    this.network = network;
    this.connectionId = connectionId;
  }

  verifyCredentials() { return this.unsupported("verifyCredentials"); }
  connect() { return this.unsupported("connect"); }
  disconnect() { return this.unsupported("disconnect"); }
  synchronizeAccount() { return this.unsupported("synchronizeAccount"); }
  placeOrder() { return this.unsupported("placeOrder"); }
  modifyOrder() { return this.unsupported("modifyOrder"); }
  cancelOrder() { return this.unsupported("cancelOrder"); }
  cancelAll() { return this.unsupported("cancelAll"); }
  fetchOpenOrders() { return this.unsupported("fetchOpenOrders"); }
  fetchPositions() { return this.unsupported("fetchPositions"); }
  fetchBalances() { return this.unsupported("fetchBalances"); }
  fetchExecutions() { return this.unsupported("fetchExecutions"); }
  subscribeAccountEvents() { return this.unsupported("subscribeAccountEvents"); }
  subscribeMarketData() { return this.unsupported("subscribeMarketData"); }
  getHealth() { return { provider: this.provider || "unknown", state: "UNAVAILABLE", connected: false, degradationReasons: ["Adapter health is not implemented."] }; }

  // Compatibility aliases for the pre-Chapter-II-B server contract.
  authenticate(...args) { return this.verifyCredentials(...args); }
  getAccount(...args) { return this.synchronizeAccount(...args); }
  getPositions(...args) { return this.fetchPositions(...args); }
  getOrders(...args) { return this.fetchOpenOrders(...args); }
  subscribePrivateEvents(options = {}) {
    return this.subscribeAccountEvents((event) => options.onMessage?.(event), options);
  }
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
