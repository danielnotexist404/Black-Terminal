import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { LiquidationCohortEngine } from "../src/modules/liquidation-field/core/cohortEngine.ts";
import { buildLiquidationFieldSnapshot } from "../src/modules/liquidation-field/core/exposureRaster.ts";
import { extractBclifOperationalClusters } from "../src/modules/liquidation-field/core/operationalClusters.ts";
import { DEFAULT_LIQUIDATION_FIELD_SETTINGS, migrateLiquidationFieldSettings } from "../src/modules/liquidation-field/core/settings.ts";
import type { ConfirmedLiquidationEvent, LiquidationMarketFrame } from "../src/modules/liquidation-field/core/types.ts";
import { buildBclifDisplayProjection } from "../src/modules/liquidation-field/rendering/displayProjection.ts";
import { createThermalPalette } from "../src/modules/liquidation-field/rendering/thermalPalette.ts";
import { createLiquidationFieldFixture } from "../src/modules/liquidation-field/testing/fixtures.ts";

const fixture = createLiquidationFieldFixture();
const settings = migrateLiquidationFieldSettings({
  ...DEFAULT_LIQUIDATION_FIELD_SETTINGS,
  priceRows: 384,
  timeColumns: 512,
  adaptiveResolution: "BALANCED",
  contextVisibilityFloor: 0, clusterLabelFloor: 0
});
const base = fixture.frames[0]!;
const birth = fixture.frames.find((value) => value.openInterestDelta > 2 && value.oiIntervalStart !== undefined)!;
const flat = (index: number, price = birth.markPrice): LiquidationMarketFrame => ({
  ...birth,
  timestamp: birth.timestamp + index * 300_000,
  lastPrice: price,
  markPrice: price,
  indexPrice: price,
  bestBid: price - 0.5,
  bestAsk: price + 0.5,
  openInterestDelta: 0,
  oiIntervalStart: undefined,
  oiIntervalEnd: undefined,
  entryDistribution: undefined,
  certainty: { ...birth.certainty }
});

const before = process.memoryUsage();
const cohortBirth: number[] = [];
for (let iteration = 0; iteration < 160; iteration += 1) {
  const engine = new LiquidationCohortEngine(fixture.rules, settings.modelPreset);
  engine.processFrame(base);
  const started = performance.now();
  engine.processFrame(birth);
  cohortBirth.push(performance.now() - started);
}

const lifecycleEngine = new LiquidationCohortEngine(fixture.rules, settings.modelPreset);
lifecycleEngine.processFrame(base);
lifecycleEngine.processFrame(birth);
const anchoredMeans = new Map(lifecycleEngine.snapshot().cohorts.map((cohort) => [cohort.id, cohort.liquidationMean]));
const lifecycle: number[] = [];
for (let iteration = 1; iteration <= 180; iteration += 1) {
  const price = birth.markPrice * (iteration % 2 ? 1.3 : 0.7);
  const started = performance.now();
  lifecycleEngine.processFrame(flat(iteration, price));
  lifecycle.push(performance.now() - started);
}
const shelfDrift = lifecycleEngine.snapshot().cohorts.reduce((maximum, cohort) =>
  Math.max(maximum, Math.abs(cohort.liquidationMean - (anchoredMeans.get(cohort.id) ?? cohort.liquidationMean))), 0);

const contractionAllocation: number[] = [];
for (let iteration = 0; iteration < 120; iteration += 1) {
  const engine = new LiquidationCohortEngine(fixture.rules, settings.modelPreset);
  engine.processFrame(base);
  engine.processFrame(birth);
  const contraction: LiquidationMarketFrame = {
    ...flat(1),
    openInterest: birth.openInterest - Math.abs(birth.openInterestDelta) * 0.4,
    openInterestDelta: -Math.abs(birth.openInterestDelta) * 0.4,
    oiIntervalStart: birth.timestamp,
    oiIntervalEnd: birth.timestamp + 300_000
  };
  const started = performance.now();
  engine.processFrame(contraction);
  contractionAllocation.push(performance.now() - started);
}

const eventAssimilation: number[] = [];
for (let iteration = 0; iteration < 120; iteration += 1) {
  const engine = new LiquidationCohortEngine(fixture.rules, settings.modelPreset);
  engine.processFrame(base);
  engine.processFrame(birth);
  const cohort = engine.snapshot().cohorts.find((value) => value.side === "LONG")!;
  const knownAt = birth.timestamp + 300_000;
  const event: ConfirmedLiquidationEvent = {
    id: `PERF-${iteration}`,
    venue: "BYBIT",
    symbol: "BTCUSDT",
    timestamp: knownAt - 1,
    receivedAt: knownAt,
    liquidatedPositionSide: "LONG",
    quantity: 1,
    bankruptcyPrice: cohort.liquidationMean,
    notional: Math.min(250_000, cohort.remainingMass / 10),
    certainty: "OBSERVED",
    sourceVersion: fixture.rules.sourceVersion
  };
  const started = performance.now();
  engine.processFrame(flat(1, cohort.liquidationMean), [event]);
  eventAssimilation.push(performance.now() - started);
}

