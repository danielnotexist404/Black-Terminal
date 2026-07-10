import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import type { MarketSymbol, OrderBookLevel, OrderBookSnapshot } from "../../market-data/types";
import type { DomHeatmapHorizon, MacroLiquidityRange } from "./types";
import { fetchBlackCoreDepthReplay } from "./marketDepthMemoryClient";

export type DepthHistorySide = "bid" | "ask";

export type DepthHistoryPoint = {
  id: string;
  side: DepthHistorySide;
  price: number;
  bucketSize: number;
  firstSeen: number;
  lastSeen: number;
  observations: number;
  peakSize: number;
  lastSize: number;
  strength: number;
};

export type DepthHistoryRead = {
  points: DepthHistoryPoint[];
  stats: {
    totalPoints: number;
    bidPoints: number;
    askPoints: number;
    firstSeen: number | null;
    lastSeen: number | null;
    localOnly: boolean;
    source: "black-core" | "supabase" | "local";
  };
};

type DepthHistoryData = {
  version: 1;
  symbolKey: string;
  updatedAt: number;
  points: DepthHistoryPoint[];
};

const storagePrefix = "bt_depth_history_v1";
const maxPointsPerSymbol = 900;
const recordThrottleMs = 5000;
const persistThrottleMs = 15000;
const remoteSyncThrottleMs = 60000;
const maxRemotePointsPerSync = 80;

export class BlackDepthHistoryStore {
  private stores = new Map<string, DepthHistoryData>();
  private listeners = new Map<string, Set<() => void>>();
  private lastRecordAt = new Map<string, number>();
  private lastPersistAt = new Map<string, number>();
  private lastRemoteSyncAt = new Map<string, number>();
  private remoteHydrated = new Set<string>();
  private remoteDisabledUntil = 0;
  private blackCoreHydrated = new Set<string>();
  private blackCoreLastQueryAt = new Map<string, number>();
  private blackCoreDisabledUntil = 0;

  subscribe(symbol: MarketSymbol, listener: () => void) {
    const key = symbolKey(symbol);
    const listeners = this.listeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    this.load(symbol);
    void this.hydrateRemote(symbol);
    return () => {
      const next = this.listeners.get(key);
      if (!next) return;
      next.delete(listener);
      if (next.size === 0) this.listeners.delete(key);
    };
  }

  record(symbol: MarketSymbol, book: OrderBookSnapshot | null, lastPrice: number | null | undefined) {
    if (typeof window === "undefined" || !book || book.bids.length === 0 || book.asks.length === 0) return;
    const key = symbolKey(symbol);
    const now = Date.now();
    if (now - (this.lastRecordAt.get(key) ?? 0) < recordThrottleMs) return;
    this.lastRecordAt.set(key, now);

    const data = this.load(symbol);
    const pointMap = new Map(data.points.map((point) => [point.id, point]));
    const mid = Number(lastPrice ?? midpoint(book));
    const bucketSize = resolveHistoryBucketSize(book, mid);
    const candidates = [
      ...selectCandidateLevels(book.bids, "bid", mid),
      ...selectCandidateLevels(book.asks, "ask", mid)
    ];
    const maxBySide = {
      bid: Math.max(...candidates.filter((item) => item.side === "bid").map((item) => item.quantity), 1),
      ask: Math.max(...candidates.filter((item) => item.side === "ask").map((item) => item.quantity), 1)
    };
    const seen = new Set<string>();

    for (const candidate of candidates) {
      const price = roundToHistoryBucket(candidate.price, bucketSize);
      const id = `${candidate.side}:${price.toFixed(8)}`;
      const previous = pointMap.get(id);
      const rawStrength = Math.min(1, candidate.quantity / Math.max(1, maxBySide[candidate.side]));
      const strength = previous ? Math.min(1, previous.strength * 0.9 + rawStrength * 0.18) : rawStrength;
      pointMap.set(id, {
        id,
        side: candidate.side,
        price,
        bucketSize,
        firstSeen: previous?.firstSeen ?? now,
        lastSeen: now,
        observations: (previous?.observations ?? 0) + 1,
        peakSize: Math.max(previous?.peakSize ?? 0, candidate.quantity),
        lastSize: candidate.quantity,
        strength
      });
      seen.add(id);
    }

