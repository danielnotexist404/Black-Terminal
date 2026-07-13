import assert from "node:assert/strict";
import { TypedEventBus } from "../src/core/events/eventBus.ts";
import { ServiceRegistry } from "../src/core/services/serviceRegistry.ts";
import { MarketCache } from "../src/market-data/cache/marketCache.ts";
import { blackCoreResourceTracker } from "../src/performance/resourceTracker.ts";

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

for (const item of tests) {
  await item.run();
  console.log(`PASS ${item.name}`);
}
console.log(`Performance regression tests passed: ${tests.length}/${tests.length}`);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
