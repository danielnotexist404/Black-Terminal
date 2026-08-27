import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculateCvdOscillator, resolveCvdOscillatorAutoLengths } from "../src/modules/cvd-oscillator/core/engine.ts";
import { DEFAULT_CVD_OSCILLATOR_SETTINGS, migrateCvdOscillatorSettings } from "../src/modules/cvd-oscillator/core/settings.ts";
import type { Candle } from "../src/chart-engine/types.ts";

const candles: Candle[] = Array.from({ length: 240 }, (_, index) => {
  const direction = index < 80 ? 1 : index < 160 ? -1 : 1;
  const open = 100 + (index < 160 ? index * direction * 0.08 : (index - 160) * 0.12);
  const close = open + direction * (0.3 + index % 5 * 0.02);
  return { time: index * 3600, open, high: Math.max(open, close) + 0.2, low: Math.min(open, close) - 0.2, close, volume: 100 + index };
});

const settings = migrateCvdOscillatorSettings({
  ...DEFAULT_CVD_OSCILLATOR_SETTINGS,
  parametersMode: "Custom",
  fastLength: 5,
  slowLength: 13,
  cloudLength: 8,
  lookback: 500
});
const snapshot = calculateCvdOscillator({ candles, settings, timeframeSeconds: 3600 });
assert.equal(snapshot.authority, "OHLCV_CANDLE_SIGNED_ESTIMATE");
assert.equal(snapshot.inputSize, candles.length);
assert.deepEqual(snapshot.lengths, { fast: 5, slow: 13 });
assert.equal(snapshot.series.delta[0], candles[0]!.volume * (candles[0]!.close - candles[0]!.open) / (candles[0]!.high - candles[0]!.low));
assert.ok(snapshot.series.state.includes("LONG"));
assert.ok(snapshot.series.state.includes("SHORT"));
assert.ok(snapshot.series.state.every((state) => state === "LONG" || state === "SHORT" || state === "SIDEWAYS"));

const prefix = calculateCvdOscillator({ candles: candles.slice(0, 180), settings, timeframeSeconds: 3600 });
assert.deepEqual(
  snapshot.series.cvd.slice(0, prefix.inputSize),
  prefix.series.cvd,
  "later candles must not alter historical cumulative delta"
);
assert.deepEqual(
  snapshot.series.fast.slice(0, prefix.inputSize),
  prefix.series.fast,
  "later candles must not alter historical fast-wave values"
);
assert.deepEqual(
  snapshot.series.state.slice(0, prefix.inputSize),
  prefix.series.state,
  "market-state history must be causal and prefix stable"
);

assert.deepEqual(resolveCvdOscillatorAutoLengths(60), { fast: 34, slow: 55 });
assert.deepEqual(resolveCvdOscillatorAutoLengths(14_400), { fast: 89, slow: 144 });
assert.deepEqual(resolveCvdOscillatorAutoLengths(86_400), { fast: 34, slow: 55 });

const clamped = migrateCvdOscillatorSettings({ fastWaveWidth: 99, slowWaveIntensity: -5, statusPanelWidth: 900 });
assert.equal(clamped.fastWaveWidth, 5);
assert.equal(clamped.slowWaveIntensity, 0);
assert.equal(clamped.statusPanelWidth, 300);

const engineSource = readFileSync(new URL("../src/chart-engine/BlackChartEngine.ts", import.meta.url), "utf8");
assert.match(engineSource, /rightAnalysisGutter\(\)[\s\S]*Math\.max\(this\.volumeProfileRightGutter\(\), this\.cvdOscillatorRightGutter\(\)\)/);
assert.match(engineSource, /visibleIndicators\.cvdOscillator[\s\S]*reserveRightGutter/);
assert.match(engineSource, /MARKET STATUS/);

console.log("BC-CVD-OSC calculation, causal-state, appearance, and right-gutter tests passed.");
