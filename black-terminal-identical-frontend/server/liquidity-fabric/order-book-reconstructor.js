import { normalizeBookUpdate } from "./contracts.js";
import { requireVenueDepthPolicy } from "./venue-policies.js";

export class CanonicalOrderBookReconstructor {
  constructor({ instrument, maxLevelsPerSide, strictContiguousSequence = false } = {}) {
    if (!instrument?.key) throw new Error("CanonicalOrderBookReconstructor requires a canonical instrument");
    this.instrument = instrument;
    this.policy = requireVenueDepthPolicy(instrument.venue);
    this.maxLevelsPerSide = normalizeDepthLimit(maxLevelsPerSide, this.policy.maxPublicDepthPerSide);
    this.strictContiguousSequence = strictContiguousSequence;
    this.bids = new Map();
    this.asks = new Map();
    this.status = "AWAITING_SNAPSHOT";
    this.lastSequence = null;
    this.lastSourceTimestamp = null;
    this.lastReceivedAt = null;
    this.provenance = null;
    this.checksum = null;
    this.checksumVerified = false;
    this.diagnostics = {
      acceptedSnapshots: 0,
      acceptedDeltas: 0,
      duplicateUpdates: 0,
      sequenceGaps: 0,
      rejectedUpdates: 0,
      recoveries: 0
    };
  }

  apply(input) {
    let update;
    try {
      update = normalizeBookUpdate(input, this.instrument);
    } catch (error) {
      this.diagnostics.rejectedUpdates += 1;
      return failure(error.code || "INVALID_UPDATE", error.message, this.snapshot());
    }
    if (update.checksum !== null && update.checksumVerified !== true && this.policy.checksumPolicy === "REQUIRED_WHEN_PROVIDED") {
      this.status = "QUARANTINED";
      this.diagnostics.rejectedUpdates += 1;
      return failure("CHECKSUM_UNVERIFIED", `Unverified ${this.instrument.venue} checksum`, this.snapshot());
    }
    if (update.type === "snapshot") return this.applySnapshot(update);
    return this.applyDelta(update);
  }

  applySnapshot(update) {
    const snapshotOrder = assessSnapshotOrder(this, update);
    if (!snapshotOrder.accept) {
      if (snapshotOrder.duplicate) this.diagnostics.duplicateUpdates += 1;
      else this.diagnostics.rejectedUpdates += 1;
      return snapshotOrder.duplicate
        ? success("DUPLICATE_SNAPSHOT_IGNORED", this.snapshot(), false)
        : failure("STALE_SNAPSHOT", snapshotOrder.reason, this.snapshot());
    }
    const nextBids = levelMap(update.bids, false);
    const nextAsks = levelMap(update.asks, false);
    trimMap(nextBids, "bid", this.maxLevelsPerSide);
    trimMap(nextAsks, "ask", this.maxLevelsPerSide);
    const shapeError = validateBookShape(nextBids, nextAsks);
    if (shapeError) {
      this.status = "QUARANTINED";
      this.diagnostics.rejectedUpdates += 1;
      return failure("INVALID_SNAPSHOT", shapeError, this.snapshot());
    }

    const recovering = this.status === "GAP" || this.status === "QUARANTINED";
    this.bids = nextBids;
    this.asks = nextAsks;
    this.status = "HEALTHY";
    this.lastSequence = update.lastSequence;
    this.lastSourceTimestamp = update.sourceTimestamp;
    this.lastReceivedAt = update.receivedAt;
    this.provenance = update.provenance;
    this.checksum = update.checksum;
    this.checksumVerified = update.checksumVerified;
    this.diagnostics.acceptedSnapshots += 1;
    if (recovering) this.diagnostics.recoveries += 1;
    return success(recovering ? "SNAPSHOT_RECOVERED" : "SNAPSHOT_ACCEPTED", this.snapshot());
  }

  applyDelta(update) {
    if (this.status !== "HEALTHY") {
      this.diagnostics.rejectedUpdates += 1;
      return failure("SNAPSHOT_REQUIRED", `Cannot apply delta while book is ${this.status}`, this.snapshot());
    }
    const sequence = assessSequence(this.lastSequence, update, this.strictContiguousSequence);
    if (sequence.duplicate) {
      this.diagnostics.duplicateUpdates += 1;
      return success("DUPLICATE_IGNORED", this.snapshot(), false);
    }
    if (sequence.gap) {
      this.status = "GAP";
      this.diagnostics.sequenceGaps += 1;
      this.diagnostics.rejectedUpdates += 1;
      return failure("SEQUENCE_GAP", sequence.reason, this.snapshot());
    }

    const nextBids = new Map(this.bids);
    const nextAsks = new Map(this.asks);
    applyChanges(nextBids, update.bids);
    applyChanges(nextAsks, update.asks);
    trimMap(nextBids, "bid", this.maxLevelsPerSide);
    trimMap(nextAsks, "ask", this.maxLevelsPerSide);
    const shapeError = validateBookShape(nextBids, nextAsks);
    if (shapeError) {
      this.status = "QUARANTINED";
      this.diagnostics.rejectedUpdates += 1;
      return failure("INVALID_RECONSTRUCTED_BOOK", shapeError, this.snapshot());
    }

    this.bids = nextBids;
    this.asks = nextAsks;
    this.lastSequence = update.lastSequence ?? this.lastSequence;
    this.lastSourceTimestamp = update.sourceTimestamp;
    this.lastReceivedAt = update.receivedAt;
    this.provenance = update.provenance;
    this.checksum = update.checksum ?? this.checksum;
    this.checksumVerified = update.checksumVerified || this.checksumVerified;
    this.diagnostics.acceptedDeltas += 1;
    return success("DELTA_ACCEPTED", this.snapshot());
  }

