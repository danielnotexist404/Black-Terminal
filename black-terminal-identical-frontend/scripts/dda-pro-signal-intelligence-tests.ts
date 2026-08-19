import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Candle } from "../src/chart-engine/types.ts";
import {
  blankSeries,
  ddaProAlertSignalStream,
  deriveCausalDDAProSignalCandidates,
  deriveDDAProSignals
} from "../src/modules/dda-pro/core/engineShared.ts";
import { calculateDDAProNative } from "../src/modules/dda-pro/core/nativeEngine.ts";
import {
  applyDDAProSignalIntelligenceMode,
  DEFAULT_DDA_PRO_SETTINGS,
  migrateDDAProSettings,
  resetDDAProSignalIntelligence
} from "../src/modules/dda-pro/core/settings.ts";
import {
  applyDDAProSignalIntelligence,
  completedHigherTimeframeDirection,
  DDA_PRO_MAX_SIGNAL_EPISODES
} from "../src/modules/dda-pro/core/signalIntelligence.ts";
import { DDA_PRO_INDICATOR_ID, type DDAProCalculationInput, type DDAProSeries, type DDAProSignalDirection, type DDAProSignalEvent } from "../src/modules/dda-pro/core/types.ts";

function candles(values: readonly number[], timeframeSeconds = 300, start = 1_700_000_000): Candle[] {
  return values.map((close, index) => ({
    time: start + index * timeframeSeconds,
    open: index ? values[index - 1]! : close,
    high: Math.max(close, index ? values[index - 1]! : close) * 1.002,
    low: Math.min(close, index ? values[index - 1]! : close) * 0.998,
    close,
    volume: 1_000 + index * 3
  }));
}

function rawSignal(index: number, direction: DDAProSignalDirection, source: readonly Candle[]): DDAProSignalEvent {
  return {
    id: `raw-${direction}-${index}`,
    indicatorId: DDA_PRO_INDICATOR_ID,
    direction,
    index,
    time: source[index]!.time,
    value: Math.abs(index),
    sourceEventType: direction === "long" ? "DDA_DRAWDOWN_DEEPENED" : "DDA_DRAWDOWN_RECOVERED",
    markerTone: direction === "long" ? "silver-white" : "blood-red"
  };
}

function distributionSeries(centroids: readonly number[], widths: readonly number[], tail: readonly number[]): DDAProSeries {
  const series = blankSeries(centroids.length);
  const keys = ["p05", "p10", "p25", "p50", "p75", "p90", "p95", "p99"] as const;
  const offsets = [-0.5, -0.4, -0.25, 0, 0.25, 0.4, 0.46, 0.5];
  for (let index = 0; index < centroids.length; index++) {
    const centroid = centroids[index]!;
    const width = widths[index] ?? 1;
    for (let band = 0; band < keys.length; band++) series[keys[band]!]![index] = centroid + offsets[band]! * width;
    series.mean[index] = centroid;
    series.rawDrawdown[index] = centroid + (tail[index] ?? 0) * width * 0.5;
    series.smoothedDrawdown[index] = series.rawDrawdown[index]!;
    series.depth[index] = Math.max(0, -series.rawDrawdown[index]!);
  }
  return series;
}

const filteredSettings = migrateDDAProSettings({
  ...DEFAULT_DDA_PRO_SETTINGS,
  signalIntelligenceMode: "CUSTOM",
  showRawSignals: false,
  showConfirmedSignals: true,
  distributionCoherenceFilter: true,
  riskCentroidMigration: true,
  distributionExpansionConfirmation: true,
  tailAsymmetryConfirmation: true,
  entropyChopSuppression: true,
  excursionPersistence: true,
  signalEpisodeClustering: true,
  distributionalResetRequirement: true,
  minimumCoherence: 40,
  minimumCentroidDisplacement: 0.03,
  minimumCentroidPersistence: 2,
  minimumExpansionScore: 0,
  minimumTailAsymmetry: 20,
  maximumChopProbability: 80,
  maximumTransitionEntropy: 80,
  minimumExcursionBars: 2,
  minimumConfirmationScore: 45,
  resetSensitivity: 25,
  episodeSeparationSensitivity: 5,
  safetyCooldownFloor: 3,
  priceStructureConfirmation: false,
  volumeConfirmation: false,
  cvdConfirmation: false,
  higherTimeframeConfirmation: false
});

