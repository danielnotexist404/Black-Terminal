import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BLACK_TERMINAL_PYTHON_RUNTIME_VERSION,
  compileAndRunScript,
  finalizedScriptResult,
  newlyConfirmedScriptEvents
} from "../src/components/ScriptCompiler.ts";
import type { Candle } from "../src/chart-engine/types.ts";
import {
  mergeCustomScriptOutput,
  mountCustomScript,
  unmountCustomScript
} from "../src/scripts/customScriptLifecycle.ts";

const closes = [10, 9, 8, 7, 6, 7, 8, 9, 10, 9, 8, 7, 8, 9, 10, 11, 10, 9, 8, 9, 10];
const candles: Candle[] = closes.map((close, index) => ({
  time: 1_780_000_000 + index * 60,
  open: index ? closes[index - 1] : close,
  high: close + 0.8,
  low: close - 0.8,
  close,
  volume: 100 + index * 5
}));

const indicator = `# deterministic Black Terminal Python
length = input.int(2, "Fast")
slow_length = length * 2
fast = ta.ema(close, length)
slow = ta.ema(close, slow_length)
long_signal = ta.crossover(fast, slow)
short_signal = ta.crossunder(fast, slow)
plot(fast, title="Fast EMA", color="#f4f4f5", width=2)
plot(slow, title="Slow EMA", color="#c40024", width=2)
alertcondition(long_signal, "Long Alert", "Long at {{price}}")
alertcondition(short_signal, "Short Alert", "Short at {{price}}")`;

const indicatorResult = compileAndRunScript(indicator, candles);
assert.equal(indicatorResult.success, true, JSON.stringify(indicatorResult.errors));
assert.equal(indicatorResult.runtimeVersion, BLACK_TERMINAL_PYTHON_RUNTIME_VERSION);
assert.equal(indicatorResult.plots.length, 2);
assert.equal(indicatorResult.plots[0].values.length, candles.length);
assert.deepEqual(indicatorResult.plots.map((plot) => plot.name), ["Fast EMA", "Slow EMA"]);
assert.equal(indicatorResult.alertConditions.length, 2);
assert.ok(indicatorResult.events.some((event) => event.direction === "long"));
assert.ok(indicatorResult.events.some((event) => event.direction === "short"));

const strategy = `${indicator}
strategy.entry("Long Entry", strategy.long, when=long_signal)
strategy.entry("Short Entry", strategy.short, when=short_signal)
plotshape(long_signal, title="Long Dot", location="belowbar", color="#ffffff")
plotshape(short_signal, title="Short Dot", location="abovebar", color="#c40024")`;
const strategyResult = compileAndRunScript(strategy, candles);
assert.equal(strategyResult.success, true, JSON.stringify(strategyResult.errors));
assert.ok(strategyResult.markers.some((marker) => marker.kind === "entry" && marker.direction === "long"));
assert.ok(strategyResult.markers.some((marker) => marker.kind === "entry" && marker.direction === "short"));
assert.ok(strategyResult.markers.some((marker) => marker.kind === "shape"));
assert.ok(strategyResult.markers.every((marker) => marker.signalPrice === candles[marker.index].close), "signal ticks must use the finalized candle price");

const finalized = finalizedScriptResult(strategyResult, candles.at(-2)!.time);
assert.ok(finalized.events.every((event) => event.time <= candles.at(-2)!.time));
assert.ok(finalized.markers.every((marker) => marker.time <= candles.at(-2)!.time));

const historicalArm = finalized.events.filter((event) => event.type === "alert").at(-2)?.time ?? candles[0].time;
const latestConfirmedTime = candles.at(-2)!.time;
const newEvents = newlyConfirmedScriptEvents({ events: finalized.events, armedAfter: historicalArm, latestConfirmedTime });
assert.ok(newEvents.every((event) => event.time > historicalArm && event.time <= latestConfirmedTime));
const delivered = new Set(newEvents.map((event) => event.id));
assert.equal(newlyConfirmedScriptEvents({ events: finalized.events, armedAfter: historicalArm, latestConfirmedTime, deliveredIds: delivered }).length, 0);

