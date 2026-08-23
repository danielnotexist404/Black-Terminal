export const venueDepthPolicies = Object.freeze({
  binance: Object.freeze({
    venue: "binance",
    maxPublicDepthPerSide: 5_000,
    expectedCadenceMs: 100,
    sequenceModel: "RANGE_SEQUENCE",
    checksumPolicy: "OPTIONAL",
    coverage: "BOUNDED_DELIVERED_BOOK"
  }),
  bybit: Object.freeze({
    venue: "bybit",
    maxPublicDepthPerSide: 1_000,
    expectedCadenceMs: 200,
    sequenceModel: "PREVIOUS_SEQUENCE",
    checksumPolicy: "OPTIONAL",
    coverage: "BOUNDED_DELIVERED_BOOK"
  }),
  coinbase: Object.freeze({
    venue: "coinbase",
    maxPublicDepthPerSide: null,
    expectedCadenceMs: 50,
    sequenceModel: "MONOTONIC_SEQUENCE",
    checksumPolicy: "OPTIONAL",
    coverage: "FULL_AGGREGATED_L2"
  }),
  kraken: Object.freeze({
    venue: "kraken",
    maxPublicDepthPerSide: 1_000,
    expectedCadenceMs: 100,
    sequenceModel: "CHECKSUM_SNAPSHOT_DELTA",
    checksumPolicy: "REQUIRED_WHEN_PROVIDED",
    coverage: "BOUNDED_DELIVERED_BOOK"
  }),
  okx: Object.freeze({
    venue: "okx",
    maxPublicDepthPerSide: 400,
    expectedCadenceMs: 100,
    sequenceModel: "PREVIOUS_SEQUENCE_CHECKSUM",
    checksumPolicy: "REQUIRED_WHEN_PROVIDED",
    coverage: "BOUNDED_DELIVERED_BOOK"
  }),
  bitget: Object.freeze({
    venue: "bitget",
    maxPublicDepthPerSide: 1_000,
    expectedCadenceMs: 50,
    sequenceModel: "PREVIOUS_SEQUENCE_CHECKSUM",
    checksumPolicy: "REQUIRED_WHEN_PROVIDED",
    coverage: "PAIR_DEPENDENT_BOUNDED_BOOK"
  }),
  hyperliquid: Object.freeze({
    venue: "hyperliquid",
    maxPublicDepthPerSide: 20,
    expectedCadenceMs: 500,
    sequenceModel: "AUTHORITATIVE_BLOCK_SNAPSHOT",
    checksumPolicy: "OPTIONAL",
    coverage: "TOP_20_PER_SIDE"
  })
});

export function requireVenueDepthPolicy(venue) {
  const normalized = String(venue || "").trim().toLowerCase();
  const policy = venueDepthPolicies[normalized];
  if (!policy) throw Object.assign(new Error(`No certified depth policy for ${normalized || "<empty>"}`), {
    code: "LIQUIDITY_FABRIC_VENUE_UNCERTIFIED"
  });
  return policy;
}
