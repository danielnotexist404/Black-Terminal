import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { calculateBCTERA } from "../src/modules/bc-tera/core/engine.ts";
import { migrateBCTERASettings } from "../src/modules/bc-tera/core/settings.ts";
import { INITIAL_CUSUM_STATE, updateDirectionalCUSUM } from "../src/modules/bc-tera/core/changePoint.ts";
import {
  BC_TERA_FEATURE_SCHEMA_VERSION,
  type BCTERADataQuality,
  type BCTERAEvidenceBlock,
  type BCTERAFeatureBar,
  type BCTERASourceObservation
} from "../src/modules/bc-tera/core/types.ts";
import { BCTERAWorkerRuntime } from "../src/modules/bc-tera/workers/runtime.ts";
import { buildChartFeatureBars } from "../src/modules/bc-tera/data/chartFeatureAdapter.ts";

const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2024, 0, 1);
const suite = process.argv.find((value) => value.startsWith("--suite="))?.split("=")[1] ?? "all";
const results: string[] = [];

function test(name: string, run: () => void) {
  run();
  results.push(name);
}

function source(time: number, quality: BCTERADataQuality = "AUTHORITATIVE", venue = "FIXTURE"):
  BCTERASourceObservation {
  return {
    source: "deterministic-fixture",
    venue,
    symbol: "BTCUSDT",
    marketType: "AGGREGATE",
    eventTimestamp: time,
    sourceCutoff: time + 4 * HOUR,
    receivedTimestamp: time + 4 * HOUR + 1,
    sequence: String(time),
    revisionId: `fixture-${time}`,
    quality
  };
}

function block<T extends Record<string, number | boolean | null>>(
  time: number,
  values: T,
  quality: BCTERADataQuality = "AUTHORITATIVE",
  venue = "FIXTURE"
): BCTERAEvidenceBlock<T> {
  return { values, quality, sources: [source(time, quality, venue)] };
}

type FixtureOptions = {
  logReturn?: number;
  close?: number;
  trend?: number;
  distance?: number;
  breakUp?: boolean;
  breakDown?: boolean;
  confirmed?: boolean;
  valuationTop?: number;
  valuationBottom?: number;
  holderDistribution?: number;
  realizedProfit?: number;
  realizedLoss?: number;
  aggressiveBuy?: number;
  aggressiveSell?: number;
  buyerCollapse?: number;
  sellerCollapse?: number;
  flowAgreement?: number;
  flowTradeConfirmed?: boolean;
  offerReplenishment?: number;
  bidReplenishment?: number;
  bookTradeConfirmed?: boolean;
  oiIntensity?: number;
  funding?: number;
  basis?: number;
  leverageReset?: number;
  longLiquidation?: number;
  shortLiquidation?: number;
  quality?: BCTERADataQuality;
  missing?: Array<"valuation" | "spotFlow" | "orderBook" | "derivatives" | "liquidations" | "options">;
};

