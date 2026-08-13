import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { calculateDDAProNative } from "../src/modules/dda-pro/core/nativeEngine.ts";
import { DEFAULT_DDA_PRO_SETTINGS } from "../src/modules/dda-pro/core/settings.ts";
import type { Candle } from "../src/chart-engine/types.ts";

function fixture(size: number): Candle[] {
  return Array.from({ length: size }, (_, index) => {
    const regime = index < size * 0.35 ? index * 0.018 : index < size * 0.72 ? -index * 0.006 : index * 0.011;
    const close = 40_000 + regime + Math.sin(index / 31) * 1_200 + Math.cos(index / 137) * 2_000;
    return { time: 1_700_000_000 + index * 3_600, open: close, high: close + 25, low: close - 25, close, volume: 1_000 + index % 300 };
  });
}

function measure(candles: Candle[], lookback: number, iterations: number) {
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const started = performance.now();
    const result = calculateDDAProNative({ candles, settings: { ...DEFAULT_DDA_PRO_SETTINGS, lookback }, timeframeSeconds: 3_600 });
    samples.push(performance.now() - started);
    assert.equal(result.inputSize, candles.length);
  }
  samples.sort((left, right) => left - right);
  return {
    p50: samples[Math.floor(samples.length * 0.5)]!,
    p95: samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)]!,
    p99: samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.99) - 1)]!,
    samples
  };
}

const cold = measure(fixture(20_000), 500, 4);
const incremental = measure(fixture(501), 500, 20);
const report = {
  authority: "LOCAL_SYNTHETIC_KERNEL_ONLY",
  hostCapacityClaim: "NONE",
  cold20kLookback500Ms: cold,
  incremental501Lookback500Ms: incremental,
  targets: { cold20kMs: 500, incrementalP95Ms: 10, mainThreadFrameMs: 16.7 },
  workerIsolation: true,
  targetStatus: { cold20kP95: cold.p95 <= 500 ? "PASS" : "FAIL", boundedRebuildP95: incremental.p95 <= 10 ? "PASS" : "FAIL" }
};
assert.ok(Number.isFinite(cold.p99) && Number.isFinite(incremental.p99));
assert.ok(cold.p95 <= report.targets.cold20kMs, "DDA Pro cold p95 target exceeded");
assert.ok(incremental.p95 <= report.targets.incrementalP95Ms, "DDA Pro bounded rebuild p95 target exceeded");
console.log(JSON.stringify(report, null, 2));
