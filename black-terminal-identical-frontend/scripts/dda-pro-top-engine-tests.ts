import assert from "node:assert/strict";
import type { Candle } from "../src/chart-engine/types.ts";
import {
  ddaProAlertSignalStream,
  deriveDDAProSignals
} from "../src/modules/dda-pro/core/engineShared.ts";
import { calculateDDAProNative } from "../src/modules/dda-pro/core/nativeEngine.ts";
import {
  applyDDAProSignalIntelligenceMode,
  DEFAULT_DDA_PRO_SETTINGS,
  migrateDDAProSettings
} from "../src/modules/dda-pro/core/settings.ts";
import { DDA_PRO_SETTINGS_VERSION } from "../src/modules/dda-pro/core/types.ts";

function candles(values: readonly number[], timeframeSeconds: number, start = 1_700_000_000): Candle[] {
  return values.map((close, index) => {
    const open = index ? values[index - 1]! : close;
    return {
      time: start + index * timeframeSeconds,
      open,
      high: Math.max(open, close) * 1.0015,
      low: Math.min(open, close) * 0.9985,
      close,
      volume: 1_000 + index * 7
    };
  });
}

function grow(seed: number, changes: readonly number[]) {
  const values = [seed];
  for (const change of changes) values.push(values.at(-1)! * (1 + change / 100));
  return values;
}

function shallowBullChanges(length = 420) {
  return Array.from({ length }, (_, index) => index % 8 === 7 ? -0.30 : 0.22);
}

function terminalTopChanges() {
  return [
    ...new Array(125).fill(0.34),
    0.24, 0.20, 0.16, 0.12, 0.08, 0.04,
    -0.10, 0.12, -0.14, 0.10, -0.18, 0.06,
    ...new Array(14).fill(-1.10)
  ];
}

function repeatedTouchChanges() {
  return [
    ...new Array(125).fill(0.34),
    ...Array.from({ length: 20 }, (_, index) => index % 2 === 0 ? 0.16 : -0.12),
    ...new Array(14).fill(-1.10)
  ];
}

function twoCycleChanges() {
  return [
    ...terminalTopChanges(),
    ...new Array(16).fill(-0.80),
    ...new Array(95).fill(0.42),
    0.20, 0.14, 0.08, -0.12, 0.08, -0.18,
    ...new Array(16).fill(-1.15)
  ];
}

const settings = migrateDDAProSettings({
  ...applyDDAProSignalIntelligenceMode(DEFAULT_DDA_PRO_SETTINGS, "RAW"),
  lookback: 100,
  topReturnQuantileLookback: 100,
  topAtrLookback: 14,
  topMinimumMaturityBars: 12,
  showRawSignals: true,
  showConfirmedSignals: true,
  showEpisodeMarkers: true
});

function snapshot(values: readonly number[], timeframeSeconds: number, overrides = {}) {
  return calculateDDAProNative({
    candles: candles(values, timeframeSeconds),
    settings: migrateDDAProSettings({ ...settings, ...overrides }),
    timeframeSeconds,
    signalContext: {
      exchange: "BYBIT",
      symbol: "BTCUSDT",
      timeframe: timeframeSeconds === 14_400 ? "4h" : timeframeSeconds === 86_400 ? "1d" : `${timeframeSeconds}s`
    }
  });
}

function shorts(result: ReturnType<typeof snapshot>) {
  return result.signals.filter((signal) => signal.direction === "short");
}

// Protected pre-correction long golden master.
{
  const values = [
    ...Array.from({ length: 100 }, (_, index) => 100 + index * 0.2),
    ...Array.from({ length: 35 }, (_, index) => 120 - index * 0.45),
    ...Array.from({ length: 35 }, (_, index) => 104.7 + index * 0.5)
  ];
  const source = candles(values, 300);
  const result = calculateDDAProNative({ candles: source, settings, timeframeSeconds: 300 });
  assert.deepEqual(
    result.rawSignals
      .filter((signal) => signal.direction === "long")
      .map(({ id, index, time, value, sourceEventType, markerTone }) => ({ id, index, time, value, sourceEventType, markerTone })),
    [{
      id: "bc-rda-long-1700040200",
      index: 134,
      time: 1_700_040_200,
      value: 12.749999999999995,
      sourceEventType: "DDA_DRAWDOWN_DEEPENED",
      markerTone: "silver-white"
    }],
    "the protected bottom/long golden object changed"
  );
}

