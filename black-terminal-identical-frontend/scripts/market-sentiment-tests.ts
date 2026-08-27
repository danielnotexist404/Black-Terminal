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

console.log(`BC-MSO core tests passed (${snapshot.events.length} confirmed band events).`);
