import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { calculateMarketSentiment } from "../src/modules/market-sentiment/core/engine.ts";
import { migrateMarketSentimentSettings } from "../src/modules/market-sentiment/core/settings.ts";
import type { Candle } from "../src/chart-engine/types.ts";

const candles: Candle[] = Array.from({ length: 760 }, (_, index) => {
  const close = 500 + Math.sin(index / 11) * 17 + Math.cos(index / 37) * 31 + index * 0.015;
  const open = close + Math.sin(index / 3) * 1.1;
  return { time: 1_710_000_000 + index * 900, open, high: Math.max(open, close) + 1.8, low: Math.min(open, close) - 1.6, close, volume: 1000 + (index % 23) * 71 };
});
const settings = migrateMarketSentimentSettings({
  smoothingEnabled: true,
  smoothingLength: 5,
  calculationMode: "ADAPTIVE_EVT",
  adaptiveWindow: 400,
  minimumCalibrationSamples: 80,
  tailConfidence: 96.5,
  evtThresholdPercentile: 88,
  evtMinimumTailSamples: 12,
  regimeLength: 100,
  requireStructureConfirmation: true,
  signalCooldownBars: 18
});
const browser = calculateMarketSentiment({ candles, settings, lastBarConfirmed: false });
const python = spawnSync("python3", ["-m", "black_core_indicators.market_sentiment"], {
  cwd: process.cwd(),
  env: { ...process.env, PYTHONPATH: `${process.cwd()}/python` },
  input: JSON.stringify({
    candles,
    settings: {
      lookback: settings.lookback,
      candleTransform: settings.candleTransform,
      heikinAshi: settings.heikinAshi,
      smoothingEnabled: settings.smoothingEnabled,
      smoothingLength: settings.smoothingLength,
      overbought: settings.overbought,
      oversold: settings.oversold,
      calculationMode: settings.calculationMode,
      adaptiveWindow: settings.adaptiveWindow,
      minimumCalibrationSamples: settings.minimumCalibrationSamples,
      tailConfidence: settings.tailConfidence,
      evtThresholdPercentile: settings.evtThresholdPercentile,
      evtMinimumTailSamples: settings.evtMinimumTailSamples,
      atrLength: settings.atrLength,
      regimeLength: settings.regimeLength,
      regimeSlopeLength: settings.regimeSlopeLength,
      regimeThreshold: settings.regimeThreshold,
      trendExpansion: settings.trendExpansion,
      minimumTailDwell: settings.minimumTailDwell,
      structureLength: settings.structureLength,
      requireStructureConfirmation: settings.requireStructureConfirmation,
      signalCooldownBars: settings.signalCooldownBars
    },
    lastBarConfirmed: false
  }),
  encoding: "utf8"
});
assert.equal(python.status, 0, python.stderr);
const reference = JSON.parse(python.stdout) as {
  authority: string;
  series: {
    rawSentiment: Array<number | null>;
    latentSentiment: Array<number | null>;
    empiricalPercentile: Array<number | null>;
    sentiment: Array<number | null>;
    dynamicUpper: Array<number | null>;
    dynamicLower: Array<number | null>;
    tailProbability: Array<number | null>;
    calibrationSamples: number[];
    evtActive: boolean[];
    regime: string[];
    regimeStrength: number[];
  };
  events: typeof browser.events;
  latest: typeof browser.latest;
};

function closeSeries(actual: Array<number | null>, expected: Array<number | null>, label: string) {
  assert.equal(actual.length, expected.length, `${label} length`);
  actual.forEach((value, index) => {
    if (value === null || expected[index] === null) assert.equal(value, expected[index], `${label}[${index}] null parity`);
    else assert.ok(Math.abs(value - expected[index]!) < 1e-9, `${label}[${index}] ${value} != ${expected[index]}`);
  });
}

closeSeries(browser.series.rawSentiment, reference.series.rawSentiment, "rawSentiment");
closeSeries(browser.series.latentSentiment, reference.series.latentSentiment, "latentSentiment");
closeSeries(browser.series.empiricalPercentile, reference.series.empiricalPercentile, "empiricalPercentile");
closeSeries(browser.series.sentiment, reference.series.sentiment, "sentiment");
closeSeries(browser.series.dynamicUpper, reference.series.dynamicUpper, "dynamicUpper");
closeSeries(browser.series.dynamicLower, reference.series.dynamicLower, "dynamicLower");
closeSeries(browser.series.tailProbability, reference.series.tailProbability, "tailProbability");
closeSeries(browser.series.regimeStrength, reference.series.regimeStrength, "regimeStrength");
assert.equal(browser.authority, reference.authority);
assert.deepEqual(browser.series.calibrationSamples, reference.series.calibrationSamples);
assert.deepEqual(browser.series.evtActive, reference.series.evtActive);
assert.deepEqual(browser.series.regime, reference.series.regime);
assert.equal(browser.events.length, reference.events.length);
browser.events.forEach((event, index) => {
  const expected = reference.events[index]!;
  assert.deepEqual(
    { index: event.index, time: event.time, kind: event.kind, regime: event.regime },
    { index: expected.index, time: expected.time, kind: expected.kind, regime: expected.regime }
  );
  assert.ok(Math.abs(event.score - expected.score) < 1e-9);
  assert.ok(Math.abs(event.threshold - expected.threshold) < 1e-9);
  if (event.tailProbability === null || expected.tailProbability === null) assert.equal(event.tailProbability, expected.tailProbability);
  else assert.ok(Math.abs(event.tailProbability - expected.tailProbability) < 1e-9);
});
assert.deepEqual(
  {
    zone: browser.latest.zone,
    regime: browser.latest.regime,
    calibrationSamples: browser.latest.calibrationSamples,
    evtActive: browser.latest.evtActive
  },
  {
    zone: reference.latest.zone,
    regime: reference.latest.regime,
    calibrationSamples: reference.latest.calibrationSamples,
    evtActive: reference.latest.evtActive
  }
);
for (const key of ["score", "rawScore", "latentScore", "regimeStrength", "dynamicUpper", "dynamicLower", "tailProbability"] as const) {
  const actual = browser.latest[key];
  const expected = reference.latest[key];
  if (actual === null || expected === null) assert.equal(actual, expected, `latest.${key}`);
  else assert.ok(Math.abs(actual - expected) < 1e-9, `latest.${key}`);
}
console.log("BC-MSO adaptive EVT Python/browser parity passed.");
