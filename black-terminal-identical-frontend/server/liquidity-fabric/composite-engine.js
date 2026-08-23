import { convertNativeQuantity } from "./contracts.js";
import { assessBookQuality } from "./quality.js";

export function buildCompositeLiquidity(input = {}) {
  const now = finitePositive(input.now ?? Date.now(), "now");
  const view = String(input.view || "GLOBAL_INFORMATIONAL").trim().toUpperCase();
  if (view !== "GLOBAL_INFORMATIONAL" && view !== "EXECUTABLE") throw new Error(`Unsupported composite view ${view}`);
  const executableVenues = new Set((input.executableVenues || []).map((venue) => String(venue).toLowerCase()));
  const quoteFxByAsset = Object.fromEntries(Object.entries(input.quoteFxByAsset || {}).map(([asset, value]) => [asset.toUpperCase(), Number(value)]));
  quoteFxByAsset.USD = quoteFxByAsset.USD ?? 1;
  const binSizeBps = finitePositive(input.binSizeBps ?? 1, "binSizeBps");
  const latestBooks = newestBookPerInstrument(input.books || []);
  const instrumentFamilyKey = String(input.instrumentFamilyKey || latestBooks[0]?.instrument?.familyKey || "");
  const accepted = [];
  const excluded = [];

  for (const book of latestBooks) {
    const venue = book?.instrument?.venue;
    if (!instrumentFamilyKey || book?.instrument?.familyKey !== instrumentFamilyKey) {
      excluded.push(exclusion(book, ["INSTRUMENT_FAMILY_MISMATCH"]));
      continue;
    }
    if (view === "EXECUTABLE" && !executableVenues.has(venue)) {
      excluded.push(exclusion(book, ["VENUE_NOT_EXECUTABLE"]));
      continue;
    }
    const quoteFx = quoteFxByAsset[book?.instrument?.quoteAsset];
    if (!Number.isFinite(quoteFx) || quoteFx <= 0) {
      excluded.push(exclusion(book, ["MISSING_QUOTE_FX"]));
      continue;
    }
    const quality = assessBookQuality(book, { now, maximumAgeMs: input.maximumAgeMs });
    if (!quality.eligible) {
      excluded.push(exclusion(book, quality.reasons, quality));
      continue;
    }
    accepted.push({ book, quality, quoteFx });
  }

  const referencePriceUsd = Number.isFinite(input.referencePriceUsd)
    ? finitePositive(input.referencePriceUsd, "referencePriceUsd")
    : deriveReferencePriceUsd(accepted);
  if (!accepted.length || !Number.isFinite(referencePriceUsd)) {
    return emptyComposite({ view, binSizeBps, excluded, now, instrumentFamilyKey });
  }

  const bins = new Map();
  const coverage = [];
  for (const source of accepted) {
    const { book, quality, quoteFx } = source;
    coverage.push(bookCoverage(book, quoteFx, quality));
    accumulateSide(bins, book.bids, "bid", source, referencePriceUsd, binSizeBps);
    accumulateSide(bins, book.asks, "ask", source, referencePriceUsd, binSizeBps);
  }

  const rows = [...bins.values()]
    .map(finalizeBin)
    .sort((left, right) => right.priceUsd - left.priceUsd);
  const includedVenues = [...new Set(accepted.map((item) => item.book.instrument.venue))].sort();
  return Object.freeze({
    schemaVersion: 1,
    view,
    generatedAt: now,
    instrumentFamilyKey,
    referencePriceUsd,
    binSizeBps,
    includedVenues: Object.freeze(includedVenues),
    excluded: Object.freeze(excluded),
    coverage: Object.freeze(coverage),
    rows: Object.freeze(rows),
    semantics: Object.freeze({
      rawQuoteNotionalUsd: "sum of directly observed venue contributions",
      qualityWeightedQuoteNotionalUsd: "raw contribution multiplied by venue freshness/latency/coverage score",
      executable: view === "EXECUTABLE",
      hiddenLiquidityIncluded: false,
      inferredLiquidityIncluded: false
    })
  });
}

export function deriveReferencePriceUsd(acceptedSources) {
  const candidates = acceptedSources
    .map(({ book, quality, quoteFx }) => ({ price: book.midPrice * quoteFx, weight: Math.max(0.0001, quality.score) }))
    .filter((item) => Number.isFinite(item.price) && item.price > 0)
    .sort((left, right) => left.price - right.price);
  if (!candidates.length) return null;
  const totalWeight = candidates.reduce((sum, item) => sum + item.weight, 0);
  let cumulative = 0;
  for (const candidate of candidates) {
    cumulative += candidate.weight;
    if (cumulative >= totalWeight / 2) return candidate.price;
  }
  return candidates[candidates.length - 1].price;
}

