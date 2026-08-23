export const LIQUIDITY_FABRIC_SCHEMA_VERSION = 1;

export const supportedLiquidityVenues = Object.freeze([
  "binance",
  "bybit",
  "coinbase",
  "kraken",
  "okx",
  "bitget",
  "hyperliquid"
]);

export const quantitySemantics = Object.freeze([
  "BASE",
  "QUOTE",
  "CONTRACTS_LINEAR",
  "CONTRACTS_INVERSE"
]);

export function createCanonicalInstrument(input = {}) {
  const venue = token(input.venue).toLowerCase();
  const marketKind = token(input.marketKind).toLowerCase();
  const exchangeSymbol = token(input.exchangeSymbol).toUpperCase();
  const baseAsset = token(input.baseAsset).toUpperCase();
  const quoteAsset = token(input.quoteAsset).toUpperCase();
  const semantics = token(input.quantitySemantics || "BASE").toUpperCase();
  const contractMultiplier = finitePositive(input.contractMultiplier ?? 1, "contractMultiplier");

  if (!supportedLiquidityVenues.includes(venue)) throw contractError(`Unsupported liquidity venue ${venue || "<empty>"}`);
  if (!marketKind) throw contractError("Canonical instrument requires marketKind");
  if (!exchangeSymbol) throw contractError("Canonical instrument requires exchangeSymbol");
  if (!baseAsset || !quoteAsset) throw contractError("Canonical instrument requires baseAsset and quoteAsset");
  if (!quantitySemantics.includes(semantics)) throw contractError(`Unsupported quantity semantics ${semantics}`);

  const canonicalSymbol = `${baseAsset}/${quoteAsset}`;
  return Object.freeze({
    schemaVersion: LIQUIDITY_FABRIC_SCHEMA_VERSION,
    venue,
    marketKind,
    exchangeSymbol,
    canonicalSymbol,
    baseAsset,
    quoteAsset,
    quantitySemantics: semantics,
    contractMultiplier,
    key: [venue, marketKind, exchangeSymbol].join(":"),
    economicKey: [marketKind, canonicalSymbol].join(":"),
    familyKey: [marketKind, baseAsset].join(":")
  });
}

export function validateDirectVenueProvenance(provenance, instrument) {
  if (!provenance || typeof provenance !== "object") throw provenanceError("Missing venue provenance");
  const declaredVenue = token(provenance.declaredVenue).toLowerCase();
  const originalVenue = token(provenance.originalVenue).toLowerCase();
  const transport = token(provenance.transport).toUpperCase();
  const sourceKind = token(provenance.sourceKind).toUpperCase();

  if (provenance.direct !== true) throw provenanceError("Composite depth requires a direct exchange feed");
  if (provenance.relabelled === true) throw provenanceError("Relabelled market depth is prohibited");
  if (declaredVenue !== instrument.venue || originalVenue !== instrument.venue) {
    throw provenanceError(`Venue provenance mismatch for ${instrument.key}`);
  }
  if (!transport) throw provenanceError("Venue provenance requires a transport identifier");
  if (sourceKind !== "PUBLIC_L2" && sourceKind !== "PUBLIC_L3") {
    throw provenanceError(`Unsupported liquidity source kind ${sourceKind || "<empty>"}`);
  }

  return Object.freeze({
    direct: true,
    relabelled: false,
    declaredVenue,
    originalVenue,
    transport,
    sourceKind,
    endpointId: token(provenance.endpointId),
    privateLiquidityIncluded: provenance.privateLiquidityIncluded === true,
    rpiIncluded: provenance.rpiIncluded === true
  });
}

