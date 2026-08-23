import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCompositeLiquidity } from "../server/liquidity-fabric/composite-engine.js";
import { createCanonicalInstrument, convertNativeQuantity } from "../server/liquidity-fabric/contracts.js";
import { CanonicalOrderBookReconstructor } from "../server/liquidity-fabric/order-book-reconstructor.js";
import { assessBookQuality } from "../server/liquidity-fabric/quality.js";
import { venueDepthPolicies } from "../server/liquidity-fabric/venue-policies.js";
import { projectLiquidityViewport } from "../server/liquidity-fabric/viewport-compositor.js";
import { VenueBookSession } from "../server/liquidity-fabric/direct-runtime.js";

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
  const venueBook = (venue, bids, asks, receivedAt = NOW) => ({
    venue,
    marketKind: venue === "coinbase" ? "spot" : "perpetual",
    exchangeSymbol: venue === "coinbase" ? "BTC-USD" : "BTCUSDT",
    baseAsset: "BTC",
    quoteAsset: venue === "coinbase" ? "USD" : "USDT",
    transport: "PUBLIC_L2",
    direct: true,
    relabelled: false,
    status: "HEALTHY",
    sourceTimestamp: receivedAt,
    receivedAt,
    bids: bids.map(([price, quantity]) => ({ price, quantity })),
    asks: asks.map(([price, quantity]) => ({ price, quantity }))
  });
  const coinbase = venueBook("coinbase", [[72_000, 2], [62_100, 3]], [[72_010, 4], [87_900, 5]]);
  const bybit = venueBook("bybit", [[72_000, 1]], [[72_010, 1.5]]);
  const field = projectLiquidityViewport({
    books: [coinbase, bybit],
    now: NOW,
    baseAsset: "BTC",
    minimumPrice: 62_000,
    maximumPrice: 88_000,
    rowCount: 52
  });
  assert.equal(field.state, "live");
  assert.equal(field.viewport.maximumPrice - field.viewport.minimumPrice, 26_000, "the chart field must preserve the complete requested $26k viewport");
  assert.equal(field.coverageRatio, 1, "a verified full-book source spanning the viewport must certify every display row as covered");
  assert.deepEqual(field.includedVenues.map((item) => item.venue), ["coinbase", "bybit"]);
  assert.equal(field.semantics.syntheticLiquidityIncluded, false);
  assert.equal(field.rows.reduce((total, row) => total + row.bidBase, 0), 6);
  assert.equal(field.rows.reduce((total, row) => total + row.askBase, 0), 10.5);
  const combinedBid = field.rows.find((row) => row.contributions.length === 2 && row.bidBase > 0);
  assert.ok(combinedBid, "same-price liquidity from multiple direct venues must be aggregated with provenance intact");
  assert.deepEqual(combinedBid.contributions.map((item) => item.venue).sort(), ["bybit", "coinbase"]);

  const anchored = projectLiquidityViewport({
    books: [coinbase, bybit],
    now: NOW,
    baseAsset: "BTC",
    minimumPrice: 62_000,
    maximumPrice: 88_000,
    rowCount: 80,
    priceStep: 500
  });
  const panned = projectLiquidityViewport({
    books: [coinbase, bybit],
    now: NOW,
    baseAsset: "BTC",
    minimumPrice: 62_500,
    maximumPrice: 88_500,
    rowCount: 80,
    priceStep: 500,
    previousRows: anchored.rows
  });
  const anchoredBid = anchored.rows.find((row) => row.price === 72_000);
  const pannedBid = panned.rows.find((row) => row.price === 72_000);
  assert.ok(anchoredBid && pannedBid, "overlapping canonical levels must remain present after a viewport pan");
  assert.equal(pannedBid.priceLow, anchoredBid.priceLow, "a pan must not redefine a canonical bucket's lower price bound");
  assert.equal(pannedBid.priceHigh, anchoredBid.priceHigh, "a pan must not redefine a canonical bucket's upper price bound");
  assert.equal(pannedBid.bidBase, anchoredBid.bidBase, "a pan must not change the quantity assigned to an unchanged price bucket");
  assert.equal(pannedBid.deltaNotionalUsd, 0, "price-keyed reconciliation must not report false order flow when rows move on screen");

  const staleOnly = projectLiquidityViewport({
    books: [venueBook("coinbase", [[72_000, 1]], [[72_010, 1]], NOW - 20_000)],
    now: NOW,
    baseAsset: "BTC",
    minimumPrice: 62_000,
    maximumPrice: 88_000,
    rowCount: 52,
    maximumAgeMs: 15_000
  });
  assert.equal(staleOnly.state, "initializing");
  assert.equal(staleOnly.rows.every((row) => row.bidBase === 0 && row.askBase === 0), true, "stale liquidity must never be painted into the chart");
  assert.ok(staleOnly.excludedVenues[0].reasons.includes("STALE_BOOK"));
}

{
  let now = NOW;
  const session = new VenueBookSession({ venue: "fixture", marketKind: "spot", exchangeSymbol: "BTC-USD", baseAsset: "BTC", quoteAsset: "USD", transport: "TEST", now: () => now });
  session.replace({ bids: [[100, 2]], asks: [[101, 3]], sourceTimestamp: now, sequence: 1 });
  const first = session.snapshot();
  assert.equal(session.snapshot(), first, "an unchanged deep book snapshot must reuse its immutable sorted cache");
  now += 800;
  session.apply([{ side: "bid", price: 100, quantity: 4 }], now, 2);
  const second = session.snapshot();
  assert.notEqual(second, first, "a genuine update must invalidate the sorted snapshot cache");
  assert.equal(second.bids[0].quantity, 4);
  assert.equal(second.receivedAt, now);
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

{
  const route = readFileSync(new URL("../server/liquidity-fabric/route.js", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../server/liquidity-fabric/direct-runtime.js", import.meta.url), "utf8");
  assert.match(route, /requireMethod\(req, "GET"\)/, "the consolidated endpoint must remain read-only");
  assert.doesNotMatch(`${route}\n${runtime}`, /\/api\/(execution|order\/create)|placeOrder|cancelOrder|amendOrder/, "liquidity synchronization must not contain an order-mutation path");
  assert.match(runtime, /orderbook\.full\./, "Bybit must use the official full-depth delta stream rather than the legacy narrow ladder feed");
  assert.match(runtime, /full_orderbook\?category=linear/, "Bybit full-depth reconstruction must be initialized by its official REST snapshot");
  assert.match(runtime, /canonical:\$\{priceStep\.toPrecision\(8\)\}/, "canonical price grids must reconcile overlapping rows across viewport pans");
}

console.log("Consolidated Liquidity Fabric tests passed: provenance, reconstruction, full-range projection, cache discipline and read-only source contracts.");
