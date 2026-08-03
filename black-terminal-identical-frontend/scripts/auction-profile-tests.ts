import assert from "node:assert/strict";
import { AUCTION_PROFILE_DEFAULT_SETTINGS, migrateAuctionProfileSettings } from "../src/modules/auction-profile/core/settings.ts";
import { stableHash } from "../src/modules/auction-profile/core/canonical.ts";
import { createAuctionProfileGrid } from "../src/modules/auction-profile/core/profileGrid.ts";
import { resolveAuctionScopeWindows } from "../src/modules/auction-profile/core/scope.ts";
import { auctionHistogramWidth, auctionProfileHorizontalBounds, auctionProfileStartX } from "../src/modules/auction-profile/rendering/histogram.ts";
import { auctionCellRenderStrides, downsampleAuctionCells } from "../src/modules/auction-profile/rendering/cells.ts";
import { auctionCellTextVisible, formatAuctionCellMetric } from "../src/modules/auction-profile/rendering/labels.ts";
import { auctionCellColor } from "../src/modules/auction-profile/rendering/AuctionProfileRenderer.ts";
import { validateAuctionProfileInvariants } from "../src/modules/auction-profile/testing/nativeValidation.ts";
import { PINE_CVD_PROFILE_KNOWN_ANOMALIES } from "../src/modules/auction-profile/engines/pineCompatibility.ts";
import { appendTradesToAuctionProfile, calculateAuctionProfile, calculateAuctionProfiles } from "../src/modules/auction-profile/engines/nativeEngine.ts";
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
assert.equal(settings.rendering.presentationMode, "DYNAMIC_KEY_LEVELS", "dynamic blocks plus restrained key levels must be the default presentation");
assert.equal(settings.nodeDetection.showLvns, false, "dense node overlays must remain opt-in");
assert.equal(settings.nodeDetection.showHvns, false, "dense node overlays must remain opt-in");
assert.equal(settings.rendering.showNodeLabels, false);
assert.equal(settings.rendering.showMidpoint, false);
assert.equal(settings.rendering.showStructuralSr, false);
assert.equal(settings.rendering.showHistoricalExtensions, false);
assert.equal(settings.rendering.structuralDetail, "MINIMAL");
assert.equal(settings.rendering.zoneExtensionMode, "PROFILE_ONLY");
assert.equal(snapshot.engineVersion, "bc-meap-2.0.0");
assert.ok(snapshot.matrix.blocks.length > 0);
assert.ok(snapshot.matrix.cells.length > 0);
assert.deepEqual(validateAuctionProfileInvariants(snapshot), []);
assert.equal(
  snapshot.matrix.cells.reduce((sum, cell) => sum + cell.totalValue, 0),
  trades.reduce((sum, trade) => sum + trade.quantity, 0),
  "the sparse matrix must conserve exact trade quantity"
);

const fullyVisibleProfile = auctionProfileHorizontalBounds(
  { start: 100, end: 500 },
  1000,
  time => time * 2
);
assert.deepEqual(fullyVisibleProfile, { left: 200, right: 1000, width: 800, visible: true });
const clippedLookbackProfile = auctionProfileHorizontalBounds(
  { start: 100, end: 500 },
  600,
  time => time * 2 - 500
);
assert.deepEqual(clippedLookbackProfile, { left: 0, right: 500, width: 500, visible: true });
const offscreenProfile = auctionProfileHorizontalBounds(
  { start: 100, end: 500 },
  600,
  time => time * 2 + 700
);
assert.equal(offscreenProfile.visible, false);
assert.equal(
  auctionProfileStartX("ROLLING", { start: 100, loadedBars: 5000 }, time => time * 2, bars => 1000 - bars / 10),
  500,
  "rolling profiles must use the loaded bar count as their visual anchor"
);
assert.equal(
  auctionProfileStartX("MANUAL_RANGE", { start: 100, loadedBars: 5000 }, time => time * 2, bars => 1000 - bars / 10),
  200,
  "manual profiles must retain their explicit timestamp anchor"
);
const strongestRow = { value: 100 } as Parameters<typeof auctionHistogramWidth>[0];
const weakerRow = { value: 25 } as Parameters<typeof auctionHistogramWidth>[0];
assert.equal(auctionHistogramWidth(strongestRow, 100, fullyVisibleProfile.width, 5), fullyVisibleProfile.width);
assert.ok(
  auctionHistogramWidth(weakerRow, 100, fullyVisibleProfile.width, 25)
    < auctionHistogramWidth(weakerRow, 100, fullyVisibleProfile.width, 100),
  "width control must taper weaker rows without moving the calculation anchor"
);

