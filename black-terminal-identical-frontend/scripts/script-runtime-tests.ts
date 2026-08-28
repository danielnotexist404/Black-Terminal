import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BLACK_TERMINAL_PYTHON_RUNTIME_VERSION,
  compileAndRunScript,
  extractScriptInputs,
  finalizedScriptResult,
  newlyConfirmedScriptEvents
} from "../src/components/ScriptCompiler.ts";
import type { Candle } from "../src/chart-engine/types.ts";
import {
  mergeCustomScriptOutput,
  mountCustomScript,
  nextCustomScriptProjectionRevision,
  restoreMountedCustomScripts,
  unmountCustomScript
} from "../src/scripts/customScriptLifecycle.ts";
import { normalizeUserScripts } from "../src/scripts/userScriptLibrary.ts";

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
assert.deepEqual(extractScriptInputs(indicator), [{ key: "Fast", variable: "length", label: "Fast", type: "int", defaultValue: 2 }]);
const overriddenIndicatorResult = compileAndRunScript(indicator, candles, { Fast: 5 });
assert.equal(overriddenIndicatorResult.success, true, JSON.stringify(overriddenIndicatorResult.errors));
assert.notDeepEqual(overriddenIndicatorResult.plots[0].values, indicatorResult.plots[0].values, "saved custom inputs must alter the deterministic runtime output");

const cvdRuntimeCoverage = `delta = close - open
cvd = ta.cum(delta)
wma = ta.wma(cvd, 3)
rma = ta.rma(cvd, 3)
hma = ta.hma(cvd, 4)
root = math.sqrt(math.max(math.abs(delta), 0))
floor = math.min(root, 2)
p95 = ta.percentile_linear_interpolation(cvd, 5, 95)
previous = ta.shift(cvd, 2)
frame_probe = cvd + timeframe_seconds
show_hidden = input.bool(False, "Show Hidden")
plot(cvd, title="CVD", color="#f4f4f5", width=2, pane="oscillator")
plot(wma, title="WMA", color="#c40024", width=1, pane="oscillator")
plot(rma, title="RMA", color="#8d8d92", width=1, pane="oscillator")
plot(hma, title="HMA", color="#d7d7da", width=1, pane="oscillator")
plot(p95, title="P95", color="#730019", width=1, pane="oscillator")
plot(floor, title="Hidden", color="#730019", width=1, pane="oscillator", visible=show_hidden)
plot(previous, title="Previous", color="#730019", width=1, pane="oscillator", visible=show_hidden)
plot(frame_probe, title="Frame Probe", color="#730019", width=1, pane="oscillator", visible=show_hidden)`;
const cvdRuntimeResult = compileAndRunScript(cvdRuntimeCoverage, candles);
assert.equal(cvdRuntimeResult.success, true, JSON.stringify(cvdRuntimeResult.errors));
assert.equal(cvdRuntimeResult.plots.length, 8);
assert.ok(cvdRuntimeResult.plots.every((plot) => plot.pane === "oscillator"), "CVD-family plots must remain isolated from the price domain");
assert.equal(cvdRuntimeResult.plots.at(-1)?.visible, false, "plot visibility must honor a scalar settings toggle");
const expectedCumulative: number[] = [];
let cumulative = 0;
for (const candle of candles) {
  cumulative += candle.close - candle.open;
  expectedCumulative.push(cumulative);
}
assert.deepEqual(cvdRuntimeResult.plots[0].values, expectedCumulative, "ta.cum must produce deterministic append-only cumulative delta");
assert.deepEqual(cvdRuntimeResult.plots[6].values.slice(2), expectedCumulative.slice(0, -2), "ta.shift must expose only past values");
assert.deepEqual(cvdRuntimeResult.plots[7].values, expectedCumulative.map((value) => value + 60), "timeframe_seconds must match the authoritative candle interval");
for (const plot of cvdRuntimeResult.plots.slice(1)) assert.equal(plot.values.length, candles.length);
const cvdPrefixResult = compileAndRunScript(cvdRuntimeCoverage, candles.slice(0, -4));
assert.equal(cvdPrefixResult.success, true, JSON.stringify(cvdPrefixResult.errors));
for (let plotIndex = 0; plotIndex < cvdPrefixResult.plots.length; plotIndex += 1) {
  assert.deepEqual(cvdRuntimeResult.plots[plotIndex].values.slice(0, -4), cvdPrefixResult.plots[plotIndex].values, `extended vector plot ${plotIndex} repainted after future append`);
}

