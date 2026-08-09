import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { bybitLiquidationInput, estimateBybitLinearLiquidationDistribution } from "../src/modules/liquidation-field/core/bybitLiquidationModel.ts";
import { LiquidationCohortEngine } from "../src/modules/liquidation-field/core/cohortEngine.ts";
import { buildLiquidationFieldSnapshot, outputFrameIndices } from "../src/modules/liquidation-field/core/exposureRaster.ts";
import { createLeveragePrior } from "../src/modules/liquidation-field/core/leveragePriors.ts";
import { normalizeExposure, normalizeExposureCausal, smoothField } from "../src/modules/liquidation-field/core/normalization.ts";
import { DEFAULT_LIQUIDATION_FIELD_SETTINGS } from "../src/modules/liquidation-field/core/settings.ts";
import { bclifThermalBackdropStyle, createThermalPalette } from "../src/modules/liquidation-field/rendering/thermalPalette.ts";
import { bclifTimestampMsToChartSeconds } from "../src/modules/liquidation-field/rendering/timeProjection.ts";
import { createLiquidationFieldFixture } from "../src/modules/liquidation-field/testing/fixtures.ts";

const fixture = createLiquidationFieldFixture();
assert.equal(
  bclifTimestampMsToChartSeconds(fixture.frames[0]!.timestamp),
  fixture.frames[0]!.timestamp / 1_000,
  "BCLIF millisecond timestamps must project into the chart's second-based time domain"
);
const settings = { ...DEFAULT_LIQUIDATION_FIELD_SETTINGS, timeColumns: 256, priceRows: 256, contextVisibilityFloor: 0, clusterLabelFloor: 0 };
const visualColumnIndices = outputFrameIndices(fixture.frames, { ...settings, timeColumns: 512 });
assert.ok(visualColumnIndices.size <= 512, "the high-resolution visual fixture must respect the configured GPU column ceiling");
assert.ok(visualColumnIndices.size >= 480, "the high-resolution visual fixture must retain dense multi-week time detail");

const normalizationExposure = new Float32Array([1_000, 10_000, 100_000, 1_000_000]);
const normalizationValidity = new Uint8Array(4).fill(255);
const uniformMediumConfidence = new Uint8Array(4).fill(Math.round(255 * 0.6));
const mediumConfidenceNormalization = normalizeExposure(
  normalizationExposure,
  uniformMediumConfidence,
  normalizationValidity,
  { ...settings, lowQuantile: 0, highQuantile: 1, gamma: 1, scale: "CONFIDENCE_WEIGHTED_LOG" }
);
assert.equal(
  Math.max(...mediumConfidenceNormalization.normalized),
  255,
  "uniform medium confidence must preserve full relative thermal dynamic range"
);
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
let paired = engine.processFrame(fixture.frames[0]!, []);
for (const frame of fixture.frames.slice(1, 121)) paired = engine.processFrame(frame, []);
assert.ok(paired.cohorts.some((cohort) => cohort.side === "LONG"), "positive OI must create a long cohort hypothesis");
assert.ok(paired.cohorts.some((cohort) => cohort.side === "SHORT"), "positive OI must create a short cohort hypothesis");
assert.ok(paired.cohorts.every((cohort) => cohort.confidence < 1), "modeled cohorts must never masquerade as observed positions");
assert.ok(paired.particles.some((particle) => particle.marginMode === "ISOLATED_ESTIMATE"), "mixed-margin inference must retain narrow isolated cores");
assert.ok(paired.particles.some((particle) => particle.marginMode === "CROSS_ESTIMATE"), "mixed-margin inference must retain broad cross-margin uncertainty");

const missingOiEngine = new LiquidationCohortEngine(fixture.rules, "REGIME_ADAPTIVE");
const missingOiFrame = {
  ...fixture.frames[0]!,
  certainty: { ...fixture.frames[0]!.certainty, openInterest: "MISSING" as const }
};
assert.equal(
  missingOiEngine.processFrame(missingOiFrame, []).cohorts.length,
  0,
  "missing OI must not create numerical cohorts from placeholder values"
);

const uninterrupted = new LiquidationCohortEngine(fixture.rules, "REGIME_ADAPTIVE");
const resumed = new LiquidationCohortEngine(fixture.rules, "REGIME_ADAPTIVE");
for (const frame of fixture.frames.slice(0, 80)) uninterrupted.processFrame(frame, fixture.events);
resumed.importState(uninterrupted.exportState());
for (const frame of fixture.frames.slice(80, 100)) {
  uninterrupted.processFrame(frame, fixture.events);
  resumed.processFrame(frame, fixture.events);
}
assert.deepEqual(resumed.exportState(), uninterrupted.exportState(), "checkpoint recovery must resume without duplicating or losing cohort state");

