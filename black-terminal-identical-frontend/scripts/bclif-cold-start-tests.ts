import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildLiquidationFieldSnapshot } from "../src/modules/liquidation-field/core/exposureRaster.ts";
import {
  DEFAULT_LIQUIDATION_FIELD_SETTINGS,
  migrateLiquidationFieldSettings
} from "../src/modules/liquidation-field/core/settings.ts";
import { extractBclifOperationalClusters } from "../src/modules/liquidation-field/core/operationalClusters.ts";
import {
  bclifExposureHash,
  bclifModelHash,
  buildBclifDisplayProjection
} from "../src/modules/liquidation-field/rendering/displayProjection.ts";
import { validateBclifProjection } from "../src/modules/liquidation-field/rendering/BlackCoreLiquidationFieldRenderer.ts";
import {
  applyBclifVisualCase,
  createLiquidationFieldFixture
} from "../src/modules/liquidation-field/testing/fixtures.ts";
import { InMemoryBclifSnapshotStore } from "../src/modules/liquidation-field/data/BclifSnapshotStore.ts";
import {
  BCLIF_BROWSER_CHECKPOINT_MAX_AGE_MS,
  BclifBrowserCheckpointStore,
  type BclifBrowserCheckpointAdapter,
  type BclifBrowserCheckpointRecord
} from "../src/modules/liquidation-field/data/BclifBrowserCheckpoint.ts";
import { BclifSingleFlightBuildGate } from "../src/modules/liquidation-field/data/BrowserLiquidationFieldFallback.ts";

const fixture = createLiquidationFieldFixture();
const settings = migrateLiquidationFieldSettings(DEFAULT_LIQUIDATION_FIELD_SETTINGS);
const base = buildLiquidationFieldSnapshot(
  fixture.frames,
  fixture.events,
  fixture.rules,
  settings,
  fixture.coverage
);
const snapshot = applyBclifVisualCase(base, "BROWSER_FALLBACK");
const currentPrice = fixture.frames.at(-1)!.markPrice;
const context = {
  chartPriceMinimum: currentPrice * 0.82,
  chartPriceMaximum: currentPrice * 1.18,
  currentPrice,
  plotWidth: 1920,
  plotHeight: 1080,
  constrainedTouchRenderer: false
};

const projection = buildBclifDisplayProjection(snapshot, settings, context);
validateBclifProjection(projection);
const projectionSamples = Array.from({ length: 20 }, () => {
  const started = performance.now();
  validateBclifProjection(buildBclifDisplayProjection(snapshot, settings, context));
  return performance.now() - started;
});
assert.ok(projection.rawNonZeroCells > 0, "fixture must contain raw exposure");
assert.ok(projection.visibleCells > 0, "50% browser fallback must retain faint OI context");
assert.ok(projection.maximumAlpha > 0, "visible context must produce non-zero alpha");
assert.equal(projection.yellowEligibleCells, 0, "50% browser fallback must never receive yellow authority");
assert.equal(DEFAULT_LIQUIDATION_FIELD_SETTINGS.contextVisibilityFloor, 25);
assert.equal(DEFAULT_LIQUIDATION_FIELD_SETTINGS.clusterLabelFloor, 60);
assert.equal(DEFAULT_LIQUIDATION_FIELD_SETTINGS.highAuthorityColorFloor, 75);
assert.equal(DEFAULT_LIQUIDATION_FIELD_SETTINGS.strictHideBelowEnabled, false);
assert.equal(DEFAULT_LIQUIDATION_FIELD_SETTINGS.diagnosticsVisible, false);
assert.equal(DEFAULT_LIQUIDATION_FIELD_SETTINGS.operationalSummaryVisible, false);

const overlaySource = readFileSync(new URL("../src/modules/liquidation-field/components/LiquidationFieldOverlays.tsx", import.meta.url), "utf8");
assert.match(overlaySource, /BCLIF — FILTERED, 0 CELLS VISIBLE/);
assert.match(overlaySource, /SHOW OI CONTEXT/);
assert.match(overlaySource, /BCLIF UNAVAILABLE/);
const fallbackSource = readFileSync(new URL("../src/modules/liquidation-field/data/BrowserLiquidationFieldFallback.ts", import.meta.url), "utf8");
assert.doesNotMatch(fallbackSource, /buildGeneration/);
assert.match(fallbackSource, /buildGate\.run/);
assert.match(fallbackSource, /if \(this\.rebuildTimer !== null\) return/);
const engineSource = readFileSync(new URL("../src/chart-engine/BlackChartEngine.ts", import.meta.url), "utf8");
assert.match(engineSource, /webglcontextlost/);
assert.match(engineSource, /webglcontextrestored/);

const strictSettings = migrateLiquidationFieldSettings({
  ...settings,
  strictHideBelowEnabled: true,
  strictHideBelowConfidence: 60
});
const strictProjection = buildBclifDisplayProjection(snapshot, strictSettings, context);
assert.ok(strictProjection.rawNonZeroCells > 0);
assert.equal(strictProjection.visibleCells, 0);
assert.equal(strictProjection.filteredCells, strictProjection.rawNonZeroCells);
assert.equal(extractBclifOperationalClusters(snapshot, currentPrice, settings).length, 0);

const legacy = migrateLiquidationFieldSettings({
  schemaVersion: 3,
  minimumConfidence: 68,
  opacity: 0,
  diagnosticsVisible: true,
  operationalSummaryVisible: true
} as never);
assert.equal(legacy.contextVisibilityFloor, 25);
assert.equal(legacy.clusterLabelFloor, 68);
assert.equal(legacy.highAuthorityColorFloor, 75);
assert.equal(legacy.opacity, 10);
assert.equal(legacy.diagnosticsVisible, false);
assert.equal(legacy.operationalSummaryVisible, false);

