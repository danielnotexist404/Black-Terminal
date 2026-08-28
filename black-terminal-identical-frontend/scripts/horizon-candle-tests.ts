import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HorizonWaveEngine, resolveHorizonLod } from "../src/modules/horizon-candles/core/HorizonWaveEngine.ts";
import { BLACK_HORIZON_DEFAULTS } from "../src/modules/horizon-candles/core/settings.ts";
import { CandleAggregationEngine } from "../src/market-data/aggregation/candleAggregator.ts";
import type { Candle } from "../src/chart-engine/types.ts";

const sourceStart = 1_787_873_600;
const source: Candle[] = Array.from({ length: 14_400 }, (_, index) => {
  const wave = Math.sin(index / 540) * 180 + Math.sin(index / 71) * 24;
  const drift = index * 0.015;
  const open = 77_000 + wave + drift;
  const direction = Math.sin(index / 83) >= 0 ? 1 : -1;
  const close = open + direction * (1.5 + (index % 7) * 0.18);
  const volume = 8 + (index % 37) * 0.7;
  const delta = direction * volume * (0.35 + (index % 5) * 0.08);
  return {
    time: sourceStart + index,
    open,
    high: Math.max(open, close) + 2 + (index % 11) * 0.12,
    low: Math.min(open, close) - 2 - (index % 13) * 0.1,
    close,
    volume,
    delta,
    buyVolume: (volume + delta) / 2,
    sellVolume: (volume - delta) / 2
  };
});

const engine = new HorizonWaveEngine();
const settings = { ...BLACK_HORIZON_DEFAULTS, dataQuality: "native-trades" as const };

const aggressorAggregator = new CandleAggregationEngine();
const buy = aggressorAggregator.ingestTrade({ exchange: "bybit", symbol: "BTCUSDT", tradeId: "buy-1", time: sourceStart, price: 100, quantity: 4, side: "buy" }, "1s");
const sell = aggressorAggregator.ingestTrade({ exchange: "bybit", symbol: "BTCUSDT", tradeId: "sell-1", time: sourceStart, price: 99, quantity: 1.5, side: "sell" }, "1s");
assert.equal(buy?.candle.delta, 4);
assert.equal(sell?.candle.delta, 2.5, "one-second delta preserves the exact signed aggressor quantities");
assert.equal(sell?.candle.buyVolume, 4);
assert.equal(sell?.candle.sellVolume, 1.5);

assert.equal(resolveHorizonLod(1, "auto"), "candles");
assert.equal(resolveHorizonLod(1.01, "auto"), "clusters");
assert.equal(resolveHorizonLod(8, "auto"), "clusters");
assert.equal(resolveHorizonLod(8.01, "auto"), "wave");
assert.equal(resolveHorizonLod(500, "candles"), "candles", "explicit LOD overrides remain deterministic");

const full = engine.project(source, 0, source.length - 1, 1, settings);
assert.equal(full.sourceSampleCount, 14_400, "a four-hour horizon retains all 14,400 one-second source samples");
assert.equal(full.expectedSampleCount, 14_400);
assert.equal(full.coverageRatio, 1);
assert.equal(full.deltaCoverageRatio, 1);
assert.equal(full.lod, "candles");
assert.equal(full.buckets.length, source.length);

const cluster = engine.project(source, 0, source.length - 1, 0.25, settings);
assert.equal(cluster.lod, "clusters");
assert.equal(cluster.bucketSize, 4);
assert.equal(cluster.buckets.length, 3_600);

const wave = engine.project(source, 0, source.length - 1, 0.05, settings);
assert.equal(wave.lod, "wave");
assert.equal(wave.bucketSize, 20);
assert.equal(wave.buckets.length, 720);
assert.equal(wave.arrays.centerline.length, wave.buckets.length, "render arrays and bucket metadata stay index aligned");

const exactIndex = 9_731;
const exact = engine.sourceAt(source, wave, exactIndex + 0.3);
assert.ok(exact);
assert.equal(exact.index, exactIndex);
assert.equal(exact.candle.time, sourceStart + exactIndex);
assert.equal(exact.candle.close, source[exactIndex]!.close, "crosshair recovers the exact one-second source candle under wave LOD");
assert.ok(exact.bucket && exactIndex >= exact.bucket.startIndex && exactIndex <= exact.bucket.endIndex);

