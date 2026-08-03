import assert from "node:assert/strict";
import { migrateAuctionProfileSettings } from "../src/modules/auction-profile/core/settings.ts";
import { stableHash } from "../src/modules/auction-profile/core/canonical.ts";
import { createAuctionProfileGrid } from "../src/modules/auction-profile/core/profileGrid.ts";
import { resolveAuctionScopeWindows } from "../src/modules/auction-profile/core/scope.ts";
import { PINE_CVD_PROFILE_KNOWN_ANOMALIES } from "../src/modules/auction-profile/engines/pineCompatibility.ts";
import { appendTradesToAuctionProfile, calculateAuctionProfile } from "../src/modules/auction-profile/engines/nativeEngine.ts";
import { InMemoryCanonicalCvdService } from "../src/modules/auction-profile/data/tradeSource.ts";
import { AuctionProfileWorkerRuntime } from "../src/modules/auction-profile/worker/auctionProfileWorker.ts";
import type { Candle } from "../src/chart-engine/types.ts";
import type { CanonicalTrade } from "../src/modules/auction-profile/core/types.ts";
import type { AuctionProfileWorkerResponse } from "../src/modules/auction-profile/worker/protocol.ts";

const bars: Candle[] = Array.from({ length: 12 }, (_, index) => ({
  time: 1_720_000_000 + index * 3600,
  open: 100 + index,
  high: 102 + index,
  low: 99 + index,
  close: 101 + index,
  volume: 1000 + index * 25
}));

const trades: CanonicalTrade[] = bars.map((bar, index) => ({
  venue: "bybit",
  symbol: "BTCUSDT",
  timestamp: bar.time + 10,
  tradeId: "t-" + index,
  price: bar.close,
  quantity: index % 3 === 0 ? 4 : 2,
  notional: bar.close * (index % 3 === 0 ? 4 : 2),
  aggressorSide: index % 3 === 0 ? "SELL" : "BUY",
  source: "EXCHANGE_AGGRESSOR_FLAG"
}));

const settings = migrateAuctionProfileSettings({
  schemaVersion: 1,
  implementationMode: "BLACK_CORE_NATIVE",
  scopeMode: "ROLLING",
  calculationEngine: "CVD_REAL_TRADES",
  cvdMetric: "NET_CVD",
  dataSource: "HYBRID",
  lookbackBars: bars.length,
  targetRows: 48,
  maximumRows: 96,
  nodeDetection: { method: "PERCENTILE", prominence: 0 }
});

const input = {
  venue: "bybit" as const,
  symbol: "BTCUSDT",
  timeframe: "1h" as const,
  metadata: {
    exchange: "bybit" as const,
    rawSymbol: "BTCUSDT",
    normalizedSymbol: "BTC/USDT",
    assetClass: "crypto" as const,
    tickSize: "0.5",
    timezone: "UTC",
    sessionPolicy: "24/7",
    source: "fixture"
  },
  bars,
  trades,
  settings,
  sourceRevision: "fixture-v1",
  now: 1_720_100_000_000
};

const snapshot = calculateAuctionProfile(input);
assert.ok(snapshot, "native profile must be produced");
assert.equal(snapshot.quality.quality, "EXACT");
assert.equal(snapshot.quality.exactTradeCoveragePercent, 100);
assert.equal(snapshot.diagnostics.viewportAffectsCalculation, false);
assert.equal(snapshot.range.loadedBars, bars.length);
assert.ok(snapshot.grid.rowCount <= settings.maximumRows);
assert.equal(
  Number(snapshot.rows.reduce((sum, row) => sum + row.totalQuantity, 0).toFixed(8)),
  trades.reduce((sum, trade) => sum + trade.quantity, 0)
);
assert.equal(
  Number(snapshot.rows.reduce((sum, row) => sum + row.buyQuantity - row.sellQuantity, 0).toFixed(8)),
  trades.reduce((sum, trade) => sum + (trade.aggressorSide === "BUY" ? trade.quantity : -trade.quantity), 0)
);
assert.ok(snapshot.keyLevels.poc !== null);
assert.ok(snapshot.keyLevels.vah !== null);
assert.ok(snapshot.keyLevels.val !== null);
assert.ok(snapshot.profileVersion.startsWith("auction-"));

const gridA = createAuctionProfileGrid(bars, settings, input.metadata);
const gridB = createAuctionProfileGrid(bars, settings, input.metadata);
assert.deepEqual(gridA, gridB, "native grid must be deterministic and camera-independent");
assert.equal(stableHash(gridA), stableHash(gridB));

const approximate = calculateAuctionProfile({ ...input, trades: [], sourceRevision: "bars-only" });
assert.ok(approximate);
assert.equal(approximate.quality.quality, "APPROXIMATE");
assert.equal(approximate.quality.exactTradeCoveragePercent, 0);
assert.equal(approximate.quality.chartBarCoveragePercent, 100);
assert.ok(approximate.diagnostics.warnings.some(warning => warning.includes("not represented as exact")));

const service = new InMemoryCanonicalCvdService(100);
assert.equal(service.ingest([...trades, trades[0]!]), trades.length);
assert.equal(service.getTrades({ venue: "bybit", symbol: "BTCUSDT", start: bars[0]!.time, end: bars.at(-1)!.time + 3600 }).length, trades.length);
assert.equal(service.coverage({ venue: "bybit", symbol: "BTCUSDT", start: bars[0]!.time, end: bars.at(-1)!.time + 3600 }).exactTradeCoveragePercent, 100);