// Recovery remains a lifecycle event and is directionally neutral.
{
  const result = snapshot(grow(100, shallowBullChanges()), 14_400);
  assert.ok(result.events.some((event) => event.type === "DDA_DRAWDOWN_RECOVERED"));
  assert.equal(
    deriveDDAProSignals(result.events).some((signal) => signal.direction === "short"),
    false,
    "drawdown recovery still derived a short"
  );
  assert.equal(shorts(result).length, 0, "shallow 4H bull pullbacks created a confirmed short");
}

// Elevated drawup without a bearish structure break may watch/build, but never confirms.
{
  const values = grow(100, [
    ...new Array(180).fill(0.30),
    ...Array.from({ length: 40 }, (_, index) => index % 10 === 9 ? -0.35 : 0.18)
  ]);
  const result = snapshot(values, 14_400);
  assert.ok(result.topSeries.state.some((state) => state === "BULL_ADVANCE"));
  assert.equal(shorts(result).length, 0, "strong bull continuation created a countertrend short");
}

const fourHourValues = grow(100, terminalTopChanges());
const fourHour = snapshot(fourHourValues, 14_400);
assert.equal(shorts(fourHour).length, 1, "genuine 4H terminal top did not create exactly one confirmed short");
assert.equal(fourHour.topEpisodes.length, 1, "one 4H terminal cycle created multiple top episodes");
assert.equal(shorts(fourHour)[0]?.classification, "confirmed");
assert.equal(shorts(fourHour)[0]?.sourceEventType, "TOP_REVERSAL_CONFIRMED");

{
  const result = snapshot(grow(100, repeatedTouchChanges()), 14_400);
  assert.equal(result.topEpisodes.length, 1, "repeated terminal touches split one unresolved top episode");
  assert.ok(result.topEpisodes[0]!.terminalTouches >= 2);
  assert.equal(shorts(result).length, 1, "repeated touches emitted duplicate confirmed shorts");
}

{
  const result = snapshot(grow(100, twoCycleChanges()), 14_400);
  assert.equal(shorts(result).length, 2, "a meaningful reset did not permit exactly one short in the new episode");
  assert.equal(new Set(shorts(result).map((signal) => signal.episodeId)).size, 2, "new top episode reused the old episode identity");
}

// Every appended prefix preserves all already-confirmed top signal objects.
{
  let prior: ReturnType<typeof shorts> = [];
  for (let size = 1; size <= fourHourValues.length; size++) {
    const current = shorts(snapshot(fourHourValues.slice(0, size), 14_400));
    assert.deepEqual(current.slice(0, prior.length), prior, `confirmed top repainted at prefix ${size}`);
    prior = current;
  }
  assert.equal(prior.length, 1);
}

// A provisional extremity may move to a later high but is never alertable.
{
  const developing = grow(100, [...new Array(125).fill(0.34), ...new Array(8).fill(0.12)]);
  const first = snapshot(developing, 14_400, { showTopCandidates: true });
  assert.equal(first.topCandidates.length, 1, "mature active top did not expose a provisional extremity");
  const advancedValues = [...developing, developing.at(-1)! * 1.002];
  const advanced = snapshot(advancedValues, 14_400, { showTopCandidates: true });
  assert.equal(advanced.topCandidates.length, 1);
  assert.ok(advanced.topCandidates[0]!.index > first.topCandidates[0]!.index, "provisional extremity did not advance with a new high");
  assert.equal(
    ddaProAlertSignalStream(advanced, migrateDDAProSettings({ ...settings, showTopCandidates: true }))
      .some((signal) => signal.classification === "provisional"),
    false
  );
}

// Solid confirmed short dots and alertable short events consume the identical IDs.
{
  const alertable = ddaProAlertSignalStream(fourHour, settings).filter((signal) => signal.direction === "short");
  assert.deepEqual(alertable.map((signal) => signal.id), shorts(fourHour).map((signal) => signal.id));
  assert.equal(new Set(alertable.map((signal) => signal.id)).size, alertable.length);
  const staleRecoveryShort = {
    ...alertable[0]!,
    id: "legacy-recovery-short",
    sourceEventType: "DDA_DRAWDOWN_RECOVERED" as never
  };
  const staleSnapshot = {
    ...fourHour,
    rawSignals: [...fourHour.rawSignals, staleRecoveryShort]
  };
  assert.ok(!ddaProAlertSignalStream(staleSnapshot, settings).some((signal) => signal.id === staleRecoveryShort.id),
    "legacy recovery short leaked through the migrated alert contract");
}

