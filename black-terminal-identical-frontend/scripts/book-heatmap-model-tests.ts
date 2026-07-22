import assert from "node:assert/strict";
import { OrderBookHeatmapModel } from "../src/chart-engine/heatmap/OrderBookHeatmapModel.ts";
import { compactBookSnapshot } from "../src/chart-engine/heatmap/bookHeatmapProcessor.ts";
import { BookHeatmapWorkerClient } from "../src/chart-engine/heatmap/bookHeatmapWorkerClient.ts";
import { classifyBinanceDepthUpdate } from "../src/market-data/orderBookIntegrity.ts";

const nowSeconds = Math.floor(Date.now() / 1000);
const candles = Array.from({ length: 120 }, (_, index) => ({
  time: nowSeconds - (119 - index) * 60,
  open: 100,
  high: 102,
  low: 98,
  close: 100,
  volume: 10
}));

const snapshot = (sequence: number, time = nowSeconds, bid = 99, ask = 101) => ({
  exchange: "bybit" as const,
  symbol: "BTCUSDT",
  time,
  sequence,
  bids: [{ price: bid, quantity: 10 }, { price: bid - 1, quantity: 3 }],
  asks: [{ price: ask, quantity: 12 }, { price: ask + 1, quantity: 2 }]
});

assert.equal(classifyBinanceDepthUpdate(
  { snapshotReady: false, lastUpdateId: 100, previousFinalUpdateId: 0 },
  { firstUpdateId: 101, finalUpdateId: 105 }
), "buffer");
assert.equal(classifyBinanceDepthUpdate(
  { snapshotReady: true, lastUpdateId: 100, previousFinalUpdateId: 0 },
  { firstUpdateId: 101, finalUpdateId: 105 }
), "apply");
assert.equal(classifyBinanceDepthUpdate(
  { snapshotReady: true, lastUpdateId: 100, previousFinalUpdateId: 0 },
  { firstUpdateId: 107, finalUpdateId: 110 }
), "resync", "initial Binance delta gap must trigger snapshot recovery");
assert.equal(classifyBinanceDepthUpdate(
  { snapshotReady: true, lastUpdateId: 105, previousFinalUpdateId: 105 },
  { firstUpdateId: 106, finalUpdateId: 110, previousFinalUpdateId: 104 }
), "resync", "Binance futures pu continuity loss must trigger snapshot recovery");
assert.equal(classifyBinanceDepthUpdate(
  { snapshotReady: true, lastUpdateId: 105, previousFinalUpdateId: 105 },
  { firstUpdateId: 90, finalUpdateId: 99, previousFinalUpdateId: 89 }
), "ignore");

const integrity = new OrderBookHeatmapModel();
integrity.setCandles(candles);
integrity.setSettings({ captureIntervalMs: 100, maxLiveFrames: 60 });
assert.equal(integrity.ingest(snapshot(10)).accepted, true);
assert.equal(integrity.ingest(snapshot(10)).reason, "duplicate_sequence");
assert.equal(integrity.ingest(snapshot(9)).reason, "sequence_regression");
assert.equal(integrity.ingest(snapshot(11, nowSeconds, 102, 101)).reason, "crossed_book");
const integrityDiagnostics = integrity.diagnostics();
assert.equal(integrityDiagnostics.acceptedSnapshots, 1);
assert.equal(integrityDiagnostics.duplicateSequences, 1);
assert.equal(integrityDiagnostics.sequenceRegressions, 1);
assert.equal(integrityDiagnostics.crossedBooks, 1);

const invalidLevels = new OrderBookHeatmapModel();
invalidLevels.setCandles(candles);
assert.equal(invalidLevels.ingest({
  ...snapshot(1),
  bids: [{ price: 99, quantity: 2 }, { price: 99, quantity: 3 }]
}).reason, "duplicate_level");
assert.equal(invalidLevels.diagnostics().duplicateLevels, 1);
assert.equal(invalidLevels.ingest({
  ...snapshot(2),
  exchange: "okx" as const
}).reason, "uncertified_quantity_unit");
assert.match(invalidLevels.diagnostics().message, /not certified/i);

const timing = new OrderBookHeatmapModel();
timing.setCandles(candles);
timing.setSettings({ staleAfterMs: 5_000, captureIntervalMs: 100 });
const timingNow = Date.now;
Date.now = () => nowSeconds * 1000;
assert.equal(timing.ingest(snapshot(1, nowSeconds)).accepted, true);
Date.now = () => nowSeconds * 1000 + 100;
assert.equal(timing.ingest(snapshot(2, nowSeconds - 1)).reason, "timestamp_regression");
const stale = new OrderBookHeatmapModel();
stale.setCandles(candles);
stale.setSettings({ staleAfterMs: 5_000 });
assert.equal(stale.ingest(snapshot(1, nowSeconds - 10)).reason, "stale_snapshot");
Date.now = timingNow;
assert.equal(timing.diagnostics().timestampRegressions, 1);
assert.equal(stale.diagnostics().staleSnapshots, 1);

