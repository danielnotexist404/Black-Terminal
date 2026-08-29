import assert from "node:assert/strict";
import type { Candle } from "../src/chart-engine/types.ts";
import type { MarketDataAdapter, MarketSymbol } from "../src/market-data/types.ts";
import { KioseffHistoryCache } from "../src/modules/kioseff-stop-loss-clustering/data/cache.ts";
import {
  aggregateKioseffQuality,
  groupKioseffIntrabars
} from "../src/modules/kioseff-stop-loss-clustering/data/grouping.ts";
import {
  normalizeKioseffCandles,
  stableSourceVersion
} from "../src/modules/kioseff-stop-loss-clustering/data/normalization.ts";
import {
  KioseffHistoryCoordinator,
  KioseffRealtimeIntrabarReconciler,
  shouldRefreshKioseffHistory
} from "../src/modules/kioseff-stop-loss-clustering/data/historyCoordinator.ts";
import { utcBucketStart } from "../src/modules/kioseff-stop-loss-clustering/data/timeframes.ts";
import type { KioseffHistoryResult } from "../src/modules/kioseff-stop-loss-clustering/data/types.ts";
import { selectKioseffLiveUpdateBars } from "../src/modules/kioseff-stop-loss-clustering/data/liveUpdate.ts";

const minute = 60;
const base = 1_704_067_200; // 2024-01-01 00:00:00 UTC

assert.equal(
  shouldRefreshKioseffHistory(base, base),
  false,
  "an update to the open chart candle must not restart full intrabar history"
);
assert.equal(
  shouldRefreshKioseffHistory(base, base + minute),
  true,
  "a newly opened chart candle schedules a causal intrabar tail update"
);

const liveHistory = Array.from({ length: 10 }, (_, index) => ({
  time: base + index * minute,
  open: 100 + index,
  high: 101 + index,
  low: 99 + index,
  close: 100.5 + index,
  volume: 10 + index
}));
assert.deepEqual(
  selectKioseffLiveUpdateBars(liveHistory, {
    committedThrough: base + 8 * minute,
    lastProcessedBarTime: base + 9 * minute
  }),
  [],
  "repeated snapshots of the current open bar are idempotent"
);
const nextLiveBar = {
  time: base + 10 * minute,
  open: 110,
  high: 111,
  low: 109,
  close: 110.5,
  volume: 20
};
assert.deepEqual(
  selectKioseffLiveUpdateBars([...liveHistory, nextLiveBar], {
    committedThrough: base + 8 * minute,
    lastProcessedBarTime: base + 9 * minute
  }).map((bar) => bar.time),
  [base + 9 * minute, base + 10 * minute],
  "a new candle advances the warmed worker with only the formerly provisional and new provisional bars"
);
const rollingHistory = [...liveHistory];
const rollingCursor = {
  committedThrough: base + 8 * minute,
  lastProcessedBarTime: base + 9 * minute
};
for (let index = 10; index < 20; index += 1) {
  rollingHistory.push({
    time: base + index * minute,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 10 + index
  });
  const tail = selectKioseffLiveUpdateBars(rollingHistory, rollingCursor);
  assert.deepEqual(
    tail.map((bar) => bar.time),
    [base + (index - 1) * minute, base + index * minute],
    "successive live candles must stay on the two-bar incremental path"
  );
  rollingCursor.committedThrough = base + (index - 1) * minute;
  rollingCursor.lastProcessedBarTime = base + index * minute;
}

function candles(count: number, start = base): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const open = 100 + index * 0.05;
    return {
      time: start + index * minute,
      open,
      high: open + 0.1,
      low: open - 0.1,
      close: open + 0.025,
      volume: 10 + index
    };
  });
}

function normalize(source: Candle[]) {
  return normalizeKioseffCandles(source, {
    source: "fixture",
    sourceRevision: "fixture-v1"
  });
}

for (const [timeframe, expected] of [
  ["5m", 5],
  ["15m", 15],
  ["1h", 60],
  ["4h", 240],
  ["1d", 1440]
] as const) {
  const chart = normalize([{
    time: base,
    open: 100,
    high: 200,
    low: 90,
    close: 150,
    volume: expected * 10
  }]).candles;
  const grouped = groupKioseffIntrabars(chart, normalize(candles(expected)).candles, {
    chartTimeframe: timeframe,
    lowerTimeframe: "1m",
    now: base + expected * minute
  });
  assert.equal(grouped[0]?.intrabars.length, expected, `1m → ${timeframe}`);
  assert.equal(grouped[0]?.quality.complete, true, `${timeframe} coverage complete`);
}

const malformed = candles(6);
malformed.splice(3, 1);
malformed.push({ ...malformed[1]!, close: 999 });
malformed.push({ ...malformed[0]!, time: base - minute });
const normalizedMalformed = normalize(malformed);
assert.deepEqual(normalizedMalformed.duplicateTimes, [base + minute]);
assert.deepEqual(normalizedMalformed.conflictingTimes, [base + minute]);
assert.ok(normalizedMalformed.outOfOrderTimes.length > 0);
const malformedGrouped = groupKioseffIntrabars(
  normalize([{ time: base, open: 100, high: 101, low: 99, close: 100, volume: 1 }]).candles,
  normalizedMalformed.candles,
  {
    chartTimeframe: "5m",
    lowerTimeframe: "1m",
    now: base + 300,
    duplicateTimes: normalizedMalformed.duplicateTimes,
    outOfOrderTimes: normalizedMalformed.outOfOrderTimes,
    conflictingTimes: normalizedMalformed.conflictingTimes
  }
);
assert.deepEqual(malformedGrouped[0]?.quality.missingTimes, [base + 180]);
assert.equal(malformedGrouped[0]?.quality.complete, false);