function fixtureBar(index: number, options: FixtureOptions = {}): BCTERAFeatureBar {
  const time = START + index * 4 * HOUR;
  const missing = new Set(options.missing ?? []);
  const quality = options.quality ?? "AUTHORITATIVE";
  const unavailable = [
    missing.has("valuation") ? "VALUATION" : null,
    missing.has("spotFlow") ? "SPOT_FLOW" : null,
    missing.has("orderBook") ? "ORDER_BOOK" : null,
    missing.has("derivatives") ? "DERIVATIVES" : null,
    missing.has("liquidations") ? "LIQUIDATIONS" : null,
    missing.has("options") ? "OPTIONS" : null,
    "STABLECOIN_LIQUIDITY"
  ].filter(Boolean) as BCTERAFeatureBar["unavailable"];
  return {
    schemaVersion: BC_TERA_FEATURE_SCHEMA_VERSION,
    symbol: "BTCUSDT",
    exchangeScope: "MULTI_VENUE_FIXTURE",
    profile: "BTC_FULL",
    timeframe: "4H",
    time,
    confirmed: options.confirmed ?? true,
    sourceCutoff: time + 4 * HOUR,
    receivedTimestamp: time + 4 * HOUR + 1,
    revisionId: `fixture-${index}`,
    market: block(time, {
      close: options.close ?? 100 + index,
      logReturn: options.logReturn ?? 0.01,
      realizedVolatility: 0.025,
      trend: options.trend ?? 0.45,
      distanceFromMean: options.distance ?? 0.3,
      structureBreakUp: options.breakUp ?? false,
      structureBreakDown: options.breakDown ?? false
    }, quality),
    valuation: missing.has("valuation") ? null : block(time, {
      topExtremity: options.valuationTop ?? 20,
      bottomExtremity: options.valuationBottom ?? 20,
      costBasisTop: options.valuationTop ?? 20,
      costBasisBottom: options.valuationBottom ?? 20,
      holderDistribution: options.holderDistribution ?? 15,
      realizedProfit: options.realizedProfit ?? 15,
      realizedLoss: options.realizedLoss ?? 15
    }, quality),
    spotFlow: missing.has("spotFlow") ? null : block(time, {
      aggressiveBuy: options.aggressiveBuy ?? 20,
      aggressiveSell: options.aggressiveSell ?? 20,
      buyerImpactCollapse: options.buyerCollapse ?? 15,
      sellerImpactCollapse: options.sellerCollapse ?? 15,
      venueAgreement: options.flowAgreement ?? 90,
      tradeConfirmed: options.flowTradeConfirmed ?? true
    }, quality),
    orderBook: missing.has("orderBook") ? null : block(time, {
      offerReplenishment: options.offerReplenishment ?? 15,
      bidReplenishment: options.bidReplenishment ?? 15,
      venueAgreement: options.flowAgreement ?? 90,
      tradeConfirmed: options.bookTradeConfirmed ?? true
    }, quality),
    derivatives: missing.has("derivatives") ? null : block(time, {
      oiIntensity: options.oiIntensity ?? 20,
      oiChange: 10,
      fundingCrowding: options.funding ?? 20,
      annualizedBasis: options.basis ?? 20,
      leverageReset: options.leverageReset ?? 20
    }, quality),
    liquidations: missing.has("liquidations") ? null : block(time, {
      longLiquidationShock: options.longLiquidation ?? 10,
      shortLiquidationShock: options.shortLiquidation ?? 10
    }, quality),
    options: missing.has("options") ? null : block(time, {
      downsideSkew: 20,
      upsideSkew: 20,
      panicVolatility: 20,
      normalization: 20
    }, quality),
    stablecoinLiquidity: null,
    unavailable
  };
}

function baseline(length = 15, contraction = false) {
  return Array.from({ length }, (_, index) => fixtureBar(index, contraction
    ? { logReturn: -0.01, trend: -0.45, distance: -0.3, close: 200 - index }
    : {}));
}

const topEvidence: FixtureOptions = {
  valuationTop: 94,
  holderDistribution: 92,
  realizedProfit: 90,
  aggressiveBuy: 94,
  buyerCollapse: 96,
  offerReplenishment: 92,
  oiIntensity: 92,
  funding: 88,
  basis: 86,
  shortLiquidation: 65,
  trend: 0.8,
  distance: 0.9
};

const bottomEvidence: FixtureOptions = {
  valuationBottom: 94,
  realizedLoss: 96,
  aggressiveSell: 96,
  sellerCollapse: 95,
  bidReplenishment: 94,
  longLiquidation: 92,
  leverageReset: 90,
  trend: -0.8,
  distance: -0.9
};

function confirmedTop() {
  const bars = baseline(12);
  bars.push(fixtureBar(12, topEvidence));
  bars.push(fixtureBar(13, topEvidence));
  bars.push(fixtureBar(14, { ...topEvidence, logReturn: -0.12, breakDown: true, trend: -0.4 }));
  return bars;
}

function confirmedBottom() {
  const bars = baseline(12, true);
  bars.push(fixtureBar(12, bottomEvidence));
  bars.push(fixtureBar(13, bottomEvidence));
  bars.push(fixtureBar(14, { ...bottomEvidence, logReturn: 0.12, breakUp: true, trend: 0.4 }));
  return bars;
}