const convertedCvdMaSource = readFileSync(new URL("./examples/cvd-ma-black-terminal.py", import.meta.url), "utf8");
const convertedCvdMaResult = compileAndRunScript(convertedCvdMaSource, candles);
assert.equal(convertedCvdMaResult.success, true, JSON.stringify(convertedCvdMaResult.errors));
assert.equal(convertedCvdMaResult.plots.length, 15, "the complete non-divergence CVD-MA conversion must expose every configured line and channel boundary");
assert.equal(convertedCvdMaResult.alertConditions.length, 14, "the CVD-MA conversion must preserve all non-divergence state alerts");
assert.ok(convertedCvdMaResult.plots.every((plot) => plot.pane === "oscillator"), "the converted CVD-MA must never contaminate the price scale");
assert.doesNotMatch(convertedCvdMaSource, /show_divergence|pivot_memory|swing_atr_mult/, "the requested conversion must omit the Pine divergence subsystem");

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
const hiddenOutput = mergeCustomScriptOutput(mounted.map((item) => item.activation.id === activation.id
  ? { ...item, activation: { ...item.activation, visible: false } }
  : item));
assert.ok(hiddenOutput.plots.every((plot) => !plot.name.startsWith(`${activation.id}:`)), "hiding one custom script must remove only its visual output");
assert.equal(mounted.length, 2, "hiding a custom script must not unload its saved runtime");
mounted = unmountCustomScript(mounted, activation.id);
assert.deepEqual(mounted.map(({ activation: item }) => item.id), [secondActivation.id], "closing one script must preserve every other mounted script");

const restoredBeforeFeedReady = restoreMountedCustomScripts([{
  id: activation.id,
  name: activation.name,
  kind: activation.kind,
  source: activation.source,
  createdAt: 1,
  chartActivation: { active: true, visible: true },
}], [], "SOURCE_OHLCV");
assert.equal(restoredBeforeFeedReady.length, 1, "a mounted script must survive refresh before chart history becomes ready");
assert.equal(restoredBeforeFeedReady[0]?.result.success, true, "cold-start restoration uses a safe pending projection");
assert.equal(restoredBeforeFeedReady[0]?.activation.visible, true);
assert.equal(restoreMountedCustomScripts([{
  id: "inactive",
  name: "Inactive",
  kind: "indicator",
  source: indicator,
  createdAt: 1,
  chartActivation: { active: false, visible: false },
}], candles, "SOURCE_OHLCV").length, 0, "explicitly closed scripts must stay closed after refresh");
assert.deepEqual(normalizeUserScripts([{
  id: "persisted",
  name: "Persisted Strategy",
  kind: "strategy",
  source: indicator,
  createdAt: 1,
  chartActivation: { active: true, visible: false },
}])[0]?.chartActivation, { active: true, visible: false }, "normalization must retain the authenticated chart activation state");

let projectionRevision = 0;
for (const engineLocalRevision of [1, 1, 1]) {
  void engineLocalRevision;
  projectionRevision = nextCustomScriptProjectionRevision(projectionRevision);
}
assert.equal(
  projectionRevision,
  3,
  "identical feed revisions from replacement timeframe engines must each trigger a custom-script projection"
);