function calculationInput(source: Candle[], settings = filteredSettings): DDAProCalculationInput {
  return { candles: source, settings, timeframeSeconds: 300, signalContext: { exchange: "BYBIT", symbol: "BTCUSDT", timeframe: "5m" } };
}

{
  const values = [
    ...Array.from({ length: 100 }, (_, index) => 100 + index * 0.2),
    ...Array.from({ length: 35 }, (_, index) => 120 - index * 0.45),
    ...Array.from({ length: 35 }, (_, index) => 104.7 + index * 0.5)
  ];
  const source = candles(values);
  const raw = calculateDDAProNative({ candles: source, settings: applyDDAProSignalIntelligenceMode(DEFAULT_DDA_PRO_SETTINGS, "RAW"), timeframeSeconds: 300 });
  assert.deepEqual(raw.rawSignals, deriveDDAProSignals(raw.events), "RAW signal sequence changed");
  assert.deepEqual(raw.signals, raw.rawSignals, "RAW intelligence must be a byte-for-byte pass-through");
  assert.deepEqual(raw.rawSignals.map(({ id, direction, index, time, sourceEventType, markerTone }) => ({ id, direction, index, time, sourceEventType, markerTone })), [
    { id: "bc-rda-long-1700040200", direction: "long", index: 134, time: 1_700_040_200, sourceEventType: "DDA_DRAWDOWN_DEEPENED", markerTone: "silver-white" },
    { id: "bc-rda-short-1700049800", direction: "short", index: 166, time: 1_700_049_800, sourceEventType: "DDA_DRAWDOWN_RECOVERED", markerTone: "blood-red" }
  ], "RAW golden fixture changed");
}

{
  const source = candles(Array.from({ length: 32 }, (_, index) => 100 + index * 0.05));
  const centroids = Array.from({ length: 32 }, (_, index) => index < 12 ? -index * 0.2 : index < 18 ? -2.2 : -2.2 - (index - 17) * 0.2);
  const widths = Array.from({ length: 32 }, (_, index) => index < 12 ? 1 + index * 0.04 : index < 18 ? 1.1 : 1.1 + (index - 17) * 0.03);
  const tails = Array.from({ length: 32 }, (_, index) => index >= 12 && index < 18 ? 0 : -1);
  const series = distributionSeries(centroids, widths, tails);
  const candidates = [rawSignal(8, "long", source), rawSignal(10, "long", source), rawSignal(22, "long", source)];
  const result = applyDDAProSignalIntelligence(calculationInput(source), series, candidates);
  assert.deepEqual(result.signals.map((signal) => signal.index), [8, 22], "one unresolved episode emitted duplicate confirmed signals or failed to re-arm after reset");
  assert.equal(result.intelligence.episodes[0]?.rawSignalCount, 2, "same-episode raw triggers were not clustered");
  assert.equal(result.intelligence.longState[8], "CONFIRMED");
  assert.notEqual(result.intelligence.shortState[8], "CONFIRMED", "long confirmation mutated the independent short state machine");

  const prefixLength = 18;
  const prefix = applyDDAProSignalIntelligence(
    calculationInput(source.slice(0, prefixLength)),
    distributionSeries(centroids.slice(0, prefixLength), widths.slice(0, prefixLength), tails.slice(0, prefixLength)),
    candidates.filter((signal) => signal.index < prefixLength)
  );
  assert.deepEqual(result.signals.filter((signal) => signal.index < prefixLength), prefix.signals, "future bars changed a closed confirmed signal");
  for (const key of ["regime", "longConfidence", "shortConfidence", "chopProbability", "centroidAcceleration", "state"] as const) {
    assert.deepEqual(result.intelligence[key].slice(0, prefixLength), prefix.intelligence[key], `${key} leaked future data`);
  }
}

{
  const source = candles(Array.from({ length: 40 }, (_, index) => 100 + Math.sin(index) * 0.05));
  const centroids = Array.from({ length: 40 }, (_, index) => index % 2 ? -0.35 : -0.1);
  const series = distributionSeries(centroids, new Array(40).fill(1), new Array(40).fill(-1));
  const candidates = Array.from({ length: 12 }, (_, index) => rawSignal(8 + index * 2, "long", source));
  const chopSettings = migrateDDAProSettings({ ...filteredSettings, maximumChopProbability: 20, maximumTransitionEntropy: 20, minimumCentroidPersistence: 3, minimumExcursionBars: 3 });
  const result = applyDDAProSignalIntelligence(calculationInput(source, chopSettings), series, candidates);
  assert.equal(result.signals.length, 0, "high-transition chop produced a filtered confirmation");
  assert.equal(result.intelligence.suppressedRawSignalCount, candidates.length);
  assert.ok(Math.max(...result.intelligence.transitionEntropy.slice(10)) > chopSettings.maximumTransitionEntropy);
}

