import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { Candle } from "../src/chart-engine/types.ts";
import { calculateDDAProNative } from "../src/modules/dda-pro/core/nativeEngine.ts";
import { applyDDAProSignalIntelligenceMode, DEFAULT_DDA_PRO_SETTINGS } from "../src/modules/dda-pro/core/settings.ts";
import type { DDAProSignalEvent } from "../src/modules/dda-pro/core/types.ts";

type Fixture = { name: string; timeframeSeconds: number; scale: number; values: number[]; missingEvery?: number };

const oscillate = (length: number, base: number, amplitude: number, period: number, drift = 0) =>
  Array.from({ length }, (_, index) => base + Math.sin(index / period) * amplitude + index * drift);

const fixtures: Fixture[] = [
  { name: "clean-directional-expansion", timeframeSeconds: 300, scale: 100, values: [...Array.from({ length: 120 }, (_, i) => 100 + i * 0.15), ...Array.from({ length: 50 }, (_, i) => 118 - i * 0.42), ...Array.from({ length: 45 }, (_, i) => 97.4 + i * 0.5)] },
  { name: "tight-consolidation", timeframeSeconds: 900, scale: 1, values: oscillate(260, 1, 0.0025, 1.7) },
  { name: "volatile-two-sided-chop", timeframeSeconds: 3_600, scale: 65_000, values: Array.from({ length: 280 }, (_, i) => 65_000 + Math.sin(i * 1.83) * 1_800 + Math.sin(i * 0.39) * 900) },
  { name: "compression-breakout", timeframeSeconds: 300, scale: 100, values: [...oscillate(160, 100, 0.15, 4), ...Array.from({ length: 100 }, (_, i) => 100 + i * 0.32)] },
  { name: "failed-breakout-redistribution", timeframeSeconds: 900, scale: 100, values: [...oscillate(100, 100, 1, 5), ...Array.from({ length: 25 }, (_, i) => 100 + i * 0.5), ...Array.from({ length: 55 }, (_, i) => 112 - i * 0.42), ...oscillate(80, 89, 2, 3)] },
  { name: "trend-shallow-pullbacks", timeframeSeconds: 3_600, scale: 100, values: Array.from({ length: 280 }, (_, i) => 100 + i * 0.14 + Math.sin(i / 5) * 1.1) },
  { name: "exhaustion-reversal", timeframeSeconds: 14_400, scale: 100, values: [...Array.from({ length: 140 }, (_, i) => 100 + i * 0.3), ...Array.from({ length: 45 }, (_, i) => 142 + i * 0.08), ...Array.from({ length: 85 }, (_, i) => 145.6 - i * 0.52)] },
  { name: "alternating-crossings", timeframeSeconds: 300, scale: 100, values: Array.from({ length: 260 }, (_, i) => 100 + (i % 2 ? 1.4 : -1.4) + Math.sin(i / 8) * 0.4) },
  { name: "long-short-episodes", timeframeSeconds: 900, scale: 100, values: [...Array.from({ length: 80 }, (_, i) => 100 + i * 0.2), ...Array.from({ length: 35 }, (_, i) => 116 - i * 0.45), ...Array.from({ length: 45 }, (_, i) => 100.7 + i * 0.4), ...Array.from({ length: 35 }, (_, i) => 118.3 - i * 0.48), ...Array.from({ length: 45 }, (_, i) => 101.5 + i * 0.43)] },
  { name: "sparse-missing-bars", timeframeSeconds: 3_600, scale: 100, values: oscillate(260, 100, 6, 11, 0.02), missingEvery: 17 },
  { name: "small-price-scale", timeframeSeconds: 300, scale: 0.7, values: oscillate(260, 0.7, 0.08, 13, 0.0002) },
  { name: "daily-macro", timeframeSeconds: 86_400, scale: 2_000, values: oscillate(300, 2_000, 260, 21, 1.2) }
];

function candlesFor(fixture: Fixture): Candle[] {
  let skipped = 0;
  return fixture.values.map((close, index) => {
    if (fixture.missingEvery && index > 0 && index % fixture.missingEvery === 0) skipped += 1;
    const time = 1_700_000_000 + (index + skipped) * fixture.timeframeSeconds;
    const prior = fixture.values[Math.max(0, index - 1)] ?? close;
    return { time, open: prior, high: Math.max(prior, close) * 1.002, low: Math.min(prior, close) * 0.998, close, volume: 1_000 + (index % 31) * 17 };
  });
}

function excursions(signals: readonly DDAProSignalEvent[], source: readonly Candle[], horizons = [3, 6, 12]) {
  return horizons.map((horizon) => {
    const outcomes = signals.flatMap((signal) => {
      const entry = source[signal.index]?.close;
      const future = source.slice(signal.index + 1, signal.index + 1 + horizon).map((candle) => candle.close);
      if (!(entry && future.length)) return [];
      const signed = future.map((price) => (price / entry - 1) * 100 * (signal.direction === "long" ? 1 : -1));
      return [{ forwardReturn: signed.at(-1) ?? 0, mfe: Math.max(...signed), mae: Math.min(...signed) }];
    });
    const mean = (key: keyof (typeof outcomes)[number]) => outcomes.length ? outcomes.reduce((sum, item) => sum + item[key], 0) / outcomes.length : null;
    return { horizon, samples: outcomes.length, meanForwardReturnPercent: mean("forwardReturn"), meanMfePercent: mean("mfe"), meanMaePercent: mean("mae") };
  });
}

