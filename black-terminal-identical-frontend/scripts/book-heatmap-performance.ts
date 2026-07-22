import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { compactBookSnapshot } from "../src/chart-engine/heatmap/bookHeatmapProcessor.ts";
import { OrderBookHeatmapModel } from "../src/chart-engine/heatmap/OrderBookHeatmapModel.ts";

const argument = process.argv.find((value) => value.startsWith("--iterations="));
const iterations = Math.max(1_000, Math.min(100_000, Number(argument?.split("=")[1]) || 12_000));
const levelsPerSide = 200;
const startedAt = Date.now();
const sourceBaseAt = startedAt - iterations * 100;
const basePrice = 103_000;
const candles = Array.from({ length: 1_500 }, (_, index) => ({
  time: Math.floor((startedAt - (1_499 - index) * 60_000) / 1000),
  open: basePrice,
  high: basePrice + 100,
  low: basePrice - 100,
  close: basePrice,
  volume: 100
}));
const model = new OrderBookHeatmapModel();
model.setCandles(candles);
model.setSettings({ maxLiveFrames: 600, captureIntervalMs: 100, staleAfterMs: 5_000 });
const initialHeap = process.memoryUsage().heapUsed;
const start = performance.now();

for (let index = 0; index < iterations; index += 1) {
  const sourceAt = sourceBaseAt + index * 100;
  const drift = (index % 40) * 0.1;
  const snapshot = {
    exchange: "bybit" as const,
    symbol: "BTCUSDT",
    time: sourceAt,
    sequence: index + 1,
    subscribedDepth: levelsPerSide,
    bids: Array.from({ length: levelsPerSide }, (_, level) => ({
      price: basePrice + drift - 0.5 - level * 0.5,
      quantity: 0.01 + ((index + level * 13) % 90) / 20
    })),
    asks: Array.from({ length: levelsPerSide }, (_, level) => ({
      price: basePrice + drift + 0.5 + level * 0.5,
      quantity: 0.01 + ((index * 3 + level * 17) % 90) / 20
    }))
  };
  const compacted = compactBookSnapshot(snapshot, sourceAt + 15);
  assert.equal(compacted.accepted, true);
  model.ingestCompacted(compacted);
}

const processingMs = performance.now() - start;
const renderStart = performance.now();
const originalNow = Date.now;
Date.now = () => sourceBaseAt + (iterations - 1) * 100 + 20;
const cells = model.cells(0, candles.length - 1, basePrice * 0.96, basePrice * 1.04);
Date.now = originalNow;
const cellBuildMs = performance.now() - renderStart;
const finalHeap = process.memoryUsage().heapUsed;
const diagnostics = model.diagnostics(sourceBaseAt + (iterations - 1) * 100 + 20);
const result = {
  iterations,
  levelsPerSide,
  processingMs: Number(processingMs.toFixed(2)),
  snapshotsPerSecond: Number((iterations / (processingMs / 1000)).toFixed(1)),
  averageProcessingMs: Number((processingMs / iterations).toFixed(4)),
  cellBuildMs: Number(cellBuildMs.toFixed(2)),
  renderedCells: cells.length,
  liveFrames: diagnostics.liveFrames,
  heapDeltaMb: Number(((finalHeap - initialHeap) / 1024 / 1024).toFixed(2))
};

assert.equal(diagnostics.liveFrames, 600, "typed live-frame ring exceeded its configured bound");
assert.ok(cells.length > 0, "bounded run produced no visible authentic cells");
assert.ok(result.averageProcessingMs < 4, `average compaction exceeded 4ms: ${result.averageProcessingMs}ms`);
assert.ok(result.cellBuildMs < 1_500, `visible-cell construction exceeded 1500ms: ${result.cellBuildMs}ms`);
assert.ok(result.heapDeltaMb < 192, `bounded run retained too much heap: ${result.heapDeltaMb}MB`);
console.log(JSON.stringify(result, null, 2));