const settings = {
  timeHorizon: { featureLookback: 500, regimeLookback: 90 },
  confirmation: { minimumStateDuration: 2, cooldownBars: 8 },
  changePoint: { confirmationProbability: 65, minimumRunLength: 1 }
};

function snapshot(bars: BCTERAFeatureBar[]) {
  return calculateBCTERA(bars, settings as never);
}

function hasConfirmedTop(bars: BCTERAFeatureBar[]) {
  return snapshot(bars).events.some((event) => event.eventType === "TOP_REVERSAL_CONFIRMED");
}

function hasConfirmedBottom(bars: BCTERAFeatureBar[]) {
  return snapshot(bars).events.some((event) => event.eventType === "BOTTOM_REVERSAL_CONFIRMED");
}

if (["all", "unit", "feature", "state-machine"].includes(suite)) {
  test("1 blow-off top with leverage confirms only after causal break", () => {
    assert.equal(hasConfirmedTop(confirmedTop()), true);
  });
  test("2 strong bull continuation does not call a top", () => {
    const bars = baseline(12);
    bars.push(fixtureBar(12, { ...topEvidence, buyerCollapse: 10 }));
    bars.push(fixtureBar(13, { ...topEvidence, buyerCollapse: 10 }));
    bars.push(fixtureBar(14, { ...topEvidence, buyerCollapse: 10, logReturn: 0.08, breakUp: true }));
    assert.equal(hasConfirmedTop(bars), false);
  });
  test("3 high MVRV alone cannot confirm a top", () => {
    const bars = baseline(12);
    for (let index = 12; index < 16; index += 1) bars.push(fixtureBar(index, { valuationTop: 99 }));
    assert.equal(hasConfirmedTop(bars), false);
  });
  test("4 buy-flow absorption reaches top exhaustion without confirmation", () => {
    const bars = baseline(12);
    bars.push(fixtureBar(12, topEvidence));
    const result = snapshot(bars);
    assert.equal(result.points.at(-1)?.state, "TOP_EXHAUSTION");
    assert.equal(hasConfirmedTop(bars), false);
  });
  test("5 bearish change point after distribution confirms a top", () => {
    assert.equal(snapshot(confirmedTop()).points.at(-1)?.changeDirection, "BEARISH");
    assert.equal(snapshot(confirmedTop()).points.at(-1)?.state, "TOP_REVERSAL_CONFIRMED");
  });
  test("6 flash crash without terminal evidence has no bottom", () => {
    const bars = baseline(12);
    bars.push(fixtureBar(12, { logReturn: -0.2, breakDown: true, trend: -0.9 }));
    assert.equal(hasConfirmedBottom(bars), false);
  });
  test("7 liquidation cascade followed by decline has no bottom", () => {
    const bars = baseline(12, true);
    for (let index = 12; index < 16; index += 1) {
      bars.push(fixtureBar(index, { ...bottomEvidence, sellerCollapse: 5, bidReplenishment: 5, logReturn: -0.1 }));
    }
    assert.equal(hasConfirmedBottom(bars), false);
  });
  test("8 capitulation plus authentic absorption reaches absorption", () => {
    const bars = baseline(12, true);
    bars.push(fixtureBar(12, bottomEvidence));
    assert.equal(snapshot(bars).points.at(-1)?.state, "BOTTOM_ABSORPTION");
  });
  test("9 bullish change point after seller exhaustion confirms bottom", () => {
    assert.equal(hasConfirmedBottom(confirmedBottom()), true);
  });
  test("10 sideways high-volatility range has no confirmed reversal", () => {
    const bars = Array.from({ length: 30 }, (_, index) => fixtureBar(index, {
      logReturn: index % 2 ? 0.08 : -0.08,
      trend: 0,
      distance: 0
    }));
    const result = snapshot(bars);
    assert.equal(result.events.some((event) => event.eventType.endsWith("REVERSAL_CONFIRMED")), false);
  });
  test("low valuation alone cannot confirm a bottom", () => {
    const bars = baseline(12, true);
    for (let index = 12; index < 16; index += 1) {
      bars.push(fixtureBar(index, { valuationBottom: 99, trend: -0.5, distance: -0.4 }));
    }
    assert.equal(hasConfirmedBottom(bars), false);
  });
  test("positive funding alone cannot confirm a top", () => {
    const bars = baseline(12);
    for (let index = 12; index < 16; index += 1) bars.push(fixtureBar(index, { funding: 100 }));
    assert.equal(hasConfirmedTop(bars), false);
  });
}

