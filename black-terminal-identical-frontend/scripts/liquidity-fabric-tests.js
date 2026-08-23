import assert from "node:assert/strict";
import { buildCompositeLiquidity } from "../server/liquidity-fabric/composite-engine.js";
import { createCanonicalInstrument, convertNativeQuantity } from "../server/liquidity-fabric/contracts.js";
import { CanonicalOrderBookReconstructor } from "../server/liquidity-fabric/order-book-reconstructor.js";
import { assessBookQuality } from "../server/liquidity-fabric/quality.js";
import { venueDepthPolicies } from "../server/liquidity-fabric/venue-policies.js";

const NOW = 1_787_508_800_000;
const direct = (venue) => ({
  direct: true,
  relabelled: false,
  declaredVenue: venue,
  originalVenue: venue,
  transport: "WEBSOCKET",
  sourceKind: "PUBLIC_L2",
  endpointId: `${venue}-public-depth`,
  privateLiquidityIncluded: false,
  rpiIncluded: false
});

function instrument(venue, overrides = {}) {
  return createCanonicalInstrument({
    venue,
    marketKind: "perpetual",
    exchangeSymbol: "BTCUSDT",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    quantitySemantics: "BASE",
    ...overrides
  });
}

function snapshot(reconstructor, venue, sequence = 100, overrides = {}) {
  return reconstructor.apply({
    type: "snapshot",
    sourceTimestamp: NOW - 20,
    receivedAt: NOW,
    lastSequence: sequence,
    bids: [[100, 2], [99, 3]],
    asks: [[101, 4], [102, 5]],
    provenance: direct(venue),
    ...overrides
  });
}