export function normalizeBookUpdate(input, instrument) {
  if (!input || typeof input !== "object") throw contractError("Book update must be an object");
  const type = token(input.type).toLowerCase();
  if (type !== "snapshot" && type !== "delta") throw contractError(`Unsupported book update type ${type || "<empty>"}`);
  const sourceTimestamp = finiteTimestamp(input.sourceTimestamp, "sourceTimestamp");
  const receivedAt = finiteTimestamp(input.receivedAt ?? Date.now(), "receivedAt");
  if (sourceTimestamp > receivedAt + 300_000) throw contractError("Book update timestamp is implausibly in the future");
  const provenance = validateDirectVenueProvenance(input.provenance, instrument);
  const bids = normalizeLevels(input.bids, type === "delta");
  const asks = normalizeLevels(input.asks, type === "delta");
  if (type === "snapshot" && (!bids.length || !asks.length)) throw contractError("Snapshot requires both bid and ask levels");
  if (type === "delta" && !bids.length && !asks.length) throw contractError("Delta requires at least one changed level");

  return {
    schemaVersion: LIQUIDITY_FABRIC_SCHEMA_VERSION,
    type,
    instrument,
    sourceTimestamp,
    receivedAt,
    firstSequence: optionalSequence(input.firstSequence),
    lastSequence: optionalSequence(input.lastSequence ?? input.sequence),
    previousSequence: optionalSequence(input.previousSequence),
    checksum: input.checksum === null || input.checksum === undefined ? null : String(input.checksum),
    checksumVerified: input.checksumVerified === true,
    bids,
    asks,
    provenance
  };
}

export function convertNativeQuantity(level, instrument, quoteFxToUsd) {
  const priceUsd = finitePositive(level.price, "level.price") * finitePositive(quoteFxToUsd, "quoteFxToUsd");
  const nativeQuantity = finiteNonNegative(level.quantity, "level.quantity");
  const multiplier = instrument.contractMultiplier;
  let baseQuantity;
  let quoteNotionalUsd;

  switch (instrument.quantitySemantics) {
    case "BASE":
      baseQuantity = nativeQuantity;
      quoteNotionalUsd = baseQuantity * priceUsd;
      break;
    case "QUOTE":
      quoteNotionalUsd = nativeQuantity * quoteFxToUsd;
      baseQuantity = quoteNotionalUsd / priceUsd;
      break;
    case "CONTRACTS_LINEAR":
      baseQuantity = nativeQuantity * multiplier;
      quoteNotionalUsd = baseQuantity * priceUsd;
      break;
    case "CONTRACTS_INVERSE":
      quoteNotionalUsd = nativeQuantity * multiplier * quoteFxToUsd;
      baseQuantity = quoteNotionalUsd / priceUsd;
      break;
    default:
      throw contractError(`Unsupported quantity semantics ${instrument.quantitySemantics}`);
  }

  return { priceUsd, baseQuantity, quoteNotionalUsd, nativeQuantity };
}

export function contractError(message) {
  return Object.assign(new Error(message), { code: "LIQUIDITY_FABRIC_CONTRACT_INVALID" });
}

export function provenanceError(message) {
  return Object.assign(new Error(message), { code: "LIQUIDITY_FABRIC_PROVENANCE_INVALID" });
}

function normalizeLevels(levels, allowZero) {
  if (!Array.isArray(levels)) return [];
  if (levels.length > 10_000) throw contractError("Book update exceeds the bounded 10,000-level safety limit per side");
  const seen = new Set();
  return levels.map((level) => {
    const price = finitePositive(Array.isArray(level) ? level[0] : level?.price ?? level?.px, "level.price");
    const quantity = finiteNonNegative(Array.isArray(level) ? level[1] : level?.quantity ?? level?.size ?? level?.sz, "level.quantity");
    if (!allowZero && quantity === 0) throw contractError("Snapshot levels must have positive quantity");
    const key = price.toFixed(12);
    if (seen.has(key)) throw contractError(`Duplicate price ${price} inside one book update side`);
    seen.add(key);
    return { price, quantity };
  });
}

function optionalSequence(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw contractError(`Invalid sequence ${value}`);
  return numeric;
}

function finiteTimestamp(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw contractError(`Invalid ${label}`);
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function finitePositive(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw contractError(`Invalid ${label}`);
  return numeric;
}

function finiteNonNegative(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) throw contractError(`Invalid ${label}`);
  return numeric;
}

function token(value) {
  return String(value ?? "").trim();
}
