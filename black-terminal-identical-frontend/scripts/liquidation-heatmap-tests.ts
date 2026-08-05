import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { bybitLiquidationInput, estimateBybitLinearLiquidationDistribution } from "../src/modules/liquidation-field/core/bybitLiquidationModel.ts";
import { LiquidationCohortEngine } from "../src/modules/liquidation-field/core/cohortEngine.ts";
import { buildLiquidationFieldSnapshot } from "../src/modules/liquidation-field/core/exposureRaster.ts";
import { createLeveragePrior } from "../src/modules/liquidation-field/core/leveragePriors.ts";
import { DEFAULT_LIQUIDATION_FIELD_SETTINGS } from "../src/modules/liquidation-field/core/settings.ts";
import { createThermalPalette } from "../src/modules/liquidation-field/rendering/thermalPalette.ts";
import { bclifTimestampMsToChartSeconds } from "../src/modules/liquidation-field/rendering/timeProjection.ts";
import { createLiquidationFieldFixture } from "../src/modules/liquidation-field/testing/fixtures.ts";

const fixture = createLiquidationFieldFixture();
assert.equal(
  bclifTimestampMsToChartSeconds(fixture.frames[0]!.timestamp),
  fixture.frames[0]!.timestamp / 1_000,
  "BCLIF millisecond timestamps must project into the chart's second-based time domain"
);
const settings = { ...DEFAULT_LIQUIDATION_FIELD_SETTINGS, timeColumns: 256, priceRows: 256, minimumConfidence: 0 };
const prior = createLeveragePrior("REGIME_ADAPTIVE", fixture.frames[40]!, fixture.rules.maxLeverage);
assert.ok(Math.abs(prior.buckets.reduce((sum, bucket) => sum + bucket.probability, 0) - 1) < 1e-9, "leverage prior must normalize to one");

const isolatedLong = estimateBybitLinearLiquidationDistribution(bybitLiquidationInput("LONG", 64_000, 64_000, 1_000_000, 20, fixture.rules, "ISOLATED"));
const isolatedShort = estimateBybitLinearLiquidationDistribution(bybitLiquidationInput("SHORT", 64_000, 64_000, 1_000_000, 20, fixture.rules, "ISOLATED"));
const unknownLong = estimateBybitLinearLiquidationDistribution(bybitLiquidationInput("LONG", 64_000, 64_000, 1_000_000, 20, fixture.rules, "UNKNOWN"));
const isolatedFiveXLong = estimateBybitLinearLiquidationDistribution(bybitLiquidationInput("LONG", 64_000, 64_000, 1_000_000, 5, fixture.rules, "ISOLATED"));
const isolatedFiftyXLong = estimateBybitLinearLiquidationDistribution(bybitLiquidationInput("LONG", 64_000, 64_000, 1_000_000, 50, fixture.rules, "ISOLATED"));
const isolatedFiveXShort = estimateBybitLinearLiquidationDistribution(bybitLiquidationInput("SHORT", 64_000, 64_000, 1_000_000, 5, fixture.rules, "ISOLATED"));
const isolatedFiftyXShort = estimateBybitLinearLiquidationDistribution(bybitLiquidationInput("SHORT", 64_000, 64_000, 1_000_000, 50, fixture.rules, "ISOLATED"));
assert.ok(isolatedLong.mean < 64_000, "long liquidation distribution must lie below entry");
assert.ok(isolatedShort.mean > 64_000, "short liquidation distribution must lie above entry");
assert.ok(unknownLong.standardDeviation > isolatedLong.standardDeviation, "unknown/cross margin must widen uncertainty");
assert.ok(isolatedFiveXLong.mean < isolatedFiftyXLong.mean, "lower-leverage longs must liquidate farther below entry");
assert.ok(isolatedFiveXShort.mean > isolatedFiftyXShort.mean, "lower-leverage shorts must liquidate farther above entry");

