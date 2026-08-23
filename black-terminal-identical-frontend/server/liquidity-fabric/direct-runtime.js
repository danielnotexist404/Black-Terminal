import WebSocket from "ws";
import { projectLiquidityViewport } from "./viewport-compositor.js";

const MAX_BOOKS = 8;
const SESSION_STALE_MS = 15_000;
const SNAPSHOT_SORT_THROTTLE_MS = 700;
const BUNDLE_IDLE_MS = 120_000;

export class DirectLiquidityFabricRuntime {
  constructor({ WebSocketCtor = WebSocket, fetchImpl = globalThis.fetch, now = () => Date.now(), logger = console } = {}) {
    this.WebSocketCtor = WebSocketCtor;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.logger = logger;
    this.bundles = new Map();
  }

  async viewport(input = {}) {
    const baseAsset = normalizeBaseAsset(input.baseAsset);
    const bundle = this.ensureBundle(baseAsset);
    bundle.lastRequestedAt = this.now();
    await waitForReady(bundle, 8_000);
    const key = viewportKey(input);
    const previousRows = bundle.previousFrames.get(key) ?? null;
    const result = projectLiquidityViewport({
      ...input,
      baseAsset,
      books: [...bundle.sessions.values()].map((session) => session.snapshot()),
      previousRows,
      now: this.now(),
      maximumAgeMs: SESSION_STALE_MS
    });
    bundle.previousFrames.set(key, result.rows);
    if (bundle.previousFrames.size > 12) bundle.previousFrames.delete(bundle.previousFrames.keys().next().value);
    return result;
  }

  ensureBundle(baseAsset) {
    for (const [asset, candidate] of this.bundles) {
      if (asset !== baseAsset && this.now() - candidate.lastRequestedAt > BUNDLE_IDLE_MS) {
        candidate.stop();
        this.bundles.delete(asset);
      }
    }
    const existing = this.bundles.get(baseAsset);
    if (existing) return existing;
    if (this.bundles.size >= MAX_BOOKS) {
      const oldest = [...this.bundles.values()].sort((left, right) => left.lastRequestedAt - right.lastRequestedAt)[0];
      oldest?.stop();
      if (oldest) this.bundles.delete(oldest.baseAsset);
    }
    const bundle = createBundle(this, baseAsset);
    this.bundles.set(baseAsset, bundle);
    bundle.start();
    return bundle;
  }

  stop() {
    for (const bundle of this.bundles.values()) bundle.stop();
    this.bundles.clear();
  }
}

export class VenueBookSession {
  constructor({ venue, marketKind, exchangeSymbol, baseAsset, quoteAsset, transport, now = () => Date.now() }) {
    this.venue = venue;
    this.marketKind = marketKind;
    this.exchangeSymbol = exchangeSymbol;
    this.baseAsset = baseAsset;
    this.quoteAsset = quoteAsset;
    this.transport = transport;
    this.status = "AWAITING_SNAPSHOT";
    this.bids = new Map();
    this.asks = new Map();
    this.sourceTimestamp = null;
    this.receivedAt = null;
    this.sequence = null;
    this.reconnects = 0;
    this.lastError = null;
    this.socket = null;
    this.timer = null;
    this.stopped = false;
    this.now = now;
    this.snapshotCache = null;
    this.snapshotDirty = true;
    this.snapshotBuiltAt = 0;
  }

  replace({ bids, asks, sourceTimestamp, sequence }) {
    const nextBids = levelMap(bids);
    const nextAsks = levelMap(asks);
    if (!validShape(nextBids, nextAsks)) throw new Error(`${this.venue} delivered a crossed or empty book`);
    this.bids = nextBids;
    this.asks = nextAsks;
    this.sourceTimestamp = finiteTimestamp(sourceTimestamp, this.now());
    this.receivedAt = this.now();
    this.sequence = sequence ?? this.sequence;
    this.status = "HEALTHY";
    this.lastError = null;
    this.snapshotDirty = true;
  }

