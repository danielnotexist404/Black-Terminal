import assert from "node:assert/strict";
import { LiquidationCohortEngine } from "../src/modules/liquidation-field/core/cohortEngine.ts";
import { buildCohortEntryDistribution } from "../src/modules/liquidation-field/core/entryDistribution.ts";
import {
  buildLiquidationFieldSnapshot,
  stableBrowserPriceGrid
} from "../src/modules/liquidation-field/core/exposureRaster.ts";
import { normalizeExposureExpanding } from "../src/modules/liquidation-field/core/normalization.ts";
import {
  DEFAULT_LIQUIDATION_FIELD_SETTINGS,
  migrateLiquidationFieldSettings
} from "../src/modules/liquidation-field/core/settings.ts";
import { buildBclifRawExposureExport } from "../src/modules/liquidation-field/core/rawShelfDiagnostics.ts";
import { LiquidationFieldTileCache } from "../src/modules/liquidation-field/data/LiquidationFieldTileCache.ts";
import type {
  LiquidationCoverage,
  LiquidationInstrumentRules,
  LiquidationMarketFrame
} from "../src/modules/liquidation-field/core/types.ts";
import {
  bclifExposureHash,
  bclifModelHash,
  buildBclifDisplayProjection
} from "../src/modules/liquidation-field/rendering/displayProjection.ts";

const START = 1_901_000_000_000;
const STEP = 5 * 60_000;
const SOURCE = "BCLIF_IIIC4_LIVE_PIPELINE_FIXTURE_V1";
const rules: LiquidationInstrumentRules = {
  venue: "BYBIT",
  symbol: "BTCUSDT",
  contractType: "USDT_LINEAR_PERPETUAL",
  contractMultiplier: 1,
  maxLeverage: 100,
  leverageStep: 0.01,
  fundingIntervalMinutes: 480,
  riskTiers: [{
    tierId: "1",
    riskLimitValue: 100_000_000,
    maintenanceMarginRate: 0.005,
    initialMarginRate: 0.01,
    maintenanceMarginDeduction: 0,
    maxLeverage: 100,
    certainty: "OBSERVED"
  }],
  fetchedAt: START,
  sourceVersion: SOURCE,
  certainty: "OBSERVED",
  tickSize: 0.5
};
const settings = migrateLiquidationFieldSettings({
  ...DEFAULT_LIQUIDATION_FIELD_SETTINGS,
  horizon: "6H",
  priceRows: 256,
  timeColumns: 256,
  smoothing: "SHARP",
  leverageMinimum: 2,
  leverageMaximum: 5,
  minimumConfidence: 0,
  minimumNotionalUsd: 0,
  oiNoiseAbsoluteNotionalUsd: 10_000,
  oiNoisePercent: 0,
  oiNoiseMadMultiplier: 0,
  oiEventWindowMs: 15 * 60_000,
  oiEventHysteresisIntervals: 2
});

function frame(index: number, price: number, openInterest: number, delta = 0, entryPrice = price): LiquidationMarketFrame {
  const timestamp = START + index * STEP;
  const intervalStart = index > 0 ? timestamp - STEP : undefined;
  const intervalEnd = index > 0 ? timestamp : undefined;
  return {
    venue: "BYBIT",
    symbol: "BTCUSDT",
    timestamp,
    lastPrice: price,
    markPrice: price,
    indexPrice: price,
    basisBps: 0,
    openInterest,
    openInterestDelta: delta,
    oiIntervalStart: intervalStart,
    oiIntervalEnd: intervalEnd,
    entryDistribution: delta > 0 && intervalStart !== undefined && intervalEnd !== undefined
      ? buildCohortEntryDistribution({
          observations: [
            { price: entryPrice * 0.999, weight: 1 },
            { price: entryPrice, weight: 8 },
            { price: entryPrice * 1.001, weight: 1 }
          ],
          source: "LOWER_TF_APPROXIMATION",
          intervalStart,
          intervalEnd,
          confidence: 0.58,
          fallbackPrice: entryPrice
        })
      : undefined,
    fundingRate: 0.0001,
    longAccountRatio: 0.5,
    shortAccountRatio: 0.5,
    aggressiveBuyNotional: 0,
    aggressiveSellNotional: 0,
    cvd: 0,
    cvdEfficiency: 0,
    realizedVolatility: 0.006,
    parkinsonVolatility: 0.007,
    bestBid: price - 0.5,
    bestAsk: price + 0.5,
    spreadBps: 0.2,
    bidDepthCurve: { points: [], certainty: "UNAVAILABLE" },
    askDepthCurve: { points: [], certainty: "UNAVAILABLE" },
    confirmedLongLiquidations: 0,
    confirmedShortLiquidations: 0,
    certainty: {
      openInterest: "OBSERVED",
      trades: "UNAVAILABLE",
      entryPrice: "ESTIMATED_LOW",
      leverage: "DERIVED",
      marginModel: "DERIVED",
      confirmedLiquidations: "UNAVAILABLE",
      continuity: "OBSERVED",
      orderbook: "UNAVAILABLE",
      funding: "OBSERVED",
      markPrice: "OBSERVED",
      positioning: "OBSERVED"
    },
    sourceVersion: SOURCE
  };
}

