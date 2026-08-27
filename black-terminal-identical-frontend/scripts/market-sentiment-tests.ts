import assert from "node:assert/strict";
import { calculateMarketSentiment } from "../src/modules/market-sentiment/core/engine.ts";
import { DEFAULT_MARKET_SENTIMENT_SETTINGS, migrateMarketSentimentSettings } from "../src/modules/market-sentiment/core/settings.ts";
import type { Candle } from "../src/chart-engine/types.ts";

function fixture(length = 900): Candle[] {
  return Array.from({ length }, (_, index) => {
    const cycle = Math.sin(index / 17) * 5 + Math.sin(index / 61) * 11;
    const trend = index < 280 ? index * 0.08 : index < 560 ? (560 - index) * 0.13 : (index - 560) * 0.06;
    const close = 120 + cycle + trend;
    const open = close - Math.sin(index / 4) * 0.7;
    return {
      time: 1_700_000_000 + index * 300,
      open,
      high: Math.max(open, close) + 0.7 + index % 3 * 0.08,
      low: Math.min(open, close) - 0.65 - index % 5 * 0.04,
      close,
      volume: 800 + (index % 41) * 19 + Math.abs(Math.sin(index / 7)) * 1100
    };
  });
}

const candles = fixture();
const settings = migrateMarketSentimentSettings({
  ...DEFAULT_MARKET_SENTIMENT_SETTINGS,
  smoothingEnabled: true,
  smoothingLength: 4
});
const snapshot = calculateMarketSentiment({ candles, settings, lastBarConfirmed: false });

assert.equal(snapshot.authority, "CAUSAL_OHLCV_COMPOSITE");
assert.equal(snapshot.integrity.causal, true);
assert.equal(snapshot.integrity.finalizedBarEventsOnly, true);
assert.equal(snapshot.integrity.futureBarsConsumed, 0);
assert.equal(snapshot.series.sentiment.length, candles.length);
assert.ok(snapshot.series.sentiment.slice(205).every((value) => value !== null && value >= 0 && value <= 10));
assert.ok(snapshot.events.every((event) => event.index < candles.length - 1), "developing bar emitted an event");
assert.ok(snapshot.events.every((event) => ["ENTER_OVERBOUGHT", "EXIT_OVERBOUGHT", "ENTER_OVERSOLD", "EXIT_OVERSOLD"].includes(event.kind)));

const prefixLength = 700;
const prefix = calculateMarketSentiment({ candles: candles.slice(0, prefixLength), settings, lastBarConfirmed: true });
const full = calculateMarketSentiment({ candles, settings, lastBarConfirmed: true });
assert.deepEqual(full.series.rawSentiment.slice(0, prefixLength), prefix.series.rawSentiment, "future bars changed raw history");
assert.deepEqual(full.series.sentiment.slice(0, prefixLength), prefix.series.sentiment, "future bars changed smoothed history");

for (const event of snapshot.events) {
  const previous = snapshot.series.sentiment[event.index - 1];
  const current = snapshot.series.sentiment[event.index];
  assert.notEqual(previous, null);
  assert.notEqual(current, null);
  if (event.kind === "ENTER_OVERBOUGHT") assert.ok(previous! < settings.overbought && current! >= settings.overbought);
  if (event.kind === "EXIT_OVERBOUGHT") assert.ok(previous! >= settings.overbought && current! < settings.overbought);
  if (event.kind === "ENTER_OVERSOLD") assert.ok(previous! > settings.oversold && current! <= settings.oversold);
  if (event.kind === "EXIT_OVERSOLD") assert.ok(previous! <= settings.oversold && current! > settings.oversold);
}

const migrated = migrateMarketSentimentSettings({ overbought: -1, oversold: 99, lookback: 8, lineWidth: 50 });
assert.ok(migrated.overbought > migrated.oversold);
assert.equal(migrated.lookback, 250);
assert.equal(migrated.lineWidth, 5);

function swingFixture(length = 1800, secondsPerBar = 7200): Candle[] {
  return Array.from({ length }, (_, index) => {
    const cycle = Math.sin(index / 17) * 5 + Math.sin(index / 61) * 11;
    const trend = index < 600 ? index * 0.08 : index < 1200 ? (1200 - index) * 0.13 : (index - 1200) * 0.06;
    const close = 120 + cycle + trend;
    const open = close - Math.sin(index / 4) * 0.7;
    return {
      time: 1_700_000_000 + index * secondsPerBar,
      open,
      high: Math.max(open, close) + 0.7 + index % 3 * 0.08,
      low: Math.min(open, close) - 0.65 - index % 5 * 0.04,
      close,
      volume: 800 + (index % 41) * 19 + Math.abs(Math.sin(index / 7)) * 1100
    };
  });
}

