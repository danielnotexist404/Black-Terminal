import type { AuctionProfileSnapshot } from "../core/types.ts";

export class AuctionProfileCache {
  private values = new Map<string, AuctionProfileSnapshot>();
  private readonly maximumEntries: number;

  constructor(maximumEntries = 24) {
    this.maximumEntries = maximumEntries;
  }

  get(key: string) {
    const value = this.values.get(key);
    return value ? structuredClone(value) : null;
  }

  set(key: string, snapshot: AuctionProfileSnapshot) {
    this.values.delete(key);
    this.values.set(key, structuredClone(snapshot));
    while (this.values.size > this.maximumEntries) {
      const oldest = this.values.keys().next().value;
      if (typeof oldest !== "string") break;
      this.values.delete(oldest);
    }
  }

  clear() {
    this.values.clear();
  }

  get size() {
    return this.values.size;
  }
}
