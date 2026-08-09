import type { ConfirmedLiquidationEvent, DepthCurve } from "../core/types.ts";
import { BCLIF_SOURCE_VERSION } from "../core/types.ts";

export interface BybitLiquidationLiveState {
  connected: boolean;
  lastInputAt: number | null;
  aggressiveBuyNotional: number;
  aggressiveSellNotional: number;
  cvd: number;
  bidDepthCurve: DepthCurve;
  askDepthCurve: DepthCurve;
  events: ConfirmedLiquidationEvent[];
}

type Listener = (state: BybitLiquidationLiveState) => void;

function finite(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export class BybitLiquidationStream {
  private readonly symbol: string;
  private readonly listener: Listener;
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private state: BybitLiquidationLiveState = {
    connected: false,
    lastInputAt: null,
    aggressiveBuyNotional: 0,
    aggressiveSellNotional: 0,
    cvd: 0,
    bidDepthCurve: { points: [], certainty: "UNAVAILABLE" },
    askDepthCurve: { points: [], certainty: "UNAVAILABLE" },
    events: []
  };

  constructor(symbol: string, listener: Listener) {
    this.symbol = symbol;
    this.listener = listener;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  snapshot() {
    return {
      ...this.state,
      bidDepthCurve: { ...this.state.bidDepthCurve, points: [...this.state.bidDepthCurve.points] },
      askDepthCurve: { ...this.state.askDepthCurve, points: [...this.state.askDepthCurve.points] },
      events: [...this.state.events]
    };
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket("wss://stream.bybit.com/v5/public/linear");
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.state.connected = true;
      ws.send(JSON.stringify({
        op: "subscribe",
        args: [`publicTrade.${this.symbol}`, `allLiquidation.${this.symbol}`, `orderbook.50.${this.symbol}`]
      }));
      this.pingTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: "ping" }));
      }, 20_000);
      this.emit();
    };
    ws.onmessage = (event) => this.onMessage(event.data);
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.state.connected = false;
      this.emit();
      if (this.stopped) return;
      const delay = Math.min(30_000, 750 * 2 ** this.reconnectAttempt++);
      this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
    };
  }

  private onMessage(raw: string) {
    try {
      const payload = JSON.parse(raw) as { topic?: string; type?: string; ts?: number; data?: unknown };
      if (!payload.topic || !payload.data) return;
      if (payload.topic.startsWith("publicTrade.")) this.onTrades(payload.data);
      else if (payload.topic.startsWith("allLiquidation.")) this.onLiquidations(payload.data, payload.ts ?? Date.now());
      else if (payload.topic.startsWith("orderbook.")) this.onBook(payload.data, payload.type);
      this.state.lastInputAt = Date.now();
      this.emit();
    } catch (error) {
      console.warn("Discarded malformed BCLIF Bybit message", error);
    }
  }

  private onTrades(data: unknown) {
    if (!Array.isArray(data)) return;
    for (const row of data as Array<Record<string, unknown>>) {
      const notional = finite(row.p) * finite(row.v);
      if (row.S === "Buy") {
        this.state.aggressiveBuyNotional += notional;
        this.state.cvd += notional;
      } else if (row.S === "Sell") {
        this.state.aggressiveSellNotional += notional;
        this.state.cvd -= notional;
      }
    }
  }

  private onLiquidations(data: unknown, receivedAt: number) {
    const rows = Array.isArray(data) ? data : [data];
    for (const row of rows as Array<Record<string, unknown>>) {
      const price = finite(row.p);
      const quantity = finite(row.v);
      const timestamp = finite(row.T, receivedAt);
      if (!price || !quantity) continue;
      this.state.events.push({
        id: `${this.symbol}:${timestamp}:${String(row.S)}:${price}:${quantity}`,
        venue: "BYBIT",
        symbol: this.symbol,
        timestamp,
        receivedAt,
        // Bybit's all-liquidation S is the liquidated position side.
        liquidatedPositionSide: row.S === "Buy" ? "LONG" : "SHORT",
        quantity,
        bankruptcyPrice: price,
        notional: price * quantity,
        certainty: "OBSERVED",
        sourceVersion: BCLIF_SOURCE_VERSION
      });
    }
    if (this.state.events.length > 10_000) this.state.events.splice(0, this.state.events.length - 10_000);
  }

  private onBook(data: unknown, type?: string) {
    const row = data as { b?: string[][]; a?: string[][]; u?: number };
    if (type === "snapshot" || row.u === 1) {
      this.bids.clear();
      this.asks.clear();
    }
    this.applyLevels(this.bids, row.b ?? []);
    this.applyLevels(this.asks, row.a ?? []);
    const bestBid = Math.max(...this.bids.keys(), 0);
    const bestAsk = Math.min(...this.asks.keys(), Number.POSITIVE_INFINITY);
    const reference = Number.isFinite(bestAsk) && bestBid > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk || 1;
    this.state.bidDepthCurve = this.depthCurve(this.bids, reference, "bid");
    this.state.askDepthCurve = this.depthCurve(this.asks, reference, "ask");
  }

  private applyLevels(book: Map<number, number>, levels: string[][]) {
    for (const [priceRaw, quantityRaw] of levels) {
      const price = finite(priceRaw);
      const quantity = finite(quantityRaw);
      if (!price) continue;
      if (quantity <= 0) book.delete(price);
      else book.set(price, quantity);
    }
  }

  private depthCurve(book: Map<number, number>, reference: number, side: "bid" | "ask"): DepthCurve {
    let cumulative = 0;
    const points = [...book.entries()]
      .sort(([a], [b]) => side === "bid" ? b - a : a - b)
      .slice(0, 50)
      .map(([price, quantity]) => {
        cumulative += price * quantity;
        return { distanceBps: Math.abs(price - reference) / reference * 10_000, notional: cumulative };
      });
    return { points, certainty: points.length ? "OBSERVED" : "UNAVAILABLE" };
  }

  private emit() {
    this.listener(this.snapshot());
  }
}
