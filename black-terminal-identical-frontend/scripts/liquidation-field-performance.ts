import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { buildLiquidationFieldSnapshot } from "../src/modules/liquidation-field/core/exposureRaster.ts";
import { DEFAULT_LIQUIDATION_FIELD_SETTINGS } from "../src/modules/liquidation-field/core/settings.ts";
import { createLiquidationFieldFixture } from "../src/modules/liquidation-field/testing/fixtures.ts";

const fixture = createLiquidationFieldFixture();
const settings = { ...DEFAULT_LIQUIDATION_FIELD_SETTINGS, timeColumns: 512, priceRows: 384 };
const samples: number[] = [];
let lastCells = 0;
const before = process.memoryUsage();
for (let iteration = 0; iteration < 25; iteration++) {
  const started = performance.now();
  const snapshot = buildLiquidationFieldSnapshot(fixture.frames, fixture.events, fixture.rules, settings, fixture.coverage);
  samples.push(performance.now() - started);
  lastCells = snapshot.header.columns * snapshot.header.rows;
}
const after = process.memoryUsage();
samples.sort((a, b) => a - b);
const percentile = (q: number) => samples[Math.min(samples.length - 1, Math.floor((samples.length - 1) * q))]!;
const p50 = percentile(0.5);
const p95 = percentile(0.95);
const p99 = percentile(0.99);
assert.ok(p95 < 1_500, `BCLIF p95 worker build exceeds interactive boundary: ${p95.toFixed(1)}ms`);
console.log(JSON.stringify({
  decision: "PASS",
  samples: samples.length,
  cells: lastCells,
  p50Ms: Number(p50.toFixed(2)),
  p95Ms: Number(p95.toFixed(2)),
  p99Ms: Number(p99.toFixed(2)),
  heapDeltaMiB: Number(((after.heapUsed - before.heapUsed) / 1024 / 1024).toFixed(2)),
  externalDeltaMiB: Number(((after.external - before.external) / 1024 / 1024).toFixed(2))
}, null, 2));
