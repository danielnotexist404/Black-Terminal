import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { LiquidationCohortEngine } from "../src/modules/liquidation-field/core/cohortEngine.ts";
import { buildLiquidationFieldSnapshot } from "../src/modules/liquidation-field/core/exposureRaster.ts";
import { DEFAULT_LIQUIDATION_FIELD_SETTINGS, migrateLiquidationFieldSettings } from "../src/modules/liquidation-field/core/settings.ts";
import { buildBclifDisplayProjection } from "../src/modules/liquidation-field/rendering/displayProjection.ts";
import { createThermalPalette } from "../src/modules/liquidation-field/rendering/thermalPalette.ts";
import { createLiquidationFieldFixture } from "../src/modules/liquidation-field/testing/fixtures.ts";

const fixture = createLiquidationFieldFixture();
const before = process.memoryUsage();
const modelUpdate: number[] = [];
const engine = new LiquidationCohortEngine(fixture.rules, "REGIME_ADAPTIVE");
for (let iteration = 0; iteration < 180; iteration++) {
  const frame = fixture.frames[iteration % fixture.frames.length]!;
  const started = performance.now();
  engine.processFrame(frame, fixture.events);
  modelUpdate.push(performance.now() - started);
}

const settings = migrateLiquidationFieldSettings({
  ...DEFAULT_LIQUIDATION_FIELD_SETTINGS,
  priceRows: 384,
  timeColumns: 512,
  adaptiveResolution: "BALANCED"
});
const rasterization: number[] = [];
let snapshot = buildLiquidationFieldSnapshot(fixture.frames, fixture.events, fixture.rules, settings, fixture.coverage);
for (let iteration = 0; iteration < 12; iteration++) {
  const started = performance.now();
  snapshot = buildLiquidationFieldSnapshot(fixture.frames, fixture.events, fixture.rules, settings, fixture.coverage);
  rasterization.push(performance.now() - started);
}

const currentPrice = fixture.frames.at(-1)!.markPrice;
const context = {
  chartPriceMinimum: currentPrice * 0.94,
  chartPriceMaximum: currentPrice * 1.06,
  currentPrice,
  plotWidth: 1_920,
  plotHeight: 980,
  constrainedTouchRenderer: false
};
const projection: number[] = [];
let display = buildBclifDisplayProjection(snapshot, settings, context)!;
for (let iteration = 0; iteration < 16; iteration++) {
  const started = performance.now();
  display = buildBclifDisplayProjection(snapshot, settings, context)!;
  projection.push(performance.now() - started);
}

const workerTransfer: number[] = [];
for (let iteration = 0; iteration < 40; iteration++) {
  const started = performance.now();
  structuredClone({
    header: snapshot.header,
    longExposure: snapshot.longExposure,
    shortExposure: snapshot.shortExposure,
    confidence: snapshot.confidence,
    validity: snapshot.validity
  });
  workerTransfer.push(performance.now() - started);
}

const textureUploadPreparation: number[] = [];
const palette = createThermalPalette(settings.palette);
for (let iteration = 0; iteration < 30; iteration++) {
  const started = performance.now();
  const rgba = new Uint8Array(display.intensity.length * 4);
  for (let index = 0; index < display.intensity.length; index++) {
    const paletteIndex = display.intensity[index]! * 4;
    const target = index * 4;
    rgba[target] = palette[paletteIndex]!;
    rgba[target + 1] = palette[paletteIndex + 1]!;
    rgba[target + 2] = palette[paletteIndex + 2]!;
    rgba[target + 3] = display.alpha[index]!;
  }
  textureUploadPreparation.push(performance.now() - started);
}

const after = process.memoryUsage();
const stages = {
  modelUpdate: summarize(modelUpdate),
  exposureRasterization: summarize(rasterization),
  displayProjection: summarize(projection),
  workerStructuredClone: summarize(workerTransfer),
  textureUploadPreparation: summarize(textureUploadPreparation)
};
assert.ok(stages.modelUpdate.p95Ms < 20, `model update p95 ${stages.modelUpdate.p95Ms}ms exceeded 20ms regression boundary`);
assert.ok(stages.exposureRasterization.p95Ms < 3_000, `raster p95 ${stages.exposureRasterization.p95Ms}ms exceeded 3000ms regression boundary`);
assert.ok(stages.displayProjection.p95Ms < 1_500, `projection p95 ${stages.displayProjection.p95Ms}ms exceeded 1500ms regression boundary`);
assert.ok(stages.workerStructuredClone.p95Ms < 30, `worker clone p95 ${stages.workerStructuredClone.p95Ms}ms exceeded 30ms regression boundary`);
assert.ok(stages.textureUploadPreparation.p95Ms < 50, `texture staging p95 ${stages.textureUploadPreparation.p95Ms}ms exceeded 50ms regression boundary`);

console.log(JSON.stringify({
  decision: "PASS",
  scope: "DETERMINISTIC_NODE_PIPELINE",
  modelGrid: `${snapshot.header.columns}x${snapshot.header.rows}`,
  displayGrid: `${display.columns}x${display.rows}`,
  stages,
  browserOnly: {
    actualGpuUpload: "MEASURED_BY_PLAYWRIGHT_VISUAL_CERTIFICATION",
    chartFrame: "MEASURED_BY_PLAYWRIGHT_VISUAL_CERTIFICATION",
    cameraFps: "MEASURED_BY_PLAYWRIGHT_VISUAL_CERTIFICATION"
  },
  memory: {
    heapDeltaMiB: mib(after.heapUsed - before.heapUsed),
    externalDeltaMiB: mib(after.external - before.external),
    arrayBuffersDeltaMiB: mib(after.arrayBuffers - before.arrayBuffers),
    rssDeltaMiB: mib(after.rss - before.rss)
  }
}, null, 2));

function summarize(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  const percentile = (value: number) => ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * value))]!;
  return {
    samples: ordered.length,
    p50Ms: rounded(percentile(0.5)),
    p95Ms: rounded(percentile(0.95)),
    p99Ms: rounded(percentile(0.99)),
    maximumMs: rounded(ordered.at(-1)!)
  };
}

function rounded(value: number) { return Number(value.toFixed(3)); }
function mib(value: number) { return Number((value / 1024 / 1024).toFixed(2)); }
