import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildLiquidationFieldSnapshot } from "../src/modules/liquidation-field/core/exposureRaster.ts";
import { analyzeBclifRawField } from "../src/modules/liquidation-field/core/rawShelfDiagnostics.ts";
import {
  DEFAULT_LIQUIDATION_FIELD_SETTINGS,
  migrateLiquidationFieldSettings
} from "../src/modules/liquidation-field/core/settings.ts";
import {
  bclifExposureHash,
  bclifModelHash,
  bclifScalarFieldHash,
  bclifUint8ToHalf,
  buildBclifDisplayProjection
} from "../src/modules/liquidation-field/rendering/displayProjection.ts";
import { measureBclifReferenceThermalField } from "../src/modules/liquidation-field/rendering/referenceThermalMetrics.ts";
import { buildBclifSafeThermalRaster } from "../src/modules/liquidation-field/rendering/safeThermalRaster.ts";
import {
  REFERENCE_THERMAL_CALIBRATION_SHA256,
  createThermalPalette
} from "../src/modules/liquidation-field/rendering/thermalPalette.ts";
import { createLiquidationFieldFixture } from "../src/modules/liquidation-field/testing/fixtures.ts";
import { createBclifReferenceThermalStyleFixture } from "../src/modules/liquidation-field/testing/referenceThermalFixture.ts";

const calibration = JSON.parse(readFileSync(
  new URL("../reference/bclif-reference-thermal-spec.json", import.meta.url),
  "utf8"
));
assert.equal(calibration.contract, "BCLIF_REFERENCE_THERMAL_CALIBRATION_V1");
assert.equal(calibration.entries, 256);
assert.equal(calibration.sourceCommitted, false);
assert.equal(calibration.sourceSha256, REFERENCE_THERMAL_CALIBRATION_SHA256);
assert.equal(calibration.missingDataColor, "#05020B");

const lut = createThermalPalette("REFERENCE_THERMAL");
assert.equal(lut.length, 1_024);
assert.deepEqual([...lut.slice(0, 4)], [53, 0, 68, 255]);
assert.deepEqual([...lut.slice(-4)], [240, 231, 5, 255]);
assert.deepEqual([...bclifUint8ToHalf(Uint8Array.of(0, 255))], [0, 0x3c00]);

const style = createBclifReferenceThermalStyleFixture();
const metrics = measureBclifReferenceThermalField(style, DEFAULT_LIQUIDATION_FIELD_SETTINGS);
const validOccupancy = style.validCells / (style.rows * style.columns) * 100;
assert.ok(validOccupancy >= 98);
assert.ok(metrics.hsvValueQuantiles.p10 >= 0.32 && metrics.hsvValueQuantiles.p10 <= 0.40);
assert.ok(metrics.hsvValueQuantiles.p50 >= 0.38 && metrics.hsvValueQuantiles.p50 <= 0.50);
assert.ok(metrics.hsvValueQuantiles.p90 >= 0.55 && metrics.hsvValueQuantiles.p90 <= 0.68);
assert.ok(metrics.hsvValueQuantiles.maximum >= 0.85 && metrics.hsvValueQuantiles.maximum <= 0.95);
assert.ok(metrics.thermalOccupancyPercent.deepPurple >= 50 && metrics.thermalOccupancyPercent.deepPurple <= 65);
assert.ok(metrics.thermalOccupancyPercent.blueCyan >= 18 && metrics.thermalOccupancyPercent.blueCyan <= 30);
assert.ok(metrics.thermalOccupancyPercent.green >= 4 && metrics.thermalOccupancyPercent.green <= 10);
assert.ok(metrics.thermalOccupancyPercent.yellow >= 0.05 && metrics.thermalOccupancyPercent.yellow <= 0.5);
assert.equal(metrics.zeroExposureValidCellCount, 0);

const fixture = createLiquidationFieldFixture();
const snapshot = buildLiquidationFieldSnapshot(
  fixture.frames,
  fixture.events,
  fixture.rules,
  DEFAULT_LIQUIDATION_FIELD_SETTINGS,
  fixture.coverage
);
const hashes = {
  model: bclifModelHash(snapshot),
  exposure: bclifExposureHash(snapshot),
  scalar: bclifScalarFieldHash(snapshot)
};
const presentationVariants = [
  { palette: "BLACK_TERMINAL_BLOOD" as const },
  { opacity: 88 },
  { gamma: 1.15 },
  { adaptiveResolution: "ULTRA" as const },
  { diagnosticsVisible: true, legendVisible: true, confirmedMarkersVisible: true }
];
for (const variant of presentationVariants) {
  migrateLiquidationFieldSettings({ ...DEFAULT_LIQUIDATION_FIELD_SETTINGS, ...variant });
  assert.equal(bclifModelHash(snapshot), hashes.model);
  assert.equal(bclifExposureHash(snapshot), hashes.exposure);
  assert.equal(bclifScalarFieldHash(snapshot), hashes.scalar);
}

