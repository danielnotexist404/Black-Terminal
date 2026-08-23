import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { QalcBookPayload, QalcInstrumentPayload, QalcMarketEvent, QalcSymbol, QalcTradePayload } from "./contracts.ts";

type GatewayOptions = {
  symbol: QalcSymbol;
  onEvent: (event: QalcMarketEvent) => void | Promise<void>;
  onState?: (state: QalcGatewayStatus) => void;
  websocketUrl?: string;
  restUrl?: string;
  reconnectBaseMs?: number;
};

export type QalcGatewayStatus = {
  state: "STOPPED" | "CONNECTING" | "SUBSCRIBING" | "LIVE" | "STALE" | "RECONNECTING" | "FAILED";
  symbol: QalcSymbol;
  connectionGeneration: number;
  reconnects: number;
  lastMessageAt?: number;
  lastBookAt?: number;
  lastTradeAt?: number;
  lastError?: string;
};

/** One canonical public Bybit socket per symbol, multiplexing book and trades. */
export class QalcBybitGateway {
  private readonly options: Required<Pick<GatewayOptions, "symbol" | "websocketUrl" | "restUrl" | "reconnectBaseMs">> & Pick<GatewayOptions, "onEvent" | "onState">;
  private socket?: WebSocket;
  private pingTimer?: ReturnType<typeof setInterval>;
  private watchdogTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private processingChain: Promise<void> = Promise.resolve();
  private stopped = true;
  private generation = 0;
  private reconnects = 0;
  private statusValue: QalcGatewayStatus;

  constructor(options: GatewayOptions) {
    this.options = {
      ...options,
      websocketUrl: options.websocketUrl || "wss://stream.bybit.com/v5/public/linear",
      restUrl: options.restUrl || "https://api.bybit.com",
      reconnectBaseMs: options.reconnectBaseMs || 1_500,
    };
    this.statusValue = { state: "STOPPED", symbol: options.symbol, connectionGeneration: 0, reconnects: 0 };
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "QALC gateway stopped");
    this.socket = undefined;
    this.update({ state: "STOPPED" });
  }

  status() { return { ...this.statusValue }; }

  resynchronize(reason = "QALC_BOOK_RESYNCHRONIZATION") {
    if (this.stopped) return;
    this.update({ state: "STALE", lastError: reason });
    this.socket?.terminate();
  }

  async fetchInstrument(): Promise<QalcInstrumentPayload> {
    const response = await fetch(`${this.options.restUrl}/v5/market/instruments-info?category=linear&symbol=${this.options.symbol}`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`BYBIT_INSTRUMENT_HTTP_${response.status}`);
    const payload = await response.json() as any;
    if (payload.retCode !== 0 || !payload.result?.list?.[0]) throw new Error(`BYBIT_INSTRUMENT_${payload.retCode || "MISSING"}`);
    const row = payload.result.list[0];
    return {
      status: String(row.status), tickSize: numeric(row.priceFilter?.tickSize), quantityStep: numeric(row.lotSizeFilter?.qtyStep),
      minimumQuantity: numeric(row.lotSizeFilter?.minOrderQty), minimumNotional: numeric(row.lotSizeFilter?.minNotionalValue),
      maximumLimitQuantity: numeric(row.lotSizeFilter?.maxOrderQty), maximumMarketQuantity: numeric(row.lotSizeFilter?.maxMktOrderQty),
      fundingIntervalMinutes: numeric(row.fundingInterval), version: `bybit-instrument:${payload.time || Date.now()}`,
    };
  }

  async fetchServerTime() {
    const sentAt = Date.now();
    const response = await fetch(`${this.options.restUrl}/v5/market/time`, { signal: AbortSignal.timeout(5_000) });
    const receivedAt = Date.now();
    if (!response.ok) throw new Error(`BYBIT_TIME_HTTP_${response.status}`);
    const payload = await response.json() as any;
    if (payload.retCode !== 0) throw new Error(`BYBIT_TIME_${payload.retCode}`);
    const serverTimeMs = payload.time ? Number(payload.time) : Number(payload.result?.timeNano) / 1_000_000;
    if (!Number.isFinite(serverTimeMs)) throw new Error("BYBIT_TIME_INVALID");
    return { serverTimeMs, sentAt, receivedAt };
  }

  private connect() {
    if (this.stopped) return;
    this.generation += 1;
    const generation = this.generation;
    this.update({ state: this.reconnects ? "RECONNECTING" : "CONNECTING", connectionGeneration: generation });
    const socket = new WebSocket(this.options.websocketUrl);
    this.socket = socket;
    socket.on("open", () => {
      if (generation !== this.generation || this.stopped) return socket.close();
      this.update({ state: "SUBSCRIBING", lastError: undefined });
      socket.send(JSON.stringify({ op: "subscribe", args: [`orderbook.200.${this.options.symbol}`, `publicTrade.${this.options.symbol}`] }));
      this.pingTimer = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: "ping" })); }, 20_000);
      this.watchdogTimer = setInterval(() => this.watchdog(generation), 1_000);
    });
    socket.on("message", (raw) => this.enqueueMessage(String(raw), generation));
    socket.on("error", (error) => this.update({ lastError: safeError(error), state: "FAILED" }));
    socket.on("close", () => this.scheduleReconnect(generation));
  }

  private enqueueMessage(raw: string, generation: number) {
    // EventEmitter does not await async listeners. A single promise chain keeps
    // snapshot/delta/trade processing in WebSocket arrival order even when the
    // downstream archive write applies backpressure.
    this.processingChain = this.processingChain
      .then(() => this.handleMessage(raw, generation))
      .catch((error) => this.update({ lastError: safeError(error), state: "FAILED" }));
  }

  private async handleMessage(raw: string, generation: number) {
    if (generation !== this.generation || this.stopped) return;
    const receiveTimestamp = Date.now();
    const receiveMonotonicNs = process.hrtime.bigint().toString();
    try {
      const payload = JSON.parse(raw);
      if (payload.success === false) throw new Error(`BYBIT_SUBSCRIPTION_${payload.ret_msg || "FAILED"}`);
      if (!payload.topic || !payload.data) return;
      const events = normalizeBybitMessage(payload, this.options.symbol, receiveTimestamp, receiveMonotonicNs);
      if (!events.length) return;
      const bookEvent = events.some((event) => event.eventType.startsWith("BOOK"));
      const tradeEvent = events.some((event) => event.eventType === "TRADE");
      this.update({ state: "LIVE", lastMessageAt: receiveTimestamp, ...(bookEvent ? { lastBookAt: receiveTimestamp } : {}), ...(tradeEvent ? { lastTradeAt: receiveTimestamp } : {}) });
      for (const event of events) await this.options.onEvent(event);
    } catch (error) {
      this.update({ lastError: safeError(error) });
    }
  }

  private watchdog(generation: number) {
    if (generation !== this.generation || this.stopped) return;
    const last = this.statusValue.lastMessageAt || 0;
    if (last && Date.now() - last > 5_000) {
      this.update({ state: "STALE", lastError: "PUBLIC_FEED_STALE" });
      this.socket?.terminate();
    }
  }

  private scheduleReconnect(generation: number) {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (generation !== this.generation || this.stopped) return;
    this.reconnects += 1;
    this.update({ state: "RECONNECTING", reconnects: this.reconnects });
    const delay = Math.min(30_000, this.options.reconnectBaseMs * 2 ** Math.min(5, this.reconnects - 1));
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private update(patch: Partial<QalcGatewayStatus>) {
    this.statusValue = { ...this.statusValue, ...patch };
    this.options.onState?.(this.status());
  }
}

