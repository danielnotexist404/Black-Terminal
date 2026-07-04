import { marketCatalog } from "../market-data/marketCatalog";
import type { ExchangeId } from "../market-data/types";
import type { ExchangeBrokerAdapter } from "./types";
import { MockExchangeBrokerAdapter } from "./mockExchangeBroker";

const adapters = new Map<ExchangeId, ExchangeBrokerAdapter>();

for (const exchange of marketCatalog) {
  adapters.set(exchange.id, new MockExchangeBrokerAdapter(exchange.id, exchange.label));
}

export function getBrokerAdapter(exchange: ExchangeId) {
  const adapter = adapters.get(exchange);
  if (!adapter) throw new Error(`No broker adapter registered for ${exchange}`);
  return adapter;
}

export function listBrokerAdapters() {
  return Array.from(adapters.values());
}