const increment = {
  ...trades[0]!,
  tradeId: "increment",
  timestamp: bars.at(-1)!.time + 20,
  price: bars.at(-1)!.close,
  quantity: 3,
  notional: bars.at(-1)!.close * 3,
  aggressorSide: "BUY" as const
};
const oldVersion = snapshot.profileVersion;
appendTradesToAuctionProfile(snapshot, [increment], settings);
assert.notEqual(snapshot.profileVersion, oldVersion);
assert.ok(snapshot.diagnostics.incrementalUpdateDurationMs >= 0);

assert.ok(PINE_CVD_PROFILE_KNOWN_ANOMALIES.length >= 7);
const compatibility = calculateAuctionProfile({
  ...input,
  trades: [],
  settings: migrateAuctionProfileSettings({ ...settings, implementationMode: "PINE_COMPATIBILITY", calculationEngine: "CVD_PINE_COMPATIBLE", lookbackBars: 5000 })
});
assert.ok(compatibility);
assert.equal(compatibility.quality.quality, "APPROXIMATE");
assert.ok(compatibility.diagnostics.warnings.some(warning => warning.includes("1,500-bar")));
const scopeFixtureStart = Date.UTC(2024, 6, 1) / 1000;
const scopeBars: Candle[] = Array.from({ length: 48 }, (_, index) => ({
  time: scopeFixtureStart + index * 3600,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1
}));
const utcSession = resolveAuctionScopeWindows(scopeBars, migrateAuctionProfileSettings({
  ...settings,
  scopeMode: "SESSION",
  sessionTemplate: "UTC_DAY",
  sessionTimezone: "UTC"
}));
assert.equal(utcSession.length, 1);
assert.equal(utcSession[0]!.start, scopeFixtureStart + 86_400, "session timestamps must remain in Black Terminal seconds");
assert.equal(utcSession[0]!.startBarIndex, 24);

const londonSession = resolveAuctionScopeWindows(scopeBars, migrateAuctionProfileSettings({
  ...settings,
  scopeMode: "SESSION",
  sessionTemplate: "LONDON"
}));
assert.equal(londonSession[0]!.start, Date.UTC(2024, 6, 2, 7) / 1000, "London session must respect summer time");

const dailyPeriodic = resolveAuctionScopeWindows(scopeBars, migrateAuctionProfileSettings({
  ...settings,
  scopeMode: "PERIODIC_COMPOSITE",
  periodicity: "DAILY",
  lookbackBars: 48
}));
assert.equal(dailyPeriodic.length, 2);
assert.deepEqual(dailyPeriodic.map(window => window.startBarIndex), [0, 24]);

const sixHourPeriodic = resolveAuctionScopeWindows(scopeBars, migrateAuctionProfileSettings({
  ...settings,
  scopeMode: "PERIODIC_COMPOSITE",
  periodicity: "CUSTOM_HOURS",
  periodicHours: 6,
  lookbackBars: 48
}));
assert.equal(sixHourPeriodic.length, 8);

const responses: AuctionProfileWorkerResponse[] = [];
const runtime = new AuctionProfileWorkerRuntime({ postMessage: response => responses.push(response) });
runtime.handle({ type: "INITIALIZE", protocolVersion: 1, requestId: "init", generation: 1, input });
const result = responses.find(response => response.type === "RESULT" && response.requestId === "init");
assert.ok(result && result.type === "RESULT" && result.snapshots.length === 1);
runtime.handle({ type: "APPEND_TRADES", protocolVersion: 1, requestId: "append", generation: 1, trades: [increment], sourceRevision: "live-2" });
const incremental = responses.find(response => response.type === "RESULT" && response.requestId === "append");
assert.ok(incremental && incremental.type === "RESULT" && incremental.incremental);
const lockedResponses: AuctionProfileWorkerResponse[] = [];
const lockedRuntime = new AuctionProfileWorkerRuntime({ postMessage: response => lockedResponses.push(response) });
lockedRuntime.handle({
  type: "INITIALIZE",
  protocolVersion: 1,
  requestId: "locked-init",
  generation: 1,
  input: { ...input, settings: migrateAuctionProfileSettings({ ...settings, compositeLocked: true }) }
});
const lockedInitial = lockedResponses.find(response => response.type === "RESULT" && response.requestId === "locked-init");
assert.ok(lockedInitial && lockedInitial.type === "RESULT");
lockedRuntime.handle({ type: "APPEND_TRADES", protocolVersion: 1, requestId: "locked-append", generation: 1, trades: [increment], sourceRevision: "locked-live" });
const lockedAppend = lockedResponses.find(response => response.type === "RESULT" && response.requestId === "locked-append");
assert.ok(lockedAppend && lockedAppend.type === "RESULT");
assert.equal(lockedAppend.snapshots[0]?.profileVersion, lockedInitial.snapshots[0]?.profileVersion, "locked composites must not repaint");

console.log("Auction Profile certification passed", {
  profileVersion: snapshot.profileVersion,
  rows: snapshot.rows.length,
  nodes: snapshot.nodes.length,
  exactCoverage: snapshot.quality.exactTradeCoveragePercent,
  anomaliesRetained: PINE_CVD_PROFILE_KNOWN_ANOMALIES.length
});
