import assert from "node:assert/strict";
import { LiquidationCohortEngine } from "../src/modules/liquidation-field/core/cohortEngine.ts";
import { buildCohortEntryDistribution } from "../src/modules/liquidation-field/core/entryDistribution.ts";
import { buildLiquidationFieldSnapshot, stableBrowserPriceGrid } from "../src/modules/liquidation-field/core/exposureRaster.ts";
import { extractBclifOperationalClusters } from "../src/modules/liquidation-field/core/operationalClusters.ts";
import {
  bybitOiIntervalForHorizon,
  DEFAULT_LIQUIDATION_FIELD_SETTINGS,
  migrateLiquidationFieldSettings
} from "../src/modules/liquidation-field/core/settings.ts";
import type {
  ConfirmedLiquidationEvent,
  LiquidationCoverage,
  LiquidationInstrumentRules,
  LiquidationMarketFrame
} from "../src/modules/liquidation-field/core/types.ts";
import {
  bclifExposureHash,
  bclifModelHash,
  buildBclifDisplayProjection
} from "../src/modules/liquidation-field/rendering/displayProjection.ts";

const START = 1_900_000_000_000;
const STEP = 5 * 60_000;
const SOURCE = "BCLIF_AUTHENTIC_EXPOSURE_FIXTURE_V1";

const rules: LiquidationInstrumentRules = {
  venue: "BYBIT",
  symbol: "BTCUSDT",
  contractType: "USDT_LINEAR_PERPETUAL",
  contractMultiplier: 1,
  maxLeverage: 100,
  leverageStep: 0.01,
  fundingIntervalMinutes: 480,
  riskTiers: [
    {
      tierId: "1",
      riskLimitValue: 25_000_000,
      maintenanceMarginRate: 0.005,
      initialMarginRate: 0.01,
      maintenanceMarginDeduction: 0,
      maxLeverage: 100,
      certainty: "OBSERVED"
    }
  ],
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
  minimumConfidence: 0,
  minimumNotionalUsd: 0
});

function frame(input: {
  index: number;
  price: number;
  openInterest: number;
  delta?: number;
  entryPrice?: number;
  interval?: boolean;
  trades?: "OBSERVED" | "MISSING" | "UNAVAILABLE";
  buy?: number;
  sell?: number;
  confirmed?: "OBSERVED" | "MISSING" | "UNAVAILABLE";
}): LiquidationMarketFrame {
  const timestamp = START + input.index * STEP;
  const delta = input.delta ?? 0;
  const interval = input.interval ?? input.index > 0;
  const intervalStart = interval ? timestamp - STEP : undefined;
  const intervalEnd = interval ? timestamp : undefined;
  const entryPrice = input.entryPrice ?? input.price;
  const entryDistribution = delta > 0 && intervalStart !== undefined && intervalEnd !== undefined
    ? buildCohortEntryDistribution({
        observations: [
          { price: entryPrice * 0.998, weight: 2 },
          { price: entryPrice, weight: 6 },
          { price: entryPrice * 1.002, weight: 2 }
        ],
        source: input.trades === "MISSING" || input.trades === "UNAVAILABLE"
          ? "LOWER_TF_APPROXIMATION"
          : "EXACT_TRADES",
        intervalStart,
        intervalEnd,
        confidence: input.trades === "MISSING" || input.trades === "UNAVAILABLE" ? 0.58 : 0.95,
        fallbackPrice: entryPrice
      })
    : undefined;
  return {
    venue: "BYBIT",
    symbol: "BTCUSDT",
    timestamp,
    lastPrice: input.price,
    markPrice: input.price,
    indexPrice: input.price,
    basisBps: 0,
    openInterest: input.openInterest,
    openInterestDelta: delta,
    oiIntervalStart: intervalStart,
    oiIntervalEnd: intervalEnd,
    entryDistribution,
    fundingRate: 0.0001,
    longAccountRatio: 0.5,
    shortAccountRatio: 0.5,
    aggressiveBuyNotional: input.buy ?? 1_000_000,
    aggressiveSellNotional: input.sell ?? 1_000_000,
    cvd: (input.buy ?? 1_000_000) - (input.sell ?? 1_000_000),
    cvdEfficiency: 0,
    realizedVolatility: 0.008,
    parkinsonVolatility: 0.009,
    bestBid: input.price - 0.5,
    bestAsk: input.price + 0.5,
    spreadBps: 0.16,
    bidDepthCurve: { points: [{ distanceBps: 5, notional: 20_000_000 }], certainty: "OBSERVED" },
    askDepthCurve: { points: [{ distanceBps: 5, notional: 20_000_000 }], certainty: "OBSERVED" },
    confirmedLongLiquidations: 0,
    confirmedShortLiquidations: 0,
    certainty: {
      trades: input.trades ?? "OBSERVED",
      openInterest: "OBSERVED",
      entryPrice: entryDistribution ? "DERIVED" : "UNAVAILABLE",
      leveragePrior: "DERIVED",
      marginModel: "DERIVED",
      confirmedLiquidations: input.confirmed ?? "OBSERVED",
      continuity: "OBSERVED",
      orderbook: "OBSERVED",
      funding: "OBSERVED",
      markPrice: "OBSERVED",
      positioning: "OBSERVED"
    },
    sourceVersion: SOURCE
  };
}

