export const IMM_INTEGRITY_VERSION = 1;

export function validateNormalizedDepthSample(sample, previousSample = null) {
  const errors = [];
  const warnings = [];
  const bids = Array.isArray(sample.bids) ? sample.bids : [];
  const asks = Array.isArray(sample.asks) ? sample.asks : [];

  if (!sample.venue) errors.push("missing_venue");
  if (!sample.symbol) errors.push("missing_symbol");
  if (!bids.length) errors.push("missing_bids");
  if (!asks.length) errors.push("missing_asks");
  validateSide(bids, "bid", errors);
  validateSide(asks, "ask", errors);

  const bestBid = bids[0]?.price;
  const bestAsk = asks[0]?.price;
  if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid >= bestAsk) {
    errors.push("crossed_book");
  }

  const now = Date.now();
  const sourceTimestamp = Number(sample.sourceTimestamp || sample.capturedAt);
  if (!Number.isFinite(sourceTimestamp)) {
    errors.push("invalid_timestamp");
  } else {
    if (sourceTimestamp > now + 5 * 60_000) errors.push("future_timestamp");
    if (now - sourceTimestamp > 7 * 24 * 60 * 60_000) warnings.push("stale_source_timestamp");
  }

  const sequence = sequenceNumber(sample.sequence);
  const previousSequence = sequenceNumber(previousSample?.sequence);
  if (Number.isFinite(sequence) && Number.isFinite(previousSequence)) {
    if (sequence < previousSequence) errors.push("sequence_regression");
    if (sequence === previousSequence) warnings.push("duplicate_sequence");
  }

  const report = {
    valid: errors.length === 0,
    errors,
    warnings,
    version: IMM_INTEGRITY_VERSION,
    venue: sample.venue,
    marketKind: sample.marketKind,
    symbol: sample.symbol,
    sequence: sample.sequence ?? null,
    bestBid: Number.isFinite(bestBid) ? bestBid : null,
    bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
    bidLevels: bids.length,
    askLevels: asks.length,
    checkedAt: new Date().toISOString()
  };

  if (!report.valid) {
    const error = new Error(`IMM orderbook integrity failed: ${errors.join(", ")}`);
    error.statusCode = 422;
    error.immIntegrity = true;
    error.report = report;
    throw error;
  }

  return report;
}

export async function recordIntegrityEvent(supabase, sample, report) {
  if (!supabase || !report) return null;
  const row = {
    venue: report.venue || sample?.venue || "unknown",
    market_kind: report.marketKind || sample?.marketKind || "unknown",
    symbol: report.symbol || sample?.symbol || "unknown",
    severity: report.valid ? "warning" : "error",
    reason: report.valid ? report.warnings.join(",") || "warning" : report.errors.join(",") || "invalid_orderbook",
    sequence: report.sequence === null || report.sequence === undefined ? null : String(report.sequence),
    occurred_at: report.checkedAt || new Date().toISOString(),
    metadata: {
      ...report,
      source: "black-core-depth-integrity"
    }
  };
  const { error } = await supabase.from("imm_integrity_events").insert(row);
  if (error) throw error;
  return row;
}

function validateSide(levels, side, errors) {
  const seenPrices = new Set();
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index];
    if (!Number.isFinite(level.price) || level.price <= 0) errors.push(`${side}_invalid_price`);
    if (!Number.isFinite(level.quantity) || level.quantity < 0) errors.push(`${side}_invalid_size`);
    const key = Number(level.price).toFixed(12);
    if (seenPrices.has(key)) errors.push(`${side}_duplicate_price`);
    seenPrices.add(key);
    const previous = levels[index - 1];
    if (!previous) continue;
    if (side === "bid" && level.price > previous.price) errors.push("bids_not_descending");
    if (side === "ask" && level.price < previous.price) errors.push("asks_not_ascending");
  }
}

function sequenceNumber(value) {
  if (value === null || value === undefined || value === "") return Number.NaN;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}