if (["all", "provenance", "feature"].includes(suite)) {
  test("11 missing on-chain stays null and lowers confidence", () => {
    const bars = baseline(15).map((bar, index) => fixtureBar(index, { missing: ["valuation"] }));
    const last = snapshot(bars).points.at(-1)!;
    assert.equal(last.evidence.valuationExtremity, null);
    assert.ok(last.unavailable.includes("VALUATION"));
    assert.ok(last.dataConfidence < 100);
  });
  test("12 missing options stays unavailable instead of zero", () => {
    const bars = baseline(15).map((bar, index) => fixtureBar(index, { missing: ["options"] }));
    const last = snapshot(bars).points.at(-1)!;
    assert.equal(last.evidence.optionsConfirmation, null);
    assert.ok(last.unavailable.includes("OPTIONS"));
  });
  test("13 stale open-interest family reduces confidence", () => {
    const fresh = snapshot(baseline()).points.at(-1)!.dataConfidence;
    const staleBars = baseline().map((_, index) => fixtureBar(index, { quality: "STALE" }));
    assert.ok(snapshot(staleBars).points.at(-1)!.dataConfidence < fresh);
  });
  test("14 conflicting exchange flow reduces confidence", () => {
    const agreed = snapshot(baseline()).points.at(-1)!.dataConfidence;
    const conflict = baseline().map((_, index) => fixtureBar(index, { flowAgreement: 10 }));
    assert.ok(snapshot(conflict).points.at(-1)!.dataConfidence < agreed);
  });
  test("15 spoofed order book without trades cannot create absorption", () => {
    const bars = baseline(12, true);
    bars.push(fixtureBar(12, { ...bottomEvidence, flowTradeConfirmed: false, bookTradeConfirmed: false }));
    const last = snapshot(bars).points.at(-1)!;
    assert.equal(last.spotAbsorption, null);
    assert.notEqual(last.state, "BOTTOM_ABSORPTION");
  });
  test("16 duplicate and out-of-order feature delivery is canonicalized", () => {
    const ordered = confirmedTop();
    const duplicated = [...ordered].reverse().concat({ ...ordered[5]!, receivedTimestamp: ordered[5]!.receivedTimestamp - 1 });
    const result = snapshot(duplicated);
    assert.equal(result.points.length, ordered.length);
    assert.deepEqual(result.events.map((event) => event.id), snapshot(ordered).events.map((event) => event.id));
  });
  test("17 scale-equivalent structure produces identical scores", () => {
    const original = confirmedTop();
    const scaled = original.map((bar) => ({
      ...bar,
      market: { ...bar.market, values: { ...bar.market.values, close: bar.market.values.close * 1_000 } }
    }));
    const left = snapshot(original).points.at(-1)!;
    const right = snapshot(scaled).points.at(-1)!;
    assert.equal(left.topHazard, right.topHazard);
    assert.equal(left.state, right.state);
  });
  test("chart adapter keeps developing bars provisional and absent families unavailable", () => {
    const origin = Math.floor(START / 1_000);
    const candles = [0, 1, 4, 5].map((offset) => ({
      time: origin + offset * 60 * 60,
      open: 100 + offset,
      high: 102 + offset,
      low: 99 + offset,
      close: 101 + offset,
      volume: 10
    }));
    const bars = buildChartFeatureBars(candles, {
      symbol: "BTCUSDT",
      venue: "BINANCE",
      timeframe: "4H",
      confirmedCutoff: origin + 4 * 60 * 60,
      receivedTimestamp: origin + 5 * 60 * 60
    });
    const shuffled = buildChartFeatureBars([...candles].reverse(), {
      symbol: "BTCUSDT",
      venue: "BINANCE",
      timeframe: "4H",
      confirmedCutoff: origin + 4 * 60 * 60,
      receivedTimestamp: origin + 5 * 60 * 60
    });
    assert.equal(bars.length, 2);
    assert.deepEqual(shuffled, bars);
    assert.equal(bars[0]?.confirmed, true);
    assert.equal(bars[1]?.confirmed, false);
    assert.equal(bars[1]?.valuation, null);
    assert.ok(bars[1]?.unavailable.includes("VALUATION"));
    assert.equal(snapshot(bars).events.some((event) => event.eventType.endsWith("REVERSAL_CONFIRMED")), false);
  });
}

