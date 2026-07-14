import assert from "node:assert/strict";
import { TypedEventBus } from "../src/core/events/eventBus.ts";
import { ServiceRegistry } from "../src/core/services/serviceRegistry.ts";
import { MarketCache } from "../src/market-data/cache/marketCache.ts";
import { blackCoreResourceTracker } from "../src/performance/resourceTracker.ts";
import { DomAggregationEngine } from "../src/modules/dom-pro/domAggregationEngine.ts";
import { defaultDomSettings } from "../src/modules/dom-pro/domSettingsStore.ts";
import { readFileSync } from "node:fs";

const tests = [];
const test = (name, run) => tests.push({ name, run });

test("Black Core rejects conflicting duplicate service registration", () => {
  const registry = new ServiceRegistry();
  const service = {};
  registry.register("market", service);
  registry.register("market", service);
  assert.throws(() => registry.register("market", {}), /already registered/);
});

test("event bus subscriptions clean up deterministically", () => {
  const bus = new TypedEventBus();
  const unsubscribe = bus.subscribe("tick", () => undefined);
  assert.equal(bus.diagnostics().listenerCount, 1);
  unsubscribe();
  assert.equal(bus.diagnostics().listenerCount, 0);
});

test("high-frequency events coalesce to the newest payload", async () => {
  const bus = new TypedEventBus();
  const values = [];
  bus.subscribe("tick", (value) => values.push(value));
  for (let value = 0; value < 100; value += 1) bus.publishLatest("tick", value, 5);
  await sleep(15);
  assert.deepEqual(values, [99]);
  assert.equal(bus.diagnostics().coalescedPublishes, 99);
});

test("market cache bounds symbol keys and per-symbol trade history", () => {
  const cache = new MarketCache();
  for (let symbolIndex = 0; symbolIndex < 40; symbolIndex += 1) {
    const symbol = { exchange: "bybit", rawSymbol: `SYM${symbolIndex}USDT`, baseAsset: `SYM${symbolIndex}`, quoteAsset: "USDT", marketKind: "perpetual" };
    for (let tradeIndex = 0; tradeIndex < 1100; tradeIndex += 1) {
      cache.appendTrade({ exchange: "bybit", symbol: symbol.rawSymbol, tradeId: `${symbolIndex}:${tradeIndex}`, price: 1, quantity: 1, side: "buy", time: tradeIndex });
    }
  }
  assert.equal(cache.diagnostics().trades, 16);
  const latest = { exchange: "bybit", rawSymbol: "SYM39USDT", baseAsset: "SYM39", quoteAsset: "USDT", marketKind: "perpetual" };
  assert.equal(cache.getTrades(latest).length, 1000);
});

test("resource releases are idempotent and return to baseline", () => {
  const before = blackCoreResourceTracker.snapshot().totalActive;
  const release = blackCoreResourceTracker.acquire("worker", "test");
  assert.equal(blackCoreResourceTracker.snapshot().totalActive, before + 1);
  release();
  release();
  assert.equal(blackCoreResourceTracker.snapshot().totalActive, before);
});

test("DOM aggregation uses bounded CVD buckets and bounded heatmap history", () => {
  const engine = new DomAggregationEngine();
  const marketSymbol = { exchange: "bybit", rawSymbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", marketKind: "perpetual" };
  const settings = { ...defaultDomSettings("test", "bybit:perpetual:BTCUSDT"), cvdSampleIntervalSec: 10, maxHeatmapHistory: 32 };
  const book = {
    exchange: "bybit", symbol: "BTCUSDT", time: Date.now() / 1000,
    bids: Array.from({ length: 80 }, (_, index) => ({ price: 100 - index * .1, quantity: index + 1 })),
    asks: Array.from({ length: 80 }, (_, index) => ({ price: 100.1 + index * .1, quantity: index + 1 }))
  };
  const trades = Array.from({ length: 200 }, (_, index) => ({ exchange: "bybit", symbol: "BTCUSDT", tradeId: `t${index}`, price: 100, quantity: 1, side: index % 2 ? "sell" : "buy", time: index }));
  const snapshot = engine.aggregate({ marketSymbol, book, ticker: null, trades, settings, subscriptionCount: 1 });
  assert.ok(snapshot.cvdSeries.length <= 21, `expected time-bucketed CVD, received ${snapshot.cvdSeries.length}`);
  assert.ok(snapshot.heatmap.length <= 32);
  assert.ok(snapshot.trace?.aggregate_total.durationMs >= 0);
});

test("DOM heatmap hot path does not create per-cell React elements", () => {
  const source = readFileSync(new URL("../src/modules/dom-pro/components/DomProWindow.tsx", import.meta.url), "utf8");
  assert.equal(source.includes('className={`dom-pro-heatmap-cell'), false);
  assert.ok(source.includes("<DomHeatmapCanvas"));
});

for (const item of tests) {
  await item.run();
  console.log(`PASS ${item.name}`);
}
console.log(`Performance regression tests passed: ${tests.length}/${tests.length}`);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
