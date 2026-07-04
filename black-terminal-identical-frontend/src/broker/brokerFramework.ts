import type { ExchangeBrokerAdapter } from "./types";
import type { ExchangeId } from "../market-data/types";

export type BrokerAdapterKind = "centralized-exchange" | "wallet" | "institutional";

export type BrokerAdapterDefinition = {
  id: ExchangeId | string;
  kind: BrokerAdapterKind;
  label: string;
  adapter: ExchangeBrokerAdapter;
};

export class BrokerFramework {
  private adapters = new Map<string, BrokerAdapterDefinition>();

  register(definition: BrokerAdapterDefinition) {
    this.adapters.set(definition.id, definition);
  }

  get(id: string) {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Broker adapter not registered: ${id}`);
    return adapter;
  }

  list(kind?: BrokerAdapterKind) {
    const adapters = Array.from(this.adapters.values());
    return kind ? adapters.filter((adapter) => adapter.kind === kind) : adapters;
  }
}

export const blackCoreBrokerFramework = new BrokerFramework();
