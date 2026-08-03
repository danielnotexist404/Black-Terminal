import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { migrateAuctionProfileSettings } from "../src/modules/auction-profile/core/settings.ts";
import { appendTradesToAuctionProfile, calculateAuctionProfile } from "../src/modules/auction-profile/engines/nativeEngine.ts";
import { auctionFixture } from "../src/modules/auction-profile/testing/fixtures.ts";
import { validateAuctionProfileInvariants } from "../src/modules/auction-profile/testing/nativeValidation.ts";

const cases = [
  [5000, 256],
  [10000, 512],
  [20000, 1024],
  [20000, 2048]
] as const;

const results: Array<Record<string, number>> = [];
for (const [barCount, targetRows] of cases) {
  const { bars } = auctionFixture(barCount);
  const settings = migrateAuctionProfileSettings({
    schemaVersion: 1,
    implementationMode: "BLACK_CORE_NATIVE",
    scopeMode: "MACRO_COMPOSITE",
    calculationEngine: "HYBRID_AUCTION_SCORE",
    dataSource: "CHART_BARS",
    lookbackBars: barCount,
    targetRows,
    maximumRows: targetRows,
    nodeDetection: { method: "HYBRID", prominence: 0.1 }
  });
  const input = {
    venue: "bybit" as const,
    symbol: "BTCUSDT",
    timeframe: "1h" as const,
    bars,
    trades: [],
    settings,
    sourceRevision: "benchmark:" + barCount + ":" + targetRows,
    now: 1_720_000_000_000
  };
  const memoryBefore = process.memoryUsage().heapUsed;
  const coldStart = performance.now();
  const first = calculateAuctionProfile(input);
  const coldMs = performance.now() - coldStart;
  const warmStart = performance.now();
  const second = calculateAuctionProfile(input);
  const warmMs = performance.now() - warmStart;
  assert.ok(first && second);
  assert.equal(first.profileVersion, second.profileVersion);
  assert.deepEqual(validateAuctionProfileInvariants(first), []);
  const serializeStart = performance.now();
  JSON.stringify(first);
  const serializationMs = performance.now() - serializeStart;
  const incrementalTrade = {
    venue: "bybit",
    symbol: "BTCUSDT",
    timestamp: bars.at(-1)!.time + 10,
    tradeId: "benchmark-increment",
    price: bars.at(-1)!.close,
    quantity: 1,
    notional: bars.at(-1)!.close,
    aggressorSide: "BUY" as const,
    source: "EXCHANGE_AGGRESSOR_FLAG" as const
  };
  const incrementStart = performance.now();
  appendTradesToAuctionProfile(first, [incrementalTrade], settings);
  const incrementalMs = performance.now() - incrementStart;
  results.push({
    bars: barCount,
    rows: first.rows.length,
    coldMs: Number(coldMs.toFixed(2)),
    warmMs: Number(warmMs.toFixed(2)),
    incrementalMs: Number(incrementalMs.toFixed(2)),
    serializationMs: Number(serializationMs.toFixed(2)),
    estimatedBytes: first.diagnostics.memoryEstimateBytes,
    measuredHeapDeltaBytes: Math.max(0, process.memoryUsage().heapUsed - memoryBefore)
  });
}
assert.ok(results.every(result => result.coldMs < 10_000), "a browser worker rebuild must stay bounded");
console.table(results);
