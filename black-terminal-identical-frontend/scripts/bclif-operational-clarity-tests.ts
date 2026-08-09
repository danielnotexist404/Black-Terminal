import assert from "node:assert/strict";
import { buildLiquidationFieldSnapshot } from "../src/modules/liquidation-field/core/exposureRaster.ts";
import {
  bclifEvidenceComposition,
  bclifMeaningfulEvidenceChannels,
  classifyBclifEvidence,
  extractBclifOperationalClusters,
  selectBclifOperationalLabels
} from "../src/modules/liquidation-field/core/operationalClusters.ts";
import {
  applyBclifPresentationPreset,
  DEFAULT_LIQUIDATION_FIELD_SETTINGS,
  liquidationFieldModelSettingsKey,
  migrateLiquidationFieldSettings
} from "../src/modules/liquidation-field/core/settings.ts";
import type { BclifPersistentCoverage, LiquidationFieldSnapshot } from "../src/modules/liquidation-field/core/types.ts";
import {
  bclifDisplayEvidenceHash,
  bclifDisplayRasterIdentity,
  bclifExposureHash,
  bclifModelHash,
  bclifRenderSettingsHash,
  buildBclifDisplayProjection,
  resolveBclifDisplayDimensions,
  resolveBclifDisplayDomain
} from "../src/modules/liquidation-field/rendering/displayProjection.ts";
import { applyBclifVisualCertificationProfile, createLiquidationFieldFixture } from "../src/modules/liquidation-field/testing/fixtures.ts";

const fixture = createLiquidationFieldFixture();
const modelSettings = migrateLiquidationFieldSettings({
  ...DEFAULT_LIQUIDATION_FIELD_SETTINGS,
  priceRows: 256,
  timeColumns: 256,
  contextVisibilityFloor: 0, clusterLabelFloor: 0
});
const model = applyBclifVisualCertificationProfile(buildLiquidationFieldSnapshot(
  fixture.frames,
  fixture.events,
  fixture.rules,
  modelSettings,
  fixture.coverage
));
const currentPrice = fixture.frames.at(-1)!.markPrice;
const chartContext = {
  chartPriceMinimum: currentPrice * 0.94,
  chartPriceMaximum: currentPrice * 1.06,
  currentPrice,
  plotWidth: 1_600,
  plotHeight: 900,
  constrainedTouchRenderer: false
};

assert.equal(DEFAULT_LIQUIDATION_FIELD_SETTINGS.preset, "TRADE_FOCUS");
assert.equal(DEFAULT_LIQUIDATION_FIELD_SETTINGS.priceDisplay, "CHART_SCALE");
assert.equal(DEFAULT_LIQUIDATION_FIELD_SETTINGS.contextVisibilityFloor, 25);
assert.equal(DEFAULT_LIQUIDATION_FIELD_SETTINGS.clusterLabelFloor, 60);
assert.equal(DEFAULT_LIQUIDATION_FIELD_SETTINGS.highAuthorityColorFloor, 75);
assert.equal(DEFAULT_LIQUIDATION_FIELD_SETTINGS.strictHideBelowEnabled, false);
assert.equal(DEFAULT_LIQUIDATION_FIELD_SETTINGS.opacity, 45);
assert.ok(DEFAULT_LIQUIDATION_FIELD_SETTINGS.gamma > 1);
assert.ok(DEFAULT_LIQUIDATION_FIELD_SETTINGS.lowQuantile >= 0.4);
assert.ok(DEFAULT_LIQUIDATION_FIELD_SETTINGS.highQuantile >= 0.997);
assert.ok(DEFAULT_LIQUIDATION_FIELD_SETTINGS.yellowTailPercent <= 0.5);
assert.equal(DEFAULT_LIQUIDATION_FIELD_SETTINGS.maximumClusterLabels, 4);

