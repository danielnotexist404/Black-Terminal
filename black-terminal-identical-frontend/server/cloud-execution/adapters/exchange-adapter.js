export class ExchangeAdapter {
  constructor({ credentials, network, connectionId } = {}) {
    this.credentials = credentials;
    this.network = network;
    this.connectionId = connectionId;
  }

  connect() { return this.unsupported("connect"); }
  authenticate() { return this.unsupported("authenticate"); }
  getAccount() { return this.unsupported("getAccount"); }
  getPositions() { return this.unsupported("getPositions"); }
  getOrders() { return this.unsupported("getOrders"); }
  placeOrder() { return this.unsupported("placeOrder"); }
  cancelOrder() { return this.unsupported("cancelOrder"); }
  modifyOrder() { return this.unsupported("modifyOrder"); }
  subscribeMarketData() { return this.unsupported("subscribeMarketData"); }
  subscribePrivateEvents() { return this.unsupported("subscribePrivateEvents"); }
  reconcile() { return this.unsupported("reconcile"); }

  unsupported(operation) {
    throw Object.assign(new Error(`${this.constructor.name} does not implement ${operation}.`), { code: "ADAPTER_OPERATION_UNSUPPORTED" });
  }
}

export function assertExchangeAdapter(adapter) {
  const operations = ["connect", "authenticate", "getAccount", "getPositions", "getOrders", "placeOrder", "cancelOrder", "modifyOrder", "subscribeMarketData", "subscribePrivateEvents", "reconcile"];
  for (const operation of operations) if (typeof adapter?.[operation] !== "function") throw new Error(`Exchange adapter is missing ${operation}().`);
  return adapter;
}