export function normalizeBybitMessage(payload: any, symbol: QalcSymbol, receiveTimestamp: number, receiveMonotonicNs?: string): QalcMarketEvent[] {
  const topic = String(payload.topic || "");
  const processTimestamp = Date.now();
  const processMonotonicNs = process.hrtime.bigint().toString();
  if (topic === `orderbook.200.${symbol}`) {
    const data = payload.data || {};
    const eventType = payload.type === "snapshot" ? "BOOK_SNAPSHOT" : "BOOK_DELTA";
    const updateId = String(data.u ?? "");
    if (!/^\d+$/.test(updateId)) return [];
    const book: QalcBookPayload = {
      bids: levels(data.b), asks: levels(data.a), updateId, crossSequence: data.seq === undefined ? undefined : String(data.seq),
      systemTimestamp: numeric(payload.ts, receiveTimestamp), matchingTimestamp: data.cts === undefined ? undefined : numeric(data.cts), depth: 200,
    };
    return [{
      id: `bybit:${symbol}:book:${eventType}:${updateId}:${book.crossSequence || "na"}`,
      venue: "BYBIT", category: "linear", symbol, eventType,
      exchangeTimestamp: book.systemTimestamp, matchingTimestamp: book.matchingTimestamp,
      receiveTimestamp, processTimestamp, receiveMonotonicNs, processMonotonicNs, sequence: book.crossSequence, updateId,
      payloadVersion: 1, payload: book,
    }];
  }
  if (topic === `publicTrade.${symbol}` && Array.isArray(payload.data)) {
    return payload.data.flatMap((row: any, index: number) => {
      const tradeId = String(row.i || "");
      const price = numeric(row.p);
      const quantity = numeric(row.v);
      if (!tradeId || price <= 0 || quantity <= 0 || !["Buy", "Sell"].includes(row.S)) return [];
      const trade: QalcTradePayload = {
        tradeId, side: row.S === "Buy" ? "BUY" : "SELL", price, quantity, notional: price * quantity,
        crossSequence: row.seq === undefined && payload.seq === undefined ? undefined : String(row.seq ?? payload.seq),
        blockTrade: !!row.BT, rpiTrade: !!row.RPI,
      };
      return [{
        id: `bybit:${symbol}:trade:${tradeId}:${index}`,
        venue: "BYBIT" as const, category: "linear" as const, symbol, eventType: "TRADE" as const,
        exchangeTimestamp: numeric(row.T, payload.ts || receiveTimestamp), receiveTimestamp, processTimestamp, receiveMonotonicNs, processMonotonicNs,
        sequence: trade.crossSequence, payloadVersion: 1 as const, payload: trade,
      }];
    });
  }
  return [];
}

function levels(rows: unknown): Array<readonly [number, number]> {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => Array.isArray(row) && numeric(row[0]) > 0 && numeric(row[1]) >= 0 ? [[numeric(row[0]), numeric(row[1])] as const] : []);
}
function numeric(value: unknown, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function safeError(error: unknown) { return String(error instanceof Error ? error.message : error || "QALC_GATEWAY_ERROR").slice(0, 240); }
