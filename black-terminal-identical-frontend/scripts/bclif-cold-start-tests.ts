import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildLiquidationFieldSnapshot } from "../src/modules/liquidation-field/core/exposureRaster.ts";
import {
  applyBclifPresentationPreset,
  DEFAULT_LIQUIDATION_FIELD_SETTINGS,
  migrateLiquidationFieldSettings
} from "../src/modules/liquidation-field/core/settings.ts";
import { extractBclifOperationalClusters } from "../src/modules/liquidation-field/core/operationalClusters.ts";
import {
  bclifExposureHash,
  bclifModelHash,
  buildBclifDisplayProjection,
  applyBclifCausalShelfPersistence
} from "../src/modules/liquidation-field/rendering/displayProjection.ts";
import { BclifLatestProjectionQueue, validateBclifProjection } from "../src/modules/liquidation-field/rendering/BlackCoreLiquidationFieldRenderer.ts";
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

const controllerSource = readFileSync(new URL("../src/modules/liquidation-field/data/LiquidationFieldController.ts", import.meta.url), "utf8");
assert.match(controllerSource, /isBclifLiveBrowserFallbackProbeEnabled\(\)/);
assert.match(controllerSource, /resolved\.hostname === "localhost"[\s\S]*resolved\.hostname === "127\.0\.0\.1"[\s\S]*resolved\.hostname === "::1"/);
assert.match(controllerSource, /get\("bclifLiveProbe"\) === "1"/);

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

const causalRows = 128;
const causalIntensity = new Uint8Array(causalRows * 5);
const causalAlpha = new Uint8Array(causalRows * 5);
for (let column = 0; column < 5; column += 1) {
  causalIntensity[column * causalRows + 20] = column === 0 ? 214 : 18;
  causalAlpha[column * causalRows + 20] = column === 2 ? 0 : 255;
}
causalIntensity[4 * causalRows + 100] = 255;
causalAlpha[4 * causalRows + 100] = 255;
applyBclifCausalShelfPersistence(causalIntensity, causalAlpha, causalRows, 5, 0.999, 196, 18);
assert.ok(causalIntensity[1 * causalRows + 20]! > 18, "a strong shelf must retain color while residual mass remains");
assert.equal(causalIntensity[3 * causalRows + 20], 18, "zero remaining mass must reset shelf persistence immediately");
assert.equal(causalIntensity[0 * causalRows + 100], 0, "a future shelf must never repaint a historical prefix");
assert.ok(causalIntensity[1 * causalRows + 30]! > 0, "retained shelves must keep a continuous thermal shoulder");

const projection = buildBclifDisplayProjection(snapshot, settings, context);
validateBclifProjection(projection);
const wideProjection = buildBclifDisplayProjection(snapshot, settings, {
  ...context,
  chartPriceMinimum: currentPrice * 0.45,
  chartPriceMaximum: currentPrice * 1.65
});
assert.ok(wideProjection, "the screenshot-scale chart domain must intersect the absolute model grid");
validateBclifProjection(wideProjection!);
assert.ok(wideProjection!.rawNonZeroCells > 0, "wide 4H domains must retain modeled exposure behind their shelf labels");
assert.ok(wideProjection!.visibleCells > 0, "wide 4H domains must publish a visible thermal raster, not labels alone");
const projectionSamples = Array.from({ length: 20 }, () => {
  const started = performance.now();
  validateBclifProjection(buildBclifDisplayProjection(snapshot, settings, context));
  return performance.now() - started;
});
assert.ok(projection.rawNonZeroCells > 0, "fixture must contain raw exposure");
assert.ok(projection.visibleCells > 0, "50% browser fallback must retain faint OI context");
assert.ok(projection.maximumAlpha > 0, "visible context must produce non-zero alpha");
assert.equal(projection.yellowEligibleCells, 0, "50% browser fallback must never receive yellow authority");
assert.equal(DEFAULT_LIQUIDATION_FIELD_SETTINGS.contextVisibilityFloor, 0);
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
const rendererSource = readFileSync(new URL("../src/modules/liquidation-field/rendering/BlackCoreLiquidationFieldRenderer.ts", import.meta.url), "utf8");
assert.doesNotMatch(
  rendererSource,
  /sprite\.visible\s*=\s*!settings\.rawCohortShelvesVisible/,
  "the diagnostic shelf overlay must never replace or hide the thermal texture"
);
assert.match(rendererSource, /drawBclifThermalBackdrop/);
assert.match(rendererSource, /plasmaBackgroundOpacity/);

const strictSettings = migrateLiquidationFieldSettings({
  ...settings,
  strictHideBelowEnabled: true,
  strictHideBelowConfidence: 60
});
const strictProjection = buildBclifDisplayProjection(snapshot, strictSettings, context);
assert.ok(strictProjection.rawNonZeroCells > 0);
assert.equal(strictProjection.visibleCells, 0);
assert.equal(strictProjection.filteredCells, strictProjection.validCells);
assert.equal(extractBclifOperationalClusters(snapshot, currentPrice, settings).length, 0);

const legacy = migrateLiquidationFieldSettings({
  schemaVersion: 3,
  minimumConfidence: 68,
  opacity: 0,
  diagnosticsVisible: true,
  operationalSummaryVisible: true
} as never);
assert.equal(legacy.contextVisibilityFloor, 0);
assert.equal(legacy.clusterLabelFloor, 68);
assert.equal(legacy.highAuthorityColorFloor, 75);
assert.equal(legacy.opacity, 96);
assert.equal(legacy.diagnosticsVisible, false);
assert.equal(legacy.operationalSummaryVisible, false);

