import { blackCoreConnectionManager } from "../connectivity/connectionManager";
import { hyperliquidProtocolAdapter } from "./hyperliquidAdapter";
import { blackCoreProtocolRouter } from "./protocolRouter";

let registered = false;

export function registerProtocolAdapters() {
  if (registered) return;
  registered = true;
  blackCoreProtocolRouter.register(hyperliquidProtocolAdapter);
  blackCoreConnectionManager.registerAdapter(hyperliquidProtocolAdapter);
}
