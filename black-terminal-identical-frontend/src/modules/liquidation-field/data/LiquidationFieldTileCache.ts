export interface LiquidationFieldTileCacheIdentity {
  venue: string;
  symbol: string;
  horizon: string;
  tileId: string;
  modelVersion: string;
  schemaVersion: number;
  checksum: string;
}

interface CacheEntry<Value> {
  value: Value;
  bytes: number;
  insertedAt: number;
  lastAccessedAt: number;
}

export interface LiquidationFieldTileCacheMetrics {
  entries: number;
  bytes: number;
  maximumBytes: number;
  hits: number;
  misses: number;
  evictions: number;
}

export function liquidationFieldTileCacheKey(identity: LiquidationFieldTileCacheIdentity) {
  return JSON.stringify([
    identity.venue.trim().toUpperCase(),
    identity.symbol.trim().toUpperCase(),
    identity.horizon.trim().toUpperCase(),
    identity.tileId,
    identity.modelVersion,
    identity.schemaVersion,
    identity.checksum.toLowerCase()
  ]);
}

/**
 * Memory-only LRU for proprietary decoded tiles. It deliberately avoids
 * localStorage/IndexedDB so a sign-out or controller disposal can remove the
 * complete cache without leaving an unbounded historical field on disk.
 */
export class LiquidationFieldTileCache<Value> {
  private readonly entries = new Map<string, CacheEntry<Value>>();
  private totalBytes = 0;
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;
  private readonly maximumBytes: number;
  private readonly maximumAgeMs: number;

  constructor(maximumBytes: number, maximumAgeMs = 20 * 60 * 1_000) {
    this.maximumBytes = maximumBytes;
    this.maximumAgeMs = maximumAgeMs;
  }

  get(identity: LiquidationFieldTileCacheIdentity) {
    const key = liquidationFieldTileCacheKey(identity);
    const entry = this.entries.get(key);
    if (!entry) {
      this.missCount += 1;
      return undefined;
    }
    if (Date.now() - entry.insertedAt > this.maximumAgeMs) {
      this.deleteKey(key, entry);
      this.missCount += 1;
      return undefined;
    }
    this.entries.delete(key);
    entry.lastAccessedAt = Date.now();
    this.entries.set(key, entry);
    this.hitCount += 1;
    return entry.value;
  }

  set(identity: LiquidationFieldTileCacheIdentity, value: Value, bytes: number) {
    const size = Math.max(0, Math.floor(Number(bytes) || 0));
    if (size <= 0 || size > this.maximumBytes) return false;
    const key = liquidationFieldTileCacheKey(identity);
    this.invalidateChecksumChanges(identity, key);
    const previous = this.entries.get(key);
    if (previous) this.deleteKey(key, previous, false);
    const now = Date.now();
    this.entries.set(key, { value, bytes: size, insertedAt: now, lastAccessedAt: now });
    this.totalBytes += size;
    this.evictExpired(now);
    while (this.totalBytes > this.maximumBytes && this.entries.size) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.entries.get(oldestKey);
      if (!oldest) break;
      this.deleteKey(oldestKey, oldest);
    }
    return this.entries.has(key);
  }

  invalidateVersions(expected: Pick<LiquidationFieldTileCacheIdentity, "venue" | "symbol" | "horizon" | "modelVersion" | "schemaVersion">) {
    for (const [key, entry] of this.entries) {
      const identity = JSON.parse(key) as [string, string, string, string, string, number, string];
      if (
        identity[0] !== expected.venue.trim().toUpperCase()
        || identity[1] !== expected.symbol.trim().toUpperCase()
        || identity[2] !== expected.horizon.trim().toUpperCase()
      ) continue;
      const modelVersion = identity[4];
      const schemaVersion = identity[5];
      if (modelVersion !== expected.modelVersion || schemaVersion !== expected.schemaVersion) this.deleteKey(key, entry);
    }
  }

  clear() {
    this.entries.clear();
    this.totalBytes = 0;
  }

  metrics(): LiquidationFieldTileCacheMetrics {
    return {
      entries: this.entries.size,
      bytes: this.totalBytes,
      maximumBytes: this.maximumBytes,
      hits: this.hitCount,
      misses: this.missCount,
      evictions: this.evictionCount
    };
  }

  private evictExpired(now: number) {
    for (const [key, entry] of this.entries) {
      if (now - entry.insertedAt <= this.maximumAgeMs) continue;
      this.deleteKey(key, entry);
    }
  }

  private invalidateChecksumChanges(identity: LiquidationFieldTileCacheIdentity, currentKey: string) {
    const scope = [
      identity.venue.trim().toUpperCase(),
      identity.symbol.trim().toUpperCase(),
      identity.horizon.trim().toUpperCase(),
      identity.tileId,
      identity.modelVersion,
      identity.schemaVersion
    ] as const;
    for (const [key, entry] of this.entries) {
      if (key === currentKey) continue;
      const cached = JSON.parse(key) as [string, string, string, string, string, number, string];
      if (scope.every((value, index) => cached[index] === value)) this.deleteKey(key, entry);
    }
  }

  private deleteKey(key: string, entry: CacheEntry<Value>, countEviction = true) {
    this.entries.delete(key);
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
    if (countEviction) this.evictionCount += 1;
  }
}

export function defaultLiquidationFieldTileCacheBytes() {
  if (typeof navigator === "undefined") return 64 * 1024 * 1024;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const constrainedTouch = navigator.maxTouchPoints > 0 && (nav.deviceMemory ?? 4) <= 4;
  return constrainedTouch ? 24 * 1024 * 1024 : 64 * 1024 * 1024;
}