    const staleCutoff = now - 14 * 24 * 60 * 60 * 1000;
    data.points = Array.from(pointMap.values())
      .map((point) => seen.has(point.id) ? point : { ...point, strength: point.strength * 0.997 })
      .filter((point) => point.lastSeen >= staleCutoff && (point.strength >= 0.035 || now - point.lastSeen < 30 * 60 * 1000))
      .sort((a, b) => historyScore(b, now) - historyScore(a, now))
      .slice(0, maxPointsPerSymbol)
      .sort((a, b) => b.price - a.price);
    data.updatedAt = now;

    if (now - (this.lastPersistAt.get(key) ?? 0) >= persistThrottleMs) {
      this.persist(key, data);
      this.lastPersistAt.set(key, now);
    }
    if (now - (this.lastRemoteSyncAt.get(key) ?? 0) >= remoteSyncThrottleMs) {
      this.lastRemoteSyncAt.set(key, now);
      void this.syncRemote(symbol, data);
    }
    this.notify(key);
  }

  read(symbol: MarketSymbol, range: MacroLiquidityRange, horizon: DomHeatmapHorizon): DepthHistoryRead {
    const now = Date.now();
    const data = this.load(symbol);
    void this.hydrateBlackCore(symbol, range, horizon);
    const cutoff = now - horizonMs(horizon);
    const points = data.points
      .filter((point) => point.price >= range.min && point.price <= range.max)
      .filter((point) => point.lastSeen >= cutoff || horizon === "1w")
      .sort((a, b) => historyScore(b, now) - historyScore(a, now))
      .slice(0, 220)
      .sort((a, b) => b.price - a.price);
    const firstSeen = points.length ? Math.min(...points.map((point) => point.firstSeen)) : null;
    const lastSeen = points.length ? Math.max(...points.map((point) => point.lastSeen)) : null;
    return {
      points,
      stats: {
        totalPoints: data.points.length,
        bidPoints: data.points.filter((point) => point.side === "bid").length,
        askPoints: data.points.filter((point) => point.side === "ask").length,
        firstSeen,
        lastSeen,
        localOnly: !isSupabaseConfigured && !this.blackCoreHydrated.has(symbolKey(symbol)),
        source: this.blackCoreHydrated.has(symbolKey(symbol)) ? "black-core" : isSupabaseConfigured ? "supabase" : "local"
      }
    };
  }

  private async hydrateBlackCore(symbol: MarketSymbol, range: MacroLiquidityRange, horizon: DomHeatmapHorizon) {
    const key = symbolKey(symbol);
    if (Date.now() < this.blackCoreDisabledUntil) return;
    const queryKey = `${key}:${horizon}:${Math.round(range.min)}:${Math.round(range.max)}`;
    if (Date.now() - (this.blackCoreLastQueryAt.get(queryKey) ?? 0) < 45_000) return;
    this.blackCoreLastQueryAt.set(queryKey, Date.now());
    try {
      const replay = await fetchBlackCoreDepthReplay(symbol, range, horizon);
      if (!replay?.points.length) return;
      const local = this.load(symbol);
      const map = new Map(local.points.map((point) => [point.id, point]));
      for (const point of replay.points) {
        if (!Number.isFinite(point.price) || point.price <= 0) continue;
        const side = point.side === "ask" ? "ask" : "bid";
        const id = `${side}:${point.price.toFixed(8)}`;
        const existing = map.get(id);
        const firstSeen = Number(point.firstSeen) || Date.now();
        const lastSeen = Number(point.lastSeen) || Date.now();
        if (existing && existing.lastSeen > lastSeen && existing.strength >= point.strength) continue;
        map.set(id, {
          id,
          side,
          price: point.price,
          bucketSize: Number(point.bucketSize) || Math.max(point.price * 0.0005, 0.01),
          firstSeen: existing ? Math.min(existing.firstSeen, firstSeen) : firstSeen,
          lastSeen: Math.max(existing?.lastSeen ?? 0, lastSeen),
          observations: Math.max(existing?.observations ?? 0, Number(point.observations) || 1),
          peakSize: Math.max(existing?.peakSize ?? 0, Number(point.peakSize) || 0),
          lastSize: Math.max(existing?.lastSize ?? 0, Number(point.lastSize) || 0),
          strength: Math.max(existing?.strength ?? 0, Math.max(0, Math.min(1, Number(point.strength) || 0)))
        });
      }
      local.points = Array.from(map.values())
        .sort((a, b) => historyScore(b, Date.now()) - historyScore(a, Date.now()))
        .slice(0, maxPointsPerSymbol)
        .sort((a, b) => b.price - a.price);
      local.updatedAt = Date.now();
      this.blackCoreHydrated.add(key);
      this.persist(key, local);
      this.notify(key);
    } catch {
      this.blackCoreDisabledUntil = Date.now() + 60_000;
    }
  }