const legacyShelfOnly = migrateLiquidationFieldSettings({
  ...settings,
  schemaVersion: 7,
  preset: "RAW_MODEL",
  horizon: "1D",
  viewMode: "COMBINED_THERMAL",
  rawCohortShelvesVisible: true,
  priceDisplay: "FULL_MODEL_RANGE",
  palette: "BLACK_TERMINAL_BLOOD"
} as never);
assert.equal(legacyShelfOnly.schemaVersion, 12);
assert.equal(legacyShelfOnly.preset, "REFERENCE_THERMAL");
assert.equal(legacyShelfOnly.rendererVersion, "REFERENCE_THERMAL_V2");
assert.equal(legacyShelfOnly.horizon, "3W");
assert.equal(legacyShelfOnly.viewMode, "COMBINED_THERMAL");
assert.equal(legacyShelfOnly.rawCohortShelvesVisible, false);
assert.equal(legacyShelfOnly.rangeMode, "AUTO");
assert.equal(legacyShelfOnly.priceDisplay, "AUTO_FOCUS");
assert.equal(legacyShelfOnly.palette, "REFERENCE_THERMAL");

const explicitV8ShelfOverlay = migrateLiquidationFieldSettings({
  ...settings,
  schemaVersion: 8,
  rawCohortShelvesVisible: true
});
assert.equal(explicitV8ShelfOverlay.schemaVersion, 12);
assert.equal(explicitV8ShelfOverlay.rawCohortShelvesVisible, false, "pre-V10 reference workspaces migrate to the clean scalar presentation");
assert.equal(explicitV8ShelfOverlay.opacity, 96);
assert.equal(explicitV8ShelfOverlay.backgroundFloor, 15);
assert.equal(explicitV8ShelfOverlay.plasmaBackgroundOpacity, 0);
assert.equal(explicitV8ShelfOverlay.historicalContextOpacity, 100);
assert.equal(
  applyBclifPresentationPreset(explicitV8ShelfOverlay, "TRADE_FOCUS").rawCohortShelvesVisible,
  false,
  "returning to an operational preset must remove the optional diagnostic shelf overlay"
);

const emergencyV10 = migrateLiquidationFieldSettings({
  ...settings,
  schemaVersion: 10,
  rendererVersion: "REFERENCE_THERMAL_V2",
  viewMode: "SHELF_LINES_ONLY",
  diagnosticsVisible: true,
  operationalSummaryVisible: true,
  legendVisible: true,
  maximumClusterLabels: 6,
  confirmedMarkersVisible: true,
  cohortBirthMarkersVisible: true,
  rawCohortShelvesVisible: true
} as never);
assert.equal(emergencyV10.schemaVersion, 12);
assert.equal(emergencyV10.viewMode, "COMBINED_THERMAL");
assert.equal(emergencyV10.compactBadgeVisible, true);
assert.equal(emergencyV10.eventNodesVisible, false);
assert.equal(emergencyV10.shelfLabelsVisible, false);
assert.equal(emergencyV10.diagnosticsVisible, false);
assert.equal(emergencyV10.operationalSummaryVisible, false);
assert.equal(emergencyV10.legendVisible, false);
assert.equal(emergencyV10.maximumClusterLabels, 0);
assert.equal(emergencyV10.confirmedMarkersVisible, false);
assert.equal(emergencyV10.cohortBirthMarkersVisible, false);
assert.equal(emergencyV10.rawCohortShelvesVisible, false);

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

const projectionQueue = new BclifLatestProjectionQueue<{ key: string }>();
const startedProjectionKeys: string[] = [];
const projectionTokens: number[] = [];
const startProjection = (token: number, value: { key: string }) => {
  projectionTokens.push(token);
  startedProjectionKeys.push(value.key);
};
const firstProjectionToken = projectionQueue.request({ key: "initial" }, startProjection, (left, right) => left.key === right.key);
for (let update = 0; update < 1_000; update += 1) {
  projectionQueue.request({ key: "update-" + update }, startProjection, (left, right) => left.key === right.key);
}
assert.deepEqual(startedProjectionKeys, ["initial"], "display projection must remain single-flight under a live snapshot flood");
assert.equal(projectionQueue.complete(firstProjectionToken, startProjection), true);
assert.deepEqual(startedProjectionKeys, ["initial", "update-999"], "only the newest waiting projection must follow the first published raster");
assert.equal(projectionQueue.complete(projectionTokens[1]!, startProjection), true);
const cancelledProjectionToken = projectionQueue.request({ key: "old-scope" }, startProjection);
projectionQueue.reset();
assert.equal(projectionQueue.complete(cancelledProjectionToken, startProjection), false, "a semantic scope reset must reject its stale worker response");

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
  wideDomainVisibleCells: wideProjection!.visibleCells,
  filteredCells: projection.filteredCells,
  minimumAlpha: projection.minimumVisibleAlpha,
  maximumAlpha: projection.maximumAlpha,
  yellowEligibleCells: projection.yellowEligibleCells,
  singleFlightBuildGate: { buildInvocations, maximumConcurrentBuilds, publishedBuilds },
  latestProjectionQueue: { startedProjectionKeys, projectionTokens },
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