  snapshot() {
    const bids = sortedLevels(this.bids, "bid", this.maxLevelsPerSide);
    const asks = sortedLevels(this.asks, "ask", this.maxLevelsPerSide);
    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    return Object.freeze({
      schemaVersion: 1,
      instrument: this.instrument,
      status: this.status,
      sourceTimestamp: this.lastSourceTimestamp,
      receivedAt: this.lastReceivedAt,
      sequence: this.lastSequence,
      checksum: this.checksum,
      checksumVerified: this.checksumVerified,
      provenance: this.provenance,
      bids,
      asks,
      bestBid,
      bestAsk,
      midPrice: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
      coverageMin: bids.length ? bids[bids.length - 1].price : null,
      coverageMax: asks.length ? asks[asks.length - 1].price : null,
      diagnostics: Object.freeze({ ...this.diagnostics })
    });
  }
}

function assessSnapshotOrder(reconstructor, update) {
  if (reconstructor.lastSequence !== null && update.lastSequence !== null) {
    if (update.lastSequence < reconstructor.lastSequence) {
      return { accept: false, duplicate: false, reason: `Snapshot sequence ${update.lastSequence} precedes ${reconstructor.lastSequence}` };
    }
    if (update.lastSequence === reconstructor.lastSequence) {
      if (reconstructor.status === "HEALTHY") return { accept: false, duplicate: true, reason: null };
      return { accept: false, duplicate: false, reason: `Recovery snapshot sequence ${update.lastSequence} does not advance the quarantined book` };
    }
  }
  if (reconstructor.lastSourceTimestamp !== null && update.sourceTimestamp < reconstructor.lastSourceTimestamp) {
    return { accept: false, duplicate: false, reason: `Snapshot timestamp ${update.sourceTimestamp} precedes ${reconstructor.lastSourceTimestamp}` };
  }
  return { accept: true, duplicate: false, reason: null };
}

function assessSequence(lastSequence, update, strictContiguous) {
  if (lastSequence === null || update.lastSequence === null) return { duplicate: false, gap: false, reason: null };
  if (update.lastSequence <= lastSequence) return { duplicate: true, gap: false, reason: null };
  if (update.previousSequence !== null && update.previousSequence !== lastSequence) {
    return { duplicate: false, gap: true, reason: `Expected previous sequence ${lastSequence}, received ${update.previousSequence}` };
  }
  if (update.firstSequence !== null) {
    const expected = lastSequence + 1;
    if (expected < update.firstSequence || expected > update.lastSequence) {
      return { duplicate: false, gap: true, reason: `Sequence range ${update.firstSequence}-${update.lastSequence} does not bridge ${lastSequence}` };
    }
  } else if (strictContiguous && update.lastSequence !== lastSequence + 1) {
    return { duplicate: false, gap: true, reason: `Expected sequence ${lastSequence + 1}, received ${update.lastSequence}` };
  }
  return { duplicate: false, gap: false, reason: null };
}

function validateBookShape(bids, asks) {
  if (!bids.size || !asks.size) return "Reconstructed book requires bids and asks";
  const bestBid = Math.max(...bids.keys());
  const bestAsk = Math.min(...asks.keys());
  if (bestBid >= bestAsk) return `Crossed book ${bestBid} >= ${bestAsk}`;
  return null;
}

function levelMap(levels, allowZero) {
  const map = new Map();
  for (const level of levels) {
    if (level.quantity === 0 && allowZero) continue;
    map.set(level.price, level.quantity);
  }
  return map;
}

function trimMap(map, side, limit) {
  if (map.size <= limit) return;
  const retained = [...map.entries()]
    .sort((left, right) => side === "bid" ? right[0] - left[0] : left[0] - right[0])
    .slice(0, limit);
  map.clear();
  for (const [price, quantity] of retained) map.set(price, quantity);
}

function applyChanges(target, levels) {
  for (const level of levels) {
    if (level.quantity === 0) target.delete(level.price);
    else target.set(level.price, level.quantity);
  }
}

function sortedLevels(map, side, limit) {
  return [...map.entries()]
    .map(([price, quantity]) => Object.freeze({ price, quantity }))
    .sort((left, right) => side === "bid" ? right.price - left.price : left.price - right.price)
    .slice(0, limit);
}

function normalizeDepthLimit(requested, venueLimit) {
  const venueMaximum = Number.isFinite(venueLimit) ? Math.max(1, Math.floor(venueLimit)) : 10_000;
  if (!Number.isFinite(requested)) return venueMaximum;
  return Math.max(1, Math.min(venueMaximum, Math.floor(requested)));
}

function success(code, book, accepted = true) {
  return Object.freeze({ ok: true, accepted, code, book });
}

function failure(code, message, book) {
  return Object.freeze({ ok: false, accepted: false, code, message, book });
}
