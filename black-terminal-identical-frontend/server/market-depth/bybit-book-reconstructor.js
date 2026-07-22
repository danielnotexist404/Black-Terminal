export const BYBIT_RECONSTRUCTION_STATES = Object.freeze({
  STARTING: "STARTING",
  SNAPSHOT_LOADING: "SNAPSHOT_LOADING",
  SYNCHRONIZING: "SYNCHRONIZING",
  LIVE: "LIVE",
  GAP_DETECTED: "GAP_DETECTED",
  RESYNCING: "RESYNCING",
  DEGRADED: "DEGRADED",
  FAILED: "FAILED"
});

export class BybitBookReconstructor {
  constructor({ symbol = "BTCUSDT", depth = 1000, persistCadenceMs = 1_000 } = {}) {
    this.symbol = normalizeSymbol(symbol);
    this.depth = Math.max(50, Math.min(1_000, Math.round(depth)));
    this.persistCadenceMs = Math.max(250, Math.round(persistCadenceMs));
    this.bids = new Map();
    this.asks = new Map();
    this.state = BYBIT_RECONSTRUCTION_STATES.STARTING;
    this.lastUpdateId = null;
    this.lastCrossSequence = null;
    this.lastSourceTimestamp = null;
    this.lastFrameAt = 0;
    this.gapCount = 0;
    this.snapshotCount = 0;
    this.deltaCount = 0;
    this.lastError = null;
  }

  connected() {
    this.resetBook();
    this.state = BYBIT_RECONSTRUCTION_STATES.SNAPSHOT_LOADING;
  }

  disconnected(reason = "transport disconnected") {
    this.state = BYBIT_RECONSTRUCTION_STATES.DEGRADED;
    this.lastError = reason;
  }

  resyncing() {
    this.resetBook();
    this.state = BYBIT_RECONSTRUCTION_STATES.RESYNCING;
  }

  failed(error) {
    this.state = BYBIT_RECONSTRUCTION_STATES.FAILED;
    this.lastError = error instanceof Error ? error.message : String(error);
  }

  ingest(payload, receivedAt = Date.now()) {
    if (!payload?.topic?.startsWith("orderbook.") || !payload.data) return { accepted: false, ignored: true, state: this.state };
    const data = payload.data;
    const updateId = finiteInteger(data.u);
    const crossSequence = finiteInteger(data.seq);
    const sourceTimestamp = finiteTimestamp(payload.cts ?? payload.ts ?? receivedAt);
    const isSnapshot = payload.type === "snapshot" || updateId === 1;

    if (isSnapshot) return this.applySnapshot(data, { updateId, crossSequence, sourceTimestamp, receivedAt });
    if (payload.type !== "delta") return this.reject("unsupported_message_type");
    if (this.state !== BYBIT_RECONSTRUCTION_STATES.LIVE) return this.reject("delta_before_snapshot", true);
    if (updateId === null || crossSequence === null) return this.integrityLost("missing_sequence");
    if (this.lastUpdateId !== null && updateId < this.lastUpdateId) return this.integrityLost("update_id_regression");
    if (this.lastCrossSequence !== null && crossSequence < this.lastCrossSequence) return this.integrityLost("cross_sequence_regression");
    if (this.lastSourceTimestamp !== null && sourceTimestamp < this.lastSourceTimestamp) return this.integrityLost("source_timestamp_regression");
    if (updateId === this.lastUpdateId && crossSequence === this.lastCrossSequence) {
      return { accepted: false, duplicate: true, state: this.state };
    }

    this.state = BYBIT_RECONSTRUCTION_STATES.SYNCHRONIZING;
    applyLevels(this.bids, data.b);
    applyLevels(this.asks, data.a);
    this.lastUpdateId = updateId;
    this.lastCrossSequence = crossSequence;
    this.lastSourceTimestamp = sourceTimestamp;
    this.deltaCount += 1;
    const validation = validateBook(this.bids, this.asks);
    if (!validation.valid) return this.integrityLost(validation.reason);
    this.state = BYBIT_RECONSTRUCTION_STATES.LIVE;
    return this.result(sourceTimestamp, receivedAt);
  }

  applySnapshot(data, metadata) {
    if (metadata.updateId === null || metadata.crossSequence === null) return this.integrityLost("snapshot_missing_sequence");
    this.state = BYBIT_RECONSTRUCTION_STATES.SYNCHRONIZING;
    this.resetBook();
    applyLevels(this.bids, data.b);
    applyLevels(this.asks, data.a);
    const validation = validateBook(this.bids, this.asks);
    if (!validation.valid) return this.integrityLost(validation.reason);
    this.lastUpdateId = metadata.updateId;
    this.lastCrossSequence = metadata.crossSequence;
    this.lastSourceTimestamp = metadata.sourceTimestamp;
    this.snapshotCount += 1;
    this.state = BYBIT_RECONSTRUCTION_STATES.LIVE;
    return this.result(metadata.sourceTimestamp, metadata.receivedAt, true);
  }

