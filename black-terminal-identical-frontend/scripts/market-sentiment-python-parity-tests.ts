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
const settings = migrateMarketSentimentSettings({ smoothingEnabled: true, smoothingLength: 5, overbought: 7.75, oversold: 3.25 });
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
      oversold: settings.oversold
    },
    lastBarConfirmed: false
  }),
  encoding: "utf8"
});
assert.equal(python.status, 0, python.stderr);
const reference = JSON.parse(python.stdout) as {
  series: { rawSentiment: Array<number | null>; sentiment: Array<number | null> };
  events: Array<{ index: number; time: number; score: number; kind: string }>;
  latest: { score: number | null; zone: string };
};

function closeSeries(actual: Array<number | null>, expected: Array<number | null>, label: string) {
  assert.equal(actual.length, expected.length, `${label} length`);
  actual.forEach((value, index) => {
    if (value === null || expected[index] === null) assert.equal(value, expected[index], `${label}[${index}] null parity`);
    else assert.ok(Math.abs(value - expected[index]!) < 1e-9, `${label}[${index}] ${value} != ${expected[index]}`);
  });
}

closeSeries(browser.series.rawSentiment, reference.series.rawSentiment, "rawSentiment");
closeSeries(browser.series.sentiment, reference.series.sentiment, "sentiment");
assert.deepEqual(browser.events, reference.events);
assert.deepEqual(browser.latest, reference.latest);
console.log("BC-MSO Python/browser parity passed.");
