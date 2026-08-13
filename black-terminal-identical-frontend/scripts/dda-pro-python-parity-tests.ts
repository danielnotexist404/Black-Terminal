import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { calculateDDAProNative } from "../src/modules/dda-pro/core/nativeEngine.ts";
import { DEFAULT_DDA_PRO_SETTINGS } from "../src/modules/dda-pro/core/settings.ts";
import type { Candle } from "../src/chart-engine/types.ts";

const values = Array.from({ length: 720 }, (_, index) => 100 + index * 0.025 + Math.sin(index / 17) * 9 + Math.cos(index / 43) * 4);
const candles: Candle[] = values.map((close, index) => ({ time: 1_700_000_000 + index * 3_600, open: close, high: close + 1, low: close - 1, close, volume: 1_000 }));
const settings = { ...DEFAULT_DDA_PRO_SETTINGS, lookback: 500, peakMode: "all-history" as const, smoothingMethod: "ema" as const };
const mirror = calculateDDAProNative({ candles, settings, timeframeSeconds: 3_600 });
const payload = JSON.stringify({ values, settings: { lookback: 500, peak_mode: "all-history", smoothing_method: "ema", smoothing_length: 14 } });

const processResult = spawnSync("python3", ["-m", "black_core_indicators.dda_pro", payload], {
  cwd: new URL("../python", import.meta.url),
  encoding: "utf8",
  timeout: 30_000
});
assert.equal(processResult.status, 0, processResult.error?.message || processResult.stderr);
const reference = JSON.parse(processResult.stdout) as { series: { raw_drawdown: number[]; smoothed_drawdown: number[]; depth: number[]; percentile_rank: number[]; p95: number[] } };
for (const [pythonKey, tsKey] of [
  ["raw_drawdown", "rawDrawdown"],
  ["smoothed_drawdown", "smoothedDrawdown"],
  ["depth", "depth"],
  ["percentile_rank", "percentileRank"]
] as const) {
  const expected = reference.series[pythonKey];
  const actual = mirror.series[tsKey];
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index++) assert.ok(Math.abs((actual[index] ?? 0) - (expected[index] ?? 0)) < 1e-8, `${pythonKey} parity failed at ${index}`);
}
for (let index = 0; index < mirror.series.p95.length; index++) assert.ok(Math.abs(Math.abs(mirror.series.p95[index] ?? 0) - (reference.series.p95[index] ?? 0)) < 1e-8, `p95 parity failed at ${index}`);

console.log("DDA Pro Python reference ↔ TypeScript mirror core parity: PASS");
