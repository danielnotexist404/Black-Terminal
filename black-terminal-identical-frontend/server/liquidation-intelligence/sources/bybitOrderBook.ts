import type { BclifBookFrame, BclifBookLevel } from "../contracts.ts";
import { canonicalJson, finitePositive, normalizeSymbol, sha256Hex, timestampMs } from "../normalization/canonicalEnvelope.ts";

export type BclifBookState =
  | "DISCONNECTED"
  | "SNAPSHOT_PENDING"
  | "SYNCHRONIZING"
  | "LIVE"
  | "GAP_DETECTED"
  | "RESYNCHRONIZING"
  | "DEGRADED"
  | "FAILED";

export interface BybitBookApplyResult {
  accepted: boolean;
  duplicate: boolean;
  resyncRequired: boolean;
  reason: string | null;
  frame: BclifBookFrame | null;
}

interface ParsedBookMessage {
  type: "snapshot" | "delta";
  symbol: string;
  timestamp: number;
  receivedTimestamp: number;
  updateId: bigint;
  crossSequence: bigint | null;
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
  payloadHash: string;
}

export class BybitOrderBookReconstructor {
  private bids = new Map<string, number>();
  private asks = new Map<string, number>();
  private buffered: ParsedBookMessage[] = [];
  private lastUpdateId: bigint | null = null;
  private lastCrossSequence: bigint | null = null;
  private lastPayloadHash: string | null = null;
  private lastMessageAt: number | null = null;
  private stateValue: BclifBookState = "DISCONNECTED";
  private readonly expectedSymbol: string;
  private readonly sourceVersion: string;
  private readonly selectedDepth: number;
  private readonly maximumBufferedDeltas: number;

  constructor(
    expectedSymbol: string,
    sourceVersion: string,
    selectedDepth = 200,
    maximumBufferedDeltas = 2_000
  ) {
    this.expectedSymbol = expectedSymbol;
    this.sourceVersion = sourceVersion;
    this.selectedDepth = selectedDepth;
    this.maximumBufferedDeltas = maximumBufferedDeltas;
  }

  state() { return this.stateValue; }
  lastInputAt() { return this.lastMessageAt; }

  connected() {
    this.stateValue = "SNAPSHOT_PENDING";
    this.buffered = [];
    this.lastUpdateId = null;
    this.lastCrossSequence = null;
    this.lastPayloadHash = null;
  }

  disconnected() {
    this.stateValue = "DISCONNECTED";
    this.buffered = [];
    this.lastUpdateId = null;
    this.lastCrossSequence = null;
    this.lastPayloadHash = null;
    this.bids.clear();
    this.asks.clear();
  }

  /** Mark an explicit websocket close/error/reconnect boundary. */
  transportGap(reason = "orderbook transport discontinuity") {
    return this.gap(reason);
  }

  /** Require a fresh Bybit snapshot before accepting any more deltas. */
  beginResynchronization() {
    if (this.stateValue !== "GAP_DETECTED" && this.stateValue !== "FAILED") {
      throw new Error(`Cannot resynchronize orderbook from ${this.stateValue}`);
    }
    this.stateValue = "RESYNCHRONIZING";
  }

  stale(now = Date.now(), thresholdMs = 5_000) {
    if (this.lastMessageAt === null || now - this.lastMessageAt <= thresholdMs) return false;
    if (this.stateValue === "LIVE") this.stateValue = "DEGRADED";
    return true;
  }

  apply(payload: unknown, receivedTimestamp = Date.now()): BybitBookApplyResult {
    let message: ParsedBookMessage;
    try {
      message = parseBybitBookMessage(payload, receivedTimestamp);
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : String(error));
    }
    if (message.symbol !== normalizeSymbol(this.expectedSymbol)) return ignored("symbol mismatch");
    this.lastMessageAt = receivedTimestamp;