  apply(changes, sourceTimestamp, sequence) {
    if (this.status !== "HEALTHY") return;
    for (const change of changes) {
      const side = change.side;
      const price = Number(change.price);
      const quantity = Number(change.quantity);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity < 0) continue;
      const target = side === "bid" ? this.bids : this.asks;
      if (quantity === 0) target.delete(price);
      else target.set(price, quantity);
    }
    if (!validShape(this.bids, this.asks)) {
      this.status = "QUARANTINED";
      this.lastError = "Crossed reconstructed book";
      this.snapshotDirty = true;
      return;
    }
    this.sourceTimestamp = finiteTimestamp(sourceTimestamp, this.now());
    this.receivedAt = this.now();
    this.sequence = sequence ?? this.sequence;
    this.snapshotDirty = true;
  }

  snapshot() {
    if (this.snapshotCache && this.snapshotCache.status === this.status
      && (!this.snapshotDirty || this.now() - this.snapshotBuiltAt < SNAPSHOT_SORT_THROTTLE_MS)) return this.snapshotCache;
    const bids = sorted(this.bids, "bid");
    const asks = sorted(this.asks, "ask");
    this.snapshotCache = Object.freeze({
      venue: this.venue,
      marketKind: this.marketKind,
      exchangeSymbol: this.exchangeSymbol,
      baseAsset: this.baseAsset,
      quoteAsset: this.quoteAsset,
      transport: this.transport,
      direct: true,
      relabelled: false,
      status: this.status,
      sourceTimestamp: this.sourceTimestamp,
      receivedAt: this.receivedAt,
      sequence: this.sequence,
      bids: Object.freeze(bids),
      asks: Object.freeze(asks)
    });
    this.snapshotDirty = false;
    this.snapshotBuiltAt = this.now();
    return this.snapshotCache;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    try { this.socket?.close(); } catch { /* best effort */ }
  }
}

function createBundle(runtime, baseAsset) {
  const sessions = new Map();
  const add = (session) => { sessions.set(session.venue, session); return session; };
  const common = { baseAsset, now: runtime.now };
  const coinbase = add(new VenueBookSession({ ...common, venue: "coinbase", marketKind: "spot", exchangeSymbol: `${baseAsset}-USD`, quoteAsset: "USD", transport: "WEBSOCKET_LEVEL2_BATCH" }));
  const binance = add(new VenueBookSession({ ...common, venue: "binance", marketKind: "spot", exchangeSymbol: `${baseAsset}USDT`, quoteAsset: "USDT", transport: "REST_L5000_SNAPSHOT" }));
  const bybit = add(new VenueBookSession({ ...common, venue: "bybit", marketKind: "perpetual", exchangeSymbol: `${baseAsset}USDT`, quoteAsset: "USDT", transport: "REST_FULL_SNAPSHOT_WEBSOCKET_FULL_DELTA" }));
  const hyperliquid = add(new VenueBookSession({ ...common, venue: "hyperliquid", marketKind: "perpetual", exchangeSymbol: baseAsset, quoteAsset: "USD", transport: "WEBSOCKET_L2_TOP20" }));
  const krakenSymbol = baseAsset === "BTC" ? "XBTUSD" : `${baseAsset}USD`;
  const kraken = add(new VenueBookSession({ ...common, venue: "kraken", marketKind: "spot", exchangeSymbol: krakenSymbol, quoteAsset: "USD", transport: "REST_L500_SNAPSHOT" }));
  const bundle = {
    baseAsset,
    sessions,
    previousFrames: new Map(),
    lastRequestedAt: runtime.now(),
    start() {
      startCoinbase(runtime, coinbase);
      startPolling(runtime, binance, () => fetchBinance(runtime, binance), 5_000);
      startBybitFull(runtime, bybit);
      startHyperliquid(runtime, hyperliquid);
      startPolling(runtime, kraken, () => fetchKraken(runtime, kraken), 2_500);
    },
    stop() { for (const session of sessions.values()) session.stop(); }
  };
  return bundle;
}