const consolidated = new OrderBookHeatmapModel();
consolidated.setCandles(candles);
consolidated.setSettings({ captureIntervalMs: 100, consolidated: true });
const consolidatedNow = Date.now;
Date.now = () => nowSeconds * 1000;
consolidated.ingest(snapshot(100, nowSeconds));
consolidated.ingest({ ...snapshot(1_000, nowSeconds), exchange: "binance" as const });
Date.now = () => nowSeconds * 1000 + 150;
consolidated.ingest({ ...snapshot(101, nowSeconds), bids: [{ price: 99, quantity: 11 }], asks: [{ price: 101, quantity: 13 }] });
consolidated.ingest({ ...snapshot(1_001, nowSeconds), exchange: "binance" as const, bids: [{ price: 99, quantity: 7 }], asks: [{ price: 101, quantity: 8 }] });
const consolidatedCells = consolidated.cells(0, 119, 80, 120);
Date.now = consolidatedNow;
assert.equal(consolidated.diagnostics(nowSeconds * 1000 + 150).liveFrames, 4);
assert.equal(Object.keys(consolidated.diagnostics(nowSeconds * 1000 + 150).venues).length, 2);
assert.ok(consolidatedCells.some((cell) => cell.venues.bybit && cell.venues.binance), "equivalent venue buckets must consolidate without losing contributions");

const model = new OrderBookHeatmapModel();
model.setCandles(candles);
model.setSettings({ captureIntervalMs: 100, maxLiveFrames: 60, scaleMode: "adaptive" });
assert.equal(model.ingest(snapshot(1, nowSeconds - 1)).accepted, true);
const liveCells = model.cells(0, 119, 80, 120);
assert.ok(liveCells.length >= 2, "valid live L2 bid/ask buckets should render");
assert.ok(liveCells.some((cell) => cell.side === "bid"));
assert.ok(liveCells.some((cell) => cell.side === "ask"));
assert.ok(liveCells.every((cell) => cell.classification === "LIVE L2"));
assert.ok(liveCells.every((cell) => cell.xStartIndex >= 118), "live data must not be projected backward");
assert.ok(liveCells.every((cell) => cell.notional > 0 && cell.strength > 0 && cell.strength <= 1));

const analytics = new OrderBookHeatmapModel();
analytics.setCandles(candles);
analytics.setSettings({ captureIntervalMs: 100 });
const realNow = Date.now;
Date.now = () => nowSeconds * 1000;
analytics.ingest(snapshot(1, nowSeconds));
analytics.ingestTrade(99, 5, nowSeconds, "sell");
Date.now = () => nowSeconds * 1000 + 150;
analytics.ingest({
  ...snapshot(2, nowSeconds),
  bids: [{ price: 99, quantity: 2 }],
  asks: [{ price: 101, quantity: 18 }]
});
Date.now = realNow;
const analyticCells = analytics.cells(0, 119, 80, 120);
assert.ok(analyticCells.some((cell) => cell.side === "ask" && cell.stackingNotional > 0));
assert.ok(analyticCells.some((cell) => cell.side === "bid" && cell.pullingNotional > 0));
assert.ok(analyticCells.some((cell) => cell.observations >= 2 && cell.persistenceMs >= 0));
assert.ok(analyticCells.every((cell) => cell.imbalance >= -1 && cell.imbalance <= 1));
assert.ok(analyticCells.some((cell) => cell.side === "bid" && cell.correlatedTradeNotional > 0));
assert.ok(analyticCells.some((cell) => cell.estimatedConsumedNotional > 0));
assert.ok(analyticCells.some((cell) => cell.estimatedCancelledNotional > 0));
assert.ok(analyticCells.every((cell) => cell.confidence >= 0 && cell.confidence <= 1));

model.replaceHistoricalCells([
  {
    time: (nowSeconds - 3600) * 1000,
    bucketEnd: (nowSeconds - 3540) * 1000,
    price: 90,
    bucketSize: 1,
    bidSize: 50_000,
    askSize: 0,
    observations: 12,
    venues: { bybit: { bidSize: 50_000 } }
  },
  {
    time: (nowSeconds - 1800) * 1000,
    bucketEnd: (nowSeconds - 1740) * 1000,
    price: 110,
    bucketSize: 1,
    bidSize: 0,
    askSize: 75_000,
    observations: 9,
    venues: { binance: { askSize: 75_000 } }
  },
  { time: "invalid", price: 95, bucketSize: 1, bidSize: 100, askSize: 0 }
]);
const historical = model.cells(0, 119, 80, 120).filter((cell) => cell.classification === "HISTORICAL L2");
assert.equal(historical.length, 2);
assert.ok(historical.some((cell) => cell.venues.bybit?.bidNotional === 50_000));
assert.ok(historical.some((cell) => cell.venues.binance?.askNotional === 75_000));
assert.equal(model.diagnostics().historicalCells, 2);