const baselineModelHash = bclifModelHash(model);
const baselineExposureHash = bclifExposureHash(model);
const displayModes = [
  "CHART_SCALE", "CURRENT_PRICE_5", "CURRENT_PRICE_10", "CURRENT_PRICE_20",
  "CURRENT_PRICE_40", "AUTO_FOCUS", "FULL_MODEL_RANGE", "CUSTOM"
] as const;
const rasterHashes = new Set<string>();
for (const priceDisplay of displayModes) {
  const settings = migrateLiquidationFieldSettings({
    ...DEFAULT_LIQUIDATION_FIELD_SETTINGS,
    priceDisplay,
    customPriceMinimum: currentPrice * 0.8,
    customPriceMaximum: currentPrice * 1.2
  });
  assert.equal(bclifModelHash(model), baselineModelHash, `${priceDisplay} changed the model hash`);
  assert.equal(bclifExposureHash(model), baselineExposureHash, `${priceDisplay} changed the exposure hash`);
  rasterHashes.add(bclifDisplayRasterIdentity(model, settings, chartContext));
}
assert.ok(rasterHashes.size >= 5, "display-domain modes must alter projection identity without mutating the model");

const opacityVariant = migrateLiquidationFieldSettings({ ...DEFAULT_LIQUIDATION_FIELD_SETTINGS, opacity: 91 });
const paletteVariant = migrateLiquidationFieldSettings({ ...DEFAULT_LIQUIDATION_FIELD_SETTINGS, palette: "INSTITUTIONAL_MONOCHROME" });
const customRangeA = migrateLiquidationFieldSettings({
  ...DEFAULT_LIQUIDATION_FIELD_SETTINGS,
  priceDisplay: "CUSTOM",
  customPriceMinimum: currentPrice * 0.8,
  customPriceMaximum: currentPrice * 1.2
});
const customRangeB = migrateLiquidationFieldSettings({
  ...customRangeA,
  customPriceMinimum: currentPrice * 0.85,
  customPriceMaximum: currentPrice * 1.15
});
const cameraVariant = { ...chartContext, chartPriceMinimum: currentPrice * 0.97, chartPriceMaximum: currentPrice * 1.03 };
for (const settings of [opacityVariant, paletteVariant]) {
  assert.equal(bclifModelHash(model), baselineModelHash);
  assert.equal(bclifExposureHash(model), baselineExposureHash);
  assert.notEqual(bclifRenderSettingsHash(settings), bclifRenderSettingsHash(DEFAULT_LIQUIDATION_FIELD_SETTINGS));
}
assert.equal(bclifModelHash(model), baselineModelHash);
assert.equal(bclifExposureHash(model), baselineExposureHash);
assert.notEqual(
  bclifDisplayRasterIdentity(model, DEFAULT_LIQUIDATION_FIELD_SETTINGS, chartContext),
  bclifDisplayRasterIdentity(model, DEFAULT_LIQUIDATION_FIELD_SETTINGS, cameraVariant),
  "camera changes must affect only the display raster identity"
);
assert.equal(
  liquidationFieldModelSettingsKey(DEFAULT_LIQUIDATION_FIELD_SETTINGS),
  liquidationFieldModelSettingsKey(opacityVariant),
  "opacity must not trigger a cohort/raster model rebuild"
);
assert.equal(liquidationFieldModelSettingsKey(customRangeA), liquidationFieldModelSettingsKey(customRangeB));
assert.equal(bclifModelHash(model), baselineModelHash);
assert.equal(bclifExposureHash(model), baselineExposureHash);
assert.notEqual(bclifRenderSettingsHash(customRangeA), bclifRenderSettingsHash(customRangeB));
assert.notEqual(
  bclifDisplayRasterIdentity(model, customRangeA, chartContext),
  bclifDisplayRasterIdentity(model, customRangeB, chartContext),
  "custom display bounds must invalidate only the display raster"
);