{
  const source = candles(Array.from({ length: 8 }, (_, index) => index + 1), 60, 0);
  const input = { candles: source, settings: { ...filteredSettings, higherTimeframeMultiplier: 4 as const }, timeframeSeconds: 60 };
  assert.equal(completedHigherTimeframeDirection(input, 6), 0, "forming higher-timeframe bucket was used as confirmation");
  const mutated = candles([1, 2, 3, 4, 500, 400, 300, 8], 60, 0);
  assert.equal(completedHigherTimeframeDirection({ ...input, candles: mutated }, 6), 0, "forming higher-timeframe values leaked into confirmation");
  assert.equal(completedHigherTimeframeDirection(input, 7), 1, "fully closed higher-timeframe buckets were not compared");
}

{
  const depth = [0, 1, 2, 3, 2, 0, 0, 1, 2, 4, 0];
  const source = candles(depth.map((value) => 100 - value));
  const full = deriveCausalDDAProSignalCandidates(source, depth, 1);
  const prefix = deriveCausalDDAProSignalCandidates(source.slice(0, 6), depth.slice(0, 6), 1);
  assert.deepEqual(full.filter((signal) => signal.index < 6), prefix, "causal candidate history changed when future bars were appended");
}

{
  const balancedA = applyDDAProSignalIntelligenceMode(DEFAULT_DDA_PRO_SETTINGS, "BALANCED");
  const balancedB = applyDDAProSignalIntelligenceMode(DEFAULT_DDA_PRO_SETTINGS, "BALANCED");
  assert.deepEqual(balancedA, balancedB, "BALANCED preset is not deterministic");
  assert.equal(balancedA.showRawSignals, false);
  assert.equal(balancedA.showConfirmedSignals, true);
  const institutional = applyDDAProSignalIntelligenceMode(DEFAULT_DDA_PRO_SETTINGS, "INSTITUTIONAL");
  assert.ok(institutional.minimumConfirmationScore > balancedA.minimumConfirmationScore);
  assert.ok(institutional.maximumChopProbability < balancedA.maximumChopProbability);
  const malformed = migrateDDAProSettings({ signalIntelligenceMode: "INVALID" as never, minimumCoherence: Number.NaN, maximumChopProbability: 500, showProvisionalSignals: "yes" as never });
  assert.equal(malformed.signalIntelligenceMode, "RAW");
  assert.equal(malformed.minimumCoherence, DEFAULT_DDA_PRO_SETTINGS.minimumCoherence);
  assert.equal(malformed.maximumChopProbability, 100);
  assert.equal(malformed.showProvisionalSignals, false);
  const reset = resetDDAProSignalIntelligence({ ...balancedA, minimumCoherence: 3, showSignalConfidence: true });
  assert.equal(reset.minimumCoherence, balancedA.minimumCoherence);
  assert.equal(reset.showSignalConfidence, DEFAULT_DDA_PRO_SETTINGS.showSignalConfidence);
}

{
  const length = 700;
  const source = candles(new Array(length).fill(100));
  const settings = migrateDDAProSettings({
    ...filteredSettings,
    distributionCoherenceFilter: false,
    riskCentroidMigration: false,
    distributionExpansionConfirmation: false,
    tailAsymmetryConfirmation: false,
    entropyChopSuppression: false,
    excursionPersistence: false,
    signalEpisodeClustering: false,
    distributionalResetRequirement: false,
    minimumConfirmationScore: 0,
    safetyCooldownFloor: 0,
    episodeSeparationSensitivity: 0
  });
  const result = applyDDAProSignalIntelligence(
    calculationInput(source, settings),
    distributionSeries(new Array(length).fill(-1), new Array(length).fill(1), new Array(length).fill(0)),
    Array.from({ length: length - 1 }, (_, index) => rawSignal(index + 1, "long", source))
  );
  assert.equal(result.intelligence.episodes.length, DDA_PRO_MAX_SIGNAL_EPISODES, "episode state exceeded its hard bound");
}