const bounded = new OrderBookHeatmapModel();
bounded.setCandles(candles);
bounded.setSettings({ captureIntervalMs: 100, maxLiveFrames: 60 });
for (let index = 0; index < 90; index += 1) {
  const originalNow = Date.now;
  Date.now = () => (nowSeconds * 1000) + index * 101;
  bounded.ingest(snapshot(index + 1, nowSeconds + index));
  Date.now = originalNow;
}
assert.equal(bounded.diagnostics().liveFrames, 60, "live frame ring must remain bounded");

const compacted = compactBookSnapshot(snapshot(200, nowSeconds), nowSeconds * 1000);
assert.equal(compacted.accepted, true);
if (compacted.accepted) {
  assert.ok(compacted.buckets instanceof Float64Array);
  let bidNotional = 0;
  for (let offset = 0; offset < compacted.buckets.length; offset += 3) bidNotional += compacted.buckets[offset + 1];
  assert.equal(bidNotional, 99 * 10 + 98 * 3, "base quantity must convert to quote notional");
}

const processedSequences: Array<number | undefined> = [];
let workerDrops = 0;
const workerClient = new BookHeatmapWorkerClient(
  (result) => processedSequences.push(result.sequence),
  (count) => { workerDrops += count; }
);
workerClient.submit(snapshot(301, nowSeconds));
workerClient.submit(snapshot(302, nowSeconds));
workerClient.submit(snapshot(303, nowSeconds));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(processedSequences, [301, 303], "latest-wins worker must replace superseded queued work");
assert.equal(workerDrops, 1);
assert.equal(workerClient.getStats().dropped, 1);
workerClient.dispose();
workerClient.submit(snapshot(304, nowSeconds));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(processedSequences, [301, 303], "disposed worker must reject new work and release its queue");

const fairSequences: Array<number | undefined> = [];
const fairWorker = new BookHeatmapWorkerClient((result) => fairSequences.push(result.sequence));
fairWorker.submit(snapshot(401, nowSeconds));
fairWorker.submit(snapshot(402, nowSeconds));
fairWorker.submit({ ...snapshot(1_401, nowSeconds), exchange: "binance" as const });
fairWorker.submit(snapshot(403, nowSeconds));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(fairSequences, [401, 403, 1_401], "per-venue latest-wins queue must retain a fair slot for each venue");
fairWorker.dispose();

const scaleModel = new OrderBookHeatmapModel();
scaleModel.setCandles(candles);
scaleModel.replaceHistoricalCells([
  { time: nowSeconds * 1000, price: 90, bucketSize: 1, bidSize: 1_000, askSize: 0 },
  { time: nowSeconds * 1000, price: 95, bucketSize: 1, bidSize: 10_000, askSize: 0 },
  { time: nowSeconds * 1000, price: 105, bucketSize: 1, bidSize: 0, askSize: 100_000 },
  { time: nowSeconds * 1000, price: 110, bucketSize: 1, bidSize: 0, askSize: 100_000_000 }
]);
let adaptiveWeak = 0;
let linearWeak = 0;
for (const mode of ["adaptive", "percentile", "logarithmic", "linear"] as const) {
  scaleModel.setSettings({ scaleMode: mode, percentile: 0.75 });
  const cells = scaleModel.cells(0, candles.length - 1, 80, 120);
  assert.equal(cells.length, 4);
  assert.ok(cells.every((cell) => cell.strength > 0 && cell.strength <= 1), `${mode} normalization must remain bounded`);
  const weak = cells.find((cell) => cell.price === 90)?.strength ?? 0;
  if (mode === "adaptive") adaptiveWeak = weak;
  if (mode === "linear") linearWeak = weak;
}
assert.ok(adaptiveWeak > linearWeak, "robust adaptive scaling must preserve weak structure better than outlier-dominated linear scaling");

const symbolReset = new OrderBookHeatmapModel();
symbolReset.setCandles(candles);
symbolReset.setSettings({ captureIntervalMs: 100 });
const symbolNow = Date.now;
Date.now = () => nowSeconds * 1000;
symbolReset.ingest(snapshot(1, nowSeconds));
symbolReset.replaceHistoricalCells([{ time: nowSeconds * 1000, price: 99, bucketSize: 1, bidSize: 100, askSize: 0 }]);
symbolReset.ingest({ ...snapshot(1, nowSeconds), symbol: "ETHUSDT", bids: [{ price: 99, quantity: 1 }], asks: [{ price: 101, quantity: 1 }] });
Date.now = symbolNow;
assert.equal(symbolReset.diagnostics(nowSeconds * 1000).symbol, "ETHUSDT");
assert.equal(symbolReset.diagnostics(nowSeconds * 1000).liveFrames, 1, "symbol change must clear the prior live ring");
assert.equal(symbolReset.diagnostics(nowSeconds * 1000).historicalCells, 0, "symbol change must clear prior-market history");

console.log("Book Heatmap tests passed: reconstruction, provenance, integrity, staleness, scaling, symbol reset, no projection, worker cleanup/backpressure, history, and bounds.");
