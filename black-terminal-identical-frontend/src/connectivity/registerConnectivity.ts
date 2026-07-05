import { marketCatalog } from "../market-data/marketCatalog";
import { blackCoreConnectionManager } from "./connectionManager";
import { createCentralizedExchangeConnectionAdapter } from "./adapters/centralizedExchangeAdapter";
import { metaMaskConnectionAdapter, phantomConnectionAdapter } from "./adapters/walletAdapters";

let registered = false;

export function registerConnectivityAdapters() {
  if (registered) return;
  registered = true;

  for (const exchange of marketCatalog) {
    blackCoreConnectionManager.registerAdapter(createCentralizedExchangeConnectionAdapter(exchange.id, exchange.label));
  }

  blackCoreConnectionManager.registerAdapter(metaMaskConnectionAdapter);
  blackCoreConnectionManager.registerAdapter(phantomConnectionAdapter);
}
