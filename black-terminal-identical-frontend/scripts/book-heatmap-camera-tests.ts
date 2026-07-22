import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OrderBookHeatmapModel } from "../src/chart-engine/heatmap/OrderBookHeatmapModel.ts";

const base = 1_750_000_000;
const candles = Array.from({ length: 8 }, (_, index) => ({
  time: base + index * 60,
  open: 100,
  high: 102,
  low: 98,
  close: 100,
  volume: 10
}));
const model = new OrderBookHeatmapModel();
model.setCandles(candles);
model.setSettings({ captureIntervalMs: 100 });
const originalNow = Date.now;
Date.now = () => (base + 210) * 1000 + 20;
model.ingest({
  exchange: "bybit",
  symbol: "BTCUSDT",
  time: base + 210,
  sequence: 1,
  bids: [{ price: 99, quantity: 2 }],
  asks: [{ price: 101, quantity: 3 }]
});
let cells = model.cells(0, 7, 80, 120);
assert.ok(cells.every((cell) => Math.abs(cell.xStartIndex - 3.5) < 0.001), "live depth time must map fractionally between the same candles as the chart camera");

const prepended = [
  { time: base - 120, open: 100, high: 102, low: 98, close: 100, volume: 10 },
  { time: base - 60, open: 100, high: 102, low: 98, close: 100, volume: 10 },
  ...candles
];
model.setCandles(prepended);
cells = model.cells(0, 9, 80, 120);
Date.now = originalNow;
assert.ok(cells.every((cell) => Math.abs(cell.xStartIndex - 5.5) < 0.001), "prepending history must reindex heatmap timestamps with the shared candle camera");

const fiveMinuteCandles = Array.from({ length: 5 }, (_, index) => ({
  time: base + index * 300,
  open: 100,
  high: 102,
  low: 98,
  close: 100,
  volume: 10
}));
model.setCandles(fiveMinuteCandles);
cells = model.cells(0, 4, 80, 120);
assert.ok(cells.every((cell) => Math.abs(cell.xStartIndex - 0.7) < 0.001), "timeframe change must remap the same source timestamp onto the new candle cadence");

const engineSource = readFileSync(new URL("../src/chart-engine/BlackChartEngine.ts", import.meta.url), "utf8");
assert.match(engineSource, /this\.xForIndex\(cell\.xStartIndex\)/);
assert.match(engineSource, /this\.xForIndex\(cell\.xEndIndex\)/);
assert.match(engineSource, /this\.xForIndex\(cell\.xIndex\)/);
assert.doesNotMatch(engineSource, /projectedBook|addProjectedBookCells|warmingProjection/);
assert.match(engineSource, /setSnapToLatest\(enabled: boolean\)/);
assert.match(engineSource, /this\.view\.scrollX = this\.clampHorizontalScroll/);
assert.match(engineSource, /this\.drawVolatilityHeatmap[\s\S]*this\.drawOrderBookHeatmap/);
assert.match(engineSource, /this\.drawHeatmap\(\);[\s\S]*this\.drawIndicators\(\);[\s\S]*this\.drawVolume\(\);[\s\S]*this\.drawCandles\(\)/, "heatmap must coexist beneath indicators, volume and candles without owning their geometry");

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
assert.match(appSource, /schemaVersion: 2/);
assert.match(appSource, /volume: false/);
assert.match(appSource, /orderBookHeatmap: false/);
assert.match(appSource, /migrateIndicatorAdvancedSettings/);

console.log("Book Heatmap camera/migration contract passed: fractional shared camera, prepend reindex, snap compatibility, and no forced indicators.");
