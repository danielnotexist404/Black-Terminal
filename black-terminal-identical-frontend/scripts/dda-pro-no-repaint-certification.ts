import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { Candle } from "../src/chart-engine/types.ts";
import { calculateDDAPro } from "../src/modules/dda-pro/core/engine.ts";
import { CausalRdaSignalMachine, deriveCausalRdaSignals, type CausalRdaSignalFrame } from "../src/modules/dda-pro/core/causalSignalEngine.ts";
import { ddaProAlertSignalStream } from "../src/modules/dda-pro/core/engineShared.ts";
import { DEFAULT_DDA_PRO_SETTINGS, ddaProSettingsHash, migrateDDAProSettings } from "../src/modules/dda-pro/core/settings.ts";
import { BC_RDA_CAUSAL_V2, BC_RDA_LEGACY_REPAINTING, type DDAProSeries, type DDAProSignalEvent, type DDAProSnapshot } from "../src/modules/dda-pro/core/types.ts";
import { DDAProWorkerRuntime } from "../src/modules/dda-pro/workers/runtime.ts";
import type { DDAProWorkerResponse } from "../src/modules/dda-pro/workers/protocol.ts";

const markets = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"] as const;
const timeframes = [
  ["5m", 300], ["15m", 900], ["1h", 3_600], ["4h", 14_400], ["1d", 86_400]
] as const;
const settings = migrateDDAProSettings({
  ...DEFAULT_DDA_PRO_SETTINGS,
  signalModelVersion: BC_RDA_CAUSAL_V2,
  signalIntelligenceMode: "RAW",
  lookback: 100,
  smoothingLength: 7,
  minimumExcursionBars: 2,
  cvdConfirmation: true
});
const compatibilitySettings = migrateDDAProSettings({ ...settings, engineMode: "pine-compatibility" });
assert.equal(settings.cvdConfirmation, false, "uncertified CVD confirmation was not forced off");

function prices(seed: number, length: number) {
  let random = (seed ^ 0x9e3779b9) >>> 0;
  let price = 100 + seed * 0.1;
  return Array.from({ length }, (_, index) => {
    random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
    const noise = (random / 0xffffffff - 0.5) * 0.32;
    const cycle = Math.sin(index / 11 + seed) * 0.18;
    const regime = index % 96 < 32 ? 0.15 : index % 96 < 62 ? -0.34 : 0.28;
    const shock = index % 151 === 88 ? -7.5 : index % 151 === 105 ? 6.8 : 0;
    price = Math.max(5, price + regime + cycle + noise + shock);
    return Number(price.toFixed(8));
  });
}

function candles(values: readonly number[], timeframeSeconds: number, seed: number): Candle[] {
  const start = 1_700_000_000 + seed * 1_000_000;
  return values.map((close, index) => ({
    time: start + index * timeframeSeconds,
    open: index ? values[index - 1]! : close,
    high: Math.max(close, index ? values[index - 1]! : close) + 0.25,
    low: Math.min(close, index ? values[index - 1]! : close) - 0.25,
    close,
    volume: 1_000 + ((index * 37 + seed * 11) % 900)
  }));
}

function calculate(source: Candle[], symbol: string, timeframe: string, timeframeSeconds: number, lastBarConfirmed = true, activeSettings = settings) {
  return calculateDDAPro({
    candles: source,
    settings: activeSettings,
    timeframeSeconds,
    lastBarConfirmed,
    signalContext: { exchange: "BYBIT", symbol, timeframe }
  });
}