  private load(symbol: MarketSymbol): DepthHistoryData {
    const key = symbolKey(symbol);
    const existing = this.stores.get(key);
    if (existing) return existing;
    const fallback: DepthHistoryData = { version: 1, symbolKey: key, updatedAt: Date.now(), points: [] };
    if (typeof localStorage === "undefined") {
      this.stores.set(key, fallback);
      return fallback;
    }
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey(key)) || "null") as DepthHistoryData | null;
      const data = parsed?.version === 1 && Array.isArray(parsed.points) ? parsed : fallback;
      this.stores.set(key, data);
      return data;
    } catch {
      this.stores.set(key, fallback);
      return fallback;
    }
  }

  private persist(key: string, data: DepthHistoryData) {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(storageKey(key), JSON.stringify(data));
    } catch {
      data.points = data.points.slice(0, Math.floor(maxPointsPerSymbol / 2));
      try {
        localStorage.setItem(storageKey(key), JSON.stringify(data));
      } catch {
        // Local persistence is best-effort; live memory remains available.
      }
    }
  }

  private async syncRemote(symbol: MarketSymbol, data: DepthHistoryData) {
    if (!isSupabaseConfigured || !supabase || Date.now() < this.remoteDisabledUntil) return;
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData.session?.user.id;
      if (!userId) return;
      const rows = data.points
        .slice()
        .sort((a, b) => historyScore(b, Date.now()) - historyScore(a, Date.now()))
        .slice(0, maxRemotePointsPerSync)
        .map((point) => ({
          user_id: userId,
          exchange: symbol.exchange,
          market_kind: symbol.marketKind,
          symbol: symbol.rawSymbol.toUpperCase(),
          side: point.side,
          price_bucket: point.price,
          bucket_size: point.bucketSize,
          first_seen_at: new Date(point.firstSeen).toISOString(),
          last_seen_at: new Date(point.lastSeen).toISOString(),
          observations: point.observations,
          peak_size: point.peakSize,
          last_size: point.lastSize,
          strength: point.strength,
          metadata: { source: "black-terminal-dom-pro", version: 1 }
        }));
      if (rows.length === 0) return;
      const { error } = await supabase
        .from("market_depth_memory")
        .upsert(rows, { onConflict: "user_id,exchange,market_kind,symbol,side,price_bucket" });
      if (error) throw error;
    } catch {
      this.remoteDisabledUntil = Date.now() + 5 * 60 * 1000;
    }
  }

  private async hydrateRemote(symbol: MarketSymbol) {
    const key = symbolKey(symbol);
    if (this.remoteHydrated.has(key) || !isSupabaseConfigured || !supabase || Date.now() < this.remoteDisabledUntil) return;
    this.remoteHydrated.add(key);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData.session?.user.id;
      if (!userId) return;
      const { data, error } = await supabase
        .from("market_depth_memory")
        .select("side,price_bucket,bucket_size,first_seen_at,last_seen_at,observations,peak_size,last_size,strength")
        .eq("user_id", userId)
        .eq("exchange", symbol.exchange)
        .eq("market_kind", symbol.marketKind)
        .eq("symbol", symbol.rawSymbol.toUpperCase())
        .order("last_seen_at", { ascending: false })
        .limit(700);
      if (error) throw error;
      if (!data?.length) return;
      const local = this.load(symbol);
      const map = new Map(local.points.map((point) => [point.id, point]));
      for (const row of data as any[]) {
        const side = row.side === "ask" ? "ask" : "bid";
        const price = Number(row.price_bucket);
        if (!Number.isFinite(price) || price <= 0) continue;
        const id = `${side}:${price.toFixed(8)}`;
        const firstSeen = Date.parse(row.first_seen_at);
        const lastSeen = Date.parse(row.last_seen_at);
        const existing = map.get(id);
        if (existing && existing.lastSeen >= lastSeen) continue;
        map.set(id, {
          id,
          side,
          price,
          bucketSize: Number(row.bucket_size) || Math.max(price * 0.00075, 0.01),
          firstSeen: Number.isFinite(firstSeen) ? firstSeen : Date.now(),
          lastSeen: Number.isFinite(lastSeen) ? lastSeen : Date.now(),
          observations: Number(row.observations) || 1,
          peakSize: Number(row.peak_size) || 0,
          lastSize: Number(row.last_size) || 0,
          strength: Math.max(0, Math.min(1, Number(row.strength) || 0))
        });
      }
      local.points = Array.from(map.values())
        .sort((a, b) => historyScore(b, Date.now()) - historyScore(a, Date.now()))
        .slice(0, maxPointsPerSymbol)
        .sort((a, b) => b.price - a.price);
      local.updatedAt = Date.now();
      this.persist(key, local);
      this.notify(key);
    } catch {
      this.remoteDisabledUntil = Date.now() + 5 * 60 * 1000;
    }
  }

  private notify(key: string) {
    const listeners = this.listeners.get(key);
    if (!listeners) return;
    for (const listener of listeners) listener();
  }
}

