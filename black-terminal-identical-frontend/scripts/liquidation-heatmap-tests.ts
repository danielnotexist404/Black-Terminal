import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { LiquidationHeatmapModel } from "../src/chart-engine/heatmap/LiquidationHeatmapModel.ts";
import type { Candle } from "../src/chart-engine/types.ts";

const candles: Candle[] = Array.from({ length: 5_000 }, (_, index) => {
  const center = 64_000 + index * 0.45 + Math.sin(index / 19) * 850;
  return {
    time: 1_700_000_000 + index * 60,
    open: center - 35,
    high: center + 125 + index % 17,
    low: center - 135 - index % 13,
    close: center + 42,
    volume: 80 + index % 97
  };
});

const model = new LiquidationHeatmapModel();
const started = performance.now();
model.setSource(candles);
const buildMs = performance.now() - started;
const diagnostics = model.diagnostics();
assert.equal(diagnostics.rebuilds, 1);
assert.ok(diagnostics.retainedCells > 0, "native liquidation model must produce visible data");
assert.ok(diagnostics.retainedCells <= 16_000, "retained liquidation cells must remain bounded");
assert.ok(buildMs < 1_500, `initial liquidation build exceeded the freeze boundary: ${buildMs.toFixed(1)}ms`);

const visible = model.visibleCells(0, candles.length - 1, candles.length - 1, 40_000, 90_000);
assert.ok(visible.length > 0);
assert.ok(visible.every((cell) => cell.startIndex >= 2_000), "bounded source indices must remain aligned to the full candle array");

const intrabar = candles.slice();
intrabar[intrabar.length - 1] = { ...intrabar[intrabar.length - 1], close: intrabar[intrabar.length - 1].close + 25, volume: 999 };
const intrabarStarted = performance.now();
model.setSource(intrabar);
const intrabarMs = performance.now() - intrabarStarted;
assert.equal(model.diagnostics().rebuilds, 1, "same-candle trades must not trigger a full historical rebuild");
assert.ok(intrabarMs < 5, `same-candle update should be constant-time, got ${intrabarMs.toFixed(2)}ms`);

const next = candles.concat({ ...candles[candles.length - 1], time: candles[candles.length - 1].time + 60 });
model.setSource(next);
assert.equal(model.diagnostics().rebuilds, 2, "a new candle must refresh the model");

console.log(JSON.stringify({ decision: "PASS", initialBuildMs: Number(buildMs.toFixed(2)), intrabarMs: Number(intrabarMs.toFixed(3)), ...model.diagnostics() }, null, 2));