function startCoinbase(runtime, session) {
  connectSocket(runtime, session, "wss://ws-feed.exchange.coinbase.com", (socket) => {
    socket.send(JSON.stringify({ type: "subscribe", product_ids: [session.exchangeSymbol], channels: ["level2_batch"] }));
  }, (payload) => {
    if (payload.product_id !== session.exchangeSymbol) return;
    if (payload.type === "snapshot") {
      session.replace({ bids: payload.bids, asks: payload.asks, sourceTimestamp: Date.now(), sequence: payload.sequence });
      return;
    }
    if (payload.type === "l2update" && Array.isArray(payload.changes)) {
      session.apply(payload.changes.map(([side, price, quantity]) => ({ side: side === "buy" ? "bid" : "ask", price, quantity })), Date.parse(payload.time) || Date.now(), payload.sequence);
    }
  });
}

function startBybitFull(runtime, session) {
  const synchronization = { generation: 0, buffered: [], synchronized: false, lastUpdate: null, lastCrossSequence: null };
  connectSocket(runtime, session, "wss://stream.bybit.com/v5/public/linear", (socket) => {
    synchronization.generation += 1;
    synchronization.buffered = [];
    synchronization.synchronized = false;
    synchronization.lastUpdate = null;
    synchronization.lastCrossSequence = null;
    socket.send(JSON.stringify({ op: "subscribe", args: [`orderbook.full.${session.exchangeSymbol}`] }));
    const generation = synchronization.generation;
    setTimeout(() => void synchronizeBybitFull(runtime, session, synchronization, generation), 50);
  }, (payload) => {
    if (payload.topic !== `orderbook.full.${session.exchangeSymbol}` || !payload.data) return;
    const book = payload.data;
    const update = Number(book.u);
    const crossSequence = Number(book.seq);
    if (!Number.isFinite(update) || !Number.isFinite(crossSequence)) return;
    if (update === 1) {
      synchronization.generation += 1;
      synchronization.buffered = [];
      synchronization.synchronized = false;
      synchronization.lastUpdate = null;
      synchronization.lastCrossSequence = null;
      session.status = "AWAITING_SNAPSHOT";
      session.snapshotDirty = true;
      void synchronizeBybitFull(runtime, session, synchronization, synchronization.generation);
      return;
    }
    const delta = {
      update,
      crossSequence,
      sourceTimestamp: payload.ts,
      changes: bybitChanges(book)
    };
    if (!synchronization.synchronized) {
      synchronization.buffered.push(delta);
      if (synchronization.buffered.length > 2_000) synchronization.buffered.splice(0, synchronization.buffered.length - 2_000);
      return;
    }
    if (!applyBybitDelta(session, synchronization, delta)) {
      synchronization.generation += 1;
      synchronization.buffered = [delta];
      synchronization.synchronized = false;
      session.status = "GAP";
      session.snapshotDirty = true;
      void synchronizeBybitFull(runtime, session, synchronization, synchronization.generation);
    }
  });
}