function closeEnough(actual: number, expected: number, message: string) {
  if (Number.isNaN(actual) && Number.isNaN(expected)) return;
  const tolerance = 1e-10 * Math.max(1, Math.abs(actual), Math.abs(expected));
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} != ${expected}`);
}

function compareSeriesPrefix(prefix: DDAProSeries, full: DDAProSeries, length: number, label: string) {
  for (const key of Object.keys(prefix) as Array<keyof DDAProSeries>) {
    const actual = prefix[key];
    const expected = full[key].slice(0, length) as typeof actual;
    assert.equal(actual.length, length, `${label}:${key}:length`);
    if (key === "riskState" || key === "flowState") assert.deepEqual(actual, expected, `${label}:${key}`);
    else for (let index = 0; index < length; index++) closeEnough((actual as number[])[index]!, (expected as number[])[index]!, `${label}:${key}:${index}`);
  }
}

function eventView(snapshot: DDAProSnapshot, before: number) {
  return snapshot.events.filter((event) => event.index < before).map((event) => ({ ...event })).sort((left, right) => left.index - right.index || left.type.localeCompare(right.type));
}

function signalView(signals: readonly DDAProSignalEvent[], before: number) {
  return signals.filter((signal) => signal.index < before).map((signal) => ({ ...signal })).sort((left, right) => left.index - right.index || left.id.localeCompare(right.id));
}

function comparePrefix(prefix: DDAProSnapshot, full: DDAProSnapshot, length: number, label: string) {
  compareSeriesPrefix(prefix.series, full.series, length, label);
  assert.deepEqual(eventView(prefix, length), eventView(full, length), `${label}:events drifted`);
  assert.deepEqual(signalView(prefix.rawSignals, length), signalView(full.rawSignals, length), `${label}:raw signals drifted`);
  assert.deepEqual(signalView(prefix.signals, length), signalView(full.signals, length), `${label}:visible signals drifted`);
}

function comparable(snapshot: DDAProSnapshot) {
  return {
    engineMode: snapshot.engineMode,
    engineVersion: snapshot.engineVersion,
    dataHash: snapshot.dataHash,
    settingsHash: snapshot.settingsHash,
    outputHash: snapshot.outputHash,
    inputSize: snapshot.inputSize,
    validFromIndex: snapshot.validFromIndex,
    series: snapshot.series,
    events: snapshot.events,
    rawSignals: snapshot.rawSignals,
    signals: snapshot.signals,
    signalIntelligence: snapshot.signalIntelligence,
    signalIntegrity: snapshot.signalIntegrity,
    latest: snapshot.latest
  };
}

function workerSnapshot(source: Candle[], symbol: string, timeframe: string, timeframeSeconds: number, streaming: boolean, activeSettings = settings) {
  const messages: DDAProWorkerResponse[] = [];
  const runtime = new DDAProWorkerRuntime((message) => messages.push(message));
  runtime.handle({ protocolVersion: 1, type: "INITIALIZE", requestId: "init", generation: 1, config: activeSettings, timeframeSeconds, signalContext: { exchange: "BYBIT", symbol, timeframe } });
  if (streaming) {
    runtime.handle({ protocolVersion: 1, type: "LOAD_HISTORY", requestId: "empty", generation: 1, values: new Float64Array(), timestamps: new BigInt64Array() });
    for (const candle of source) runtime.handle({ protocolVersion: 1, type: "APPEND", requestId: `append-${candle.time}`, generation: 1, value: candle.close, timestamp: candle.time, confirmed: true });
  } else {
    runtime.handle({ protocolVersion: 1, type: "LOAD_HISTORY", requestId: "history", generation: 1, values: Float64Array.from(source.map((candle) => candle.close)), timestamps: BigInt64Array.from(source.map((candle) => BigInt(candle.time))) });
  }
  runtime.handle({ protocolVersion: 1, type: "REBUILD", requestId: "rebuild", generation: 1 });
  const result = messages.findLast((message) => message.type === "RESULT");
  assert.equal(result?.type, "RESULT", "worker did not return a snapshot");
  return (result as Extract<DDAProWorkerResponse, { type: "RESULT" }>).snapshot;
}

const timings: number[] = [];
let deterministicPrefixCases = 0;
let randomTruncations = 0;
let streamingParityCases = 0;
let reloadParityCases = 0;
let checkpointParityCases = 0;
const fixtures: Array<{ symbol: string; timeframe: string; seconds: number; source: Candle[]; full: DDAProSnapshot; settings: typeof settings }> = [];

for (let marketIndex = 0; marketIndex < markets.length; marketIndex++) {
  for (let timeframeIndex = 0; timeframeIndex < timeframes.length; timeframeIndex++) {
    const symbol = markets[marketIndex]!;
    const [timeframe, seconds] = timeframes[timeframeIndex]!;
    const source = candles(prices(100 + marketIndex * 17 + timeframeIndex, 320), seconds, marketIndex * 10 + timeframeIndex);
    const started = performance.now();
    const full = calculate(source, symbol, timeframe, seconds);
    timings.push(performance.now() - started);
    assert.equal(full.signalIntegrity.model, BC_RDA_CAUSAL_V2);
    assert.equal(full.signalIntegrity.alertEligibility, "BLOCKED");
    assert.equal(full.signalIntegrity.strategyEligibility, "BLOCKED");
    assert.deepEqual(ddaProAlertSignalStream(full, settings), [], "alert stream escaped containment");
    for (const cut of [110, 145, 180, 220, 270, 310]) {
      comparePrefix(calculate(source.slice(0, cut), symbol, timeframe, seconds), full, cut, `${symbol}:${timeframe}:${cut}`);
      deterministicPrefixCases += 1;
    }
    const reload = calculate(source, symbol, timeframe, seconds);
    assert.deepEqual(comparable(reload), comparable(full), `${symbol}:${timeframe}:reload parity`);
    reloadParityCases += 1;

    const flat = source.map((candle) => ({ ...candle, open: candle.close, high: candle.close, low: candle.close, volume: 0 }));
    const batch = calculate(flat, symbol, timeframe, seconds);
    assert.deepEqual(comparable(workerSnapshot(flat, symbol, timeframe, seconds, false)), comparable(batch), `${symbol}:${timeframe}:worker batch parity`);
    assert.deepEqual(comparable(workerSnapshot(flat, symbol, timeframe, seconds, true)), comparable(batch), `${symbol}:${timeframe}:worker streaming parity`);
    streamingParityCases += 1;

    const frames: CausalRdaSignalFrame[] = source.map((candle, index) => ({ index, time: candle.time, close: candle.close, depth: full.series.depth[index]!, velocity: full.series.velocity[index]! }));
    const machineConfig = { episodeThresholdPercent: settings.drawdownEpisodeThresholdPercent, confirmationBars: settings.minimumExcursionBars, timeframeSeconds: seconds, settingsHash: ddaProSettingsHash(settings), signalContext: { exchange: "BYBIT", symbol, timeframe } };
    const continuous = new CausalRdaSignalMachine(machineConfig);
    const continuousSignals = frames.flatMap((frame) => continuous.append(frame));
    const split = 173;
    const first = new CausalRdaSignalMachine(machineConfig);
    const restoredSignals = frames.slice(0, split).flatMap((frame) => first.append(frame));
    const restored = new CausalRdaSignalMachine(machineConfig, JSON.parse(JSON.stringify(first.checkpoint())));
    restoredSignals.push(...frames.slice(split).flatMap((frame) => restored.append(frame)));
    assert.deepEqual(restoredSignals, continuousSignals, `${symbol}:${timeframe}:checkpoint signals`);
    assert.deepEqual(restored.checkpoint(), continuous.checkpoint(), `${symbol}:${timeframe}:checkpoint state`);
    checkpointParityCases += 1;
    fixtures.push({ symbol, timeframe, seconds, source, full, settings });
  }
}

for (let marketIndex = 0; marketIndex < markets.length; marketIndex++) {
  for (let timeframeIndex = 0; timeframeIndex < timeframes.length; timeframeIndex++) {
    const symbol = markets[marketIndex]!;
    const [timeframe, seconds] = timeframes[timeframeIndex]!;
    const source = candles(prices(500 + marketIndex * 17 + timeframeIndex, 320), seconds, 500 + marketIndex * 10 + timeframeIndex);
    const started = performance.now();
    const full = calculate(source, symbol, timeframe, seconds, true, compatibilitySettings);
    timings.push(performance.now() - started);
    for (const cut of [120, 200, 300]) {
      comparePrefix(calculate(source.slice(0, cut), symbol, timeframe, seconds, true, compatibilitySettings), full, cut, `compat:${symbol}:${timeframe}:${cut}`);
      deterministicPrefixCases += 1;
    }
    assert.deepEqual(comparable(calculate(source, symbol, timeframe, seconds, true, compatibilitySettings)), comparable(full), `${symbol}:${timeframe}:compat reload parity`);
    reloadParityCases += 1;
    const flat = source.map((candle) => ({ ...candle, open: candle.close, high: candle.close, low: candle.close, volume: 0 }));
    const batch = calculate(flat, symbol, timeframe, seconds, true, compatibilitySettings);
    assert.deepEqual(comparable(workerSnapshot(flat, symbol, timeframe, seconds, false, compatibilitySettings)), comparable(batch), `${symbol}:${timeframe}:compat worker batch parity`);
    assert.deepEqual(comparable(workerSnapshot(flat, symbol, timeframe, seconds, true, compatibilitySettings)), comparable(batch), `${symbol}:${timeframe}:compat worker streaming parity`);
    streamingParityCases += 1;
    const frames: CausalRdaSignalFrame[] = source.map((candle, index) => ({ index, time: candle.time, close: candle.close, depth: full.series.depth[index]!, velocity: full.series.velocity[index]! }));
    const machineConfig = { episodeThresholdPercent: compatibilitySettings.drawdownEpisodeThresholdPercent, confirmationBars: compatibilitySettings.minimumExcursionBars, timeframeSeconds: seconds, settingsHash: ddaProSettingsHash(compatibilitySettings), signalContext: { exchange: "BYBIT", symbol, timeframe } };
    const continuous = new CausalRdaSignalMachine(machineConfig);
    const continuousSignals = frames.flatMap((frame) => continuous.append(frame));
    const first = new CausalRdaSignalMachine(machineConfig);
    const restoredSignals = frames.slice(0, 173).flatMap((frame) => first.append(frame));
    const restored = new CausalRdaSignalMachine(machineConfig, JSON.parse(JSON.stringify(first.checkpoint())));
    restoredSignals.push(...frames.slice(173).flatMap((frame) => restored.append(frame)));
    assert.deepEqual(restoredSignals, continuousSignals, `${symbol}:${timeframe}:compat checkpoint signals`);
    assert.deepEqual(restored.checkpoint(), continuous.checkpoint(), `${symbol}:${timeframe}:compat checkpoint state`);
    checkpointParityCases += 1;
    fixtures.push({ symbol, timeframe, seconds, source, full, settings: compatibilitySettings });
  }
}

let random = 0xc0ffee;
for (let iteration = 0; iteration < 100; iteration++) {
  random = (Math.imul(random, 1_103_515_245) + 12_345) >>> 0;
  const fixture = fixtures[random % fixtures.length]!;
  const cut = 105 + (random % 205);
  comparePrefix(calculate(fixture.source.slice(0, cut), fixture.symbol, fixture.timeframe, fixture.seconds, true, fixture.settings), fixture.full, cut, `random:${iteration}:${fixture.symbol}:${fixture.timeframe}:${cut}`);
  randomTruncations += 1;
}

{
  const symbol = "BTCUSDT";
  const timeframe = "5m";
  const seconds = 300;
  const source = candles(prices(999, 1_300), seconds, 999);
  const full = calculate(source, symbol, timeframe, seconds);
  for (const length of [200, 210, 300, 1_200]) comparePrefix(calculate(source.slice(0, length), symbol, timeframe, seconds), full, length, `future-append:${length}`);
}

{
  const source = candles([100, 99, 95, 90, 92, 88, 89, 87, 91, 96, 100, 101], 300, 77);
  const legacy = migrateDDAProSettings({ ...settings, signalModelVersion: BC_RDA_LEGACY_REPAINTING, signalIntelligenceMode: "RAW" });
  const markerIndexes = [5, 7, 9].map((length) => calculateDDAPro({ candles: source.slice(0, length), settings: legacy, timeframeSeconds: 300 }).rawSignals.find((signal) => signal.direction === "long")?.index);
  assert.ok(new Set(markerIndexes).size > 1, `legacy repaint reproduction failed: ${markerIndexes.join(",")}`);
}

{
  const source = candles([100, 99, 96, 94, 95, 97], 300, 88);
  const full = calculate(source, "BTCUSDT", "5m", 300, true);
  const developing = calculate(source, "BTCUSDT", "5m", 300, false);
  assert.notEqual(developing.calculationHash, full.calculationHash, "developing/finalized input lifecycle shared one calculation identity");
  assert.notEqual(developing.outputHash, full.outputHash, "signal lifecycle was omitted from the output identity");
  assert.deepEqual(signalView(developing.rawSignals, source.length), signalView(calculate(source.slice(0, -1), "BTCUSDT", "5m", 300).rawSignals, source.length - 1), "developing bar emitted a final signal");
  for (const signal of full.rawSignals) {
    assert.equal(signal.lifecycle, "FINAL");
    assert.equal(signal.finalized, true);
    assert.equal(signal.index, signal.confirmationIndex, "final marker was backpainted onto its candidate bar");
    assert.ok((signal.executionEligibleTimestamp ?? 0) >= (signal.confirmationTimestamp ?? 0) + 300, "execution became eligible before confirmation-bar close");
    assert.ok((signal.displayAnchorIndex ?? signal.index) <= signal.index, "analytical anchor lies after confirmation");
  }
  const direct = deriveCausalRdaSignals({ candles: source, depth: [0, 1, 4, 3, 2.5, 0], velocity: [0, 1, 3, -1, -0.5, -2.5], settings, settingsHash: ddaProSettingsHash(settings), timeframeSeconds: 300, finalizedLength: 5 });
  assert.equal(direct.signals.length, 1, "closed-bar confirmation fixture did not emit exactly one final signal");
  assert.equal(direct.signals[0]?.confirmationIndex, 4);
  assert.equal(direct.signals[0]?.displayAnchorIndex, 2);
  const open = deriveCausalRdaSignals({ candles: source, depth: [0, 1, 4, 3, 2.5, 0], velocity: [0, 1, 3, -1, -0.5, -2.5], settings, settingsHash: ddaProSettingsHash(settings), timeframeSeconds: 300, finalizedLength: 4 });
  assert.equal(open.signals.length, 0, "open/developing confirmation bar emitted a final signal");
  assert.equal(open.developingSignals[0]?.executionEligibleTimestamp, null);

  const shortSource = candles([100, 97, 98, 100, 101, 100.7, 100.4], 300, 89);
  const short = deriveCausalRdaSignals({
    candles: shortSource,
    depth: [0, 3, 2, 0, 0, 0.3, 0.6],
    velocity: [0, 3, -1, -2, 0, 0.3, 0.3],
    settings,
    settingsHash: ddaProSettingsHash(settings),
    timeframeSeconds: 300
  });
  const finalShort = short.signals.find((signal) => signal.direction === "short");
  assert.equal(finalShort?.candidateIndex, 3, "short upper-extreme candidate did not begin at causal recovery");
  assert.equal(finalShort?.displayAnchorIndex, 4, "short analytical anchor did not follow the last known upper extreme");
  assert.equal(finalShort?.confirmationIndex, 6, "short marker was not delayed until rollover confirmation");
  assert.equal(finalShort?.causalAudit?.cloudState, "ROLLOVER_CONFIRMED");
  const preRollover = deriveCausalRdaSignals({
    candles: shortSource,
    depth: [0, 3, 2, 0, 0, 0.3, 0.6],
    velocity: [0, 3, -1, -2, 0, 0.3, 0.3],
    settings,
    settingsHash: ddaProSettingsHash(settings),
    timeframeSeconds: 300,
    finalizedLength: 6
  });
  assert.equal(preRollover.signals.some((signal) => signal.direction === "short"), false, "short finalized before closed-bar rollover confirmation");
  assert.equal(preRollover.developingSignals.some((signal) => signal.direction === "short"), true, "developing short candidate was not exposed separately");
}

timings.sort((left, right) => left - right);
const percentile = (rank: number) => timings[Math.min(timings.length - 1, Math.max(0, Math.ceil(timings.length * rank) - 1))] ?? 0;
const report = {
  status: "PASS",
  model: BC_RDA_CAUSAL_V2,
  engineModes: 2,
  deterministicMarkets: markets.length,
  deterministicTimeframes: timeframes.length,
  deterministicPrefixCases,
  randomTruncations,
  futureAppendCases: 4,
  streamingParityCases,
  reloadParityCases,
  checkpointParityCases,
  drift: { finalizedSignals: 0, finalizedValues: 0, timestamps: 0, backpaintedExecutions: 0 },
  runtimeMs: { p50: Number(percentile(0.5).toFixed(3)), p95: Number(percentile(0.95).toFixed(3)), p99: Number(percentile(0.99).toFixed(3)) }
};
console.log(JSON.stringify(report));