function engineRun(frames: readonly LiquidationMarketFrame[], events: readonly ConfirmedLiquidationEvent[] = []) {
  const engine = new LiquidationCohortEngine(rules, settings.modelPreset, {
    oiNoiseMethod: settings.oiNoiseMethod,
    oiNoiseAbsoluteNotionalUsd: settings.oiNoiseAbsoluteNotionalUsd,
    oiNoisePercent: settings.oiNoisePercent,
    oiNoiseMadMultiplier: settings.oiNoiseMadMultiplier,
    isolatedContributionCap: settings.isolatedContributionCap,
    crossContributionCap: settings.crossContributionCap,
    unknownContributionCap: settings.unknownContributionCap
  });
  let state = engine.snapshot();
  for (const value of frames) state = engine.processFrame(value, events);
  return { engine, state };
}

function conservation(state: ReturnType<LiquidationCohortEngine["snapshot"]>) {
  const ledger = state.massLedger;
  const expected = ledger.totalCreatedMass - ledger.voluntaryClosureMass
    - ledger.confirmedLiquidationMass - ledger.decayExpiryMass;
  assert.ok(Math.abs(expected - ledger.totalRemainingMass) <= ledger.tolerance);
  assert.ok(Math.abs(ledger.conservationError) <= ledger.tolerance);
}

const swingFrames = [64_000, 72_000, 58_000, 76_000, 55_000, 70_000, 60_000]
  .map((price, index) => frame({ index, price, openInterest: 100_000, delta: 0, interval: index > 0 }));
const swingOnly = engineRun(swingFrames).state;
assert.equal(swingOnly.cohorts.length, 0, "price swings with flat OI must not invent position cohorts");
assert.equal(swingOnly.massLedger.totalCreatedMass, 0);

const deltaWithoutInterval = engineRun([
  frame({ index: 0, price: 64_000, openInterest: 100_000, interval: false }),
  frame({ index: 1, price: 68_000, openInterest: 100_100, delta: 100, interval: false })
]).state;
assert.equal(deltaWithoutInterval.cohorts.length, 0, "unbounded chart-bar deltas must not create authentic cohorts");

const noisy = engineRun([
  frame({ index: 0, price: 64_000, openInterest: 100_000, interval: false }),
  frame({ index: 1, price: 66_000, openInterest: 100_000.5, delta: 0.5 })
]).state;
assert.equal(noisy.cohorts.length, 0, "sub-threshold OI noise must be ignored");

