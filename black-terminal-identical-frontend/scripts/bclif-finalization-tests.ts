import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildLiquidationFieldSnapshot } from "../src/modules/liquidation-field/core/exposureRaster.ts";
import {
  DEFAULT_LIQUIDATION_FIELD_SETTINGS,
  bclifPriceDisplayForRangeMode,
  liquidationFieldModelSettingsKey,
  migrateLiquidationFieldSettings
} from "../src/modules/liquidation-field/core/settings.ts";
import type { BclifDisplayProjection } from "../src/modules/liquidation-field/rendering/displayProjection.ts";
import {
  bclifExposureHash,
  bclifModelHash,
  bclifRenderSettingsHash,
  buildBclifCausalClarityIntensity,
  resolveBclifDisplayDomain
} from "../src/modules/liquidation-field/rendering/displayProjection.ts";
import { buildBclifSafeThermalRaster } from "../src/modules/liquidation-field/rendering/safeThermalRaster.ts";
import { createThermalPalette } from "../src/modules/liquidation-field/rendering/thermalPalette.ts";
import { createLiquidationFieldFixture } from "../src/modules/liquidation-field/testing/fixtures.ts";

const defaults = DEFAULT_LIQUIDATION_FIELD_SETTINGS;
assert.equal(defaults.schemaVersion, 12);
assert.equal(defaults.rangeMode, "AUTO");
assert.equal(defaults.palette, "REFERENCE_THERMAL");
assert.equal(defaults.modelPreset, "BALANCED");
assert.equal(defaults.viewMode, "COMBINED_THERMAL");
assert.equal(defaults.noiseSuppression, "MEDIUM");
assert.equal(defaults.showBackgroundField, true);
assert.equal(defaults.strongShelvesOnly, false);
assert.equal(defaults.diagnosticsVisible, false);
assert.equal(defaults.eventNodesVisible, false);
assert.equal(defaults.shelfLabelsVisible, false);
assert.equal(migrateLiquidationFieldSettings({ schemaVersion: 11, priceDisplay: "CHART_SCALE" } as never).rangeMode, "VISIBLE");
assert.equal(migrateLiquidationFieldSettings({ schemaVersion: 12, rangeMode: "INVALID" } as never).rangeMode, "AUTO");

const fixture = createLiquidationFieldFixture();
const compactModelSettings = migrateLiquidationFieldSettings({ ...defaults, priceRows: 128, timeColumns: 128 });
const snapshot = buildLiquidationFieldSnapshot(fixture.frames, fixture.events, fixture.rules, compactModelSettings, fixture.coverage);
const modelHash = bclifModelHash(snapshot);
const exposureHash = bclifExposureHash(snapshot);
const counts: Record<string, number> = {};
for (const noiseSuppression of ["LOW", "MEDIUM", "HIGH"] as const) {
  const settings = migrateLiquidationFieldSettings({ ...defaults, noiseSuppression });
  const field = buildBclifCausalClarityIntensity(snapshot, settings);
  counts[noiseSuppression] = field.filter(Boolean).length;
  for (let index = 0; index < field.length; index += 1) {
    if (!field[index]) continue;
    assert.ok((snapshot.longExposure[index] ?? 0) + (snapshot.shortExposure[index] ?? 0) > 0, "clarity compression fabricated exposure");
  }
}
const strong = buildBclifCausalClarityIntensity(snapshot, migrateLiquidationFieldSettings({ ...defaults, strongShelvesOnly: true }));
counts.STRONG = strong.filter(Boolean).length;
assert.ok(counts.LOW! >= counts.MEDIUM! && counts.MEDIUM! >= counts.HIGH!, "noise suppression must be monotonic");
assert.ok(counts.HIGH! > 0 && counts.STRONG! > 0, "major shelves must survive compression");
assert.ok(counts.STRONG! <= counts.MEDIUM!, "strong-only mode cannot add shelves");

const presentationVariants = [
  migrateLiquidationFieldSettings({ ...defaults, intensityGain: 155 }),
  migrateLiquidationFieldSettings({ ...defaults, palette: "BLACK_TERMINAL_BLOOD" }),
  migrateLiquidationFieldSettings({ ...defaults, rangeMode: "MACRO", priceDisplay: bclifPriceDisplayForRangeMode("MACRO") }),
  migrateLiquidationFieldSettings({ ...defaults, noiseSuppression: "HIGH" })
];
for (const settings of presentationVariants) {
  assert.equal(bclifModelHash(snapshot), modelHash);
  assert.equal(bclifExposureHash(snapshot), exposureHash);
  assert.equal(liquidationFieldModelSettingsKey(settings), liquidationFieldModelSettingsKey(defaults));
  assert.notEqual(bclifRenderSettingsHash(settings), bclifRenderSettingsHash(defaults));
}

