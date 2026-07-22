import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { OrderBookSnapshot } from "../src/market-data/types.ts";
import { compactBookSnapshot } from "../src/chart-engine/heatmap/bookHeatmapProcessor.ts";
import { OrderBookHeatmapModel } from "../src/chart-engine/heatmap/OrderBookHeatmapModel.ts";
import { normalizeBookHeatmapHistoryCells } from "../src/chart-engine/heatmap/bookHeatmapHistoryNormalization.ts";

type Fixture = {
  provenance: { venue: string; classification: string; limitation?: string };
  snapshot: Omit<OrderBookSnapshot, "bids" | "asks"> & { bids: number[][]; asks: number[][] };
};

function load(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`../tests/fixtures/book-heatmap/${name}`, import.meta.url), "utf8")) as Fixture;
}

function normalized(fixture: Fixture): OrderBookSnapshot {
  return {
    ...fixture.snapshot,
    bids: fixture.snapshot.bids.map(([price, quantity]) => ({ price, quantity })),
    asks: fixture.snapshot.asks.map(([price, quantity]) => ({ price, quantity }))
  };
}

const bybitFixture = load("bybit-btcusdt-l2.json");
const binanceFixture = load("binance-btcusdt-l2.json");
const okxFixture = load("okx-btcusdt-swap-l2.json");
for (const fixture of [bybitFixture, binanceFixture, okxFixture]) {
  assert.match(fixture.provenance.classification, /^recorded-public-l2-normalized/);
  assert.equal(fixture.provenance.venue, fixture.snapshot.exchange);
}

for (const fixture of [bybitFixture, binanceFixture]) {
  const snapshot = normalized(fixture);
  const sourceAt = snapshot.time * 1000;
  const result = compactBookSnapshot(snapshot, sourceAt + 40);
  assert.equal(result.accepted, true, `${fixture.provenance.venue} base-quantity fixture must be certified`);
  if (!result.accepted) continue;
  let compactedBidNotional = 0;
  for (let offset = 0; offset < result.buckets.length; offset += 3) compactedBidNotional += result.buckets[offset + 1];
  const expectedBidNotional = snapshot.bids.reduce((total, level) => total + level.price * level.quantity, 0);
  assert.ok(Math.abs(compactedBidNotional - expectedBidNotional) < 0.0001);

  const model = new OrderBookHeatmapModel();
  const candleTime = snapshot.time;
  model.setCandles([
    { time: candleTime - 60, open: 103200, high: 103300, low: 103100, close: 103240, volume: 10 },
    { time: candleTime, open: 103240, high: 103280, low: 103220, close: 103242, volume: 12 }
  ]);
  assert.equal(model.ingestCompacted(result).accepted, true);
  const originalNow = Date.now;
  Date.now = () => sourceAt + 40;
  const cells = model.cells(0, 1, 100000, 106000);
  Date.now = originalNow;
  assert.ok(cells.length > 0);
  assert.ok(cells.every((cell) => cell.classification === "LIVE L2"));
  assert.ok(cells.every((cell) => Object.keys(cell.venues).includes(fixture.provenance.venue)));
}

const okxResult = compactBookSnapshot(normalized(okxFixture), okxFixture.snapshot.time * 1000 + 30);
assert.equal(okxResult.accepted, false);
if (!okxResult.accepted) assert.equal(okxResult.reason, "uncertified_quantity_unit");
assert.match(okxFixture.provenance.limitation ?? "", /contract value/i);

const normalizedHistory = normalizeBookHeatmapHistoryCells([{
  time: new Date(bybitFixture.snapshot.time * 1000).toISOString(),
  price: 100,
  bucketSize: 1,
  bidSize: 2,
  askSize: 3,
  bidPeakSize: 4,
  askPeakSize: 5,
  venues: { bybit: { bidSize: 1.25, askSize: 0.75 } }
}]);
assert.equal(normalizedHistory[0].bidSize, 200);
assert.equal(normalizedHistory[0].askSize, 300);
assert.equal(normalizedHistory[0].bidPeakSize, 400);
assert.equal(normalizedHistory[0].venues?.bybit?.bidSize, 125);
assert.equal(normalizedHistory[0].venues?.bybit?.askSize, 75);

console.log("Book Heatmap fixture integration passed: recorded Bybit/Binance L2 accepted, historical sizes converted to quote notional, uncertified OKX contracts rejected.");
