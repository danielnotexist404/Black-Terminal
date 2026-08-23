import { requireVenueDepthPolicy } from "./venue-policies.js";

export function assessBookQuality(book, options = {}) {
  const now = finiteNow(options.now ?? Date.now());
  const policy = requireVenueDepthPolicy(book?.instrument?.venue);
  const expectedCadenceMs = policy.expectedCadenceMs;
  const maximumAgeMs = Number.isFinite(options.maximumAgeMs)
    ? Math.max(expectedCadenceMs, Number(options.maximumAgeMs))
    : Math.max(1_500, expectedCadenceMs * 6);
  const sourceTimestamp = Number(book?.sourceTimestamp);
  const receivedAt = Number(book?.receivedAt);
  const reasons = [];

  if (book?.status !== "HEALTHY") reasons.push(`BOOK_${book?.status || "MISSING"}`);
  if (!book?.provenance?.direct || book.provenance.relabelled || book.provenance.originalVenue !== book?.instrument?.venue) {
    reasons.push("UNVERIFIED_PROVENANCE");
  }
  if (!Number.isFinite(sourceTimestamp) || !Number.isFinite(receivedAt)) reasons.push("MISSING_TIMESTAMPS");
  const ageMs = Number.isFinite(sourceTimestamp) ? Math.max(0, now - sourceTimestamp) : Number.POSITIVE_INFINITY;
  const transportLatencyMs = Number.isFinite(sourceTimestamp) && Number.isFinite(receivedAt)
    ? Math.max(0, receivedAt - sourceTimestamp)
    : Number.POSITIVE_INFINITY;
  if (ageMs > maximumAgeMs) reasons.push("STALE_BOOK");
  if (transportLatencyMs > Math.max(2_500, expectedCadenceMs * 10)) reasons.push("EXCESSIVE_TRANSPORT_LATENCY");
  if (!book?.bids?.length || !book?.asks?.length) reasons.push("EMPTY_SIDE");
  if (policy.checksumPolicy === "REQUIRED" && book?.checksumVerified !== true) reasons.push("CHECKSUM_REQUIRED");
  if (policy.checksumPolicy === "REQUIRED_WHEN_PROVIDED" && book?.checksum !== null && book?.checksum !== undefined && book?.checksumVerified !== true) {
    reasons.push("CHECKSUM_UNVERIFIED");
  }

  const freshnessScore = Number.isFinite(ageMs) ? clamp(1 - ageMs / maximumAgeMs, 0, 1) : 0;
  const latencyCeiling = Math.max(1_000, expectedCadenceMs * 8);
  const latencyScore = Number.isFinite(transportLatencyMs) ? clamp(1 - transportLatencyMs / latencyCeiling, 0, 1) : 0;
  const suppliedLevels = Math.min(book?.bids?.length || 0, book?.asks?.length || 0);
  const targetLevels = Number.isFinite(policy.maxPublicDepthPerSide)
    ? Math.min(100, policy.maxPublicDepthPerSide)
    : 100;
  const coverageScore = clamp(suppliedLevels / Math.max(1, targetLevels), 0, 1);
  const score = reasons.length ? 0 : clamp(freshnessScore * 0.5 + latencyScore * 0.2 + coverageScore * 0.3, 0, 1);

  return Object.freeze({
    eligible: reasons.length === 0,
    score,
    reasons: Object.freeze(reasons),
    ageMs,
    transportLatencyMs,
    suppliedLevels,
    expectedCadenceMs,
    maximumAgeMs
  });
}

function finiteNow(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new Error("Invalid liquidity quality clock");
  return numeric;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