{
  const source = candles([100, 110, 90, 110]);
  const rawSettings = applyDDAProSignalIntelligenceMode(DEFAULT_DDA_PRO_SETTINGS, "RAW");
  const snapshot = calculateDDAProNative({ candles: source, settings: rawSettings, timeframeSeconds: 300 });
  assert.deepEqual(ddaProAlertSignalStream(snapshot, rawSettings), snapshot.rawSignals);
  const filtered = { ...snapshot, signals: snapshot.rawSignals.slice(0, 1), signalIntelligence: { ...snapshot.signalIntelligence, mode: "BALANCED" as const, rawCandidateSignals: snapshot.rawSignals } };
  const confirmedSettings = { ...applyDDAProSignalIntelligenceMode(DEFAULT_DDA_PRO_SETTINGS, "BALANCED"), showConfirmedSignals: true };
  assert.deepEqual(ddaProAlertSignalStream(filtered, confirmedSettings), filtered.signals, "confirmed alerts did not consume the rendered confirmed stream");
  assert.deepEqual(ddaProAlertSignalStream(filtered, { ...confirmedSettings, showConfirmedSignals: false }), [], "a hidden confirmed dot remained alertable");
  assert.deepEqual(ddaProAlertSignalStream(filtered, { ...confirmedSettings, confirmedAlertsOnly: false, showRawSignals: true }), filtered.signalIntelligence.rawCandidateSignals, "explicit raw alerts did not consume visible raw candidates");
  assert.ok(!ddaProAlertSignalStream(filtered, confirmedSettings).some((signal) => signal.classification === "provisional"), "provisional signal entered the confirmed alert stream");
}

{
  const renderer = readFileSync(new URL("../src/chart-engine/BlackChartEngine.ts", import.meta.url), "utf8");
  const chart = readFileSync(new URL("../src/components/PixiBlackChart.tsx", import.meta.url), "utf8");
  const theme = readFileSync(new URL("../src/styles/theme.css", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../src/modules/dda-pro/workers/DDAProWorkerClient.ts", import.meta.url), "utf8");
  const intelligence = readFileSync(new URL("../src/modules/dda-pro/core/signalIntelligence.ts", import.meta.url), "utf8");
  assert.match(renderer, /markerTone === "blood-red"[\s\S]*?#ff1838[\s\S]*?#f2f2f4/, "short/long signal colors are not blood-red and silver-white");
  assert.match(renderer, /dashboardPanelWidth[\s\S]*?roundRect\(panelX, panelY[\s\S]*?alpha:\s*0\.9/, "BC-RDA dashboard has no high-contrast backing panel");
  assert.match(renderer, /resolution:\s*Math\.min\(3, Math\.max\(2[\s\S]*?roundPixels:\s*true/, "BC-RDA diagnostic text is not rendered on a pixel-snapped high-resolution surface");
  assert.match(renderer, /signalIntelligence\.rawCandidateSignals/);
  assert.match(chart, /ddaProAlertSignalStream\(ddaProSnapshot, ddaProSettings\)/, "alerts independently recalculate the signal condition");
  assert.match(chart, /ddaSignalAlertArmedAtRef/, "mount/reconnect alert arming guard is missing");
  assert.match(chart, /ddaConfiguredEventsRef/, "canonical event idempotency guard is missing");
  assert.match(chart, /indicator-settings profile-settings oscillator-settings dda-pro-settings/, "BC-RDA settings are not mounted in the bounded scroll shell");
  assert.match(theme, /\.indicator-settings\.dda-pro-settings[\s\S]*?overflow-y:\s*auto[\s\S]*?scrollbar-gutter:\s*stable/, "BC-RDA advanced controls can be clipped below the chart without a visible scroll affordance");
  assert.match(worker, /DDA_PRO_STALE_GENERATION/, "stale worker generations are not rejected");
  assert.doesNotMatch(intelligence, /camera|viewport|visibleRange/i, "signal calculation depends on chart navigation state");
  assert.doesNotMatch(intelligence, /RADAP|HDLX|liquidation/i, "signal intelligence imported an unrelated indicator dependency");
  assert.doesNotMatch(chart, /placeOrder|submitOrder|cancelOrder/, "BC-RDA settings introduced an execution path");
}

console.log("BC-RDA signal intelligence RAW parity, causal regime, episode, alert/dot, HTF, bounds, and settings tests: PASS");
