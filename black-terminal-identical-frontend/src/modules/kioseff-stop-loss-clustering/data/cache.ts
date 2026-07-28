import type { KioseffHistoryResult } from "./types.ts";

export class KioseffHistoryCache {
  private entries = new Map<string, KioseffHistoryResult>();
  private readonly limit: number;

  constructor(limit = 4) {
    this.limit = limit;
  }

  get(key: string) {
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: KioseffHistoryResult) {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  invalidateSource(sourceVersion: string) {
    for (const [key, value] of this.entries) {
      if (value.sourceVersion === sourceVersion) this.entries.delete(key);
    }
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}