const chartDomain = resolveBclifDisplayDomain(model, DEFAULT_LIQUIDATION_FIELD_SETTINGS, chartContext)!;
assert.equal(chartDomain.minimum, chartContext.chartPriceMinimum);
assert.equal(chartDomain.maximum, chartContext.chartPriceMaximum);
const research = applyBclifPresentationPreset(DEFAULT_LIQUIDATION_FIELD_SETTINGS, "FULL_SPECTRUM_RESEARCH");
const researchDomain = resolveBclifDisplayDomain(model, research, chartContext)!;
assert.equal(researchDomain.minimum, model.header.minPrice);
assert.equal(researchDomain.maximum, model.header.maxPrice);

const tradeDimensions = resolveBclifDisplayDimensions(model, DEFAULT_LIQUIDATION_FIELD_SETTINGS, chartContext);
assert.ok(tradeDimensions.rows >= 768 && tradeDimensions.rows <= 2_048);
const researchDimensions = resolveBclifDisplayDimensions(model, research, chartContext);
assert.ok(researchDimensions.rows >= 512 && researchDimensions.rows <= 1_024);
const fallbackDimensions = resolveBclifDisplayDimensions(model, { ...DEFAULT_LIQUIDATION_FIELD_SETTINGS, adaptiveResolution: "LOW_PERFORMANCE" }, chartContext);
assert.ok(fallbackDimensions.rows >= 384 && fallbackDimensions.rows <= 512);

const coverage = (overrides: Partial<BclifPersistentCoverage>): BclifPersistentCoverage => ({
  venue: "BYBIT", symbol: "BTCUSDT", horizon: "3W",
  requestedStart: model.header.startTime, requestedEnd: model.header.endTime,
  modelStart: model.header.startTime, modelEnd: model.header.endTime,
  openInterestCoveragePercent: 100, tradeCoveragePercent: 0, liquidationCoveragePercent: 0,
  orderbookCoveragePercent: 0, fundingCoveragePercent: 0, continuityPercent: 100,
  sourceMode: "PERSISTENT_COLLECTOR", quality: "HIGH", gaps: [], updatedAt: model.header.endTime,
  ...overrides
});
const withQuality = (
  confidence: number,
  authority: LiquidationFieldSnapshot["authority"],
  persistentCoverage: BclifPersistentCoverage,
  validity = model.validity
): LiquidationFieldSnapshot => ({
  ...model,
  authority,
  certainty: confidence >= 75 ? "ESTIMATED_HIGH" : confidence >= 60 ? "ESTIMATED_MEDIUM" : "ESTIMATED_LOW",
  confidence: new Uint8Array(model.confidence.length).fill(Math.round(confidence * 2.55)),
  validity,
  persistentCoverage,
  confidenceBreakdown: { ...model.confidenceBreakdown, total: confidence }
});
const project = (snapshot: LiquidationFieldSnapshot, settings = DEFAULT_LIQUIDATION_FIELD_SETTINGS) => {
  const result = buildBclifDisplayProjection(snapshot, { ...settings, adaptiveResolution: "LOW_PERFORMANCE" }, chartContext);
  assert.ok(result);
  return result;
};
const maximumByte = (values: Uint8Array) => values.reduce((maximum, value) => Math.max(maximum, value), 0);

const oiOnly50Snapshot = withQuality(50, "BROWSER_FALLBACK", coverage({ sourceMode: "BROWSER_SESSION" }));
const oiOnly50 = project(oiOnly50Snapshot);
assert.equal(oiOnly50.yellowEligible.filter(Boolean).length, 0, "50% OI-only context must never become yellow");
assert.ok(maximumByte(oiOnly50.intensity) <= 176, "historical OI-only context must remain below high-authority thermal colors");
assert.ok(oiOnly50.historicalCells > 0 && oiOnly50.liveCalibratedCells === 0);