const prefix = candles.slice(0, -4);
const prefixResult = compileAndRunScript(strategy, prefix);
assert.equal(prefixResult.success, true, JSON.stringify(prefixResult.errors));
for (let plotIndex = 0; plotIndex < prefixResult.plots.length; plotIndex += 1) {
  assert.deepEqual(strategyResult.plots[plotIndex].values.slice(0, prefix.length), prefixResult.plots[plotIndex].values, `plot ${plotIndex} repainted after future append`);
}
const prefixEvents = strategyResult.events.filter((event) => event.index < prefix.length).map((event) => event.id);
assert.deepEqual(prefixEvents, prefixResult.events.map((event) => event.id), "historical events changed after future append");

for (const blocked of [
  "import os",
  "while True:\n    pass",
  "def signal():\n    return close",
  "open('/etc/passwd')"
]) {
  const blockedResult = compileAndRunScript(blocked, candles);
  assert.equal(blockedResult.success, false, `unsafe source unexpectedly compiled: ${blocked}`);
}

assert.equal(compileAndRunScript(indicator, []).success, false);

const activation = {
  id: "saved-script-1",
  name: "Stored Indicator",
  kind: "indicator" as const,
  source: indicator,
  sourceHash: indicatorResult.sourceHash,
  inputFeed: "SOURCE_OHLCV" as const
};
let mounted = mountCustomScript([], { activation, result: indicatorResult });
mounted = mountCustomScript(mounted, { activation, result: indicatorResult });
assert.equal(mounted.length, 1, "running the same saved script repeatedly must update one mounted runtime");

const secondActivation = { ...activation, id: "saved-script-2", name: "Independent Strategy", kind: "strategy" as const };
mounted = mountCustomScript(mounted, { activation: secondActivation, result: strategyResult });
assert.equal(mounted.length, 2, "independent saved scripts must coexist on the chart");
const mergedOutput = mergeCustomScriptOutput(mounted);
assert.ok(mergedOutput.plots.every((plot) => plot.name.startsWith("saved-script-")), "custom plot identities must be namespaced by saved script");
assert.equal(new Set(mergedOutput.markers.map((marker) => marker.id)).size, mergedOutput.markers.length, "custom marker identities must remain unique across scripts");
mounted = unmountCustomScript(mounted, activation.id);
assert.deepEqual(mounted.map(({ activation: item }) => item.id), [secondActivation.id], "closing one script must preserve every other mounted script");

const editorSource = readFileSync(new URL("../src/components/ScriptEditor.tsx", import.meta.url), "utf8");
const chartSource = readFileSync(new URL("../src/components/PixiBlackChart.tsx", import.meta.url), "utf8");
const engineSource = readFileSync(new URL("../src/chart-engine/BlackChartEngine.ts", import.meta.url), "utf8");
const strategyAdapterSource = readFileSync(new URL("../src/modules/strategy-lab/adapters/pythonStrategyAdapter.ts", import.meta.url), "utf8");
assert.match(editorSource, /getCandles\(\)\.slice\(-20_000\)/, "the editor must compile against the active chart candle reader");
assert.doesNotMatch(editorSource, /bt_chart_candles_cache/, "the nonexistent local candle cache must never return");
const saveLifecycleSource = editorSource.slice(editorSource.indexOf("const saveCurrentScript"), editorSource.indexOf("const deleteScript"));
assert.doesNotMatch(saveLifecycleSource, /onRunScript/, "Save must persist source without mounting a chart runtime");
assert.match(editorSource, /dbSaveCurrentUserScripts/, "production script Save must use authenticated VPS-backed storage");
assert.match(editorSource, /Run \/ Add to chart/, "Run must be the explicit chart activation action");
assert.match(chartSource, /custom-script-row/, "mounted user scripts must have an independent chart-list row");
assert.match(chartSource, /onRemoveCustomScript/, "mounted user scripts must be removable without deleting saved source");
assert.match(chartSource, /latestConfirmedTime = candles\.at\(-2\)!\.time/, "custom alerts must use the latest closed candle");
assert.match(chartSource, /newlyConfirmedScriptEvents/, "custom alerts must pass the historical replay guard");
assert.match(chartSource, /replayActiveRef\.current/, "Replay must not emit custom live alerts");
assert.match(chartSource, /alertSettingsRef\.current\.enabled/, "custom external delivery must honor the alert master switch");
assert.match(engineSource, /marker\.signalPrice/, "the chart must render markers at their finalized signal price");
assert.match(engineSource, /0x39ff88/, "the chart must render the phosphor-green signal-price micro-tick");
assert.match(strategyAdapterSource, /not wired yet|not available/i, "uncertified headless Python automation must remain fail closed");

console.log("Black Terminal Python indicator/strategy/alert runtime: PASS");
