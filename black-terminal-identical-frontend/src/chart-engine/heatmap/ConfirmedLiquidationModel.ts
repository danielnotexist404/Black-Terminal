import type { Candle } from "../types";

export type LiquidatedPositionSide = "long" | "short" | "unknown";

export type ConfirmedLiquidationEvent = {
  id: string;
  venue: string;
  symbol: string;
  time: number;
  price: number;
  quantity: number;
  liquidatedSide: LiquidatedPositionSide;
  priceKind: "bankruptcy" | "average-fill" | "order";
};

export type ConfirmedLiquidationCell = ConfirmedLiquidationEvent & {
  xIndex: number;
  notional: number;
  strength: number;
  classification: "CONFIRMED LIQUIDATION";
  confidence: 1;
};

export type ConfirmedLiquidationDiagnostics = {
  state: "idle" | "live" | "stale";
  events: number;
  venues: string[];
  lastEventAt: number | null;
  message: string;
};

function epochMs(value: number) {
  if (!Number.isFinite(value)) return Number.NaN;
  return value < 10_000_000_000 ? value * 1000 : value;
}

export class ConfirmedLiquidationModel {
  private candles: Candle[] = [];
  private events: ConfirmedLiquidationEvent[] = [];
  private eventIds = new Set<string>();
  private readonly maxEvents = 5_000;

  setCandles(candles: Candle[]) {
    this.candles = candles;
  }

  ingest(event: ConfirmedLiquidationEvent) {
    const time = epochMs(event.time);
    if (
      !event.id || this.eventIds.has(event.id) || !event.venue || !event.symbol ||
      !Number.isFinite(time) || !Number.isFinite(event.price) || event.price <= 0 ||
      !Number.isFinite(event.quantity) || event.quantity <= 0
    ) return false;
    this.events.push({ ...event, time });
    this.events.sort((left, right) => left.time - right.time);
    this.eventIds.add(event.id);
    if (this.events.length > this.maxEvents) {
      const removed = this.events.splice(0, this.events.length - this.maxEvents);
      removed.forEach((item) => this.eventIds.delete(item.id));
    }
    return true;
  }

  clear() {
    this.events = [];
    this.eventIds.clear();
  }

  cells(firstIndex: number, lastIndex: number, priceMin: number, priceMax: number): ConfirmedLiquidationCell[] {
    if (this.candles.length === 0) return [];
    const visible = this.events
      .map((event) => ({ event, xIndex: this.indexForTime(event.time), notional: event.price * event.quantity }))
      .filter(({ event, xIndex }) => xIndex >= firstIndex - 1 && xIndex <= lastIndex + 1 && event.price >= priceMin && event.price <= priceMax);
    const notionals = visible.map((item) => item.notional).sort((left, right) => left - right);
    const reference = notionals[Math.max(0, Math.floor((notionals.length - 1) * 0.95))] ?? 1;
    return visible.map(({ event, xIndex, notional }) => ({
      ...event,
      xIndex,
      notional,
      strength: Math.min(1, Math.sqrt(notional / Math.max(1, reference))),
      classification: "CONFIRMED LIQUIDATION",
      confidence: 1
    }));
  }

  diagnostics(now = Date.now()): ConfirmedLiquidationDiagnostics {
    const last = this.events[this.events.length - 1];
    const stale = Boolean(last && now - last.time > 30_000);
    return {
      state: !last ? "idle" : stale ? "stale" : "live",
      events: this.events.length,
      venues: [...new Set(this.events.map((event) => event.venue))],
      lastEventAt: last?.time ?? null,
      message: !last ? "Waiting for confirmed liquidation events" : stale ? "Confirmed liquidation feed quiet or stale" : "Confirmed exchange liquidation events live"
    };
  }

  private indexForTime(timeMs: number) {
    if (this.candles.length <= 1) return 0;
    const time = timeMs / 1000;
    let low = 0;
    let high = this.candles.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if ((this.candles[middle]?.time ?? Number.POSITIVE_INFINITY) <= time) low = middle + 1;
      else high = middle - 1;
    }
    const index = Math.max(0, Math.min(this.candles.length - 1, high));
    const current = this.candles[index];
    const next = this.candles[index + 1];
    const previous = this.candles[index - 1];
    const fallback = Math.max(1, (current?.time ?? 0) - (previous?.time ?? 0));
    const step = Math.max(1, (next?.time ?? ((current?.time ?? time) + fallback)) - (current?.time ?? time));
    return index + (current ? Math.max(0, Math.min(1.2, (time - current.time) / step)) : 0);
  }
}