const causalExposure = new Float32Array([
  1, 4, 16, 64,
  2, 8, 32, 128,
  3, 12, 48, 192
]);
const causalConfidence = new Uint8Array(causalExposure.length).fill(255);
const causalValidity = new Uint8Array(causalExposure.length).fill(255);
const firstTwoColumns = normalizeExposureCausal(
  causalExposure.slice(0, 8), causalConfidence.slice(0, 8), causalValidity.slice(0, 8), 2, 4,
  { ...settings, lowQuantile: 0, highQuantile: 1, gamma: 1 }, 2
);
const withFutureColumn = normalizeExposureCausal(
  causalExposure, causalConfidence, causalValidity, 3, 4,
  { ...settings, lowQuantile: 0, highQuantile: 1, gamma: 1 }, 2
);
assert.deepEqual(
  [...withFutureColumn.normalized.slice(0, 8)],
  [...firstTwoColumns.normalized],
  "future exposure must not rewrite historical normalized columns"
);
const smoothedPast = smoothField(causalExposure.slice(0, 8), causalValidity.slice(0, 8), 2, 4, 1, 0,);
const smoothedWithFuture = smoothField(causalExposure, causalValidity, 3, 4, 1, 0);
assert.deepEqual(
  [...smoothedWithFuture.slice(0, 8)],
  [...smoothedPast],
  "future exposure must not leak through the time smoother"
);

const prefixFrames = fixture.frames.slice(0, 60);
const futureBase = prefixFrames.at(-1)!;
const appendedExtreme = {
  ...futureBase,
  timestamp: futureBase.timestamp + 2 * 60 * 60 * 1_000,
  lastPrice: futureBase.lastPrice * 4,
  markPrice: futureBase.markPrice * 4,
  indexPrice: futureBase.indexPrice * 4,
  bestBid: futureBase.bestBid * 4,
  bestAsk: futureBase.bestAsk * 4,
  openInterestDelta: Math.max(1, futureBase.openInterestDelta)
};
const prefixSettings = { ...settings, timeColumns: 128, priceRows: 64 };
const prefixSnapshot = buildLiquidationFieldSnapshot(prefixFrames, [], fixture.rules, prefixSettings, fixture.coverage);
const withExtremeFuture = buildLiquidationFieldSnapshot([...prefixFrames, appendedExtreme], [], fixture.rules, prefixSettings, fixture.coverage);
const historicalCells = prefixSnapshot.header.columns * prefixSnapshot.header.rows;
assert.deepEqual(
  [...withExtremeFuture.combinedExposure.slice(0, historicalCells)],
  [...prefixSnapshot.combinedExposure],
  "a future price extreme must not move or rewrite historical exposure cells"
);
assert.deepEqual(
  [...withExtremeFuture.normalizedIntensity.slice(0, historicalCells)],
  [...prefixSnapshot.normalizedIntensity],
  "a future price extreme must not renormalize historical thermal intensity"
);

const lateEvent = {
  ...fixture.events[0]!,
  id: "late-arrival-causality-test",
  timestamp: prefixFrames[8]!.timestamp,
  receivedAt: prefixFrames[20]!.timestamp
};
const beforeLateArrival = buildLiquidationFieldSnapshot(
  prefixFrames.slice(0, 20),
  [lateEvent],
  fixture.rules,
  prefixSettings,
  fixture.coverage
);
assert.ok(
  beforeLateArrival.confirmedIntensity.every((value) => value === 0),
  "a liquidation received after the replay cutoff must not appear in historical cells"
);

const started = performance.now();
const snapshot = buildLiquidationFieldSnapshot(fixture.frames, fixture.events, fixture.rules, settings, fixture.coverage);
const buildMs = performance.now() - started;
assert.ok(snapshot.header.columns > 0 && snapshot.header.columns <= Math.min(settings.timeColumns, fixture.frames.length));
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
assert.deepEqual([...reference.slice(0, 3)], [22, 0, 39], "low exposure must remain deep plasma rather than transparent black");
assert.deepEqual([...reference.slice(-4, -1)], [255, 240, 74], "extreme exposure must reach the crisp plasma-yellow endpoint");
assert.deepEqual(bclifThermalBackdropStyle("REFERENCE_THERMAL"), {
  top: 0x28003f, middle: 0x071435, bottom: 0x31003d, invalid: 0x23003c
});
const blood = createThermalPalette("BLACK_TERMINAL_BLOOD");
assert.deepEqual([...blood.slice(0, 3)], [3, 2, 5], "Black Terminal thermal background must remain near-black");
assert.deepEqual([...blood.slice(-4, -1)], [255, 255, 255], "Black Terminal thermal cores must reach white");
assert.deepEqual(bclifThermalBackdropStyle("BLACK_TERMINAL_BLOOD"), {
  top: 0x210007, middle: 0x080205, bottom: 0x260008, invalid: 0x120207
});

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

const missing = buildLiquidationFieldSnapshot(
  absentOiFrames.map((frame) => ({ ...frame, certainty: { ...frame.certainty, openInterest: "MISSING" as const } })),
  [],
  fixture.rules,
  settings,
  { ...fixture.coverage, state: "UNAVAILABLE", openInterestCoveragePercent: 0 }
);
assert.ok(missing.validity.every((value) => value === 0), "MISSING OI must remain invalid rather than a zero-valued observation");

console.log(JSON.stringify({
  decision: "PASS",
  model: snapshot.header.modelVersion,
  grid: `${snapshot.header.columns}x${snapshot.header.rows}`,
  cohorts: snapshot.cohorts.length,
  buildMs: Number(buildMs.toFixed(2)),
  checksum: snapshot.header.checksum
}, null, 2));