  result(sourceTimestamp, receivedAt, snapshot = false) {
    const due = snapshot || sourceTimestamp - this.lastFrameAt >= this.persistCadenceMs;
    const frame = due ? this.frame(sourceTimestamp, receivedAt) : null;
    if (due) this.lastFrameAt = sourceTimestamp;
    return { accepted: true, snapshot, frame, state: this.state };
  }

  frame(sourceTimestamp, receivedAt) {
    const bids = sorted(this.bids, "bid", this.depth);
    const asks = sorted(this.asks, "ask", this.depth);
    const bestBid = bids[0]?.price;
    const bestAsk = asks[0]?.price;
    const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk || 0;
    const priceBucketSize = adaptiveBucketSize([...bids, ...asks], midPrice);
    return {
      venue: "bybit",
      marketType: "PERPETUAL",
      marketKind: "perpetual",
      symbol: this.symbol,
      timestamp: sourceTimestamp,
      capturedAt: receivedAt,
      sourceTimestamp,
      sequence: this.lastUpdateId,
      crossSequence: this.lastCrossSequence,
      midPrice,
      bestBid,
      bestAsk,
      priceBucketSize,
      bids: bucketLevels(bids, priceBucketSize),
      asks: bucketLevels(asks, priceBucketSize),
      reconstructionState: this.state,
      sequenceValidation: "snapshot-gated-monotonic-u-and-seq"
    };
  }

  diagnostics() {
    return {
      state: this.state,
      symbol: this.symbol,
      depth: this.depth,
      lastUpdateId: this.lastUpdateId,
      lastCrossSequence: this.lastCrossSequence,
      lastSourceTimestamp: this.lastSourceTimestamp,
      snapshotCount: this.snapshotCount,
      deltaCount: this.deltaCount,
      gapCount: this.gapCount,
      bidLevels: this.bids.size,
      askLevels: this.asks.size,
      lastError: this.lastError
    };
  }

  integrityLost(reason) {
    this.gapCount += 1;
    this.state = BYBIT_RECONSTRUCTION_STATES.GAP_DETECTED;
    this.lastError = reason;
    return { accepted: false, gapDetected: true, reason, state: this.state };
  }

  reject(reason, degraded = false) {
    if (degraded) this.state = BYBIT_RECONSTRUCTION_STATES.DEGRADED;
    this.lastError = reason;
    return { accepted: false, reason, state: this.state };
  }

  resetBook() {
    this.bids.clear();
    this.asks.clear();
    this.lastUpdateId = null;
    this.lastCrossSequence = null;
    this.lastSourceTimestamp = null;
    this.lastFrameAt = 0;
  }
}

function applyLevels(book, levels) {
  for (const level of Array.isArray(levels) ? levels : []) {
    const price = Number(Array.isArray(level) ? level[0] : level?.price);
    const quantity = Number(Array.isArray(level) ? level[1] : level?.quantity);
    if (!(price > 0) || !Number.isFinite(quantity) || quantity < 0) throw new Error("Invalid Bybit depth level.");
    if (quantity === 0) book.delete(price);
    else book.set(price, quantity);
  }
}

function validateBook(bids, asks) {
  if (!bids.size || !asks.size) return { valid: false, reason: "incomplete_book" };
  const bestBid = Math.max(...bids.keys());
  const bestAsk = Math.min(...asks.keys());
  if (!(bestBid < bestAsk)) return { valid: false, reason: "crossed_book" };
  return { valid: true };
}

function sorted(book, side, limit) {
  return [...book.entries()].sort(([left], [right]) => side === "bid" ? right - left : left - right).slice(0, limit).map(([price, quantity]) => ({ price, quantity }));
}

function bucketLevels(levels, bucketSize) {
  const grouped = new Map();
  for (const level of levels) {
    const priceBucket = Math.round(level.price / bucketSize) * bucketSize;
    const current = grouped.get(priceBucket) ?? { priceBucket, quantity: 0, notional: 0 };
    current.quantity += level.quantity;
    current.notional += level.price * level.quantity;
    grouped.set(priceBucket, current);
  }
  return [...grouped.values()].sort((left, right) => left.priceBucket - right.priceBucket);
}

function adaptiveBucketSize(levels, midPrice) {
  const prices = levels.map((level) => level.price).sort((a, b) => a - b);
  let tick = Number.POSITIVE_INFINITY;
  for (let index = 1; index < prices.length; index += 1) {
    const difference = prices[index] - prices[index - 1];
    if (difference > 0) tick = Math.min(tick, difference);
  }
  if (!Number.isFinite(tick)) tick = Math.max(0.01, midPrice * 0.000001);
  const visibleSpan = Math.max(0, (prices[prices.length - 1] ?? midPrice) - (prices[0] ?? midPrice));
  const target = Math.max(tick, midPrice * 0.000025, visibleSpan / 512);
  const exponent = 10 ** Math.floor(Math.log10(target));
  const normalized = target / exponent;
  return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * exponent;
}

function finiteInteger(value) { const number = Number(value); return Number.isSafeInteger(number) && number >= 0 ? number : null; }
function finiteTimestamp(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? (number < 10_000_000_000 ? number * 1000 : number) : Date.now(); }
function normalizeSymbol(value) { return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
