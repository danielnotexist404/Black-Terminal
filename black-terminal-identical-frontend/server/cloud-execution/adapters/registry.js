import { BybitCloudAdapter } from "./bybit-cloud-adapter.js";
import { assertExchangeAdapter } from "./exchange-adapter.js";

const factories = new Map([["bybit", (options) => new BybitCloudAdapter(options)]]);

export function registerCloudExchangeAdapter(provider, factory) {
  if (!provider || typeof factory !== "function") throw new Error("A provider and adapter factory are required.");
  factories.set(String(provider).toLowerCase(), factory);
}

export function createCloudExchangeAdapter(provider, options) {
  const factory = factories.get(String(provider || "").toLowerCase());
  if (!factory) throw Object.assign(new Error(`No Black Cloud adapter is registered for ${provider}.`), { code: "PROVIDER_UNSUPPORTED" });
  return assertExchangeAdapter(factory(options));
}

export function listCloudExchangeAdapters() { return [...factories.keys()]; }