const price = fixture.frames.at(-1)!.markPrice;
const context = { chartPriceMinimum: price * 0.94, chartPriceMaximum: price * 1.06, currentPrice: price };
const visible = resolveBclifDisplayDomain(snapshot, migrateLiquidationFieldSettings({ ...defaults, rangeMode: "VISIBLE", priceDisplay: "CHART_SCALE" }), context)!;
assert.deepEqual(visible, { minimum: context.chartPriceMinimum, maximum: context.chartPriceMaximum });
const full = resolveBclifDisplayDomain(snapshot, migrateLiquidationFieldSettings({ ...defaults, rangeMode: "FULL_LOADED", priceDisplay: "FULL_MODEL_RANGE" }), context)!;
assert.deepEqual(full, { minimum: snapshot.header.minPrice, maximum: snapshot.header.maxPrice });
for (const rangeMode of ["AUTO", "VISIBLE", "SESSION", "SWING", "MACRO", "FULL_LOADED"] as const) {
  assert.ok(resolveBclifDisplayDomain(snapshot, migrateLiquidationFieldSettings({ ...defaults, rangeMode, priceDisplay: bclifPriceDisplayForRangeMode(rangeMode) }), context));
}

const miniProjection = {
  columns: 2,
  rows: 2,
  intensity: Uint8Array.of(0, 210, 0, 248),
  alpha: Uint8Array.of(255, 255, 255, 255),
  confidence: Uint8Array.of(100, 180, 100, 220),
  validity: Uint8Array.of(1, 1, 1, 1)
} as BclifDisplayProjection;
const withFloor = buildBclifSafeThermalRaster(miniProjection, defaults);
const withoutFloor = buildBclifSafeThermalRaster(miniProjection, { ...defaults, showBackgroundField: false });
assert.equal(withFloor.metrics.finalVisiblePixels, 4);
assert.equal(withFloor.metrics.exposureVisiblePixels, 2);
assert.equal(withoutFloor.metrics.finalVisiblePixels, 2);
assert.equal(withoutFloor.metrics.exposureVisiblePixels, 2);

assert.notDeepEqual(createThermalPalette("REFERENCE_THERMAL"), createThermalPalette("BLACK_TERMINAL_BLOOD"));
const settingsSource = readFileSync(new URL("../src/modules/liquidation-field/components/LiquidationFieldSettingsPanel.tsx", import.meta.url), "utf8");
const chartSource = readFileSync(new URL("../src/components/PixiBlackChart.tsx", import.meta.url), "utf8");
const rendererSource = readFileSync(new URL("../src/modules/liquidation-field/rendering/BlackCoreLiquidationFieldRenderer.ts", import.meta.url), "utf8");
assert.match(settingsSource, /Advanced \/ Diagnostics/);
assert.match(settingsSource, /<details className="bclif-advanced-settings">/);
assert.match(settingsSource, /Show Background Field/);
assert.match(settingsSource, /Strong Shelves Only/);
assert.match(chartSource, /aria-label="BCLIF quick intensity"/);
assert.match(chartSource, /aria-label="BCLIF range"/);
assert.match(chartSource, /aria-label="BCLIF thermal theme"/);
const emptySnapshotGuard = rendererSource.indexOf("if (!snapshot) return;", rendererSource.indexOf("draw(transform:"));
const backdropDraw = rendererSource.indexOf("drawBclifThermalBackdrop(this.backdrop, transform, settings);", rendererSource.indexOf("draw(transform:"));
assert.ok(emptySnapshotGuard >= 0 && backdropDraw > emptySnapshotGuard, "BCLIF backdrop must remain hidden when the indicator snapshot is absent");

console.log(JSON.stringify({
  decision: "PASS",
  contract: "BCLIF_CHAPTER_IIIC7_FINALIZATION_V1",
  modelHash,
  exposureHash,
  shelfCells: counts,
  ranges: 6,
  themes: 2,
  backgroundFloorIsPresentationOnly: true
}, null, 2));