// Daily fixture uses the same causal percentages at a different cadence.
{
  const daily = snapshot(grow(20_000, terminalTopChanges()), 86_400);
  assert.equal(shorts(daily).length, 1, "genuine 1D terminal top did not create exactly one confirmed short");
}

// Price scale does not alter states, confirmation indexes, or episode count.
{
  const base = snapshot(fourHourValues, 14_400);
  const scaled = snapshot(fourHourValues.map((value) => value * 1_000), 14_400);
  assert.deepEqual(scaled.topSeries.state, base.topSeries.state);
  assert.deepEqual(shorts(scaled).map((signal) => signal.index), shorts(base).map((signal) => signal.index));
  assert.equal(scaled.topEpisodes.length, base.topEpisodes.length);
}

// The top anchor is explicitly bound to the declared analytical horizon.
{
  const shortLookback = snapshot(fourHourValues, 14_400, { lookback: 100 });
  const longLookback = snapshot(fourHourValues, 14_400, { lookback: 200 });
  assert.equal(shortLookback.topEpisodes[0]?.analyticalHorizon, 100);
  assert.equal(longLookback.topEpisodes[0]?.analyticalHorizon, 200);
}

// Optional flow absence lowers confidence; required exact flow fails closed.
{
  const source = candles(fourHourValues, 14_400);
  const exactFlow = source.map((candle) => ({
    time: candle.time,
    buyVolume: 400,
    sellVolume: 600,
    unknownVolume: 0,
    buyNotional: 40_000,
    sellNotional: 60_000,
    unknownNotional: 0,
    exactTradeCount: 100,
    totalTradeCount: 100,
    deliveryComplete: true
  }));
  const withFlow = calculateDDAProNative({
    candles: source,
    settings,
    timeframeSeconds: 14_400,
    flowBars: exactFlow,
    flowAuthority: "EXACT_AGGRESSOR_TRADES",
    signalContext: { exchange: "BYBIT", symbol: "BTCUSDT", timeframe: "4h" }
  });
  assert.ok((shorts(withFlow)[0]?.confidence ?? 0) > (shorts(fourHour)[0]?.confidence ?? 0));
  const requiredMissing = snapshot(fourHourValues, 14_400, { topRequireExactBearishFlow: true });
  assert.equal(shorts(requiredMissing).length, 0, "required exact bearish flow did not fail closed");
}

{
  const migrated = migrateDDAProSettings({ settingsVersion: 4 as never });
  assert.equal(migrated.settingsVersion, DDA_PRO_SETTINGS_VERSION);
  assert.equal(migrated.enableMirroredTopEngine, true);
  assert.equal(migrated.topEngineMode, "mirrored-causal");
  assert.equal(migrated.topAnchorMethod, "causal-episode-trough");
  assert.equal(migrated.modelVersion, "v2-causal");
}