const engine = new LiquidationCohortEngine(fixture.rules, "REGIME_ADAPTIVE");
const paired = engine.processFrame(fixture.frames[0]!, []);
assert.ok(paired.cohorts.some((cohort) => cohort.side === "LONG"), "positive OI must create a long cohort hypothesis");
assert.ok(paired.cohorts.some((cohort) => cohort.side === "SHORT"), "positive OI must create a short cohort hypothesis");
assert.ok(paired.cohorts.every((cohort) => cohort.confidence < 1), "modeled cohorts must never masquerade as observed positions");
assert.ok(paired.particles.some((particle) => particle.marginMode === "ISOLATED_ESTIMATE"), "mixed-margin inference must retain narrow isolated cores");
assert.ok(paired.particles.some((particle) => particle.marginMode === "CROSS_ESTIMATE"), "mixed-margin inference must retain broad cross-margin uncertainty");

const started = performance.now();
const snapshot = buildLiquidationFieldSnapshot(fixture.frames, fixture.events, fixture.rules, settings, fixture.coverage);
const buildMs = performance.now() - started;
assert.equal(snapshot.header.columns, Math.min(settings.timeColumns, fixture.frames.length));
assert.equal(snapshot.header.rows, 256);
assert.equal(snapshot.certainty, "SYNTHETIC_TEST");
assert.ok(snapshot.longExposure.some((value) => value > 0), "long exposure channel must be populated");
assert.ok(snapshot.shortExposure.some((value) => value > 0), "short exposure channel must be populated");
assert.ok(snapshot.normalizedIntensity.some((value) => value > 150), "robust normalization must preserve bright shelves");
assert.equal(snapshot.confirmedEvents.length, fixture.events.length);
assert.ok(snapshot.header.checksum.startsWith("fnv1a-"));
assert.ok(buildMs < 8_000, `deterministic field build exceeded the safety boundary: ${buildMs.toFixed(1)}ms`);

const finalColumn = snapshot.normalizedIntensity.slice((snapshot.header.columns - 1) * snapshot.header.rows);
const finalMaximum = Math.max(...finalColumn);
let significantShelfCount = 0;
for (let row = 1; row < finalColumn.length - 1; row++) {
  if (
    finalColumn[row]! > finalColumn[row - 1]!
    && finalColumn[row]! >= finalColumn[row + 1]!
    && finalColumn[row]! >= finalMaximum * 0.18
  ) significantShelfCount += 1;
}
assert.ok(significantShelfCount >= 6, "selected leverage hypotheses must remain separated into multiple price shelves");

const reference = createThermalPalette("REFERENCE_THERMAL");
assert.deepEqual([...reference.slice(0, 3)], [7, 3, 16], "low exposure must remain dark purple rather than transparent black");
assert.deepEqual([...reference.slice(-4, -1)], [217, 227, 35], "extreme exposure must reach the reference yellow endpoint");

const absentOiFrames = fixture.frames.slice(0, 8).map((frame) => ({
  ...frame,
  openInterest: 0,
  openInterestDelta: 0,
  certainty: { ...frame.certainty, openInterest: "UNAVAILABLE" as const }
}));
const unavailable = buildLiquidationFieldSnapshot(absentOiFrames, [], fixture.rules, settings, {
  ...fixture.coverage,
  state: "UNAVAILABLE",
  openInterestCoveragePercent: 0
});
assert.ok(unavailable.validity.every((value) => value === 0), "missing OI intervals must remain explicit invalid cells");
assert.ok(unavailable.combinedExposure.every((value) => value === 0), "missing OI must not fabricate exposure");

console.log(JSON.stringify({
  decision: "PASS",
  model: snapshot.header.modelVersion,
  grid: `${snapshot.header.columns}x${snapshot.header.rows}`,
  cohorts: snapshot.cohorts.length,
  buildMs: Number(buildMs.toFixed(2)),
  checksum: snapshot.header.checksum
}, null, 2));