const partial = groupKioseffIntrabars(
  normalize([{ time: base, open: 1, high: 2, low: 1, close: 2, volume: 1 }]).candles,
  normalize(candles(3)).candles,
  { chartTimeframe: "5m", lowerTimeframe: "1m", now: base + 190 }
);
assert.equal(partial[0]?.chartBarClosed, false);
assert.equal(partial[0]?.quality.partial, true);
assert.equal(partial[0]?.quality.expectedCount, 3);
assert.equal(partial[0]?.quality.complete, true);

const mismatch = groupKioseffIntrabars(
  normalize([{ time: base, open: 1, high: 2, low: 1, close: 2, volume: 1 }]).candles,
  normalize(candles(5)).candles,
  { chartTimeframe: "5m", lowerTimeframe: "1m", now: base + 300, sourceMismatch: true }
);
assert.deepEqual(mismatch[0]?.quality.flags, ["source-history-live-mismatch"]);

assert.equal(utcBucketStart(base + 86_399, "1d"), base);
assert.equal(utcBucketStart(base + 86_400, "1d"), base + 86_400);

const reconciler = new KioseffRealtimeIntrabarReconciler();
reconciler.setHistorical(normalize(candles(5)).candles);
reconciler.replaceRealtime(
  [{ ...candles(5)[4]!, close: 123 }, ...candles(2, base + 5 * minute)],
  "fixture-live",
  "live-1"
);
const reconciled = reconciler.snapshot();
assert.equal(reconciled.candles.length, 7, "history/live overlap is deduplicated");
assert.equal(reconciled.candles[4]?.close, 123, "realtime revision wins overlap");

assert.equal(
  stableSourceVersion(["fixture", 1, true]),
  stableSourceVersion(["fixture", 1, true]),
  "source hashes are deterministic"
);

const aggregate = aggregateKioseffQuality([...partial, ...mismatch]);
assert.equal(aggregate.sourceMismatch, true);

let activeHistoryRequests = 0;
let maximumActiveHistoryRequests = 0;
const historyAdapter = {
  id: "bybit",
  label: "Bybit fixture",
  normalizeSymbol: (symbol: string) => symbol,
  getHistoricalCandles: async (query) => {
    activeHistoryRequests += 1;
    maximumActiveHistoryRequests = Math.max(maximumActiveHistoryRequests, activeHistoryRequests);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const result: Candle[] = [];
    for (let time = query.from ?? base; time <= (query.to ?? base); time += minute) {
      result.push({
        time,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1
      });
    }
    activeHistoryRequests -= 1;
    return result;
  }
} as MarketDataAdapter;
const concurrentChart = Array.from({ length: 30 }, (_, index) => ({
  time: base + index * 3600,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 60
}));
const concurrentSymbol = {
  exchange: "bybit",
  rawSymbol: "BTCUSDT",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  marketKind: "perpetual",
  metadata: {
    exchange: "bybit",
    rawSymbol: "BTCUSDT",
    normalizedSymbol: "BTCUSDT",
    assetClass: "crypto",
    marketKind: "perpetual",
    tickSize: "0.1",
    timezone: "UTC",
    sessionPolicy: "24x7",
    source: "fixture"
  }
} satisfies MarketSymbol;
const concurrentHistory = await new KioseffHistoryCoordinator().load({
  adapter: historyAdapter,
  symbol: concurrentSymbol,
  chartCandles: concurrentChart,
  targetChartBars: 60,
  chartTimeframe: "1h",
  lowerTimeframe: "1m",
  transport: "fixture",
  now: base + 30 * 3600
});
assert.equal(concurrentHistory.quality.complete, true);
assert.equal(concurrentHistory.quality.actualCount, 1800);
assert.equal(concurrentHistory.warmup.completedChartBars, 30);
assert.equal(concurrentHistory.warmup.targetChartBars, 60);
assert.equal(concurrentHistory.warmup.full, false, "requested lookback remains truthful when chart history is shorter");
assert.ok(maximumActiveHistoryRequests > 1, "intrabar pages load concurrently");
assert.ok(maximumActiveHistoryRequests <= 6, "intrabar concurrency remains bounded");

let throttledAttempts = 0;
const throttledAdapter = {
  ...historyAdapter,
  getHistoricalCandles: async (query) => {
    throttledAttempts += 1;
    if (throttledAttempts === 1) {
      throw new Error("Bybit request failed (10006): Too many visits!");
    }
    return historyAdapter.getHistoricalCandles(query);
  }
} as MarketDataAdapter;
const recoveredHistory = await new KioseffHistoryCoordinator().load({
  adapter: throttledAdapter,
  symbol: concurrentSymbol,
  chartCandles: concurrentChart.slice(0, 1),
  targetChartBars: 1,
  chartTimeframe: "1h",
  lowerTimeframe: "1m",
  transport: "fixture",
  now: base + 3600
});
assert.equal(throttledAttempts, 2, "Bybit 10006 throttling is retried instead of becoming unavailable");
assert.equal(recoveredHistory.quality.complete, true);

const cache = new KioseffHistoryCache(2);
const result = (sourceVersion: string) => ({
  generation: 1,
  sourceVersion,
  chartBars: [],
  provenance: {} as KioseffHistoryResult["provenance"],
  quality: aggregate
});
cache.set("a", result("one"));
cache.set("b", result("two"));
cache.set("c", result("three"));
assert.equal(cache.size, 2);
assert.equal(cache.get("a"), undefined, "cache evicts oldest");
cache.invalidateSource("two");
assert.equal(cache.get("b"), undefined, "source invalidation removes matching revision");

console.log("Kioseff deterministic intrabar data tests passed.");