function coverage(frames: readonly LiquidationMarketFrame[]): LiquidationCoverage {
  return {
    venue: "BYBIT",
    symbol: "BTCUSDT",
    horizon: "6H",
    requestedStart: frames[0]!.timestamp,
    requestedEnd: frames.at(-1)!.timestamp,
    availableStart: frames[0]!.timestamp,
    availableEnd: frames.at(-1)!.timestamp,
    observedTradeCoveragePercent: 0,
    openInterestCoveragePercent: 100,
    liquidationEventCoveragePercent: 0,
    orderbookCoveragePercent: 0,
    modelContinuityPercent: 100,
    missingIntervals: [],
    quality: "MIXED",
    state: "LIVE"
  };
}

const grouped = new LiquidationCohortEngine(rules, settings.modelPreset, settings);
grouped.processFrame(frame(0, 65_000, 100_000));
grouped.processFrame(frame(1, 58_000, 100_030, 30, 58_000));
grouped.processFrame(frame(2, 58_200, 100_055, 25, 58_100));
const beforeClose = grouped.processFrame(frame(3, 58_100, 100_075, 20, 58_050));
assert.equal(beforeClose.cohorts.length, 2, "three related OI observations must create one paired event family, not six cohorts");
assert.equal(beforeClose.lifecycleEvents.filter((event) => event.kind === "BIRTH").length, 2);
assert.equal(beforeClose.cohorts[0]!.sourceIntervalStart, START + STEP - STEP);
assert.equal(beforeClose.cohorts[0]!.sourceIntervalEnd, START + 3 * STEP);

const hysteresis = new LiquidationCohortEngine(rules, settings.modelPreset, settings);
hysteresis.processFrame(frame(0, 65_000, 100_000));
hysteresis.processFrame(frame(1, 64_000, 100_040, 40, 64_000));
assert.equal(hysteresis.processFrame(frame(2, 64_100, 100_040, 0)).cohorts.length, 0);
assert.equal(hysteresis.processFrame(frame(3, 64_050, 100_040, 0)).cohorts.length, 2,
  "two quiet intervals must causally close the event window");

const anchorFrames = [
  frame(0, 65_000, 100_000),
  frame(1, 58_000, 100_040, 40, 58_000),
  frame(2, 58_100, 100_040, 0),
  frame(3, 58_100, 100_040, 0),
  frame(4, 72_000, 100_075, 35, 72_000),
  frame(5, 72_100, 100_075, 0),
  frame(6, 72_100, 100_075, 0)
];
const absoluteGrid = stableBrowserPriceGrid(65_000, 0.5, settings.priceRows, 0.6);
const marks = [62_000, 66_000, 70_000, 60_000, 75_000];
const perturbed = marks.map((mark) => {
  const frames = [...anchorFrames, frame(7, mark, 100_075, 0)];
  return buildLiquidationFieldSnapshot(frames, [], rules, settings, coverage(frames), absoluteGrid);
});
const baseline = perturbed[0]!;
for (const snapshot of perturbed.slice(1)) {
  assert.equal(bclifModelHash(snapshot), bclifModelHash(baseline), "current mark must not change immutable cohort anchors");
  assert.equal(bclifExposureHash(snapshot), bclifExposureHash(baseline), "current mark must not translate the raw exposure field");
  assert.deepEqual(snapshot.absoluteDistribution, baseline.absoluteDistribution);
  assert.deepEqual(
    snapshot.rawCohortShelves?.map((shelf) => [shelf.cohortId, shelf.liquidationMean, shelf.liquidationLower, shelf.liquidationUpper]),
    baseline.rawCohortShelves?.map((shelf) => [shelf.cohortId, shelf.liquidationMean, shelf.liquidationLower, shelf.liquidationUpper])
  );
}