async function synchronizeBybitFull(runtime, session, synchronization, generation) {
  for (let attempt = 0; attempt < 8 && !session.stopped && generation === synchronization.generation; attempt += 1) {
    try {
      const snapshot = await fetchBybitFull(runtime, session);
      if (session.stopped || generation !== synchronization.generation) return;
      const pending = synchronization.buffered
        .filter((delta) => delta.update >= snapshot.update && delta.crossSequence >= snapshot.crossSequence)
        .sort((left, right) => left.update - right.update);
      const matchIndex = pending.findIndex((delta) => delta.update === snapshot.update && delta.crossSequence === snapshot.crossSequence);
      const remaining = matchIndex >= 0 ? pending.slice(matchIndex + 1) : pending.filter((delta) => delta.update > snapshot.update);
      if (remaining.length && remaining[0].update !== snapshot.update + 1) {
        await pause(75 * (attempt + 1));
        continue;
      }

      session.replace({ bids: snapshot.bids, asks: snapshot.asks, sourceTimestamp: snapshot.sourceTimestamp, sequence: snapshot.update });
      synchronization.lastUpdate = snapshot.update;
      synchronization.lastCrossSequence = snapshot.crossSequence;
      synchronization.synchronized = true;
      synchronization.buffered = [];
      for (const delta of remaining) {
        if (!applyBybitDelta(session, synchronization, delta)) {
          synchronization.synchronized = false;
          session.status = "GAP";
          session.snapshotDirty = true;
          break;
        }
      }
      if (synchronization.synchronized) return;
    } catch (error) {
      session.lastError = error instanceof Error ? error.message : String(error);
    }
    await pause(100 * (attempt + 1));
  }
  if (generation === synchronization.generation && !synchronization.synchronized) {
    session.status = "DISCONNECTED";
    session.snapshotDirty = true;
  }
}

function applyBybitDelta(session, synchronization, delta) {
  if (delta.update <= Number(synchronization.lastUpdate)) return true;
  if (delta.update !== Number(synchronization.lastUpdate) + 1 || delta.crossSequence < Number(synchronization.lastCrossSequence)) return false;
  session.apply(delta.changes, delta.sourceTimestamp, delta.update);
  if (session.status !== "HEALTHY") return false;
  synchronization.lastUpdate = delta.update;
  synchronization.lastCrossSequence = delta.crossSequence;
  return true;
}

function bybitChanges(book) {
  return [
    ...(book.b || []).map(([price, quantity]) => ({ side: "bid", price, quantity })),
    ...(book.a || []).map(([price, quantity]) => ({ side: "ask", price, quantity }))
  ];
}

function startHyperliquid(runtime, session) {
  connectSocket(runtime, session, "wss://api.hyperliquid.xyz/ws", (socket) => {
    socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "l2Book", coin: session.baseAsset } }));
  }, (payload) => {
    if (payload.channel !== "l2Book" || payload.data?.coin !== session.baseAsset) return;
    const levels = payload.data.levels;
    if (Array.isArray(levels?.[0]) && Array.isArray(levels?.[1])) {
      session.replace({
        bids: levels[0].map((level) => [level.px, level.sz]),
        asks: levels[1].map((level) => [level.px, level.sz]),
        sourceTimestamp: payload.data.time,
        sequence: payload.data.time
      });
    }
  });
}

function connectSocket(runtime, session, url, onOpen, onPayload) {
  if (session.stopped) return;
  session.status = "CONNECTING";
  const socket = new runtime.WebSocketCtor(url, { handshakeTimeout: 10_000 });
  session.socket = socket;
  socket.on("open", () => onOpen(socket));
  socket.on("message", (raw) => {
    try { onPayload(JSON.parse(String(raw))); }
    catch (error) { session.lastError = error instanceof Error ? error.message : String(error); }
  });
  socket.on("error", (error) => { session.lastError = error instanceof Error ? error.message : String(error); });
  socket.on("close", () => {
    if (session.stopped) return;
    session.status = "DISCONNECTED";
    session.reconnects += 1;
    session.timer = setTimeout(() => connectSocket(runtime, session, url, onOpen, onPayload), Math.min(30_000, 750 * 2 ** Math.min(5, session.reconnects)));
  });
}

function startPolling(runtime, session, fetcher, intervalMs) {
  const poll = async () => {
    if (session.stopped) return;
    try { await fetcher(); }
    catch (error) {
      session.lastError = error instanceof Error ? error.message : String(error);
      if (session.status !== "HEALTHY") session.status = "DISCONNECTED";
    }
    if (!session.stopped) session.timer = setTimeout(poll, intervalMs);
  };
  void poll();
}