const currentPrice = fixture.frames.at(-1)!.markPrice;
const context = {
  chartPriceMinimum: currentPrice * 0.88,
  chartPriceMaximum: currentPrice * 1.12,
  currentPrice,
  plotWidth: 960,
  plotHeight: 540,
  devicePixelRatio: 1,
  constrainedTouchRenderer: true
};
const projection = buildBclifDisplayProjection(snapshot, DEFAULT_LIQUIDATION_FIELD_SETTINGS, context);
assert.ok(projection);
assert.equal(projection!.rgba, undefined, "V2 must not allocate a pre-colored RGBA field");
assert.equal(bclifUint8ToHalf(projection!.intensity).length, projection!.intensity.length);
const safeRaster = buildBclifSafeThermalRaster(projection!, DEFAULT_LIQUIDATION_FIELD_SETTINGS);
assert.equal(safeRaster.rgba.length, projection!.rows * projection!.columns * 4);
assert.equal(safeRaster.metrics.finalVisiblePixels, projection!.validCells);
assert.ok(safeRaster.metrics.exposureVisiblePixels > 0);
assert.ok(safeRaster.metrics.minimumAlpha >= 46);
assert.ok(safeRaster.metrics.maximumAlpha > 0);
assert.equal(
  projection!.rawNonZeroCells > 0 && safeRaster.metrics.exposureVisiblePixels === 0,
  false,
  "raw model exposure must reach at least one visible final thermal pixel"
);

const confidenceChanged = {
  ...snapshot,
  confidence: new Uint8Array(snapshot.confidence.length).fill(32)
};
const lowConfidenceProjection = buildBclifDisplayProjection(confidenceChanged, DEFAULT_LIQUIDATION_FIELD_SETTINGS, context);
assert.ok(lowConfidenceProjection);
assert.equal(bclifModelHash(confidenceChanged), hashes.model, "confidence metadata must not change the model");
assert.equal(bclifExposureHash(confidenceChanged), hashes.exposure, "confidence metadata must not change raw exposure");
const lowConfidenceSafeRaster = buildBclifSafeThermalRaster(lowConfidenceProjection!, DEFAULT_LIQUIDATION_FIELD_SETTINGS);
assert.ok(lowConfidenceSafeRaster.metrics.exposureVisiblePixels > 0, "confidence-aware clarity must retain major modeled shelves");
assert.ok(lowConfidenceSafeRaster.metrics.exposureVisiblePixels <= safeRaster.metrics.exposureVisiblePixels,
  "lower confidence may suppress weak presentation shelves but cannot create exposure");

const rawAudit = analyzeBclifRawField(snapshot);
assert.ok([
  "RAW FIELD VALID — RENDERER DEFECT",
  "RAW FIELD TOO SPARSE — SOURCE/MODEL RESOLUTION LIMIT",
  "RAW FIELD PRICE-PATH DEFECT REMAINS"
].includes(rawAudit.verdict));

const rendererSource = readFileSync(new URL(
  "../src/modules/liquidation-field/rendering/BlackCoreReferenceThermalRendererV2.ts",
  import.meta.url
), "utf8");
assert.match(rendererSource, /"r16float"/);
assert.match(rendererSource, /"r8unorm"/);
assert.match(rendererSource, /uPaletteTexture/);
assert.match(rendererSource, /blendMode = "normal"/);
assert.doesNotMatch(rendererSource, /multiply|DST_COLOR/i);
assert.match(rendererSource, /max\(0\.18, uOpacity/);
assert.match(rendererSource, /0\.5 \/ 255/);
const controllerSource = readFileSync(new URL(
  "../src/modules/liquidation-field/rendering/BlackCoreLiquidationFieldRenderer.ts",
  import.meta.url
), "utf8");
assert.match(controllerSource, /BCLIF_RENDER_VISIBILITY_FAILURE/);
assert.match(controllerSource, /safeCompositingPlane/);
assert.match(controllerSource, /__BCLIF_RENDER_TRUTH__/);

console.log(JSON.stringify({
  decision: "PASS",
  fixtureAuthority: "SYNTHETIC_TEST",
  rawFieldVerdict: rawAudit.verdict,
  rawShelfCount: rawAudit.rawShelfCount,
  hashes,
  scalarTextureFormat: "R16F",
  confidenceTextureFormat: "R8",
  validityTextureFormat: "R8",
  validOccupancyPercent: Number(validOccupancy.toFixed(4)),
  thermalOccupancyPercent: metrics.thermalOccupancyPercent,
  hsvValueQuantiles: metrics.hsvValueQuantiles,
  lutSourceSha256: REFERENCE_THERMAL_CALIBRATION_SHA256
}, null, 2));
