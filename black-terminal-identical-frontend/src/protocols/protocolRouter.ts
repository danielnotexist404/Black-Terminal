import type { ConnectionRecord } from "../connectivity/types";
import type { ProtocolAdapter, ProtocolId } from "./types";

class ProtocolRouter {
  private adapters = new Map<ProtocolId, ProtocolAdapter>();

  register(adapter: ProtocolAdapter) {
    this.adapters.set(adapter.protocol, adapter);
  }

  get(protocol: ProtocolId) {
    const adapter = this.adapters.get(protocol);
    if (!adapter) throw new Error(`Protocol adapter not registered: ${protocol}`);
    return adapter;
  }

  list() {
    return Array.from(this.adapters.values());
  }

  resolve(connection: ConnectionRecord) {
    const protocol = connection.metadata.protocol;
    if (typeof protocol !== "string") return null;
    return this.adapters.get(protocol as ProtocolId) ?? null;
  }
}

export const blackCoreProtocolRouter = new ProtocolRouter();