if (["all", "prefix", "alert-parity", "state-machine"].includes(suite)) {
  test("18 every prefix is stable and non-repainting", () => {
    const fullBars = confirmedTop();
    const full = snapshot(fullBars);
    for (let length = 5; length <= fullBars.length; length += 1) {
      assert.deepEqual(snapshot(fullBars.slice(0, length)).points, full.points.slice(0, length));
    }
  });
  test("19 repeated evaluation preserves marker and alert identity", () => {
    const first = snapshot(confirmedBottom());
    const second = snapshot(confirmedBottom());
    assert.deepEqual(first.events, second.events);
    for (const event of first.events) {
      const markers = first.points.filter((point) => point.time === event.confirmedCandleTimestamp && point.state === event.state);
      assert.equal(markers.length, 1);
    }
  });
  test("20 quality downgrade during episode fails closed and emits degradation", () => {
    const bars = baseline(12);
    bars.push(fixtureBar(12, topEvidence));
    bars.push(fixtureBar(13, { ...topEvidence, missing: ["valuation", "spotFlow", "orderBook", "derivatives", "liquidations", "options"] }));
    const result = snapshot(bars);
    assert.equal(result.points.at(-1)?.state, "DATA_DEGRADED");
    assert.ok(result.events.some((event) => event.eventType === "DATA_DEGRADED"));
    assert.equal(result.events.some((event) => event.eventType === "TOP_REVERSAL_CONFIRMED"), false);
  });
  test("provisional change point cannot emit a confirmed reversal", () => {
    const bars = confirmedTop();
    bars[bars.length - 1] = { ...bars.at(-1)!, confirmed: false };
    assert.equal(hasConfirmedTop(bars), false);
  });
  test("one terminal episode emits at most one confirmed event", () => {
    const bars = confirmedTop();
    bars.push(fixtureBar(15, { ...topEvidence, logReturn: -0.08, breakDown: true }));
    bars.push(fixtureBar(16, { ...topEvidence, logReturn: -0.07, breakDown: true }));
    assert.equal(snapshot(bars).events.filter((event) => event.eventType === "TOP_REVERSAL_CONFIRMED").length, 1);
  });
}

if (["all", "change-point"].includes(suite)) {
  test("directional CUSUM is causal and directional", () => {
    let state = INITIAL_CUSUM_STATE;
    for (const impulse of [0, 0, -3, -2]) state = updateDirectionalCUSUM(state, impulse, 1, 1);
    assert.equal(state.direction, "BEARISH");
    assert.ok(state.probability > 0.7);
    const bullish = updateDirectionalCUSUM(INITIAL_CUSUM_STATE, 4, 1, 1);
    assert.equal(bullish.direction, "BULLISH");
  });
}

if (["all", "hazard-calibration"].includes(suite)) {
  test("research-prior hazard is bounded and monotonic in complete evidence", () => {
    const lower = baseline(12);
    lower.push(fixtureBar(12, { ...topEvidence, valuationTop: 82, buyerCollapse: 70, aggressiveBuy: 70, oiIntensity: 70 }));
    const higher = baseline(12);
    higher.push(fixtureBar(12, topEvidence));
    const lowerHazard = snapshot(lower).points.at(-1)!.topHazard;
    const higherHazard = snapshot(higher).points.at(-1)!.topHazard;
    assert.ok(lowerHazard >= 0 && higherHazard <= 100);
    assert.ok(higherHazard > lowerHazard);
  });
}

