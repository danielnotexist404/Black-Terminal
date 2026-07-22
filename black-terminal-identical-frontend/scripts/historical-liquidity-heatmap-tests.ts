import assert from "node:assert/strict";
import { BybitBookReconstructor, BYBIT_RECONSTRUCTION_STATES } from "../server/market-depth/bybit-book-reconstructor.js";
import { buildCoverageFrameStats, buildHistoricalTopology } from "../server/book-heatmap/historical-tile-engine.js";
import { buildHistoricalLiquidityMatrix } from "../src/chart-engine/heatmap/HistoricalLiquidityMatrix.ts";

const reconstructor = new BybitBookReconstructor({ symbol: "BTCUSDT", persistCadenceMs: 1_000 });
reconstructor.connected();
assert.equal(reconstructor.diagnostics().state, BYBIT_RECONSTRUCTION_STATES.SNAPSHOT_LOADING);

const snapshot = reconstructor.ingest({
  topic: "orderbook.1000.BTCUSDT", type: "snapshot", ts: 1_000_000,
  data: { u: 100, seq: 500, b: [["100", "4"], ["99", "7"]], a: [["101", "5"], ["102", "6"]] }
}, 1_000_010);
assert.equal(snapshot.accepted, true);
assert.equal(snapshot.frame?.bids.some((level) => level.quantity === 7), true);
assert.equal(reconstructor.diagnostics().state, BYBIT_RECONSTRUCTION_STATES.LIVE);

const delta = reconstructor.ingest({
  topic: "orderbook.1000.BTCUSDT", type: "delta", ts: 1_001_100,
  data: { u: 101, seq: 501, b: [["99", "0"], ["98", "9"]], a: [["101", "8"]] }
}, 1_001_110);
assert.equal(delta.accepted, true);
assert.equal(delta.frame?.bids.some((level) => level.priceBucket === 99), false, "zero quantity must delete the level");
assert.equal(delta.frame?.asks.some((level) => level.quantity === 8), true, "delta must update the reconstructed book");

const regression = reconstructor.ingest({
  topic: "orderbook.1000.BTCUSDT", type: "delta", ts: 1_002_000,
  data: { u: 99, seq: 499, b: [["97", "2"]], a: [] }
}, 1_002_010);
assert.equal(regression.gapDetected, true);
assert.equal(reconstructor.diagnostics().state, BYBIT_RECONSTRUCTION_STATES.GAP_DETECTED);
reconstructor.resyncing();
assert.equal(reconstructor.diagnostics().state, BYBIT_RECONSTRUCTION_STATES.RESYNCING);
const recovered = reconstructor.ingest({
  topic: "orderbook.1000.BTCUSDT", type: "snapshot", ts: 1_003_000,
  data: { u: 110, seq: 520, b: [["100", "3"]], a: [["101", "4"]] }
}, 1_003_010);
assert.equal(recovered.accepted, true);
assert.equal(reconstructor.diagnostics().state, BYBIT_RECONSTRUCTION_STATES.LIVE);

const topology = buildHistoricalTopology([
  row(0, 100, 10), row(1_000, 100, 10), row(2_000, 100, 10),
  row(5_000, 101, 20), row(6_000, 101, 20),
  row(8_000, 102, 30), row(9_000, 103, 30)
], 100, 1_000);
assert.equal(topology.length, 7);
assert.equal(topology.some((cell) => Date.parse(cell.time) === 3_000), false, "missing frames must not be interpolated");
const coverage = buildCoverageFrameStats([0, 1_000, 2_000, 5_000, 6_000], "1s", 10_000);
assert.equal(coverage.availableHorizonMs, 7_000);
assert.equal(coverage.gaps.length, 1);
assert.deepEqual(coverage.gaps[0], { from: 3_000, to: 5_000 });
assert.equal(coverage.continuityPercent, 71.43);

const matrix = buildHistoricalLiquidityMatrix([
  heatmapCell(0, 3, 100, 1_000),
  heatmapCell(5, 7, 102, 2_000),
  heatmapCell(8, 9, 103, 3_000)
], 0, 9, 95, 105, { maxColumns: 10, maxRows: 10 });
assert.equal(matrix.columns, 10);
assert.equal(matrix.rows, 10);
assert.equal(matrix.observedColumns[4], 0, "a missing time column must remain transparent");
assert.equal(matrix.observedColumns[1], 1, "a persistent wall must span its actual lifetime");
assert.equal(matrix.observedColumns[6], 1, "a moved wall must begin only at its real timestamp");
assert.equal(matrix.bidIntensity.length, 100);

console.log("Historical liquidity heatmap tests passed: snapshot gating, deltas, deletion, resync, truthful gaps, topology, matrix bounds, wall lifetime and movement.");

function row(offset: number, price: number, bidSize: number) {
  const time = new Date(offset).toISOString();
  return {
    venue: "bybit", bucket_start: time, bucket_end: new Date(offset + 1_000).toISOString(),
    price_bucket: price, bucket_size: 1, bid_size: bidSize, ask_size: 0,
    bid_peak_size: bidSize, ask_peak_size: 0, observations: 1, liquidity_score: 0.5, gravity_score: 0.5
  };
}

function heatmapCell(xStartIndex: number, xEndIndex: number, price: number, notional: number) {
  return {
    xStartIndex, xEndIndex, price, priceLow: price - 0.5, priceHigh: price + 0.5,
    strength: 0.5, side: "bid" as const, notional, peakNotional: notional, observations: 1,
    firstSeenAt: xStartIndex * 1_000, lastSeenAt: xEndIndex * 1_000, persistenceMs: (xEndIndex - xStartIndex) * 1_000,
    stackingNotional: 0, pullingNotional: 0, imbalance: 1, replenishmentScore: 0, spoofRisk: 0,
    correlatedTradeNotional: 0, estimatedConsumedNotional: 0, estimatedCancelledNotional: 0,
    absorptionScore: 0, icebergProbability: 0, confidence: 1, active: false,
    analyticsBasis: "HISTORICAL DEPTH TILES" as const, classification: "HISTORICAL L2" as const,
    venues: { bybit: { bidNotional: notional, askNotional: 0 } }
  };
}