const birthFrames = [
  frame({ index: 0, price: 64_000, openInterest: 100_000, interval: false }),
  frame({ index: 1, price: 70_000, entryPrice: 62_000, openInterest: 100_100, delta: 100, buy: 99_000_000, sell: 1 })
];
const firstBirth = engineRun(birthFrames).state;
const repeatedBirth = engineRun(birthFrames).state;
assert.equal(firstBirth.cohorts.length, 2, "one OI expansion must create one paired long/short hypothesis");
assert.deepEqual(firstBirth.cohorts.map((cohort) => cohort.id), repeatedBirth.cohorts.map((cohort) => cohort.id), "cohort IDs must be content-stable");
const longBirth = firstBirth.cohorts.find((cohort) => cohort.side === "LONG")!;
const shortBirth = firstBirth.cohorts.find((cohort) => cohort.side === "SHORT")!;
assert.equal(longBirth.initialOpenMass, shortBirth.initialOpenMass, "an OI expansion is paired gross exposure, not directional flow");
assert.equal(longBirth.massUnit, "QUOTE_NOTIONAL");
assert.equal(shortBirth.massUnit, "QUOTE_NOTIONAL");
assert.equal(longBirth.initialOpenMass, 100 * 70_000 * rules.contractMultiplier,
  "single-side OI is represented once as equal gross long and short quote-notional hypotheses");
assert.ok(Math.abs(longBirth.riskTierDistribution.reduce((sum, tier) => sum + tier.weight, 0) - 1) < 1e-12);
assert.ok(Math.abs(shortBirth.riskTierDistribution.reduce((sum, tier) => sum + tier.weight, 0) - 1) < 1e-12);
assert.ok(Math.abs(longBirth.entryMean - 62_000) < 50 && Math.abs(shortBirth.entryMean - 62_000) < 50);
assert.ok(longBirth.liquidationMean < longBirth.entryMean && shortBirth.liquidationMean > shortBirth.entryMean);
assert.equal(firstBirth.lifecycleEvents.filter((event) => event.kind === "BIRTH").length, 2);
conservation(firstBirth);

const reversedFlowBirth = engineRun([
  birthFrames[0]!,
  frame({ index: 1, price: 70_000, entryPrice: 62_000, openInterest: 100_100, delta: 100, buy: 1, sell: 99_000_000 })
]).state;
assert.deepEqual(
  firstBirth.cohorts.map((cohort) => [cohort.id, cohort.initialOpenMass]),
  reversedFlowBirth.cohorts.map((cohort) => [cohort.id, cohort.initialOpenMass]),
  "trade imbalance may refine confidence, but cannot fabricate one-sided OI mass"
);

const anchored = engineRun([
  ...birthFrames,
  frame({ index: 2, price: 88_000, openInterest: 100_100, delta: 0 }),
  frame({ index: 3, price: 48_000, openInterest: 100_100, delta: 0 })
]).state;
for (const cohort of firstBirth.cohorts) {
  const after = anchored.cohorts.find((candidate) => candidate.id === cohort.id)!;
  assert.equal(after.liquidationMean, cohort.liquidationMean, "current price must not re-center a born liquidation distribution");
  assert.equal(after.entryMean, cohort.entryMean, "entry anchors are immutable after cohort birth");
}
conservation(anchored);

const contraction = engineRun([
  ...birthFrames,
  frame({ index: 2, price: 70_000, openInterest: 100_060, delta: -40 })
]).state;
assert.equal(contraction.cohorts.length, 2, "negative OI must reduce existing mass, not create a new shelf");
assert.ok(contraction.massLedger.voluntaryClosureMass > 0);
assert.ok(contraction.cohorts.every((cohort) => cohort.remainingMass < cohort.initialOpenMass));
assert.ok(contraction.lifecycleEvents.some((event) => event.kind === "OI_CONTRACTION"));
conservation(contraction);

const eventEngine = engineRun(birthFrames).engine;
const eventBirth = eventEngine.snapshot();
const eventLong = eventBirth.cohorts.find((cohort) => cohort.side === "LONG")!;
const eventTimestamp = START + 2 * STEP;
const confirmedEvent: ConfirmedLiquidationEvent = {
  id: "AUTHENTIC-LONG-1",
  venue: "BYBIT",
  symbol: "BTCUSDT",
  timestamp: eventTimestamp - 100,
  receivedAt: eventTimestamp,
  liquidatedPositionSide: "LONG",
  quantity: 10,
  bankruptcyPrice: eventLong.liquidationMean,
  notional: Math.min(1_000_000, eventLong.remainingMass / 4),
  certainty: "OBSERVED",
  sourceVersion: SOURCE
};
const eventState = eventEngine.processFrame(
  frame({ index: 2, price: eventLong.liquidationMean, openInterest: 100_100, delta: 0 }),
  [confirmedEvent]
);
assert.ok(eventState.massLedger.confirmedLiquidationMass > 0);
assert.ok(eventState.lifecycleEvents.some((event) => event.kind === "CONFIRMED_LIQUIDATION" && event.evidenceId === confirmedEvent.id));
conservation(eventState);

