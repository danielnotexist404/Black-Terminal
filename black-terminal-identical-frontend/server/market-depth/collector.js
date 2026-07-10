import { MarketDepthMemoryEngine } from "./storage.js";
import { normalizeMarketKind, normalizeSymbol, normalizeVenue } from "./types.js";

export class MarketDepthCollector {
  constructor({ supabase, symbols, logger = console, reconnectBaseMs = 1500 } = {}) {
    if (!supabase) throw new Error("MarketDepthCollector requires Supabase admin client.");
    this.supabase = supabase;
    this.symbols = normalizeCollectorSymbols(symbols);
    this.logger = logger;
    this.reconnectBaseMs = reconnectBaseMs;
    this.engine = new MarketDepthMemoryEngine();
    this.sessions = new Map();
    this.running = false;
  }

  start() {
    if (this.running) return;
    if (typeof WebSocket !== "function") {
      throw new Error("MarketDepthCollector requires a runtime with global WebSocket support.");
    }
    this.running = true;
    for (const symbol of this.symbols) this.connect(symbol);
  }

  stop() {
    this.running = false;
    for (const session of this.sessions.values()) {
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
      try {
        session.ws?.close();
      } catch {
        // Best effort shutdown.
      }
    }
    this.sessions.clear();
  }

  diagnostics() {
    return Array.from(this.sessions.values()).map((session) => ({
      key: session.key,
      venue: session.symbol.venue,
      marketKind: session.symbol.marketKind,
      symbol: session.symbol.symbol,
      status: session.status,
      reconnects: session.reconnects,
      lastMessageAt: session.lastMessageAt,
      lastError: session.lastError,
      messageCount: session.messageCount,
      sampleCount: session.sampleCount,
      ingestCount: session.ingestCount,
      packetLossCount: session.packetLossCount,
      lastSequence: session.lastSequence
    }));
  }

  connect(symbol) {
    const adapter = collectorAdapters[symbol.venue];
    if (!adapter) {
      this.logger.warn?.(`No market depth collector adapter for ${symbol.venue}.`);
      return;
    }
    const key = symbolKey(symbol);
    const session = this.sessions.get(key) ?? {
      key,
      symbol,
      reconnects: 0,
      status: "connecting",
      lastMessageAt: null,
      lastError: null,
      lastSequence: null,
      messageCount: 0,
      sampleCount: 0,
      ingestCount: 0,
      packetLossCount: 0,
      ws: null,
      reconnectTimer: null
    };
    this.sessions.set(key, session);

    const ws = new WebSocket(adapter.url(symbol));
    session.ws = ws;
    session.status = "connecting";

    ws.onopen = () => {
      session.status = "open";
      session.lastError = null;
      adapter.subscribe(ws, symbol);
      this.logger.info?.(`[MarketDepthCollector] subscribed ${key}`);
    };

    ws.onmessage = async (event) => {
      try {
        const samples = adapter.parse(event.data, symbol);
        if (!samples.length) return;
        session.lastMessageAt = Date.now();
        session.messageCount += 1;
        for (const sample of samples) {
          const diagnostics = updateSequenceDiagnostics(session, sample);
          sample.metadata = {
            ...sample.metadata,
            packetLossCount: diagnostics.packetLossCount,
            reconnectCount: session.reconnects,
            collectorLatencyMs: Math.max(0, Date.now() - Number(sample.sourceTimestamp || Date.now()))
          };
          await this.engine.ingest(this.supabase, sample);
          session.sampleCount += 1;
          session.ingestCount += 1;
        }
      } catch (error) {
        session.lastError = error instanceof Error ? error.message : String(error);
        this.logger.error?.(`[MarketDepthCollector] ingest failed ${key}`, error);
      }
    };

    ws.onerror = () => {
      session.status = "error";
      session.lastError = "WebSocket transport error.";
      this.logger.warn?.(`[MarketDepthCollector] websocket error ${key}`);
    };

    ws.onclose = () => {
      session.status = "closed";
      if (!this.running) return;
      session.reconnects += 1;
      const delay = Math.min(60_000, this.reconnectBaseMs * Math.max(1, session.reconnects));
      session.reconnectTimer = setTimeout(() => this.connect(symbol), delay);
      this.logger.warn?.(`[MarketDepthCollector] reconnecting ${key} in ${delay}ms`);
    };
  }
}

export function normalizeCollectorSymbols(symbols) {
  const source = Array.isArray(symbols) && symbols.length ? symbols : parseEnvSymbols();
  return source
    .map((item) => {
      if (typeof item === "string") {
        const [venue, marketKind, symbol] = item.split(":");
        return { venue, marketKind, symbol };
      }
      return item;
    })
    .map((item) => ({
      venue: normalizeVenue(item.venue || item.exchange),
      marketKind: normalizeMarketKind(item.marketKind),
      symbol: normalizeSymbol(item.symbol || item.rawSymbol),
      exchangeSymbol: normalizeSymbol(item.exchangeSymbol || item.symbol || item.rawSymbol)
    }))
    .filter((item) => item.venue && item.symbol);
}