async function fetchBinance(runtime, session) {
  const response = await runtime.fetchImpl(`https://data-api.binance.vision/api/v3/depth?symbol=${encodeURIComponent(session.exchangeSymbol)}&limit=5000`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Binance depth ${response.status}`);
  const payload = await response.json();
  session.replace({ bids: payload.bids, asks: payload.asks, sourceTimestamp: Date.now(), sequence: payload.lastUpdateId });
}

async function fetchBybitFull(runtime, session) {
  const response = await runtime.fetchImpl(`https://api.bybit.com/v5/market/full_orderbook?category=linear&symbol=${encodeURIComponent(session.exchangeSymbol)}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Bybit full depth ${response.status}`);
  const payload = await response.json();
  const result = payload?.result;
  if (Number(payload?.retCode) !== 0 || !Array.isArray(result?.b) || !Array.isArray(result?.a) || !result.b.length || !result.a.length) {
    throw new Error(`Bybit full depth unavailable (${payload?.retCode ?? "invalid"})`);
  }
  return {
    bids: result.b,
    asks: result.a,
    sourceTimestamp: Number(result.cts ?? result.ts ?? runtime.now()),
    update: Number(result.u),
    crossSequence: Number(result.seq)
  };
}

async function fetchKraken(runtime, session) {
  const response = await runtime.fetchImpl(`https://api.kraken.com/0/public/Depth?pair=${encodeURIComponent(session.exchangeSymbol)}&count=500`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Kraken depth ${response.status}`);
  const payload = await response.json();
  const book = Object.values(payload.result || {})[0];
  if (!book) throw new Error("Kraken depth unavailable");
  session.replace({ bids: book.bids, asks: book.asks, sourceTimestamp: Date.now(), sequence: Date.now() });
}

function waitForReady(bundle, timeoutMs) {
  if (bundleReady(bundle)) return Promise.resolve();
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (bundleReady(bundle) || Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });
}

function bundleReady(bundle) {
  const sessions = [...bundle.sessions.values()];
  const healthy = sessions.filter((session) => session.status === "HEALTHY");
  return sessions.find((session) => session.venue === "coinbase")?.status === "HEALTHY" || healthy.length >= 3;
}

function levelMap(levels) {
  const map = new Map();
  for (const level of Array.isArray(levels) ? levels : []) {
    const price = Number(Array.isArray(level) ? level[0] : level?.price ?? level?.px);
    const quantity = Number(Array.isArray(level) ? level[1] : level?.quantity ?? level?.size ?? level?.sz);
    if (Number.isFinite(price) && price > 0 && Number.isFinite(quantity) && quantity > 0) map.set(price, quantity);
  }
  return map;
}

function validShape(bids, asks) {
  if (!bids.size || !asks.size) return false;
  let bestBid = -Infinity;
  let bestAsk = Infinity;
  for (const price of bids.keys()) bestBid = Math.max(bestBid, price);
  for (const price of asks.keys()) bestAsk = Math.min(bestAsk, price);
  return bestBid < bestAsk;
}

function sorted(map, side) {
  return [...map.entries()]
    .map(([price, quantity]) => Object.freeze({ price, quantity }))
    .sort((left, right) => side === "bid" ? right.price - left.price : left.price - right.price);
}

function finiteTimestamp(value, fallback) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  return fallback;
}

function normalizeBaseAsset(value) {
  const normalized = String(value || "").trim().toUpperCase().replace(/^XBT$/, "BTC");
  if (!/^[A-Z0-9]{2,15}$/.test(normalized)) throw Object.assign(new Error("Invalid liquidity base asset"), { statusCode: 400, code: "LIQUIDITY_FABRIC_SYMBOL_INVALID" });
  return normalized;
}

function viewportKey(input) {
  return [Number(input.minimumPrice).toPrecision(8), Number(input.maximumPrice).toPrecision(8), Math.floor(Number(input.rowCount) || 80)].join(":");
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export const directLiquidityFabricRuntime = new DirectLiquidityFabricRuntime();
