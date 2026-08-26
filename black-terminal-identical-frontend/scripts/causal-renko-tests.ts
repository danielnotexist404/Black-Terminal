import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CausalRenkoStream, causalRenkoBrickSize } from "../src/chart-engine/causalRenko.ts";
import type { Candle } from "../src/chart-engine/types.ts";

function candle(time: number, close: number, previous = close): Candle {
  return {
    time,
    open: previous,
    high: Math.max(previous, close),
    low: Math.min(previous, close),
    close,
    volume: 100
  };
}

const start = 1_780_000_000;
const seed = [
  candle(start, 100_000),
  candle(start + 60, 100_100, 100_000),
  candle(start + 120, 100_200, 100_100),
  candle(start + 180, 100_300, 100_200),
  candle(start + 240, 100_100, 100_300),
  candle(start + 300, 99_900, 100_100),
  candle(start + 360, 99_800, 99_900)
];

assert.equal(causalRenkoBrickSize(seed), 100, "the epoch must derive one deterministic nice-step size from its initial price/timeframe");

const first = new CausalRenkoStream();
const second = new CausalRenkoStream();
first.resetFromCandles(seed);
second.resetFromCandles(seed);
assert.deepEqual(first.snapshot(), second.snapshot(), "identical inputs must create identical frozen epochs");

const prefix = new CausalRenkoStream();
prefix.resetFromCandles(seed.slice(0, -2));
const prefixSnapshot = prefix.snapshot();
const fullSnapshot = first.snapshot();
const prefixLastOpenTime = seed.at(-3)!.time;
assert.deepEqual(
  fullSnapshot.candles.filter((entry) => entry.time < prefixLastOpenTime),
  prefixSnapshot.candles.filter((entry) => entry.time < prefixLastOpenTime),
  "future source candles must not mutate already completed prefix bricks"
);

const live = new CausalRenkoStream();
live.resetFromCandles([candle(start, 100_000), candle(start + 60, 100_000)]);
const size = live.snapshot().brickSize;
assert.equal(live.ingestTrade(100_000 + size, 2, start + 61, "trade-1"), true);
const afterUp = live.snapshot();
assert.equal(afterUp.completedCount, 1);
assert.equal(afterUp.authority, "MIXED_LIVE_TRADES");
assert.equal(live.ingestTrade(100_000 + size, 2, start + 61, "trade-1"), false, "duplicate trades must be idempotent");
assert.equal(live.snapshot().completedCount, 1);

assert.equal(live.ingestTrade(100_000, 1, start + 62, "trade-2"), false, "a one-brick retracement must not reverse a traditional Renko stream");
assert.equal(live.snapshot().completedCount, 1);
assert.equal(live.ingestTrade(100_000 - size, 1, start + 63, "trade-3"), true, "a two-brick retracement must confirm the reversal");
const afterReverse = live.snapshot();
assert.equal(afterReverse.completedCount, 2);
assert.equal(afterReverse.candles[1]!.open, 100_000);
assert.equal(afterReverse.candles[1]!.close, 100_000 - size);

const frozenBeforeRetraction = afterReverse.candles.slice(0, afterReverse.completedCount);
live.ingestTrade(100_000 - size / 2, 1, start + 64, "trade-4");
assert.deepEqual(
  live.snapshot().candles.slice(0, afterReverse.completedCount),
  frozenBeforeRetraction,
  "a later retraction must never rewrite completed live bricks"
);

const multi = new CausalRenkoStream();
multi.resetFromCandles([candle(start, 100_000), candle(start + 60, 100_000)]);
multi.ingestTrade(100_000 + multi.snapshot().brickSize * 4, 3, start + 61, "multi");
const multiCompleted = multi.snapshot().candles.slice(0, multi.snapshot().completedCount);
assert.equal(multiCompleted.length, 4);
assert.equal(new Set(multiCompleted.map((entry) => entry.time)).size, 4, "multi-brick events require unique monotonic identities");
assert.ok(multiCompleted.every((entry, index) => index === 0 || entry.time > multiCompleted[index - 1]!.time));
assert.equal(multi.snapshot().candles.length, multi.snapshot().completedCount + 1, "the runtime must expose one non-final developing brick");

const engineSource = readFileSync(new URL("../src/chart-engine/BlackChartEngine.ts", import.meta.url), "utf8");
const chartSource = readFileSync(new URL("../src/components/PixiBlackChart.tsx", import.meta.url), "utf8");
const editorSource = readFileSync(new URL("../src/components/ScriptEditor.tsx", import.meta.url), "utf8");
assert.match(engineSource, /getCustomScriptCandles\(\)/, "the chart engine must expose an explicit script input boundary");
assert.match(engineSource, /this\.causalRenko\.snapshot\(\)\.candles/, "Renko rendering must use the append-only stream");
assert.doesNotMatch(engineSource, /source\.slice\(-160\)/, "Renko must not reconstruct history from a moving ATR window");
assert.match(chartSource, /engine\.getCustomScriptCandles\(\)/, "the Script Editor reader must use the selected custom-script feed");
assert.match(chartSource, /getCustomScriptFeed\(\)/, "alert identity must include its explicit feed authority");
assert.match(chartSource, /ingestCausalRenkoTrade\(trade\.price, trade\.quantity, trade\.time, trade\.tradeId\)/, "canonical live trades must advance the causal stream");
assert.match(editorSource, /CAUSAL_RENKO/, "the Script Editor must disclose Renko activation explicitly");

// Certified built-ins retain their source-candle boundary. Selecting Renko is
// not allowed to silently mutate BC-RDA or BC-ACVD calculations.
assert.ok((chartSource.match(/getSourceCandles\(\)/g) ?? []).length >= 3);
assert.match(chartSource, /const sourceCandles = engineRef\.current\?\.getSourceCandles\(\) \?\? \[\]/);

console.log("Black Terminal causal Renko stream: PASS");