export function parseEnvSymbols() {
  const raw = process.env.MARKET_DEPTH_SYMBOLS || "hyperliquid:perpetual:BTCUSDT";
  try {
    if (raw.trim().startsWith("[")) return JSON.parse(raw);
  } catch {
    // Fall back to comma parsing below.
  }
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

const collectorAdapters = {
  hyperliquid: {
    url: () => "wss://api.hyperliquid.xyz/ws",
    subscribe: (ws, symbol) => {
      ws.send(JSON.stringify({
        method: "subscribe",
        subscription: { type: "l2Book", coin: hyperliquidCoin(symbol.symbol) }
      }));
    },
    parse: (raw, symbol) => {
      const payload = JSON.parse(raw);
      const coin = hyperliquidCoin(symbol.symbol);
      if (payload.channel !== "l2Book" || payload.data?.coin !== coin) return [];
      const levels = payload.data.levels;
      if (!Array.isArray(levels) || levels.length < 2) return [];
      return [baseSample(symbol, {
        sourceTimestamp: payload.data.time || Date.now(),
        bids: levels[0].map((level) => [level.px, level.sz]),
        asks: levels[1].map((level) => [level.px, level.sz]),
        sequence: payload.data.time,
        sequenceKind: "timestamp"
      })];
    }
  },
  binance: {
    url: (symbol) => symbol.marketKind === "spot" || symbol.marketKind === "margin"
      ? `wss://stream.binance.com:9443/ws/${normalizeSymbol(symbol.symbol).toLowerCase()}@depth20@1000ms`
      : `wss://fstream.binance.com/ws/${normalizeSymbol(symbol.symbol).toLowerCase()}@depth20@1000ms`,
    subscribe: () => {},
    parse: (raw, symbol) => {
      const payload = JSON.parse(raw);
      const bids = payload.b || payload.bids || [];
      const asks = payload.a || payload.asks || [];
      if (!bids.length || !asks.length) return [];
      return [baseSample(symbol, {
        sourceTimestamp: payload.T || payload.E || Date.now(),
        sequence: payload.u || payload.lastUpdateId,
        sequenceKind: "incremental",
        bids,
        asks
      })];
    }
  },
  bybit: {
    url: (symbol) => symbol.marketKind === "spot" || symbol.marketKind === "margin"
      ? "wss://stream.bybit.com/v5/public/spot"
      : "wss://stream.bybit.com/v5/public/linear",
    subscribe: (ws, symbol) => {
      const depth = symbol.marketKind === "spot" || symbol.marketKind === "margin" ? 50 : 200;
      ws.send(JSON.stringify({
        op: "subscribe",
        args: [`orderbook.${depth}.${normalizeSymbol(symbol.symbol)}`]
      }));
    },
    parse: (raw, symbol) => {
      const payload = JSON.parse(raw);
      if (!payload.topic?.startsWith("orderbook.") || !payload.data) return [];
      return [baseSample(symbol, {
        sourceTimestamp: payload.ts || Date.now(),
        sequence: payload.data.u || payload.data.seq,
        sequenceKind: "incremental",
        bids: payload.data.b || [],
        asks: payload.data.a || []
      })];
    }
  },
  okx: {
    url: () => "wss://ws.okx.com:8443/ws/v5/public",
    subscribe: (ws, symbol) => {
      ws.send(JSON.stringify({
        op: "subscribe",
        args: [{ channel: "books", instId: okxInstId(symbol.symbol) }]
      }));
    },
    parse: (raw, symbol) => {
      const payload = JSON.parse(raw);
      if (payload.event || payload.arg?.channel !== "books" || !Array.isArray(payload.data)) return [];
      return payload.data
        .filter((book) => Array.isArray(book.bids) && Array.isArray(book.asks))
        .map((book) => baseSample(symbol, {
          sourceTimestamp: book.ts || Date.now(),
          bids: book.bids,
          asks: book.asks
        }));
    }
  }
};

function baseSample(symbol, data) {
  return {
    venue: symbol.venue,
    marketKind: symbol.marketKind,
    symbol: symbol.symbol,
    exchangeSymbol: symbol.exchangeSymbol,
    capturedAt: Date.now(),
    sourceTimestamp: data.sourceTimestamp,
    sequence: data.sequence,
    bids: data.bids,
    asks: data.asks,
    metadata: {
      source: "black-core-depth-collector",
      collectorVersion: 1,
      sequenceKind: data.sequenceKind || "none"
    }
  };
}

function hyperliquidCoin(symbol) {
  return normalizeSymbol(symbol).replace(/USDT$/, "").replace(/USD$/, "");
}

function okxInstId(symbol) {
  const clean = normalizeSymbol(symbol);
  if (clean.includes("-")) return clean;
  if (clean.endsWith("USDT")) return `${clean.replace(/USDT$/, "")}-USDT-SWAP`;
  return clean;
}

function symbolKey(symbol) {
  return [symbol.venue, symbol.marketKind, symbol.symbol].join(":");
}

function updateSequenceDiagnostics(session, sample) {
  if (sample.metadata?.sequenceKind !== "incremental") {
    return { packetLossCount: session.packetLossCount };
  }
  const sequence = Number(sample.sequence);
  if (!Number.isFinite(sequence)) {
    return { packetLossCount: session.packetLossCount };
  }
  const previous = Number(session.lastSequence);
  if (Number.isFinite(previous) && sequence > previous + 1) {
    session.packetLossCount += 1;
    session.lastError = `Sequence gap ${previous} -> ${sequence}`;
  }
  session.lastSequence = sequence;
  return { packetLossCount: session.packetLossCount };
}