const trades80Snapshot = withQuality(80, "PERSISTENT_NODE", coverage({ tradeCoveragePercent: 100 }));
const trades80 = project(trades80Snapshot);
assert.ok(trades80.liveCalibratedCells > 0);
assert.ok(maximumByte(trades80.alpha) > maximumByte(oiOnly50.alpha), "verified exact trades must gain visual authority");
assert.equal(classifyBclifEvidence(bclifEvidenceComposition(trades80Snapshot)), "OI_PLUS_TRADES");
assert.equal(bclifModelHash(trades80Snapshot), baselineModelHash);
assert.equal(bclifExposureHash(trades80Snapshot), baselineExposureHash);
assert.notEqual(bclifDisplayEvidenceHash(oiOnly50Snapshot), bclifDisplayEvidenceHash(trades80Snapshot));
assert.notEqual(
  bclifDisplayRasterIdentity(oiOnly50Snapshot, DEFAULT_LIQUIDATION_FIELD_SETTINGS, chartContext),
  bclifDisplayRasterIdentity(trades80Snapshot, DEFAULT_LIQUIDATION_FIELD_SETTINGS, chartContext),
  "source authority and evidence confidence must be part of display identity"
);

const full90Snapshot = withQuality(90, "PERSISTENT_NODE", coverage({
  tradeCoveragePercent: 100, liquidationCoveragePercent: 100, orderbookCoveragePercent: 100, fundingCoveragePercent: 100
}));
const full90 = project(full90Snapshot);
const yellowCells = full90.yellowEligible.filter(Boolean).length;
assert.ok(yellowCells > 0, "fully supported exceptional exposure must remain yellow-eligible");
assert.ok(yellowCells / full90.yellowEligible.length <= 0.006, "yellow must remain a rare tail");
assert.equal(classifyBclifEvidence(bclifEvidenceComposition(full90Snapshot)), "FULL_CONTEXT");
assert.ok(bclifMeaningfulEvidenceChannels(bclifEvidenceComposition(full90Snapshot)) >= 2);

const staleBook = withQuality(90, "PERSISTENT_NODE", coverage({ tradeCoveragePercent: 100, orderbookCoveragePercent: 0 }));
assert.notEqual(classifyBclifEvidence(bclifEvidenceComposition(staleBook)), "OI_PLUS_TRADES_PLUS_BOOK");
const missingValidity = Uint8Array.from(model.validity);
missingValidity.fill(0, 0, Math.floor(missingValidity.length / 12));
const missingProjection = project(withQuality(80, "PERSISTENT_NODE", coverage({ tradeCoveragePercent: 100 }), missingValidity));
assert.ok(missingProjection.missingCells > 0, "missing intervals must remain distinct from purple low exposure");

const clusters = extractBclifOperationalClusters(full90Snapshot, currentPrice, DEFAULT_LIQUIDATION_FIELD_SETTINGS);
assert.ok(clusters.length > 0, "operational shelves must be extracted from the retained full-spectrum model");
assert.ok(clusters.every((cluster) => cluster.rankScore >= 0 && cluster.rankScore <= 1));
assert.ok(clusters.every((cluster) => cluster.estimatedExposureHigh >= cluster.estimatedExposureLow));
assert.ok(selectBclifOperationalLabels(clusters, currentPrice, 4).length <= 4);

console.log(JSON.stringify({
  decision: "PASS",
  modelHash: baselineModelHash,
  exposureHash: baselineExposureHash,
  displayModes: displayModes.length,
  distinctDisplayRasters: rasterHashes.size,
  tradeFocusGrid: `${tradeDimensions.columns}x${tradeDimensions.rows}`,
  researchGrid: `${researchDimensions.columns}x${researchDimensions.rows}`,
  clusters: clusters.length,
  visibleLabels: selectBclifOperationalLabels(clusters, currentPrice, 4).length,
  yellowTailPercent: Number((yellowCells / full90.yellowEligible.length * 100).toFixed(4))
}, null, 2));