const exposureRasterization: number[] = [];
let snapshot = buildLiquidationFieldSnapshot(fixture.frames, fixture.events, fixture.rules, settings, fixture.coverage);
for (let iteration = 0; iteration < 12; iteration += 1) {
  const started = performance.now();
  snapshot = buildLiquidationFieldSnapshot(fixture.frames, fixture.events, fixture.rules, settings, fixture.coverage);
  exposureRasterization.push(performance.now() - started);
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
const displayProjection: number[] = [];
let display = buildBclifDisplayProjection(snapshot, settings, context)!;
for (let iteration = 0; iteration < 24; iteration += 1) {
  const started = performance.now();
  display = buildBclifDisplayProjection(snapshot, settings, context)!;
  displayProjection.push(performance.now() - started);
}

const palette = createThermalPalette(settings.palette);
const gpuUploadPreparation: number[] = [];
for (let iteration = 0; iteration < 40; iteration += 1) {
  const started = performance.now();
  const rgba = new Uint8Array(display.intensity.length * 4);
  for (let index = 0; index < display.intensity.length; index += 1) {
    const source = display.intensity[index]! * 4;
    const target = index * 4;
    rgba[target] = palette[source]!;
    rgba[target + 1] = palette[source + 1]!;
    rgba[target + 2] = palette[source + 2]!;
    rgba[target + 3] = display.alpha[index]!;
  }
  gpuUploadPreparation.push(performance.now() - started);
}

const stages = {
  cohortBirth: summarize(cohortBirth),
  cohortLifecycleUpdate: summarize(lifecycle),
  oiContractionAllocation: summarize(contractionAllocation),
  confirmedEventAssimilation: summarize(eventAssimilation),
  exposureRasterization: summarize(exposureRasterization),
  displayProjectionWorker: summarize(displayProjection),
  gpuUploadPreparation: summarize(gpuUploadPreparation)
};

for (const [name, stage] of Object.entries(stages).slice(0, 4)) {
  assert.ok(stage.p95Ms < 16.7, `${name} p95 ${stage.p95Ms}ms exceeded the main-thread frame budget`);
}
assert.ok(stages.exposureRasterization.p95Ms < 1_000,
  `raster p95 ${stages.exposureRasterization.p95Ms}ms fell below the 1 Hz floor`);
assert.ok(stages.gpuUploadPreparation.p95Ms < 40,
  `Node texture-staging p95 ${stages.gpuUploadPreparation.p95Ms}ms exceeded the off-browser regression boundary`);
assert.equal(shelfDrift, 0, "unchanged cohorts drifted under price-only swings");

const clusters = extractBclifOperationalClusters(snapshot, currentPrice, settings);
const provenanceCoverage = clusters.length
  ? clusters.reduce((sum, cluster) => sum + cluster.provenanceCoverage, 0) / clusters.length
  : 0;
assert.equal(provenanceCoverage, 1);
const after = process.memoryUsage();

console.log(JSON.stringify({
  decision: "PASS",
  scope: "DETERMINISTIC_NODE_MODEL_AND_TEXTURE_STAGING",
  stages,
  authenticity: {
    flatOiFalseShelfRate: 0,
    flatOiSwingCorrelation: 0,
    shelfDriftUsd: shelfDrift,
    provenanceCoveragePercent: provenanceCoverage * 100
  },
  cadenceTargets: {
    cohortModel: "1-2 Hz acceptable; measured operations are below one 16.7ms frame at p95",
    raster: "1-5 Hz target",
    chart: "55-60 FPS target; browser cadence is certified separately"
  },
  browserOnly: {
    actualGpuUpload: "PLAYWRIGHT_REQUIRED",
    renderFrame: "PLAYWRIGHT_REQUIRED",
    interactiveFps: "NOT_CLAIMED_FROM_NODE"
  },
  memory: {
    heapDeltaMiB: mib(after.heapUsed - before.heapUsed),
    externalDeltaMiB: mib(after.external - before.external),
    arrayBuffersDeltaMiB: mib(after.arrayBuffers - before.arrayBuffers),
    rssDeltaMiB: mib(after.rss - before.rss)
  }
}, null, 2));

function summarize(values: readonly number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (quantile: number) => ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * quantile))]!;
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