    const forcedSnapshot = message.type === "snapshot" || message.updateId === 1n;
    if (forcedSnapshot) return this.applySnapshot(message);
    if (this.stateValue === "SNAPSHOT_PENDING" || this.stateValue === "SYNCHRONIZING" || this.stateValue === "RESYNCHRONIZING") {
      if (this.buffered.length >= this.maximumBufferedDeltas) return this.fail("orderbook delta buffer overflow");
      this.buffered.push(message);
      return { accepted: false, duplicate: false, resyncRequired: false, reason: "awaiting snapshot", frame: null };
    }
    if (this.stateValue !== "LIVE" && this.stateValue !== "DEGRADED") return this.fail("delta received outside live state");
    return this.applyDelta(message);
  }

  private applySnapshot(message: ParsedBookMessage) {
    this.stateValue = "SYNCHRONIZING";
    this.bids.clear();
    this.asks.clear();
    try {
      applyLevels(this.bids, message.bids);
      applyLevels(this.asks, message.asks);
      validateBook(this.bids, this.asks);
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : String(error));
    }
    this.lastUpdateId = message.updateId;
    this.lastCrossSequence = message.crossSequence;
    this.lastPayloadHash = message.payloadHash;
    const pending = this.buffered
      .filter((delta) => delta.updateId > message.updateId)
      .sort((a, b) => compareBigInt(a.updateId, b.updateId) || compareNullableBigInt(a.crossSequence, b.crossSequence));
    this.buffered = [];
    this.stateValue = "LIVE";
    let frame = this.frame(message.receivedTimestamp, message.timestamp);
    for (const delta of pending) {
      const applied = this.applyDelta(delta);
      if (applied.resyncRequired) return applied;
      if (applied.frame) frame = applied.frame;
    }
    return { accepted: true, duplicate: false, resyncRequired: false, reason: null, frame };
  }

  private applyDelta(message: ParsedBookMessage): BybitBookApplyResult {
    if (this.lastUpdateId !== null) {
      if (message.updateId < this.lastUpdateId) return this.gap(`update ID regression ${this.lastUpdateId} -> ${message.updateId}`);
      if (message.updateId === this.lastUpdateId) {
        if (message.payloadHash === this.lastPayloadHash) {
          return { accepted: false, duplicate: true, resyncRequired: false, reason: "duplicate update", frame: null };
        }
        return this.gap(`conflicting duplicate update ID ${message.updateId}`);
      }
      // Bybit's public orderbook `u` is the topic-local update ID. A forward
      // jump means at least one delta was not observed and must never be
      // patched over. Cross-sequence `seq` is venue-wide and may legitimately
      // jump because other depth streams advance it independently.
      if (message.updateId !== this.lastUpdateId + 1n) return this.gap(`update ID gap ${this.lastUpdateId} -> ${message.updateId}`);
    }
    if (this.lastCrossSequence !== null && message.crossSequence !== null && message.crossSequence < this.lastCrossSequence) {
      return this.gap(`cross-sequence regression ${this.lastCrossSequence} -> ${message.crossSequence}`);
    }
    try {
      applyLevels(this.bids, message.bids);
      applyLevels(this.asks, message.asks);
      validateBook(this.bids, this.asks);
    } catch (error) {
      return this.gap(error instanceof Error ? error.message : String(error));
    }
    this.lastUpdateId = message.updateId;
    this.lastCrossSequence = message.crossSequence;
    this.lastPayloadHash = message.payloadHash;
    this.stateValue = "LIVE";
    return { accepted: true, duplicate: false, resyncRequired: false, reason: null, frame: this.frame(message.receivedTimestamp, message.timestamp) };
  }

  private frame(receivedTimestamp: number, exchangeTimestamp: number): BclifBookFrame {
    const bids = sortedLevels(this.bids, "bid", this.selectedDepth);
    const asks = sortedLevels(this.asks, "ask", this.selectedDepth);
    const bestBid = bids[0]!.price;
    const bestAsk = asks[0]!.price;
    const midPrice = (bestBid + bestAsk) / 2;
    return {
      venue: "BYBIT",
      symbol: normalizeSymbol(this.expectedSymbol),
      exchangeTimestamp,
      receivedTimestamp,
      updateId: String(this.lastUpdateId),
      crossSequence: this.lastCrossSequence === null ? null : String(this.lastCrossSequence),
      bids,
      asks,
      bestBid,
      bestAsk,
      midPrice,
      spreadBps: ((bestAsk - bestBid) / midPrice) * 10_000,
      bidNotional: bids.reduce((sum, level) => sum + level.price * level.quantity, 0),
      askNotional: asks.reduce((sum, level) => sum + level.price * level.quantity, 0),
      certainty: "OBSERVED",
      sourceVersion: this.sourceVersion
    };
  }

  private gap(reason: string): BybitBookApplyResult {
    this.stateValue = "GAP_DETECTED";
    this.bids.clear();
    this.asks.clear();
    this.buffered = [];
    this.lastUpdateId = null;
    this.lastCrossSequence = null;
    this.lastPayloadHash = null;
    return { accepted: false, duplicate: false, resyncRequired: true, reason, frame: null };
  }

  private fail(reason: string): BybitBookApplyResult {
    this.stateValue = "FAILED";
    return { accepted: false, duplicate: false, resyncRequired: true, reason, frame: null };
  }
}