const before = new InMemoryBclifSnapshotStore();
let orderA = "NONE";
before.subscribe((value) => { orderA = bclifExposureHash(value); });
before.publish(snapshot);
const after = new InMemoryBclifSnapshotStore();
after.publish(snapshot);
let orderB = "NONE";
after.subscribe((value) => { orderB = bclifExposureHash(value); });
assert.equal(orderA, orderB, "model-first and renderer-first orders must replay identical exposure");
assert.equal(after.getLatestSnapshot()?.generations?.modelGeneration, 1);
const replaySamples = Array.from({ length: 100 }, () => {
  const store = new InMemoryBclifSnapshotStore();
  store.publish(snapshot);
  const started = performance.now();
  store.subscribe(() => undefined)();
  return performance.now() - started;
});

const buildGate = new BclifSingleFlightBuildGate();
let buildInvocations = 0;
let concurrentBuilds = 0;
let maximumConcurrentBuilds = 0;
let releaseFirstBuild!: () => void;
const firstBuildBlocker = new Promise<void>((resolve) => { releaseFirstBuild = resolve; });
const publishedBuilds: number[] = [];
const buildTask = async () => {
  const invocation = ++buildInvocations;
  concurrentBuilds += 1;
  maximumConcurrentBuilds = Math.max(maximumConcurrentBuilds, concurrentBuilds);
  if (invocation === 1) await firstBuildBlocker;
  publishedBuilds.push(invocation);
  concurrentBuilds -= 1;
};
const firstBuild = buildGate.run(buildTask);
for (let update = 0; update < 1_000; update += 1) void buildGate.run(buildTask);
releaseFirstBuild();
await firstBuild;
assert.equal(maximumConcurrentBuilds, 1, "live updates must never overlap expensive raster builds");
assert.equal(buildInvocations, 2, "one thousand live updates must coalesce into one follow-up build");
assert.deepEqual(publishedBuilds, [1, 2], "the first valid snapshot must publish before the coalesced refresh");

class MemoryCheckpointAdapter implements BclifBrowserCheckpointAdapter {
  readonly records = new Map<string, BclifBrowserCheckpointRecord>();
  async get(key: string) { return this.records.get(key) ?? null; }
  async list() { return [...this.records.values()]; }
  async put(record: BclifBrowserCheckpointRecord) { this.records.set(record.key, record); }
  async delete(key: string) { this.records.delete(key); }
}

const adapter = new MemoryCheckpointAdapter();
let now = snapshot.generatedAt + 1_000;
const checkpoints = new BclifBrowserCheckpointStore(adapter, () => now);
assert.equal(await checkpoints.save("BTCUSDT", settings, snapshot), true);
const restored = await checkpoints.restore("BTCUSDT", settings);
assert.equal(bclifExposureHash(restored!), bclifExposureHash(snapshot));
const checkpointSamples: number[] = [];
for (let index = 0; index < 50; index += 1) {
  const started = performance.now();
  await checkpoints.restore("BTCUSDT", settings);
  checkpointSamples.push(performance.now() - started);
}
const record = [...adapter.records.values()][0]!;
record.checksum = "corrupt";
assert.equal(await checkpoints.restore("BTCUSDT", settings), null);
assert.equal(adapter.records.size, 0);
assert.equal(await checkpoints.save("BTCUSDT", settings, snapshot), true);
const malformed = [...adapter.records.values()][0]!;
(malformed as unknown as { snapshot: null }).snapshot = null;
assert.equal(await checkpoints.restore("BTCUSDT", settings), null);
assert.equal(adapter.records.size, 0);
assert.equal(await checkpoints.save("BTCUSDT", settings, snapshot), true);
now += BCLIF_BROWSER_CHECKPOINT_MAX_AGE_MS + 1;
assert.equal(await checkpoints.restore("BTCUSDT", settings), null);

assert.equal(bclifModelHash(snapshot), bclifModelHash(base), "authority/UI recovery must not mutate model geometry");
assert.equal(bclifExposureHash(snapshot), bclifExposureHash(base), "authority/UI recovery must not mutate exposure");
console.log(JSON.stringify({
  decision: "PASS",
  fixture: "BCLIF_COLD_START_BROWSER_FALLBACK_50",
  rawCells: projection.intensity.length,
  rawNonZeroCells: projection.rawNonZeroCells,
  visibleCellsAfterCorrection: projection.visibleCells,
  filteredCells: projection.filteredCells,
  minimumAlpha: projection.minimumVisibleAlpha,
  maximumAlpha: projection.maximumAlpha,
  yellowEligibleCells: projection.yellowEligibleCells,
  singleFlightBuildGate: { buildInvocations, maximumConcurrentBuilds, publishedBuilds },
  performance: {
    projectionKernel: summarize(projectionSamples),
    snapshotReplay: summarize(replaySamples),
    inMemoryCheckpointAdapterRestore: summarize(checkpointSamples),
    measurementBoundary: "NODE_KERNEL_AND_IN_MEMORY_ADAPTER_ONLY; GPU_UPLOAD_AND_FIRST_FRAME_REQUIRE_BROWSER_CERTIFICATION"
  }
}, null, 2));

function summarize(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  const at = (q: number) => ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * q))];
  return {
    samples: ordered.length,
    p50Ms: Number(at(0.5).toFixed(3)),
    p95Ms: Number(at(0.95).toFixed(3)),
    p99Ms: Number(at(0.99).toFixed(3))
  };
}