const adaptiveCandles = swingFixture();
const adaptiveSettings = migrateMarketSentimentSettings({
  calculationMode: "ADAPTIVE_EVT",
  adaptiveWindow: 500,
  minimumCalibrationSamples: 80,
  evtMinimumTailSamples: 12
});
const adaptive = calculateMarketSentiment({ candles: adaptiveCandles, settings: adaptiveSettings, lastBarConfirmed: true });
assert.equal(adaptive.authority, "CAUSAL_REGIME_EVT");
assert.equal(adaptive.integrity.priorBarsOnlyCalibration, true);
assert.equal(adaptive.integrity.historicalValuesFrozen, true);
assert.ok(adaptive.series.sentiment.some((value) => value !== null));
assert.ok(adaptive.series.sentiment.every((value) => value === null || (value >= 0 && value <= 10)));
assert.ok(adaptive.series.evtActive.some(Boolean), "EVT never activated with a sufficient prior tail sample");
assert.ok(adaptive.series.dynamicUpper.some((value) => value !== null && value > adaptiveSettings.tailConfidence / 10), "uptrend did not expand the upper extreme");
assert.ok(adaptive.series.dynamicLower.some((value) => value !== null && value < (100 - adaptiveSettings.tailConfidence) / 10), "downtrend did not expand the lower extreme");

const adaptiveSignals = adaptive.events.filter((event) => event.kind.startsWith("CONFIRMED_ADAPTIVE"));
assert.ok(adaptiveSignals.length > 0, "deterministic swing fixture produced no confirmed adaptive signal");
for (const signal of adaptiveSignals) {
  const matchingTail = adaptive.events.findLast((event) => event.index <= signal.index && (
    signal.kind === "CONFIRMED_ADAPTIVE_LONG" ? event.kind === "ENTER_OVERSOLD" : event.kind === "ENTER_OVERBOUGHT"
  ));
  assert.ok(matchingTail && matchingTail.index < signal.index, `${signal.kind} was not armed by an earlier tail entry`);
  assert.ok(signal.tailProbability !== null);
}
for (const kind of ["CONFIRMED_ADAPTIVE_LONG", "CONFIRMED_ADAPTIVE_SHORT"] as const) {
  const sameSide = adaptiveSignals.filter((event) => event.kind === kind);
  for (let index = 1; index < sameSide.length; index += 1) {
    assert.ok(sameSide[index]!.index - sameSide[index - 1]!.index >= adaptiveSettings.signalCooldownBars, `${kind} violated cooldown`);
  }
}

const adaptivePrefixLength = 1400;
const adaptivePrefix = calculateMarketSentiment({ candles: adaptiveCandles.slice(0, adaptivePrefixLength), settings: adaptiveSettings, lastBarConfirmed: true });
for (const key of ["latentSentiment", "empiricalPercentile", "sentiment", "dynamicUpper", "dynamicLower", "tailProbability", "regime"] as const) {
  assert.deepEqual(adaptive.series[key].slice(0, adaptivePrefixLength), adaptivePrefix.series[key], `future bars changed adaptive ${key}`);
}
assert.deepEqual(
  adaptive.events.filter((event) => event.index < adaptivePrefixLength),
  adaptivePrefix.events,
  "future bars changed confirmed adaptive event history"
);
const adaptiveDeveloping = calculateMarketSentiment({ candles: adaptiveCandles, settings: adaptiveSettings, lastBarConfirmed: false });
assert.deepEqual(adaptiveDeveloping.series, adaptive.series, "developing-bar status changed historical or current calculations");
assert.ok(adaptiveDeveloping.events.every((event) => event.index < adaptiveCandles.length - 1), "developing adaptive bar emitted an event");

const dailyCandles = swingFixture(1800, 86_400);
const dailyAdaptive = calculateMarketSentiment({ candles: dailyCandles, settings: adaptiveSettings, lastBarConfirmed: true });
assert.deepEqual(dailyAdaptive.series.sentiment, adaptive.series.sentiment, "identical OHLCV produced different 2H and daily adaptive scores");
assert.deepEqual(
  dailyAdaptive.events.map(({ index, kind }) => ({ index, kind })),
  adaptive.events.map(({ index, kind }) => ({ index, kind })),
  "identical OHLCV produced different 2H and daily event locations"
);

const empiricalFallbackSettings = migrateMarketSentimentSettings({
  ...adaptiveSettings,
  evtMinimumTailSamples: 250
});
const empiricalFallback = calculateMarketSentiment({ candles: adaptiveCandles, settings: empiricalFallbackSettings, lastBarConfirmed: true });
assert.ok(!empiricalFallback.series.evtActive.some(Boolean), "EVT activated without its configured tail sample");
assert.ok(empiricalFallback.series.sentiment.some((value) => value !== null), "empirical fallback stopped the oscillator");

const adaptiveStart = performance.now();
calculateMarketSentiment({ candles: swingFixture(20_000), settings: migrateMarketSentimentSettings({ ...adaptiveSettings, lookback: 20_000 }) });
const adaptiveElapsed = performance.now() - adaptiveStart;
assert.ok(adaptiveElapsed < 5000, `20K adaptive evaluation exceeded 5s (${adaptiveElapsed.toFixed(1)}ms)`);

console.log(`BC-MSO core tests passed (${snapshot.events.length} original events, ${adaptiveSignals.length} adaptive signals, 20K in ${adaptiveElapsed.toFixed(1)}ms).`);
