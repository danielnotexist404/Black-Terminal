import type {
  QalcBookChange,
  QalcBookMutation,
  QalcBookPayload,
  QalcBookState,
  QalcBookView,
  QalcMarketEvent,
  QalcSymbol,
} from "./contracts.ts";

const MAX_LEVELS = 1_000;

/**
 * Deterministic Bybit snapshot/delta book. Mutations are prepared on copies and
 * committed only after the resulting book passes structural validation.
 */
export class QalcOrderBook {
  readonly symbol: QalcSymbol;
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private _state: QalcBookState = "DISCONNECTED";
  private _version = 0;
  private updateId?: string;
  private crossSequence?: string;
  private exchangeTimestamp?: number;
  private matchingTimestamp?: number;
  private receiveTimestamp?: number;

  constructor(symbol: QalcSymbol) {
    this.symbol = symbol;
  }

  get state() { return this._state; }
  get version() { return this._version; }

  markSnapshotPending() {
    this._state = this._version ? "RESYNCHRONIZING" : "SNAPSHOT_PENDING";
  }

  markStale() {
    if (this._state === "LIVE") this._state = "STALE";
  }

  markFailed() {
    this._state = "FAILED";
  }

  apply(event: QalcMarketEvent): QalcBookMutation {
    if (event.symbol !== this.symbol || !["BOOK_SNAPSHOT", "BOOK_DELTA"].includes(event.eventType)) {
      return this.reject("BOOK_EVENT_MISMATCH");
    }
    const payload = event.payload as QalcBookPayload;
    if (!validPayload(payload)) return this.reject("INVALID_BOOK_PAYLOAD");

    if (event.eventType === "BOOK_SNAPSHOT") return this.applySnapshot(event, payload);
    if (!this._version || !this.updateId) {
      this._state = "SNAPSHOT_PENDING";
      return this.reject("DELTA_BEFORE_SNAPSHOT");
    }

    const updateComparison = compareIntegerStrings(payload.updateId, this.updateId);
    const crossComparison = compareOptionalIntegerStrings(payload.crossSequence, this.crossSequence);
    if (updateComparison === 0 || (crossComparison === 0 && payload.crossSequence !== undefined)) {
      return { ...this.reject("DUPLICATE_BOOK_DELTA"), duplicate: true };
    }
    if (updateComparison < 0 || crossComparison < 0) {
      this._state = "GAP_DETECTED";
      return this.reject("BOOK_SEQUENCE_REGRESSION");
    }
    // Bybit documents update id 1 as a service-reset snapshot boundary.
    if (payload.updateId === "1") {
      this._state = "GAP_DETECTED";
      return this.reject("BOOK_SERVICE_RESET");
    }

    const nextBids = new Map(this.bids);
    const nextAsks = new Map(this.asks);
    const changes = [
      ...applyLevels(nextBids, payload.bids, "BID"),
      ...applyLevels(nextAsks, payload.asks, "ASK"),
    ];
    const validation = validateBook(nextBids, nextAsks);
    if (validation) {
      this._state = "GAP_DETECTED";
      return this.reject(validation);
    }

    const bestBidBefore = bestBid(this.bids);
    const bestAskBefore = bestAsk(this.asks);
    this.commit(nextBids, nextAsks, event, payload);
    return {
      accepted: true,
      duplicate: false,
      state: this._state,
      changes,
      bestBidBefore,
      bestAskBefore,
      bestBidAfter: bestBid(this.bids),
      bestAskAfter: bestAsk(this.asks),
      version: this._version,
    };
  }

  view(now = Date.now(), depth = 50): QalcBookView {
    const safeDepth = Math.max(1, Math.min(MAX_LEVELS, Math.trunc(depth)));
    return {
      state: this._state,
      symbol: this.symbol,
      bids: sortedLevels(this.bids, "BID", safeDepth),
      asks: sortedLevels(this.asks, "ASK", safeDepth),
      updateId: this.updateId,
      crossSequence: this.crossSequence,
      exchangeTimestamp: this.exchangeTimestamp,
      matchingTimestamp: this.matchingTimestamp,
      receiveTimestamp: this.receiveTimestamp,
      version: this._version,
      ageMs: this.receiveTimestamp === undefined ? Number.POSITIVE_INFINITY : Math.max(0, now - this.receiveTimestamp),
    };
  }