const weights = new Map<string, number>();
for (const particle of firstBirth.particles.filter((particle) => particle.side === "LONG")) {
  weights.set(particle.uncertaintyClass, (weights.get(particle.uncertaintyClass) ?? 0) + particle.weight);
}
assert.ok(Math.abs((weights.get("ISOLATED_ESTIMATE") ?? 0) - settings.isolatedContributionCap) < 1e-9);
assert.ok(Math.abs((weights.get("CROSS_ESTIMATE") ?? 0) - settings.crossContributionCap) < 1e-9);
assert.ok(Math.abs((weights.get("UNKNOWN") ?? 0) - settings.unknownContributionCap) < 1e-9);
const isolated = firstBirth.particles.find((particle) => particle.uncertaintyClass === "ISOLATED_ESTIMATE")!;
const cross = firstBirth.particles.find((particle) => particle.uncertaintyClass === "CROSS_ESTIMATE" && particle.leverage === isolated.leverage)!;
assert.ok(cross.liquidationStdDev > isolated.liquidationStdDev && cross.confidence < isolated.confidence);

const oiOnly = engineRun([
  frame({ index: 0, price: 64_000, openInterest: 100_000, interval: false, trades: "MISSING" }),
  frame({ index: 1, price: 65_000, openInterest: 100_100, delta: 100, trades: "MISSING" })
]).state;
assert.ok(oiOnly.particles.every((particle) => particle.confidence <= 0.6), "historical OI-only context must be authority-capped");

const modelFrames = [
  frame({ index: 0, price: 64_000, openInterest: 100_000, interval: false }),
  frame({ index: 1, price: 64_200, openInterest: 100_080, delta: 80, entryPrice: 64_100 }),
  frame({ index: 2, price: 63_900, openInterest: 100_080, delta: 0 }),
  frame({ index: 3, price: 64_600, openInterest: 100_150, delta: 70, entryPrice: 64_350 }),
  frame({ index: 4, price: 64_300, openInterest: 100_125, delta: -25 }),
  frame({ index: 5, price: 64_800, openInterest: 100_125, delta: 0 }),
  frame({ index: 6, price: 64_100, openInterest: 100_190, delta: 65, entryPrice: 64_500 }),
  frame({ index: 7, price: 63_800, openInterest: 100_190, delta: 0 }),
  frame({ index: 8, price: 64_050, openInterest: 100_190, delta: 0 }),
  frame({ index: 9, price: 64_400, openInterest: 100_190, delta: 0 })
];
const coverage: LiquidationCoverage = {
  venue: "BYBIT",
  symbol: "BTCUSDT",
  horizon: "6H",
  requestedStart: modelFrames[0]!.timestamp,
  requestedEnd: modelFrames.at(-1)!.timestamp,
  availableStart: modelFrames[0]!.timestamp,
  availableEnd: modelFrames.at(-1)!.timestamp,
  observedTradeCoveragePercent: 100,
  openInterestCoveragePercent: 100,
  liquidationEventCoveragePercent: 100,
  orderbookCoveragePercent: 100,
  modelContinuityPercent: 100,
  missingIntervals: [],
  quality: "EXCELLENT",
  state: "SYNTHETIC_TEST"
};
const prefixCoverage = { ...coverage, requestedEnd: modelFrames[6]!.timestamp, availableEnd: modelFrames[6]!.timestamp };
const prefix = buildLiquidationFieldSnapshot(modelFrames.slice(0, 7), [], rules, settings, prefixCoverage);
const full = buildLiquidationFieldSnapshot(modelFrames, [], rules, settings, coverage);
assert.equal(prefix.header.gridOrigin, full.header.gridOrigin);
assert.equal(prefix.header.gridVersion, full.header.gridVersion);
assert.equal(prefix.header.minPrice, full.header.minPrice);
assert.equal(prefix.header.priceStep, full.header.priceStep);
for (let column = 0; column < prefix.header.columns; column += 1) {
  assert.equal(prefix.timestamps[column], full.timestamps[column], "historical time columns must remain append-stable");
  const start = column * prefix.header.rows;
  const end = start + prefix.header.rows;
  assert.deepEqual(full.longExposure.slice(start, end), prefix.longExposure.slice(start, end));
  assert.deepEqual(full.shortExposure.slice(start, end), prefix.shortExposure.slice(start, end));
  assert.deepEqual(full.normalizedIntensity.slice(start, end), prefix.normalizedIntensity.slice(start, end));
}