const gridA = createAuctionProfileGrid(bars, settings, input.metadata);
const gridB = createAuctionProfileGrid(bars, settings, input.metadata);
assert.deepEqual(gridA, gridB, "native grid must be deterministic and camera-independent");
assert.equal(stableHash(gridA), stableHash(gridB));

const exactBars: Candle[] = [
  { time: 1_800_000_000, open: 63000, high: 63100, low: 62950, close: 63050, volume: 20 },
  { time: 1_800_000_060, open: 63050, high: 63150, low: 63000, close: 63100, volume: 30 }
];
const exactTrades: CanonicalTrade[] = [
  { venue: "bybit", symbol: "BTCUSDT", timestamp: exactBars[0]!.time + 1, tradeId: "matrix-buy-a", price: 63000, quantity: 2, notional: 126000, aggressorSide: "BUY", source: "EXCHANGE_AGGRESSOR_FLAG" },
  { venue: "bybit", symbol: "BTCUSDT", timestamp: exactBars[0]!.time + 2, tradeId: "matrix-buy-b", price: 63000, quantity: 1, notional: 63000, aggressorSide: "BUY", source: "EXCHANGE_AGGRESSOR_FLAG" },
  { venue: "bybit", symbol: "BTCUSDT", timestamp: exactBars[0]!.time + 3, tradeId: "matrix-sell", price: 63050, quantity: 4, notional: 252200, aggressorSide: "SELL", source: "EXCHANGE_AGGRESSOR_FLAG" },
  { venue: "bybit", symbol: "BTCUSDT", timestamp: exactBars[1]!.time + 1, tradeId: "matrix-buy-current", price: 63100, quantity: 6, notional: 378600, aggressorSide: "BUY", source: "EXCHANGE_AGGRESSOR_FLAG" }
];
const exactSettings = migrateAuctionProfileSettings({
  ...AUCTION_PROFILE_DEFAULT_SETTINGS,
  scopeMode: "ROLLING",
  lookbackBars: exactBars.length,
  calculationEngine: "CVD_REAL_TRADES",
  cvdMetric: "NET_CVD",
  dataSource: "LIVE_TRADE_STREAM",
  rowSizingMode: "PRICE",
  rowSizePrice: 50,
  targetRows: 16,
  maximumRows: 64,
  blockResolution: "1m",
  maximumTimeBlocks: 64
});
const exactSnapshot = calculateAuctionProfile({
  venue: "bybit",
  symbol: "BTCUSDT",
  timeframe: "1m",
  metadata: {
    exchange: "bybit",
    rawSymbol: "BTCUSDT",
    normalizedSymbol: "BTC/USDT",
    assetClass: "crypto",
    tickSize: "0.5",
    timezone: "UTC",
    sessionPolicy: "24/7",
    source: "matrix-fixture"
  },
  bars: exactBars,
  trades: exactTrades,
  settings: exactSettings,
  sourceRevision: "matrix-fixture-v1"
});
assert.ok(exactSnapshot);
assert.equal(exactSnapshot.matrix.blocks.length, 2);
const exactCell = (blockIndex: number, price: number) => exactSnapshot.matrix.cells.find(cell =>
  cell.blockIndex === blockIndex && cell.priceLow <= price && cell.priceHigh > price
);
assert.equal(exactCell(0, 63000)?.rawValue, 3, "aggressive buys at one price must occupy one positive cell");
assert.equal(exactCell(0, 63050)?.rawValue, -4, "aggressive sells must remain negative in their exact price row");
assert.equal(exactCell(1, 63100)?.rawValue, 6, "the live block must preserve its own time column");
assert.equal(exactCell(0, 63000)?.isFinalized, true);
assert.equal(exactCell(1, 63100)?.isDeveloping, true);
const tpoSnapshot = calculateAuctionProfile({
  venue: "bybit",
  symbol: "BTCUSDT",
  timeframe: "1m",
  bars: exactBars,
  trades: exactTrades,
  settings: migrateAuctionProfileSettings({ ...exactSettings, calculationEngine: "TPO" }),
  sourceRevision: "matrix-tpo-fixture-v1"
});
assert.ok(tpoSnapshot);
assert.equal(
  tpoSnapshot.matrix.cells.find(cell => cell.blockIndex === 0 && cell.priceLow <= 63000 && cell.priceHigh > 63000)?.rawValue,
  1,
  "multiple prints in one row and TPO bracket must remain one TPO observation"
);
const frozenValue = exactCell(0, 63000)!.rawValue;
const developingBefore = exactCell(1, 63100)!.rawValue;
appendTradesToAuctionProfile(exactSnapshot, [{
  venue: "bybit", symbol: "BTCUSDT", timestamp: exactBars[1]!.time + 5, tradeId: "matrix-increment",
  price: 63100, quantity: 2, notional: 126200, aggressorSide: "SELL", source: "EXCHANGE_AGGRESSOR_FLAG"
}], exactSettings);
assert.equal(exactCell(0, 63000)?.rawValue, frozenValue, "incremental updates must not mutate finalized historical cells");
assert.equal(exactCell(1, 63100)?.rawValue, developingBefore - 2, "incremental trades must update only their active cell");
assert.deepEqual(validateAuctionProfileInvariants(exactSnapshot), []);