  quantityAt(side: "BUY" | "SELL", price: number) {
    return (side === "BUY" ? this.bids : this.asks).get(price) || 0;
  }

  private applySnapshot(event: QalcMarketEvent, payload: QalcBookPayload): QalcBookMutation {
    const nextBids = new Map<number, number>();
    const nextAsks = new Map<number, number>();
    const changes = [
      ...applyLevels(nextBids, payload.bids, "BID"),
      ...applyLevels(nextAsks, payload.asks, "ASK"),
    ];
    const validation = validateBook(nextBids, nextAsks);
    if (validation) {
      this._state = "FAILED";
      return this.reject(validation);
    }
    const bestBidBefore = bestBid(this.bids);
    const bestAskBefore = bestAsk(this.asks);
    this.commit(nextBids, nextAsks, event, payload);
    return {
      accepted: true,
      duplicate: false,
      state: this._state,
      changes,
      bestBidBefore,
      bestAskBefore,
      bestBidAfter: bestBid(this.bids),
      bestAskAfter: bestAsk(this.asks),
      version: this._version,
    };
  }

  private commit(bids: Map<number, number>, asks: Map<number, number>, event: QalcMarketEvent, payload: QalcBookPayload) {
    this.bids = trimLevels(bids, "BID");
    this.asks = trimLevels(asks, "ASK");
    this.updateId = payload.updateId;
    this.crossSequence = payload.crossSequence;
    this.exchangeTimestamp = event.exchangeTimestamp;
    this.matchingTimestamp = event.matchingTimestamp ?? payload.matchingTimestamp;
    this.receiveTimestamp = event.receiveTimestamp;
    this._version += 1;
    this._state = "LIVE";
  }

  private reject(reason: string): QalcBookMutation {
    return { accepted: false, duplicate: false, state: this._state, reason, changes: [], version: this._version };
  }
}

function applyLevels(target: Map<number, number>, levels: readonly (readonly [number, number])[], side: "BID" | "ASK") {
  const changes: QalcBookChange[] = [];
  for (const [price, quantity] of levels) {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity < 0) continue;
    const before = target.get(price) || 0;
    if (quantity === 0) target.delete(price);
    else target.set(price, quantity);
    if (before !== quantity) changes.push({ side, price, before, after: quantity, delta: quantity - before, kind: quantity === 0 ? "REMOVE" : before === 0 ? "ADD" : "UPDATE" });
  }
  return changes;
}

function validPayload(payload: QalcBookPayload) {
  return !!payload && Array.isArray(payload.bids) && Array.isArray(payload.asks) && /^\d+$/.test(String(payload.updateId || ""));
}

function validateBook(bids: Map<number, number>, asks: Map<number, number>) {
  if (!bids.size || !asks.size) return "EMPTY_BOOK_SIDE";
  const bid = bestBid(bids);
  const ask = bestAsk(asks);
  if (bid === undefined || ask === undefined || bid >= ask) return "CROSSED_OR_INVALID_BOOK";
  return undefined;
}

function compareOptionalIntegerStrings(a?: string, b?: string) {
  if (a === undefined || b === undefined) return 1;
  return compareIntegerStrings(a, b);
}

function compareIntegerStrings(a: string, b: string) {
  try {
    const left = BigInt(a);
    const right = BigInt(b);
    return left === right ? 0 : left > right ? 1 : -1;
  } catch {
    return a === b ? 0 : a > b ? 1 : -1;
  }
}

function sortedLevels(levels: Map<number, number>, side: "BID" | "ASK", depth: number) {
  return [...levels.entries()]
    .sort((a, b) => side === "BID" ? b[0] - a[0] : a[0] - b[0])
    .slice(0, depth)
    .map(([price, quantity]) => ({ price, quantity }));
}

function trimLevels(levels: Map<number, number>, side: "BID" | "ASK") {
  return new Map(sortedLevels(levels, side, MAX_LEVELS).map(({ price, quantity }) => [price, quantity]));
}

function bestBid(levels: Map<number, number>) { return levels.size ? Math.max(...levels.keys()) : undefined; }
function bestAsk(levels: Map<number, number>) { return levels.size ? Math.min(...levels.keys()) : undefined; }