function accumulateSide(bins, levels, side, source, referencePriceUsd, binSizeBps) {
  const { book, quality, quoteFx } = source;
  for (const level of levels) {
    const normalized = convertNativeQuantity(level, book.instrument, quoteFx);
    const distanceBps = ((normalized.priceUsd - referencePriceUsd) / referencePriceUsd) * 10_000;
    const binIndex = Math.round(distanceBps / binSizeBps);
    const bucketBps = binIndex * binSizeBps;
    const key = `${side}:${binIndex}`;
    const row = bins.get(key) || {
      side,
      bucketBps,
      priceUsd: referencePriceUsd * (1 + bucketBps / 10_000),
      rawQuoteNotionalUsd: 0,
      qualityWeightedQuoteNotionalUsd: 0,
      baseQuantity: 0,
      contributions: new Map()
    };
    row.rawQuoteNotionalUsd += normalized.quoteNotionalUsd;
    row.qualityWeightedQuoteNotionalUsd += normalized.quoteNotionalUsd * quality.score;
    row.baseQuantity += normalized.baseQuantity;
    const venue = book.instrument.venue;
    const contributionKey = book.instrument.key;
    const contribution = row.contributions.get(contributionKey) || {
      venue,
      instrumentKey: book.instrument.key,
      rawQuoteNotionalUsd: 0,
      qualityWeightedQuoteNotionalUsd: 0,
      baseQuantity: 0,
      qualityScore: quality.score,
      sourceTimestamp: book.sourceTimestamp
    };
    contribution.rawQuoteNotionalUsd += normalized.quoteNotionalUsd;
    contribution.qualityWeightedQuoteNotionalUsd += normalized.quoteNotionalUsd * quality.score;
    contribution.baseQuantity += normalized.baseQuantity;
    row.contributions.set(contributionKey, contribution);
    bins.set(key, row);
  }
}

function finalizeBin(row) {
  const contributions = [...row.contributions.values()]
    .sort((left, right) => right.qualityWeightedQuoteNotionalUsd - left.qualityWeightedQuoteNotionalUsd)
    .map((item) => Object.freeze({ ...item }));
  return Object.freeze({
    side: row.side,
    bucketBps: row.bucketBps,
    priceUsd: row.priceUsd,
    rawQuoteNotionalUsd: row.rawQuoteNotionalUsd,
    qualityWeightedQuoteNotionalUsd: row.qualityWeightedQuoteNotionalUsd,
    baseQuantity: row.baseQuantity,
    venueCount: new Set(contributions.map((item) => item.venue)).size,
    instrumentCount: contributions.length,
    contributions: Object.freeze(contributions)
  });
}

function newestBookPerInstrument(books) {
  const newest = new Map();
  for (const book of books) {
    const key = book?.instrument?.key;
    if (!key) continue;
    const current = newest.get(key);
    if (!current || Number(book.receivedAt || 0) > Number(current.receivedAt || 0)) newest.set(key, book);
  }
  return [...newest.values()];
}

function bookCoverage(book, quoteFx, quality) {
  return Object.freeze({
    venue: book.instrument.venue,
    instrumentKey: book.instrument.key,
    minimumPriceUsd: book.coverageMin * quoteFx,
    maximumPriceUsd: book.coverageMax * quoteFx,
    bidLevels: book.bids.length,
    askLevels: book.asks.length,
    qualityScore: quality.score,
    sourceTimestamp: book.sourceTimestamp
  });
}

function exclusion(book, reasons, quality = null) {
  return Object.freeze({
    venue: book?.instrument?.venue || null,
    instrumentKey: book?.instrument?.key || null,
    reasons: Object.freeze([...reasons]),
    quality
  });
}

function emptyComposite({ view, binSizeBps, excluded, now, instrumentFamilyKey }) {
  return Object.freeze({
    schemaVersion: 1,
    view,
    generatedAt: now,
    instrumentFamilyKey: instrumentFamilyKey || null,
    referencePriceUsd: null,
    binSizeBps,
    includedVenues: Object.freeze([]),
    excluded: Object.freeze(excluded),
    coverage: Object.freeze([]),
    rows: Object.freeze([]),
    semantics: Object.freeze({
      rawQuoteNotionalUsd: "unavailable",
      qualityWeightedQuoteNotionalUsd: "unavailable",
      executable: view === "EXECUTABLE",
      hiddenLiquidityIncluded: false,
      inferredLiquidityIncluded: false
    })
  });
}

function finitePositive(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new Error(`Invalid ${label}`);
  return numeric;
}
