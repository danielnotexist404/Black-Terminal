import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  aggregateCandleRenderBuckets,
  chartRenderIndices,
  chartRenderStride,
  visibleCandleDomain
} from "../src/chart-engine/renderLod.ts";
import type { Candle } from "../src/chart-engine/types.ts";

const candles: Candle[] = Array.from({ length: 22_000 }, (_, index) => {
  const base = 50_000 + index * 0.7 + Math.sin(index / 19) * 180;
  return {
    time: 1_700_000_000 + index * 300,
    open: base - 8,
    high: base + 25 + (index % 31 === 0 ? 300 : 0),
    low: base - 23 - (index % 47 === 0 ? 420 : 0),
    close: base + 9,
    volume: 100 + (index % 17) * 13
  };
});

const minimumStep = 0.18 + 0.04;
const plotWidth = 1_900;
const rawVisibleCount = Math.ceil(plotWidth / minimumStep) + 80;
const firstIndex = candles.length - rawVisibleCount;
const lastIndex = candles.length - 1;
const stride = chartRenderStride(minimumStep);
const indices = chartRenderIndices(firstIndex, lastIndex, stride);
const buckets = aggregateCandleRenderBuckets(candles, firstIndex, lastIndex, stride);

assert.equal(stride, 5, "maximum zoom-out uses a deterministic five-candle pixel bucket");
assert.ok(rawVisibleCount > 8_000, "regression fixture reproduces the former unbounded historical view");
assert.ok(buckets.length <= Math.ceil(plotWidth / 1) + 20, "rendered candles stay bounded by physical plot width");
assert.equal(indices[0], firstIndex);
assert.equal(indices.at(-1), lastIndex);

for (const bucket of buckets) {
  const source = candles.slice(bucket.startIndex, bucket.endIndex + 1);
  assert.equal(bucket.candle.open, source[0]?.open, "bucket retains the first source open");
  assert.equal(bucket.candle.close, source.at(-1)?.close, "bucket retains the last source close");
  assert.equal(bucket.candle.high, Math.max(...source.map((candle) => candle.high)), "bucket retains intra-pixel highs");
  assert.equal(bucket.candle.low, Math.min(...source.map((candle) => candle.low)), "bucket retains intra-pixel lows");
  assert.equal(bucket.candle.volume, source.reduce((sum, candle) => sum + candle.volume, 0), "bucket retains total volume");
}

const domain = visibleCandleDomain(candles, firstIndex, lastIndex);
const visible = candles.slice(firstIndex, lastIndex + 1);
assert.equal(domain.minimum, Math.min(...visible.map((candle) => candle.low)), "price autoscale retains historical low spikes");
assert.equal(domain.maximum, Math.max(...visible.map((candle) => candle.high)), "price autoscale retains historical high spikes");

const normalStride = chartRenderStride(7);
const normalBuckets = aggregateCandleRenderBuckets(candles, candles.length - 200, candles.length - 1, normalStride);
assert.equal(normalStride, 1, "normal zoom remains full fidelity");
assert.equal(normalBuckets.length, 200);
assert.deepEqual(normalBuckets[0]?.candle, candles.at(-200));

const rawDdaPathPoints = rawVisibleCount * (8 + 7 * 2 + 9);
const lodDdaPathPoints = indices.length * (8 + 7 * 2 + 9);
assert.ok(lodDdaPathPoints / rawDdaPathPoints < 0.23, "BC-RDA dense path submission is reduced by at least 77%");

const timings: number[] = [];
for (let iteration = 0; iteration < 25; iteration++) {
  const started = performance.now();
  aggregateCandleRenderBuckets(candles, firstIndex, lastIndex, stride);
  timings.push(performance.now() - started);
}
timings.sort((left, right) => left - right);
const p95Ms = timings[Math.floor(timings.length * 0.95)] ?? Number.POSITIVE_INFINITY;
assert.ok(p95Ms < 100, `LOD projection p95 must stay interactive; measured ${p95Ms.toFixed(2)}ms`);

const here = dirname(fileURLToPath(import.meta.url));
const engineSource = readFileSync(resolve(here, "../src/chart-engine/BlackChartEngine.ts"), "utf8");
const componentSource = readFileSync(resolve(here, "../src/components/PixiBlackChart.tsx"), "utf8");
assert.match(engineSource, /aggregateCandleRenderBuckets\(data, this\.view\.firstIndex, this\.view\.lastIndex, stride\)/);
assert.match(engineSource, /this\.countdownText\.text = next/);
assert.match(engineSource, /autoStart: false/, "Pixi must render on demand rather than rasterizing an unchanged dense scene continuously");
assert.doesNotMatch(engineSource, /app\.ticker\.add\(/, "chart rendering must not be attached to the permanent Pixi ticker");
assert.match(engineSource, /if \(this\.countdownTimer\) window\.clearInterval\(this\.countdownTimer\)/, "countdown timer must be released on teardown");
assert.doesNotMatch(engineSource, /lower\.unshift\(/, "historical band polygons must stay linear rather than front-inserting every point");
const ingestTradeSource = engineSource.match(/  ingestTrade\([\s\S]*?\n  }\n\n  private setHeatmapSource/)?.[0] ?? "";
assert.match(ingestTradeSource, /this\.queueDraw\(\)/, "trade ingestion must schedule a coalesced frame");
assert.doesNotMatch(ingestTradeSource, /this\.draw\(\)/, "high-frequency trade ingestion must not synchronously rebuild chart geometry");
assert.match(componentSource, /chartUiPublishTimer = window\.setTimeout\(flushChartUiState, 50\)/, "trade-driven React state must be bounded to 20Hz");
assert.match(componentSource, /window\.clearTimeout\(chartUiPublishTimer\)/, "bounded chart UI publisher must clean up on remount");
const replayUpsertSource = componentSource.match(/const upsertReplaySourceCandle = \(candle: Candle\) => \{([\s\S]*?)\n  \};/)?.[1] ?? "";
assert.match(replayUpsertSource, /source\[source\.length - 1\] = candle/);
assert.doesNotMatch(replayUpsertSource, /\.\.\.source|source\.slice\(/, "a live trade must not clone the full retained history");
assert.doesNotMatch(
  componentSource,
  /auctionTradeHistoryRef\.current = \[\.\.\.auctionTradeHistoryRef\.current/,
  "trade history must use amortized bounded compaction rather than clone 250k entries per trade"
);
assert.doesNotMatch(
  engineSource,
  /if \(epochSec !== this\.lastCountdownTime\)[\s\S]{0,180}this\.draw\(\)/,
  "countdown updates must never rebuild full chart geometry"
);

console.log("Chart historical LOD tests PASS", {
  rawVisibleCount,
  renderedCandleBuckets: buckets.length,
  reductionPercent: Number(((1 - buckets.length / rawVisibleCount) * 100).toFixed(2)),
  projectionP95Ms: Number(p95Ms.toFixed(3))
});