const report = [];
const started = performance.now();
for (const fixture of fixtures) {
  const source = candlesFor(fixture);
  const common = { ...DEFAULT_DDA_PRO_SETTINGS, lookback: 100 };
  const raw = calculateDDAProNative({ candles: source, settings: applyDDAProSignalIntelligenceMode(common, "RAW"), timeframeSeconds: fixture.timeframeSeconds, signalContext: { exchange: "FIXTURE", symbol: fixture.name, timeframe: `${fixture.timeframeSeconds}s` } });
  const balanced = calculateDDAProNative({ candles: source, settings: applyDDAProSignalIntelligenceMode(common, "BALANCED"), timeframeSeconds: fixture.timeframeSeconds, signalContext: { exchange: "FIXTURE", symbol: fixture.name, timeframe: `${fixture.timeframeSeconds}s` } });
  const confirmedBottomSignals = balanced.signals.filter((signal) => signal.direction === "long");
  const confirmedTopSignals = balanced.signals.filter((signal) => signal.direction === "short");
  assert.ok(confirmedBottomSignals.length <= balanced.signalIntelligence.rawCandidateSignals.length, `${fixture.name}: confirmed bottom count exceeds causal bottom candidates`);
  assert.ok(confirmedTopSignals.length <= balanced.topEpisodes.length, `${fixture.name}: confirmed top count exceeds causal top episodes`);
  assert.ok(balanced.signalIntelligence.episodes.length <= 512, `${fixture.name}: episode bound exceeded`);
  for (const signal of balanced.signals) {
    assert.equal(signal.classification, "confirmed");
    assert.ok((signal.confidence ?? -1) >= 0 && (signal.confidence ?? 101) <= 100);
    assert.equal(signal.id.split(":")[1], "fixture");
  }
  const cuts = [Math.floor(source.length * 0.5), Math.floor(source.length * 0.75)];
  for (const cut of cuts) {
    const prefix = calculateDDAProNative({ candles: source.slice(0, cut), settings: applyDDAProSignalIntelligenceMode(common, "BALANCED"), timeframeSeconds: fixture.timeframeSeconds, signalContext: { exchange: "FIXTURE", symbol: fixture.name, timeframe: `${fixture.timeframeSeconds}s` } });
    assert.deepEqual(balanced.signals.filter((signal) => signal.index < cut), prefix.signals, `${fixture.name}: historical calculation disagrees with incremental prefix replay at ${cut}`);
  }
  const segments = [
    ["development", 0, Math.floor(source.length * 0.5)],
    ["validation", Math.floor(source.length * 0.5), Math.floor(source.length * 0.75)],
    ["holdout", Math.floor(source.length * 0.75), source.length]
  ] as const;
  report.push({
    fixture: fixture.name,
    timeframeSeconds: fixture.timeframeSeconds,
    priceScale: fixture.scale,
    rawSignalCount: raw.rawSignals.length,
    causalCandidateCount: balanced.signalIntelligence.rawCandidateSignals.length,
    confirmedSignalCount: balanced.signals.length,
    confirmedBottomSignalCount: confirmedBottomSignals.length,
    confirmedTopSignalCount: confirmedTopSignals.length,
    clusteredEpisodeCount: balanced.signalIntelligence.episodes.length,
    duplicateSuppressionCount: balanced.signalIntelligence.suppressedRawSignalCount,
    regimeDistribution: Object.fromEntries([...new Set(balanced.signalIntelligence.regime)].map((regime) => [regime, balanced.signalIntelligence.regime.filter((value) => value === regime).length])),
    forwardDistributions: excursions(balanced.signals, source),
    walkForward: segments.map(([name, from, to]) => ({ name, from, to, signals: balanced.signals.filter((signal) => signal.index >= from && signal.index < to).length }))
  });
}

const chopRows = report.filter((row) => ["tight-consolidation", "volatile-two-sided-chop", "alternating-crossings"].includes(row.fixture));
assert.ok(chopRows.every((row) => row.confirmedBottomSignalCount <= row.causalCandidateCount * 0.2), "chop fixtures did not materially suppress repetitive bottom candidates");
assert.equal(report.find((row) => row.fixture === "clean-directional-expansion")?.confirmedBottomSignalCount, 1, "organized downside expansion did not retain one clustered confirmation");
assert.equal(report.find((row) => row.fixture === "alternating-crossings")?.confirmedSignalCount, 0, "alternating recross noise was not suppressed");
const elapsedMs = performance.now() - started;
console.log(JSON.stringify({ methodology: "DETERMINISTIC_FIXTURES_NOT_A_PROFITABILITY_BACKTEST", fixtures: report, elapsedMs }, null, 2));
console.log("BC-RDA 12-regime causal walk-forward/selectivity validation: PASS");