// Exact adversarial correction: no early short, later structural top remains eligible.
{
  const adversarial = grow(100, [
    ...new Array(80).fill(0.34), ...new Array(5).fill(-1.10), ...new Array(100).fill(0.34),
    0.20, 0.14, 0.08, -0.12, 0.08, -0.18, ...new Array(16).fill(-1.15)
  ]);
  for (const mode of ["RAW", "BALANCED", "INSTITUTIONAL"] as const) {
    const result = snapshot(adversarial, 14_400, applyDDAProSignalIntelligenceMode(settings, mode));
    assert.ok(!result.rawSignals.some((signal) => signal.direction === "short" && signal.index <= 84), `${mode} confirmed the ordinary correction`);
    assert.ok(result.rawSignals.some((signal) => signal.direction === "short" && signal.index > 184), `${mode} never evaluated the later final top`);
  }
  const rawDecision = snapshot(adversarial, 14_400, applyDDAProSignalIntelligenceMode(settings, "RAW"));
  const balancedDecision = snapshot(adversarial, 14_400, applyDDAProSignalIntelligenceMode(settings, "BALANCED"));
  const institutionalDecision = snapshot(adversarial, 14_400, applyDDAProSignalIntelligenceMode(settings, "INSTITUTIONAL"));
  assert.equal(shorts(rawDecision).length, 1, "RAW did not pass through the confirmed V2 top");
  assert.equal(shorts(balancedDecision).length, 0, "BALANCED did not independently arbitrate the top candidate");
  assert.equal(shorts(institutionalDecision).length, 0, "INSTITUTIONAL did not independently arbitrate the top candidate");
  assert.ok((balancedDecision.signalIntelligence.suppressedRawSignalCount ?? 0) > 0);
  assert.ok((institutionalDecision.signalIntelligence.suppressedRawSignalCount ?? 0) > 0);
  const result = snapshot(adversarial, 14_400);
  assert.notEqual(result.topSeries.dynamicTopBarrier[84], result.topSeries.dynamicTopBarrier[184], "the V2 barrier froze through the continuing advance");
}

// History outside every declared horizon cannot alter the in-window top path.
{
  const tail = grow(100, terminalTopChanges());
  const historyA = [...new Array(120).fill(100), ...tail.slice(1)];
  const historyB = [
    ...Array.from({ length: 119 }, (_, index) => 100 + Math.sin(index / 3) * 4),
    100,
    ...tail.slice(1)
  ];
  const overrides = { lookback: 100, topRegimeHorizon: 100, topStructuralHorizon: 80, topReturnQuantileLookback: 80 };
  const resultA = snapshot(historyA, 14_400, overrides);
  const resultB = snapshot(historyB, 14_400, overrides);
  const compareFrom = 220;
  assert.deepEqual(resultB.topSeries.state.slice(compareFrom), resultA.topSeries.state.slice(compareFrom));
  assert.deepEqual(
    shorts(resultB).filter((signal) => signal.index >= compareFrom).map((signal) => signal.index),
    shorts(resultA).filter((signal) => signal.index >= compareFrom).map((signal) => signal.index),
    "out-of-horizon candles changed in-window V2 confirmations"
  );
}

// Explicit preservation mode restores the exact pre-532 recovery short and isolates V2.
{
  const values = grow(100, [...new Array(50).fill(0.20), ...new Array(10).fill(-1), ...new Array(20).fill(0.80)]);
  const legacy = snapshot(values, 14_400, { modelVersion: "legacy-pre-532" });
  assert.ok(legacy.rawSignals.some((signal) => signal.direction === "short" && signal.sourceEventType === "DDA_DRAWDOWN_RECOVERED"));
  assert.equal(legacy.topEpisodes.length, 0);
  assert.match(legacy.engineVersion, /PRE_532_LEGACY/);
}

// Byte-for-byte pre-532 RAW golden master behind the explicit legacy selector.
{
  const values = [
    ...Array.from({ length: 100 }, (_, index) => 100 + index * 0.2),
    ...Array.from({ length: 35 }, (_, index) => 120 - index * 0.45),
    ...Array.from({ length: 35 }, (_, index) => 104.7 + index * 0.5)
  ];
  const legacy = snapshot(values, 300, {
    ...applyDDAProSignalIntelligenceMode(settings, "RAW"),
    modelVersion: "legacy-pre-532"
  });
  assert.deepEqual(
    legacy.rawSignals.map(({ id, direction, index, time, sourceEventType, markerTone }) => ({ id, direction, index, time, sourceEventType, markerTone })),
    [
      { id: "bc-rda-long-1700040200", direction: "long", index: 134, time: 1_700_040_200, sourceEventType: "DDA_DRAWDOWN_DEEPENED", markerTone: "silver-white" },
      { id: "bc-rda-short-1700049800", direction: "short", index: 166, time: 1_700_049_800, sourceEventType: "DDA_DRAWDOWN_RECOVERED", markerTone: "blood-red" }
    ]
  );
}

console.log(
  `BC-RDA V2/legacy selection, causality, recovery neutrality, adversarial re-arm, long parity, prefix stability, 4H/1D, alert/dot, flow, scale, and reset tests: PASS (4H shorts=${shorts(fourHour).length})`
);