const editorSource = readFileSync(new URL("../src/components/ScriptEditor.tsx", import.meta.url), "utf8");
const chartSource = readFileSync(new URL("../src/components/PixiBlackChart.tsx", import.meta.url), "utf8");
const librarySource = readFileSync(new URL("../src/components/IndicatorLibrary.tsx", import.meta.url), "utf8");
const databaseSource = readFileSync(new URL("../src/lib/supabase.ts", import.meta.url), "utf8");
const engineSource = readFileSync(new URL("../src/chart-engine/BlackChartEngine.ts", import.meta.url), "utf8");
const strategyAdapterSource = readFileSync(new URL("../src/modules/strategy-lab/adapters/pythonStrategyAdapter.ts", import.meta.url), "utf8");
assert.match(editorSource, /getCandles\(\)\.slice\(-20_000\)/, "the editor must compile against the active chart candle reader");
assert.doesNotMatch(editorSource, /bt_chart_candles_cache/, "the nonexistent local candle cache must never return");
const saveLifecycleSource = editorSource.slice(editorSource.indexOf("const saveCurrentScript"), editorSource.indexOf("const deleteScript"));
assert.doesNotMatch(saveLifecycleSource, /onRunScript/, "Save must persist source without mounting a chart runtime");
assert.match(editorSource, /dbSaveCurrentUserScripts/, "production script Save must use authenticated VPS-backed storage");
assert.match(editorSource, /Run \/ Add to chart/, "Run must be the explicit chart activation action");
assert.match(editorSource, /INDICATOR NAME/, "the Script Editor must expose an explicit indicator-name field");
assert.match(editorSource, /Name this \$\{kind\} before saving it/, "unnamed scripts must not silently save under an ambiguous fallback title");
assert.match(chartSource, /custom-script-row/, "mounted user scripts must have an independent chart-list row");
assert.match(chartSource, /onRemoveCustomScript/, "mounted user scripts must be removable without deleting saved source");
assert.match(chartSource, /onToggleCustomScriptVisibility/, "mounted user scripts must have an independent hide control");
assert.match(chartSource, /setCustomScriptFeedRevision\(nextCustomScriptProjectionRevision\)/, "timeframe engine replacement must advance an app-scoped custom-script projection revision");
assert.match(chartSource, /CustomScriptSettingsPanel/, "mounted user scripts must expose native-style settings");
assert.match(chartSource, /custom-oscillator-pane-resizer/, "custom oscillators must use the shared draggable pane divider");
assert.match(chartSource, /updateCustomOscillatorPaneHeight/, "custom oscillator heights must update through persisted pane settings");
assert.match(chartSource, /extractScriptInputs/, "custom settings must be derived from deterministic input declarations");
assert.match(librarySource, /dbGetCurrentUserScripts/, "My Indicators must load from authenticated owner storage");
assert.match(librarySource, /OWNER ONLY \/ PRIVATE SOURCE/, "private scripts must be visibly distinguished from published catalog entries");
assert.match(librarySource, /publishUserScript/, "publication must remain a separate explicit owner action");
assert.doesNotMatch(librarySource, /0 LOCAL \/ 0 PUBLISHED/, "My Indicators must not remain a placeholder");
const publicAssetQuery = databaseSource.slice(databaseSource.indexOf("export async function dbListPublicScriptAssets"), databaseSource.indexOf("export async function", databaseSource.indexOf("export async function dbListPublicScriptAssets") + 30));
assert.match(publicAssetQuery, /published_indicators/, "Community Indicators must read only the public publication table");
assert.match(publicAssetQuery, /published_strategies/, "Community Strategies must read only the public publication table");
assert.doesNotMatch(publicAssetQuery, /bt_users/, "Community catalogs must never query private user script storage");
assert.match(chartSource, /latestConfirmedTime = candles\.at\(-2\)!\.time/, "custom alerts must use the latest closed candle");
assert.match(chartSource, /newlyConfirmedScriptEvents/, "custom alerts must pass the historical replay guard");
assert.match(chartSource, /replayActiveRef\.current/, "Replay must not emit custom live alerts");
assert.match(chartSource, /alertSettingsRef\.current\.enabled/, "custom external delivery must honor the alert master switch");
assert.match(engineSource, /marker\.signalPrice/, "the chart must render markers at their finalized signal price");
assert.match(engineSource, /0x39ff88/, "the chart must render the phosphor-green signal-price micro-tick");
assert.match(engineSource, /plot\.pane === "oscillator"/, "custom oscillator plots must be excluded from the price-scale renderer");
assert.match(engineSource, /customOscillatorPlots/, "custom oscillator plots must render in an isolated pane");
assert.match(engineSource, /stack\.customPanes/, "custom oscillators must be laid out by the unified oscillator stack");
assert.match(engineSource, /plot\.visible !== false/, "hidden custom plots must not reserve or render a chart pane");
assert.match(strategyAdapterSource, /not wired yet|not available/i, "uncertified headless Python automation must remain fail closed");

console.log("Black Terminal Python indicator/strategy/alert runtime: PASS");