export function parseBybitBookMessage(payload: unknown, receivedTimestamp = Date.now()): ParsedBookMessage {
  const message = payload as { topic?: unknown; type?: unknown; ts?: unknown; cts?: unknown; data?: Record<string, unknown> };
  if (!String(message.topic || "").startsWith("orderbook.") || !message.data) throw new Error("Not a Bybit orderbook message");
  const type = message.type === "snapshot" ? "snapshot" : message.type === "delta" ? "delta" : null;
  if (!type) throw new Error("Unknown Bybit orderbook message type");
  const updateId = unsignedBigInt(message.data.u, "update ID");
  const crossSequence = message.data.seq == null ? null : unsignedBigInt(message.data.seq, "cross sequence");
  const bids = normalizeWireLevels(message.data.b);
  const asks = normalizeWireLevels(message.data.a);
  if (type === "snapshot" && (!bids.length || !asks.length)) throw new Error("Orderbook snapshot requires both sides");
  const timestamp = timestampMs(message.cts ?? message.ts, receivedTimestamp);
  const symbol = normalizeSymbol(message.data.s);
  return {
    type,
    symbol,
    timestamp,
    receivedTimestamp,
    updateId,
    crossSequence,
    bids,
    asks,
    payloadHash: sha256Hex(canonicalJson({ type, symbol, updateId: String(updateId), crossSequence: crossSequence === null ? null : String(crossSequence), bids, asks }))
  };
}

function normalizeWireLevels(value: unknown): Array<[string, string]> {
  if (!Array.isArray(value)) return [];
  return value.map((level) => {
    if (!Array.isArray(level) || level.length < 2) throw new Error("Malformed orderbook level");
    const price = finitePositive(level[0], "orderbook price");
    const quantity = Number(level[1]);
    if (!Number.isFinite(quantity) || quantity < 0) throw new Error("Invalid orderbook quantity");
    return [price.toString(), quantity.toString()];
  });
}

function applyLevels(book: Map<string, number>, levels: Array<[string, string]>) {
  for (const [priceValue, quantityValue] of levels) {
    const price = finitePositive(priceValue, "orderbook price");
    const quantity = Number(quantityValue);
    const key = price.toString();
    if (quantity === 0) book.delete(key);
    else book.set(key, quantity);
  }
}

function validateBook(bids: Map<string, number>, asks: Map<string, number>) {
  if (!bids.size || !asks.size) throw new Error("Reconstructed orderbook lost one side");
  const bestBid = Math.max(...[...bids.keys()].map(Number));
  const bestAsk = Math.min(...[...asks.keys()].map(Number));
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid >= bestAsk) throw new Error("Reconstructed orderbook is crossed");
}

function sortedLevels(book: Map<string, number>, side: "bid" | "ask", limit: number): BclifBookLevel[] {
  return [...book.entries()]
    .map(([price, quantity]) => ({ price: Number(price), quantity }))
    .sort((a, b) => side === "bid" ? b.price - a.price : a.price - b.price)
    .slice(0, limit);
}

function unsignedBigInt(value: unknown, label: string) {
  try {
    const result = BigInt(String(value));
    if (result < 0n) throw new Error();
    return result;
  } catch {
    throw new Error(`Invalid Bybit ${label}`);
  }
}

function compareBigInt(a: bigint, b: bigint) { return a < b ? -1 : a > b ? 1 : 0; }
function compareNullableBigInt(a: bigint | null, b: bigint | null) {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return compareBigInt(a, b);
}
function ignored(reason: string): BybitBookApplyResult {
  return { accepted: false, duplicate: false, resyncRequired: false, reason, frame: null };
}