{
  const target = instrument("coinbase", { marketKind: "spot", exchangeSymbol: "BTC-USD", quoteAsset: "USD" });
  const book = new CanonicalOrderBookReconstructor({ instrument: target });
  const result = book.apply({
    type: "snapshot",
    sourceTimestamp: NOW,
    receivedAt: NOW,
    bids: [[100, 1]],
    asks: [[101, 1]],
    provenance: { ...direct("coinbase"), originalVenue: "binance", relabelled: true }
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "LIQUIDITY_FABRIC_PROVENANCE_INVALID");
  assert.equal(book.snapshot().status, "AWAITING_SNAPSHOT");
}

{
  const target = instrument("bybit");
  const book = new CanonicalOrderBookReconstructor({ instrument: target });
  assert.equal(snapshot(book, "bybit").code, "SNAPSHOT_ACCEPTED");
  for (let index = 0; index < 10; index += 1) {
    const duplicate = book.apply({
      type: "delta",
      sourceTimestamp: NOW + index,
      receivedAt: NOW + index,
      previousSequence: 99,
      lastSequence: 100,
      bids: [[100, 2]],
      asks: [],
      provenance: direct("bybit")
    });
    assert.equal(duplicate.code, "DUPLICATE_IGNORED");
  }
  assert.equal(book.snapshot().bids[0].quantity, 2);
  assert.equal(book.snapshot().diagnostics.duplicateUpdates, 10);
  const duplicateSnapshot = snapshot(book, "bybit", 100, { bids: [[100, 999]], asks: [[101, 999]] });
  assert.equal(duplicateSnapshot.code, "DUPLICATE_SNAPSHOT_IGNORED");
  assert.equal(duplicateSnapshot.book.bids[0].quantity, 2);
  const staleSnapshot = snapshot(book, "bybit", 99, { bids: [[100, 500]], asks: [[101, 500]] });
  assert.equal(staleSnapshot.code, "STALE_SNAPSHOT");
  assert.equal(staleSnapshot.book.bids[0].quantity, 2);
}

{
  const target = instrument("bybit");
  const book = new CanonicalOrderBookReconstructor({ instrument: target });
  snapshot(book, "bybit");
  const delta = book.apply({
    type: "delta",
    sourceTimestamp: NOW + 10,
    receivedAt: NOW + 12,
    previousSequence: 100,
    lastSequence: 101,
    bids: [[100, 7], [99, 0], [98, 1]],
    asks: [[101, 6]],
    provenance: direct("bybit")
  });
  assert.equal(delta.ok, true);
  assert.deepEqual(delta.book.bids.map((level) => [level.price, level.quantity]), [[100, 7], [98, 1]]);
  assert.equal(delta.book.asks[0].quantity, 6);
}

{
  const target = instrument("binance");
  const book = new CanonicalOrderBookReconstructor({ instrument: target });
  snapshot(book, "binance", 200);
  const before = book.snapshot();
  const gap = book.apply({
    type: "delta",
    sourceTimestamp: NOW + 10,
    receivedAt: NOW + 10,
    firstSequence: 205,
    lastSequence: 206,
    bids: [[100, 99]],
    asks: [],
    provenance: direct("binance")
  });
  assert.equal(gap.code, "SEQUENCE_GAP");
  assert.equal(gap.book.status, "GAP");
  assert.equal(gap.book.bids[0].quantity, before.bids[0].quantity);
  const recovery = snapshot(book, "binance", 220, {
    sourceTimestamp: NOW + 20,
    receivedAt: NOW + 20,
    bids: [[100, 8]],
    asks: [[101, 9]]
  });
  assert.equal(recovery.code, "SNAPSHOT_RECOVERED");
  assert.equal(recovery.book.diagnostics.recoveries, 1);
}

{
  const target = instrument("okx");
  const book = new CanonicalOrderBookReconstructor({ instrument: target });
  snapshot(book, "okx", 5);
  const crossed = book.apply({
    type: "delta",
    sourceTimestamp: NOW + 10,
    receivedAt: NOW + 10,
    previousSequence: 5,
    lastSequence: 6,
    bids: [[102, 1]],
    asks: [],
    provenance: direct("okx")
  });
  assert.equal(crossed.code, "INVALID_RECONSTRUCTED_BOOK");
  assert.equal(crossed.book.status, "QUARANTINED");
  assert.equal(crossed.book.bids.some((level) => level.price === 102), false);
}

{
  const target = instrument("okx");
  const book = new CanonicalOrderBookReconstructor({ instrument: target });
  const result = snapshot(book, "okx", 1, { checksum: "venue-checksum", checksumVerified: false });
  assert.equal(result.code, "CHECKSUM_UNVERIFIED");
  assert.equal(result.book.status, "QUARANTINED");
  const recovery = snapshot(book, "okx", 2, { checksum: "venue-checksum-2", checksumVerified: true });
  assert.equal(recovery.code, "SNAPSHOT_RECOVERED");
}

{
  const target = instrument("hyperliquid");
  const book = new CanonicalOrderBookReconstructor({ instrument: target });
  snapshot(book, "hyperliquid", 1, { sourceTimestamp: NOW - 10_000, receivedAt: NOW - 9_900 });
  const quality = assessBookQuality(book.snapshot(), { now: NOW });
  assert.equal(quality.eligible, false);
  assert.ok(quality.reasons.includes("STALE_BOOK"));
  assert.equal(venueDepthPolicies.hyperliquid.maxPublicDepthPerSide, 20);
}

{
  const bybitBook = new CanonicalOrderBookReconstructor({ instrument: instrument("bybit") });
  const binanceBook = new CanonicalOrderBookReconstructor({ instrument: instrument("binance") });
  snapshot(bybitBook, "bybit", 10, { bids: [[100, 2]], asks: [[101, 2]] });
  snapshot(binanceBook, "binance", 20, { bids: [[100, 3]], asks: [[101, 3]] });
  const composite = buildCompositeLiquidity({
    books: [bybitBook.snapshot(), binanceBook.snapshot(), bybitBook.snapshot()],
    now: NOW,
    referencePriceUsd: 100.5,
    quoteFxByAsset: { USDT: 1 },
    binSizeBps: 100
  });
  assert.deepEqual(composite.includedVenues, ["binance", "bybit"]);
  const ask = composite.rows.find((row) => row.side === "ask");
  assert.equal(ask.venueCount, 2);
  assert.equal(ask.rawQuoteNotionalUsd, 505);
  assert.deepEqual(ask.contributions.map((item) => item.venue).sort(), ["binance", "bybit"]);
  assert.equal(composite.semantics.inferredLiquidityIncluded, false);
  assert.equal(composite.instrumentFamilyKey, "perpetual:BTC");

  const executable = buildCompositeLiquidity({
    books: [bybitBook.snapshot(), binanceBook.snapshot()],
    now: NOW,
    view: "EXECUTABLE",
    executableVenues: ["bybit"],
    referencePriceUsd: 100.5,
    quoteFxByAsset: { USDT: 1 },
    binSizeBps: 100
  });
  assert.deepEqual(executable.includedVenues, ["bybit"]);
  assert.ok(executable.excluded.some((item) => item.venue === "binance" && item.reasons.includes("VENUE_NOT_EXECUTABLE")));
}

{
  const perpetual = new CanonicalOrderBookReconstructor({ instrument: instrument("bybit") });
  const spotInstrument = instrument("coinbase", { marketKind: "spot", exchangeSymbol: "BTC-USD", quoteAsset: "USD" });
  const spot = new CanonicalOrderBookReconstructor({ instrument: spotInstrument });
  snapshot(perpetual, "bybit", 1);
  snapshot(spot, "coinbase", 1);
  const composite = buildCompositeLiquidity({
    books: [perpetual.snapshot(), spot.snapshot()],
    now: NOW,
    referencePriceUsd: 100.5,
    quoteFxByAsset: { USDT: 1, USD: 1 }
  });
  assert.deepEqual(composite.includedVenues, ["bybit"]);
  assert.ok(composite.excluded.some((item) => item.venue === "coinbase" && item.reasons.includes("INSTRUMENT_FAMILY_MISMATCH")));
}

{
  const inverse = instrument("bybit", {
    marketKind: "perpetual",
    exchangeSymbol: "BTCUSD",
    quoteAsset: "USD",
    quantitySemantics: "CONTRACTS_INVERSE",
    contractMultiplier: 1
  });
  const converted = convertNativeQuantity({ price: 50_000, quantity: 10_000 }, inverse, 1);
  assert.equal(converted.quoteNotionalUsd, 10_000);
  assert.equal(converted.baseQuantity, 0.2);
}

{
  const target = instrument("bybit");
  const book = new CanonicalOrderBookReconstructor({ instrument: target });
  snapshot(book, "bybit", 1);
  const composite = buildCompositeLiquidity({ books: [book.snapshot()], now: NOW, referencePriceUsd: 100.5 });
  assert.equal(composite.rows.length, 0);
  assert.ok(composite.excluded[0].reasons.includes("MISSING_QUOTE_FX"));
}

console.log("Consolidated Liquidity Fabric Phase I tests passed: provenance, reconstruction, quality, conversion and composite semantics.");