if (["all", "settings"].includes(suite)) {
  test("settings migration preserves research-only execution locks", () => {
    const migrated = migrateBCTERASettings({
      dataSources: { minimumConfidence: 999 } as never,
      automationReadiness: { researchOnly: false, liveExecutionLocked: false } as never,
      confirmation: { confirmedCandlesOnly: false, oneSignalPerEpisode: false } as never
    });
    assert.equal(migrated.dataSources.minimumConfidence, 100);
    assert.equal(migrated.automationReadiness.researchOnly, true);
    assert.equal(migrated.automationReadiness.liveExecutionLocked, true);
    assert.equal(migrated.confirmation.confirmedCandlesOnly, true);
  });
  test("disabled source families contribute neither evidence nor confirmation", () => {
    const result = calculateBCTERA(confirmedTop(), {
      ...settings,
      dataSources: { useSpotFlow: false }
    } as never);
    assert.equal(result.points.at(-1)?.buyerExhaustion, null);
    assert.equal(result.events.some((event) => event.eventType === "TOP_REVERSAL_CONFIRMED"), false);
  });
  test("configured leverage weights change the evidence score", () => {
    const bars = baseline(12);
    bars.push(fixtureBar(12, { oiIntensity: 0, funding: 100, basis: 0, shortLiquidation: 0 }));
    const weighted = snapshot(bars).points.at(-1)?.leverageFragility ?? 0;
    const excluded = calculateBCTERA(bars, {
      ...settings,
      leverage: { fundingWeight: 0 }
    } as never).points.at(-1)?.leverageFragility ?? 0;
    assert.ok(weighted > excluded);
  });
}

if (["all", "worker"].includes(suite)) {
  test("worker enforces bounded normalized input", () => {
    const messages: unknown[] = [];
    const runtime = new BCTERAWorkerRuntime((message) => messages.push(message));
    runtime.handle({ protocolVersion: 1, type: "CALCULATE", requestId: "ok", generation: 1, bars: confirmedTop(), settings });
    assert.equal((messages.at(-1) as { type: string }).type, "RESULT");
    runtime.handle({
      protocolVersion: 1,
      type: "CALCULATE",
      requestId: "large",
      generation: 2,
      bars: Array.from({ length: 2_001 }, (_, index) => fixtureBar(index)),
      settings
    });
    assert.equal((messages.at(-1) as { code: string }).code, "INPUT_TOO_LARGE");
  });
}

if (["all", "security"].includes(suite)) {
  test("research module contains no broker mutation or credential path", () => {
    const files = [
      "src/modules/bc-tera/core/engine.ts",
      "src/modules/bc-tera/core/types.ts",
      "src/modules/bc-tera/workers/runtime.ts",
      "src/modules/bc-tera/workers/BCTERAWorkerClient.ts",
      "src/modules/bc-tera/data/chartFeatureAdapter.ts",
      "src/modules/bc-tera/components/BCTERASettingsPanel.tsx"
    ];
    const sourceText = files.map((file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8")).join("\n");
    assert.doesNotMatch(sourceText, /placeOrder|submitOrder|cancelOrder|brokerCredential|privateKey/i);
    const result = snapshot(confirmedTop());
    assert.equal(result.automationState, "RESEARCH_ONLY");
    assert.equal(result.liveExecutionLocked, true);
  });
}

if (["all", "performance"].includes(suite)) {
  test("two-thousand bounded bars calculate within desktop budget", () => {
    const bars = Array.from({ length: 2_000 }, (_, index) => fixtureBar(index));
    const startedAt = performance.now();
    const result = calculateBCTERA(bars, { timeHorizon: { featureLookback: 2_000 } } as never);
    const elapsed = performance.now() - startedAt;
    assert.equal(result.points.length, 2_000);
    assert.ok(elapsed < 1_500, `calculation took ${elapsed.toFixed(1)}ms`);
  });
}

console.log(`BC-TERA ${suite}: ${results.length} deterministic checks passed`);
for (const name of results) console.log(`  ✓ ${name}`);