const exposure = new Float32Array([
  8_000, 9_000, 10_000, 11_000, 12_000, 13_000, 14_000, 15_000,
  1, 5, 10, 20, 2, 4, 8, 16
]);
const validity = new Uint8Array(exposure.length).fill(255);
const confidence = new Uint8Array(exposure.length).fill(255);
const expanding = normalizeExposureExpanding(exposure, confidence, validity, 2, 8, settings);
assert.ok(expanding.normalized[11]! < 255, "a later weak local maximum must not receive a fresh per-column maximum");
assert.ok(expanding.highs[1]! >= expanding.highs[0]!, "expanding normalization may not forget stronger historical context");

const browserSnapshot = {
  ...baseline,
  authority: "BROWSER_FALLBACK" as const,
  coverage: {
    ...baseline.coverage,
    observedTradeCoveragePercent: 0,
    liquidationEventCoveragePercent: 0,
    orderbookCoveragePercent: 0,
    modelContinuityPercent: 100,
    state: "LIVE" as const
  }
};
const projection = buildBclifDisplayProjection(browserSnapshot, settings, {
  chartPriceMinimum: 45_000,
  chartPriceMaximum: 90_000,
  currentPrice: 65_000,
  plotWidth: 1_200,
  plotHeight: 700,
  constrainedTouchRenderer: false
})!;
assert.equal(projection.yellowEligibleCells, 0, "historical browser OI-only context must never claim yellow authority");

const exported = buildBclifRawExposureExport(browserSnapshot);
assert.equal(exported.contract, "BCLIF_ABSOLUTE_RAW_EXPOSURE_V1");
assert.equal(exported.absoluteDistribution.priceUnit, "QUOTE_PRICE");
assert.equal(exported.longExposure.length, baseline.header.rows * baseline.header.columns);
assert.ok(exported.highIntensityCellAudit.length > 0 && exported.highIntensityCellAudit.length <= 20);
assert.ok(exported.highIntensityCellAudit.every((cell) => Number.isFinite(cell.rawCombinedExposure)
  && Number.isFinite(cell.globalNormalizedIntensity) && Number.isFinite(cell.columnPercentile)));

const cache = new LiquidationFieldTileCache<string>(1024);
const legacyIdentity = {
  venue: "BYBIT",
  symbol: "BTCUSDT",
  horizon: "6H",
  tileId: "tile-absolute-1",
  modelVersion: "BCLIF_MODEL_V5_AUTHENTIC_EXPOSURE",
  schemaVersion: 1,
  checksum: "sha256:legacy"
};
assert.equal(cache.set(legacyIdentity, "legacy", 64), true);
cache.invalidateVersions({ ...legacyIdentity, modelVersion: baseline.header.modelVersion });
assert.equal(cache.get(legacyIdentity), undefined, "a corrected V6 request may not reuse a V5 decoded tile");
assert.equal(cache.metrics().entries, 0);

console.log(JSON.stringify({
  decision: "PASS",
  result: "RAW_SHELVES_HORIZONTAL_THERMAL_PIPELINE_CORRECTED",
  markPerturbations: marks,
  modelHash: bclifModelHash(baseline),
  exposureHash: bclifExposureHash(baseline),
  eventFamilies: beforeClose.cohorts.length / 2,
  rawShelves: baseline.rawCohortShelves?.length ?? 0,
  yellowBrowserHistorical: projection.yellowEligibleCells,
  normalization: "CAUSAL_EXPANDING_WITH_12_PERCENT_VISIBLE_CONTRAST",
  exportCellsAudited: exported.highIntensityCellAudit.length,
  legacyCacheEntriesAfterV6Invalidation: cache.metrics().entries
}, null, 2));