const projected = downsampleAuctionCells(exactSnapshot.matrix.cells, 2, 2);
assert.equal(
  projected.reduce((sum, cell) => sum + cell.rawValue, 0),
  exactSnapshot.matrix.cells.reduce((sum, cell) => sum + cell.rawValue, 0),
  "render-only downsampling must conserve signed matrix value"
);
assert.deepEqual(auctionCellRenderStrides(1000, 600, 500, 300), { columnStride: 2, rowStride: 2 });
assert.equal(auctionCellTextVisible("AUTO", 30, 12, 0.5), true);
assert.equal(auctionCellTextVisible("HOVER_ONLY", 30, 12, 1), false);
assert.equal(formatAuctionCellMetric(-1250, "CVD_REAL_TRADES"), "-1.3K");
assert.equal(formatAuctionCellMetric(0.34, "IMBALANCE_RATIO"), "+34%");
assert.equal(formatAuctionCellMetric(0.34, "CVD_REAL_TRADES", "CVD_IMBALANCE_RATIO"), "+34%");
assert.equal(formatAuctionCellMetric(84_000, "USD_VOLUME"), "$84.0K");
assert.equal(formatAuctionCellMetric(7, "TPO"), "7");
assert.equal(formatAuctionCellMetric(0.0042, "REALIZED_VOLATILITY"), "0.42%");
assert.equal(auctionCellColor(0, 0, exactSettings.rendering), 0x333333, "neutral cells must use the configured balanced color");
assert.equal(auctionCellColor(1, 1, exactSettings.rendering), 0xe2e3e5, "maximum positive cells must render silver-white");
assert.equal(auctionCellColor(-1, 1, exactSettings.rendering), 0xec182a, "maximum negative cells must render blood red");
assert.notEqual(auctionCellColor(1, 0.2, exactSettings.rendering), auctionCellColor(1, 0.9, exactSettings.rendering), "positive intensity must be continuous");
assert.notEqual(auctionCellColor(-1, 0.2, exactSettings.rendering), auctionCellColor(-1, 0.9, exactSettings.rendering), "negative intensity must be continuous");

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
  lookbackBars: 48,
  sessionTemplate: "UTC_DAY",
  sessionTimezone: "UTC"
}));
assert.equal(utcSession.length, 2, "completed session matrices must be retained inside the selected lookback");
assert.deepEqual(utcSession.map(window => window.startBarIndex), [0, 24]);
assert.equal(utcSession[1]!.start, scopeFixtureStart + 86_400, "session timestamps must remain in Black Terminal seconds");

const historicalSessions = calculateAuctionProfiles({
  ...input,
  bars: scopeBars,
  trades: [],
  settings: migrateAuctionProfileSettings({
    ...settings,
    scopeMode: "SESSION",
    lookbackBars: 48,
    dataSource: "CHART_BARS"
  })
});
assert.equal(historicalSessions.length, 2);
assert.ok(historicalSessions[0]!.matrix.blocks.every(block => block.isFinalized && !block.isDeveloping));
assert.ok(historicalSessions[1]!.matrix.blocks.at(-1)!.isDeveloping);

const londonSession = resolveAuctionScopeWindows(scopeBars, migrateAuctionProfileSettings({
  ...settings,
  scopeMode: "SESSION",
  lookbackBars: 48,
  sessionTemplate: "LONDON"
}));
assert.equal(londonSession.at(-1)!.start, Date.UTC(2024, 6, 2, 7) / 1000, "London session must respect summer time");
assert.ok(londonSession.length >= 2, "session history must not collapse into the latest profile");

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

const independentModes = [
  ["MACRO_COMPOSITE", "DYNAMIC_BLOCKS"],
  ["SESSION", "AGGREGATE_HISTOGRAM"],
  ["COMPOSITE", "DYNAMIC_AGGREGATE"],
  ["VISIBLE_RANGE", "DYNAMIC_KEY_LEVELS"]
] as const;
for (const [scopeMode, presentationMode] of independentModes) {
  const independent = migrateAuctionProfileSettings({ ...settings, scopeMode, rendering: { ...settings.rendering, presentationMode } });
  assert.equal(independent.scopeMode, scopeMode);
  assert.equal(independent.rendering.presentationMode, presentationMode, `${scopeMode} must not force a presentation mode`);
}

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