function selectCandidateLevels(levels: OrderBookLevel[], side: DepthHistorySide, mid: number) {
  const valid = levels
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.quantity) && level.price > 0 && level.quantity > 0)
    .filter((level) => mid <= 0 || (side === "bid" ? level.price <= mid : level.price >= mid));
  const quantities = valid.map((level) => level.quantity);
  const avg = average(quantities);
  const threshold = Math.max(avg * 1.1, avg + standardDeviation(quantities) * 0.35);
  const ranked = valid.slice().sort((a, b) => b.quantity - a.quantity);
  const accepted = ranked.filter((level) => level.quantity >= threshold).slice(0, 30);
  const fallback = ranked.slice(0, Math.min(14, ranked.length));
  return (accepted.length ? accepted : fallback).map((level) => ({ ...level, side }));
}

function resolveHistoryBucketSize(book: OrderBookSnapshot, mid: number) {
  const prices = [...book.bids.slice(0, 20), ...book.asks.slice(0, 20)].map((level) => level.price).filter((price) => price > 0);
  const diffs = prices
    .slice()
    .sort((a, b) => a - b)
    .map((price, index, sorted) => index === 0 ? 0 : price - sorted[index - 1])
    .filter((diff) => diff > 0);
  const minTick = diffs.length ? Math.min(...diffs) : Math.max(mid * 0.00001, 0.01);
  return Math.max(minTick * 8, mid * 0.00075, 0.01);
}

function roundToHistoryBucket(price: number, bucketSize: number) {
  return Math.round(price / bucketSize) * bucketSize;
}

function midpoint(book: OrderBookSnapshot) {
  const bid = book.bids[0]?.price ?? 0;
  const ask = book.asks[0]?.price ?? 0;
  return bid && ask ? (bid + ask) / 2 : bid || ask || 0;
}

function historyScore(point: DepthHistoryPoint, now: number) {
  const persistenceHours = Math.max(0.1, (point.lastSeen - point.firstSeen) / 3600000);
  const ageHours = Math.max(0, (now - point.lastSeen) / 3600000);
  const ageDecay = 1 / (1 + ageHours / 48);
  return point.strength * ageDecay * (1 + Math.log1p(point.observations) * 0.18 + Math.min(1.4, persistenceHours * 0.08));
}

function horizonMs(horizon: DomHeatmapHorizon) {
  switch (horizon) {
    case "15m": return 15 * 60 * 1000;
    case "2h": return 2 * 60 * 60 * 1000;
    case "6h": return 6 * 60 * 60 * 1000;
    case "12h": return 12 * 60 * 60 * 1000;
    case "24h": return 24 * 60 * 60 * 1000;
    case "3d": return 3 * 24 * 60 * 60 * 1000;
    case "1w": return 14 * 24 * 60 * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}

function symbolKey(symbol: MarketSymbol) {
  return [symbol.exchange, symbol.marketKind, symbol.rawSymbol.toUpperCase()].join(":");
}

function storageKey(key: string) {
  return `${storagePrefix}:${key}`;
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values: number[]) {
  if (values.length <= 1) return 0;
  const avg = average(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length);
}

export const blackDepthHistoryStore = new BlackDepthHistoryStore();