const sourceWithoutDelta = source.map(({ delta: _delta, buyVolume: _buy, sellVolume: _sell, ...candle }) => candle);
const noDelta = engine.project(sourceWithoutDelta, 0, sourceWithoutDelta.length - 1, 0.05, settings);
assert.equal(noDelta.deltaCoverageRatio, 0);
assert.ok(noDelta.buckets.every((bucket) => !bucket.deltaAvailable));
assert.ok(noDelta.buckets.every((bucket) => Number.isFinite(bucket.directionScore)), "direction weights are safely renormalized without CVD");

for (const bucket of wave.buckets) {
  assert.ok(bucket.directionScore >= -1 && bucket.directionScore <= 1);
  assert.ok(bucket.upperEnvelope >= bucket.centerline);
  assert.ok(bucket.lowerEnvelope <= bucket.centerline);
}

for (let offset = 0; offset < 12; offset++) {
  engine.project(source, offset, source.length - 1 - offset, 0.07 + offset * 0.001, settings);
}
assert.ok(engine.cacheSize() <= 6, "viewport projection cache is strictly bounded");

const timings: number[] = [];
for (let iteration = 0; iteration < 30; iteration++) {
  const uncached = new HorizonWaveEngine();
  const started = performance.now();
  uncached.project(source, 0, source.length - 1, 0.05, settings);
  timings.push(performance.now() - started);
}
timings.sort((left, right) => left - right);
const p95Ms = timings[Math.floor(timings.length * 0.95)] ?? Number.POSITIVE_INFINITY;
assert.ok(p95Ms < 100, `14,400-sample wave projection p95 must remain interactive; measured ${p95Ms.toFixed(2)}ms`);

const here = dirname(fileURLToPath(import.meta.url));
const chartEngineSource = readFileSync(resolve(here, "../src/chart-engine/BlackChartEngine.ts"), "utf8");
const chartComponentSource = readFileSync(resolve(here, "../src/components/PixiBlackChart.tsx"), "utf8");
const appSource = readFileSync(resolve(here, "../src/App.tsx"), "utf8");
const fixtureSource = readFileSync(resolve(here, "../src/modules/horizon-candles/testing/fixtures.ts"), "utf8");

assert.match(chartEngineSource, /if \(this\.chartType === "horizon"\)/, "Horizon rendering has an explicit isolated branch");
assert.match(chartEngineSource, /const buckets = aggregateCandleRenderBuckets\(data, this\.view\.firstIndex, this\.view\.lastIndex, stride\)/, "the ordinary candle renderer remains unchanged behind the isolated branch");
assert.match(chartEngineSource, /return this\.chartType === "horizon" \? 100_000 : 20_000/, "Horizon source retention is hard-bounded at 100k samples");
assert.match(chartComponentSource, /sourceTimeframe: Timeframe = chartType === "horizon" \? "1s" : timeframe/, "source resolution is decoupled from display horizon");
assert.match(chartComponentSource, /native-trades/, "authentic trade-built quality is surfaced to the UI");
assert.match(chartComponentSource, /degraded/, "incomplete source coverage is never silently presented as complete");
assert.match(appSource, /blackHorizonCandlesEnabled\(\)/, "the mode is protected by a production kill switch");
assert.match(appSource, /Black Horizon Candles/, "the dedicated chart-type menu entry is present");
assert.match(fixtureSource, /const local = resolved\.hostname === "localhost"/, "the synthetic visual fixture is localhost-restricted");
assert.match(fixtureSource, /horizonVisualFixture/, "synthetic test data requires an explicit query switch");
assert.match(chartComponentSource, /activeCustomScriptSettingsId \|\|\s*horizonSettingsOpen \|\|/, "Horizon settings isolate pointer interaction from the chart behind them");

console.log("Black Horizon Candles certification PASS", {
  sourceSamples: source.length,
  candleBuckets: full.buckets.length,
  clusterBuckets: cluster.buckets.length,
  waveBuckets: wave.buckets.length,
  projectionP95Ms: Number(p95Ms.toFixed(3)),
  cacheEntries: engine.cacheSize()
});