const chunked = [...modelFrames.slice(5), ...modelFrames.slice(0, 6), modelFrames[5]!];
const canonicalChunked = [...new Map(chunked.map((value) => [value.timestamp, value])).values()]
  .sort((left, right) => left.timestamp - right.timestamp);
const rebuilt = buildLiquidationFieldSnapshot(canonicalChunked, [], rules, settings, coverage);
assert.equal(bclifModelHash(full), bclifModelHash(rebuilt), "fetch pagination/chunking must not change cohort identity");
assert.equal(bclifExposureHash(full), bclifExposureHash(rebuilt));

const chartContexts = [
  { chartPriceMinimum: 61_000, chartPriceMaximum: 68_000, currentPrice: 64_400, plotWidth: 700, plotHeight: 420, constrainedTouchRenderer: false },
  { chartPriceMinimum: 45_000, chartPriceMaximum: 90_000, currentPrice: 64_400, plotWidth: 1_900, plotHeight: 1_100, constrainedTouchRenderer: false }
];
const modelHashBeforeProjection = bclifModelHash(full);
const exposureHashBeforeProjection = bclifExposureHash(full);
const projections = chartContexts.map((context) => buildBclifDisplayProjection(full, settings, context));
assert.ok(projections.every(Boolean));
assert.equal(bclifModelHash(full), modelHashBeforeProjection, "viewport changes must remain projection-only");
assert.equal(bclifExposureHash(full), exposureHashBeforeProjection);
assert.notEqual(projections[0]!.displayRasterHash, projections[1]!.displayRasterHash);

const gridA = stableBrowserPriceGrid(64_000, 0.5, 1_024, 0.52);
const gridB = stableBrowserPriceGrid(64_000, 0.5, 1_024, 0.52);
assert.deepEqual(gridA, gridB);
assert.ok(gridA.minPrice > 0 && gridA.priceStep % 0.5 === 0);

for (const horizon of ["6H", "12H", "1D", "3D", "1W", "3W", "1M", "CUSTOM"] as const) {
  assert.equal(bybitOiIntervalForHorizon(horizon), "5min", `${horizon} must use the canonical five-minute OI clock`);
}

const clusters = extractBclifOperationalClusters(full, 64_400, { ...settings, maximumClusterLabels: 6 });
assert.ok(clusters.length > 0);
assert.ok(clusters.every((cluster) => cluster.cohortIds.length > 0 && cluster.provenanceCoverage > 0));
assert.ok(clusters.every((cluster) => Number.isFinite(cluster.exposureConcentration)
  && Number.isFinite(cluster.shelfWidth) && Number.isFinite(cluster.priceEntropy)));

const unavailableFrames = modelFrames.map((value, index) => index === 5
  ? { ...value, certainty: { ...value.certainty, openInterest: "MISSING" as const } }
  : value);
const withMissing = buildLiquidationFieldSnapshot(unavailableFrames, [], rules, settings, coverage);
assert.equal(withMissing.validity[5 * withMissing.header.rows], 0, "missing evidence is not zero exposure");

console.log(JSON.stringify({
  decision: "PASS",
  invariants: 24,
  modelHash: bclifModelHash(full),
  exposureHash: bclifExposureHash(full),
  cohorts: full.cohorts.length,
  clusters: clusters.length,
  massError: full.massLedger.conservationError,
  browserGrid: gridA
}, null, 2));
