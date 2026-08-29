import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AUCTION_PROFILE_DEFAULT_SETTINGS, auctionProfileCalculationSettingsHash, migrateAuctionProfileSettings } from "../src/modules/auction-profile/core/settings.ts";
import { stableHash } from "../src/modules/auction-profile/core/canonical.ts";
import { configureAuctionProfileEngine } from "../src/modules/auction-profile/core/engineContract.ts";
import { RADAP_DISPLAY_NAME, RADAP_FULL_NAME, RADAP_SHORT_NAME } from "../src/modules/auction-profile/core/identity.ts";
import { retainCertifiedRadapSnapshots } from "../src/modules/auction-profile/core/stability.ts";
import { resolveAuctionProfileReplayWindow } from "../src/modules/auction-profile/core/replay.ts";
import { detectAuctionNodes } from "../src/modules/auction-profile/core/nodes.ts";
import { createAuctionProfileGrid } from "../src/modules/auction-profile/core/profileGrid.ts";
import { auctionScopeUsesSessionControls, resolveAuctionScopeWindows } from "../src/modules/auction-profile/core/scope.ts";
import { auctionHistogramWidth, auctionProfileHorizontalBounds, auctionProfileStartX } from "../src/modules/auction-profile/rendering/histogram.ts";
import { auctionCellRenderStrides, downsampleAuctionCells } from "../src/modules/auction-profile/rendering/cells.ts";
import { auctionCellTextVisible, formatAuctionCellMetric } from "../src/modules/auction-profile/rendering/labels.ts";
import { CVD_FOOTPRINT_RENDERER_KIND, auctionCellColor } from "../src/modules/auction-profile/rendering/footprint/CvdFootprintRenderer.ts";
import { auctionLvnFillOpacity, auctionProfileDrawSignature } from "../src/modules/auction-profile/rendering/AuctionProfileRenderer.ts";
import { AUCTION_PROFILE_RENDERER_KIND, auctionProfileBarSpans, auctionProfileEffectiveWidthPercent, buildAuctionProfileRows, compressAuctionProfileSegments, resolveAuctionProfilePlacement, resolveAuctionProfileRangeBounds } from "../src/modules/auction-profile/core/profileGeometry.ts";
import { resolveAuctionVisualizationLayers } from "../src/modules/auction-profile/rendering/visualization.ts";
import { validateAuctionProfileInvariants } from "../src/modules/auction-profile/testing/nativeValidation.ts";
import { PINE_CVD_PROFILE_KNOWN_ANOMALIES } from "../src/modules/auction-profile/engines/pineCompatibility.ts";
import { appendTradesToAuctionProfile, calculateAuctionProfile, calculateAuctionProfiles } from "../src/modules/auction-profile/engines/nativeEngine.ts";
import { auctionTpoLetters, compactAuctionTpoLetters } from "../src/modules/auction-profile/engines/tpo.ts";
import { InMemoryCanonicalCvdService } from "../src/modules/auction-profile/data/tradeSource.ts";
import { auctionProfileNeedsLowerHistory, resolveAuctionLowerSourceTimeframe, resolveAuctionTpoSourceTimeframe } from "../src/modules/auction-profile/core/lowerTimeframe.ts";
import { AuctionProfileWorkerRuntime } from "../src/modules/auction-profile/worker/auctionProfileWorker.ts";
import { AuctionProfileWorkerClient } from "../src/modules/auction-profile/worker/AuctionProfileWorkerClient.ts";
import { auctionProfileSettingsForDevice, RADAP_TABLET_RENDER_BUDGET } from "../src/modules/auction-profile/rendering/deviceBudget.ts";
import { isIpadClassDevice, resolveChartDeviceCapabilities } from "../src/chart-engine/deviceCapabilities.ts";
import { canUseIndicator } from "../src/features/premium.ts";
import type { Candle } from "../src/chart-engine/types.ts";
import type { AuctionProfileRow, CanonicalTrade } from "../src/modules/auction-profile/core/types.ts";
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

const visualManifest = JSON.parse(readFileSync(new URL("../tests/golden/auction-profile/manifest.json", import.meta.url), "utf8")) as {
  captureStatus: string;
  fixtures: Array<{ id: string; visualizationType: string; expected: string[] }>;
};
assert.equal(visualManifest.captureStatus, "pending-browser-runtime");
assert.deepEqual(visualManifest.fixtures.map(fixture => fixture.id), ["session-cvd-profile", "macro-cvd-composite", "pine-segmented-profile", "cvd-footprint"]);
assert.ok(visualManifest.fixtures.every(fixture => fixture.expected.length >= 5));
assert.equal(visualManifest.fixtures.filter(fixture => fixture.visualizationType === "CVD_FOOTPRINT").length, 1);
assert.deepEqual(resolveAuctionVisualizationLayers(true, false, "AUCTION_PROFILE"), { dataRequired: true, profile: true, footprint: false });
assert.deepEqual(resolveAuctionVisualizationLayers(false, true, "AUCTION_PROFILE"), { dataRequired: true, profile: false, footprint: true });
assert.deepEqual(resolveAuctionVisualizationLayers(true, false, "CVD_FOOTPRINT"), { dataRequired: true, profile: false, footprint: true });
assert.deepEqual(resolveAuctionVisualizationLayers(true, false, "COMBINED"), { dataRequired: true, profile: true, footprint: true });

const snapshot = calculateAuctionProfile(input);
assert.ok(snapshot, "native profile must be produced");
assert.equal(RADAP_SHORT_NAME, "RADAP");
assert.equal(RADAP_FULL_NAME, "Range Anchored Directional Auction Profile");
assert.equal(RADAP_DISPLAY_NAME, "RADAP · Range Anchored Directional Auction Profile");
assert.equal(canUseIndicator("auctionProfile", { role: "user", allowedIndicators: [] }), true, "RADAP must remain available on a fresh signed-in device");
assert.equal(canUseIndicator("volatilityHeatmap", { role: "user", allowedIndicators: [] }), false, "admin-controlled indicators must remain restricted");
assert.equal(isIpadClassDevice({ userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)", platform: "iPad", maxTouchPoints: 5 }), true);
assert.equal(isIpadClassDevice({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5 }), true, "desktop-class iPad user agents must be detected");
assert.equal(resolveChartDeviceCapabilities({ userAgent: "iPad", platform: "iPad", maxTouchPoints: 5, devicePixelRatio: 2 }).rendererResolution, 1.5);
assert.equal(resolveChartDeviceCapabilities({ userAgent: "Desktop", platform: "Linux x86_64", maxTouchPoints: 0, devicePixelRatio: 2 }).rendererResolution, 2);
const tabletSettings = auctionProfileSettingsForDevice(settings, true);
assert.equal(tabletSettings.rendering.maximumVisibleColumns, RADAP_TABLET_RENDER_BUDGET.maximumVisibleColumns);
assert.equal(tabletSettings.rendering.maximumVisibleRows, RADAP_TABLET_RENDER_BUDGET.maximumVisibleRows);
assert.equal(tabletSettings.rendering.maximumVisibleLabels, RADAP_TABLET_RENDER_BUDGET.maximumVisibleLabels);
assert.equal(tabletSettings.rendering.cellTextMode, "AUTO");
assert.equal(auctionProfileSettingsForDevice(settings, false), settings, "desktop RADAP rendering must remain unchanged");
assert.deepEqual(retainCertifiedRadapSnapshots([snapshot], []), [snapshot], "an empty rebuild must retain the last certified RADAP snapshot");
assert.deepEqual(retainCertifiedRadapSnapshots([], [snapshot]), [snapshot], "a certified rebuild must replace an empty display");
const replayWindow = resolveAuctionProfileReplayWindow(bars, 5, { enabled: true, selecting: false, cursor: 7 }, 3600);
assert.deepEqual(replayWindow.bars.map(bar => bar.time), bars.slice(3, 8).map(bar => bar.time), "Replay RADAP must observe only the causal prefix ending at its cursor");
assert.equal(replayWindow.sourceEndIndex, 7);
assert.equal(replayWindow.cutoffEnd, bars[7]!.time + 3600 - 1);
assert.equal(replayWindow.replayBounded, true);
const replaySelectionWindow = resolveAuctionProfileReplayWindow(bars, 5, { enabled: true, selecting: true, cursor: 2 }, 3600);
assert.deepEqual(replaySelectionWindow.bars.map(bar => bar.time), bars.slice(-5).map(bar => bar.time), "Replay start selection may inspect the retained source before a cursor owns the calculation");
assert.equal(replaySelectionWindow.replayBounded, false);
assert.deepEqual(
  retainCertifiedRadapSnapshots([snapshot], [], replayWindow.cutoffEnd!),
  [],
  "a full-history RADAP snapshot must never survive behind an earlier replay cutoff"
);
const replayProfileEarly = calculateAuctionProfile({
  ...input,
  bars: replayWindow.bars,
  trades: trades.filter(trade => trade.timestamp <= replayWindow.cutoffEnd!),
  sourceRevision: "replay:7",
  now: replayWindow.cutoffEnd! * 1_000
});
const replayWindowLater = resolveAuctionProfileReplayWindow(bars, 5, { enabled: true, selecting: false, cursor: 9 }, 3600);
const replayProfileLater = calculateAuctionProfile({
  ...input,
  bars: replayWindowLater.bars,
  trades: trades.filter(trade => trade.timestamp <= replayWindowLater.cutoffEnd!),
  sourceRevision: "replay:9",
  now: replayWindowLater.cutoffEnd! * 1_000
});
assert.ok(replayProfileEarly && replayProfileLater);
assert.notEqual(replayProfileEarly.profileVersion, replayProfileLater.profileVersion, "RADAP must mutate as Replay advances to a new causal prefix");
assert.ok(replayProfileEarly.range.end < replayProfileLater.range.end, "RADAP range must advance with the Replay cursor");
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
assert.equal(settings.rendering.visualizationType, "AUCTION_PROFILE", "range × price RADAP must be the default visualization");
assert.equal(settings.rendering.profileBodyStyle, "HDLX_CVD_BLOCKS");
assert.equal(settings.rendering.profileBlockValueMode, "CUMULATIVE_CVD");
assert.equal(settings.rendering.profileGeometry, "SINGLE_SIDED_RIGHT");
assert.equal(settings.rendering.profilePlacement, "RANGE_START");
assert.equal(settings.rendering.profileWidthMetric, "CVD_ACTIVITY");
assert.equal(settings.rendering.profileLayoutRevision, 4);
assert.equal(settings.rendering.widthPercent, 30);
assert.equal(settings.rendering.profileSide, "LEFT");
assert.equal(settings.rendering.profileLengthPercent, 75);
assert.equal(settings.rendering.valueAreaFillColor, "#24272d");
assert.equal(settings.rendering.valueAreaFillOpacity, 0.1);
assert.equal(settings.rendering.pocColor, "#ff1738");
const presentationOnlySettings = migrateAuctionProfileSettings({
  ...settings,
  rendering: { ...settings.rendering, profileSide: "RIGHT", profileLengthPercent: 125, brightness: 175 }
});
assert.equal(
  auctionProfileCalculationSettingsHash(presentationOnlySettings),
  auctionProfileCalculationSettingsHash(settings),
  "presentation controls must redraw RADAP without restarting its calculation worker"
);
assert.notEqual(
  auctionProfileCalculationSettingsHash(migrateAuctionProfileSettings({ ...settings, targetRows: settings.targetRows + 1 })),
  auctionProfileCalculationSettingsHash(settings),
  "calculation controls must still schedule a certified RADAP rebuild"
);
assert.equal(settings.rendering.timeSegmentsMode, "STACKED", "the profile silhouette must be built from chronological CVD cells");
assert.equal(settings.nodeDetection.showLvns, true, "restrained LVN context is enabled by default");
assert.equal(settings.nodeDetection.showHvns, true, "restrained HVN context is enabled by default");
assert.equal(settings.nodeDetection.lvnGapAware, true);
assert.equal(settings.nodeDetection.lvnMaximumActivityRatio, 0.35);
assert.equal(settings.nodeDetection.lvnRequireTwoSidedAcceptance, true);
assert.equal(settings.rendering.maximumVisibleLvns, 6);
assert.equal(settings.rendering.maximumVisibleHvns, 2);
assert.equal(settings.rendering.maximumVisibleStructuralZones, 8);
assert.equal(settings.nodeDetection.prominence, 0.36);
assert.equal(settings.nodeDetection.sensitivityPercentile, 10);
assert.equal(settings.rendering.showNodeLabels, false);
assert.equal(settings.rendering.showMidpoint, false);
assert.equal(settings.rendering.showStructuralSr, false);
assert.equal(settings.rendering.showHistoricalExtensions, false);
assert.equal(settings.rendering.structuralDetail, "STANDARD");
assert.equal(settings.rendering.zoneExtensionMode, "PROFILE_ONLY");
assert.equal(settings.rendering.lvnFillOpacity, 0.22);
assert.equal(settings.rendering.lvnStrongFillOpacity, 0.72);
assert.equal(settings.rendering.lvnFullColorProminence, 0.7);
assert.equal(auctionLvnFillOpacity(0.8, settings.rendering), 0.72, "high-prominence LVNs must receive configured full-color intensity");
assert.ok(auctionLvnFillOpacity(0.2, settings.rendering) > settings.rendering.lvnFillOpacity, "developing LVNs must interpolate above base fill intensity");

const gapActivity = [100, 120, 110, 4, 2, 3, 100, 130, 110];
const gapRows: AuctionProfileRow[] = gapActivity.map((totalQuantity, index) => ({
  index,
  low: 100 + index,
  high: 101 + index,
  center: 100.5 + index,
  value: totalQuantity,
  buyQuantity: totalQuantity * 0.55,
  sellQuantity: totalQuantity * 0.45,
  unknownQuantity: 0,
  totalQuantity,
  buyNotional: totalQuantity * 100,
  sellNotional: totalQuantity * 100,
  unknownNotional: 0,
  tradeCount: totalQuantity,
  averageTradeSize: 1,
  maximumTradeSize: 1,
  tpoCount: totalQuantity,
  tpoBrackets: [],
  realizedVariance: 0,
  parkinsonVariance: 0,
  garmanKlassVariance: 0,
  rangeExpansion: 0,
  cvdEfficiency: 0.1,
  cvdPersistence: 0,
  hybridScore: totalQuantity,
  inValueArea: false
}));
const gapSettings = migrateAuctionProfileSettings({
  ...settings,
  nodeDetection: {
    ...settings.nodeDetection,
    source: "VOLUME",
    method: "HYBRID",
    sensitivityPercentile: 30,
    neighborhood: 2,
    prominence: 0.5,
    minimumWidthRows: 2,
    maximumGapRows: 0,
    lvnGapAware: true,
    lvnMaximumActivityRatio: 0.1,
    lvnRequireTwoSidedAcceptance: true
  }
});
const wideGap = detectAuctionNodes(gapRows, gapSettings, input.now, "wide-gap-v1").find(node => node.type === "LVN");
assert.ok(wideGap, "a wide low-activity auction gap must be detected as one LVN zone");
assert.deepEqual(wideGap.componentRowIndices, [3, 4, 5]);
assert.equal(wideGap.widthRows, 3);
assert.ok(wideGap.prominence > 0.95, "wide-gap prominence must compare the valley with acceptance outside it");
const isolatedMinima = detectAuctionNodes(gapRows, migrateAuctionProfileSettings({
  ...gapSettings,
  nodeDetection: { ...gapSettings.nodeDetection, lvnGapAware: false }
}), input.now, "isolated-minima-v1").filter(node => node.type === "LVN");
assert.equal(isolatedMinima.length, 0, "isolated-minimum mode must not misrepresent a multi-row valley when its minimum width is unmet");
assert.equal(snapshot.engineVersion, "bc-meap-2.1.0");
assert.ok(snapshot.matrix.blocks.length > 0);
assert.ok(snapshot.matrix.cells.length > 0);
assert.deepEqual(validateAuctionProfileInvariants(snapshot), []);
assert.equal(
  snapshot.matrix.cells.reduce((sum, cell) => sum + cell.totalValue, 0),
  trades.reduce((sum, trade) => sum + trade.quantity, 0),
  "the sparse matrix must conserve exact trade quantity"
);
const stableTransform = {
  width: 1000,
  height: 700,
  top: 40,
  bottom: 650,
  xForTime: (time: number) => time / 1000,
  xForLookbackBars: (count: number) => 1000 - count,
  yForPrice: (price: number) => 650 - price
};
const stableDrawSignature = auctionProfileDrawSignature([snapshot], settings, stableTransform);
assert.equal(
  auctionProfileDrawSignature([snapshot], settings, stableTransform),
  stableDrawSignature,
  "ordinary market redraws must reuse the existing GPU profile"
);
assert.notEqual(
  auctionProfileDrawSignature([{ ...snapshot, profileVersion: snapshot.profileVersion + ":live" }], settings, stableTransform),
  stableDrawSignature,
  "a genuine CVD snapshot revision must invalidate the profile cache"
);
assert.notEqual(
  auctionProfileDrawSignature([snapshot], settings, { ...stableTransform, yForPrice: (price: number) => 640 - price }),
  stableDrawSignature,
  "a price-camera change must invalidate the profile cache"
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
const tpoSettings = migrateAuctionProfileSettings(configureAuctionProfileEngine(exactSettings, "TPO"));
assert.equal(tpoSettings.valueAreaBasis, "TPO");
assert.equal(tpoSettings.pocBasis, "MAXIMUM_TPO");
assert.equal(tpoSettings.nodeDetection.source, "TPO");
assert.equal(tpoSettings.rendering.profileWidthMetric, "SELECTED_ENGINE");
assert.equal(tpoSettings.rendering.displayStyle, "LETTERS_TPO");
assert.equal(tpoSettings.rendering.profileBodyStyle, "SOLID_HISTOGRAM");
assert.equal(
  auctionProfileEffectiveWidthPercent(tpoSettings.rendering.widthPercent, tpoSettings.rendering.profileLengthPercent),
  22.5,
  "TPO must respect the shared profile-length control instead of occupying the full configured width"
);
assert.equal(resolveAuctionTpoSourceTimeframe(30), "30m");
assert.equal(resolveAuctionTpoSourceTimeframe(45), "15m", "non-native TPO brackets must use the finest exact divisor available");
assert.equal(resolveAuctionLowerSourceTimeframe(tpoSettings), "30m");
assert.equal(auctionProfileNeedsLowerHistory("4h", tpoSettings), true, "higher-timeframe TPO must request bracket-scale history");
assert.equal(auctionProfileNeedsLowerHistory("15m", tpoSettings), false, "a chart already finer than the TPO bracket needs no duplicate history request");
const tpoSnapshot = calculateAuctionProfile({
  venue: "bybit",
  symbol: "BTCUSDT",
  timeframe: "1m",
  bars: exactBars,
  trades: exactTrades,
  settings: tpoSettings,
  sourceRevision: "matrix-tpo-fixture-v1"
});
assert.ok(tpoSnapshot);
assert.equal(
  tpoSnapshot.matrix.cells.find(cell => cell.blockIndex === 0 && cell.priceLow <= 63000 && cell.priceHigh > 63000)?.rawValue,
  1,
  "multiple prints in one row and TPO bracket must remain one TPO observation"
);
const tpoRow63000 = tpoSnapshot.rows.find(row => row.low <= 63000 && row.high > 63000);
assert.equal(tpoRow63000?.tpoCount, 1, "aggregate TPO must deduplicate repeated exact trades in one price/bracket");
assert.equal(tpoRow63000?.tpoBrackets.length, 1, "TPO must retain the real bracket identity required for letter rendering");
assert.deepEqual(
  auctionTpoLetters(tpoRow63000?.tpoBrackets ?? [], tpoSnapshot.range.start, tpoSettings.tpoBracketMinutes * 60),
  ["A"],
  "the first chronological TPO bracket must render as the authentic A print"
);
const denseTpoLetters = Array.from({ length: 5000 }, (_, index) => `A${index + 1}`);
const compactTpo = compactAuctionTpoLetters(denseTpoLetters, 28);
assert.ok(compactTpo.text.length <= 28, "large composite TPO text must remain inside its row width");
assert.ok(compactTpo.hiddenCount > 0, "compaction must disclose omitted historical prints");
assert.equal(compactTpo.visibleLetters.at(-1), "A5000", "the newest chronological TPO print must remain visible");
assert.equal(compactAuctionTpoLetters(["A", "B", "C"], 8).text, "ABC", "small TPO profiles must remain unchanged");
const tpoProfileRows = buildAuctionProfileRows(tpoSnapshot, tpoSettings);
assert.equal(tpoProfileRows.find(row => row.priceLow <= 63000 && row.priceHigh > 63000)?.rawWidthValue, 1, "TPO profile width must be time-at-price, not CVD activity");

const volumeSettings = migrateAuctionProfileSettings(configureAuctionProfileEngine(exactSettings, "VOLUME"));
assert.equal(volumeSettings.valueAreaBasis, "TOTAL_VOLUME");
assert.equal(volumeSettings.pocBasis, "MAXIMUM_TOTAL_VOLUME");
assert.equal(volumeSettings.nodeDetection.source, "SELECTED_ENGINE");
assert.equal(volumeSettings.rendering.profileWidthMetric, "SELECTED_ENGINE");
const volumeSnapshot = calculateAuctionProfile({
  venue: "bybit",
  symbol: "BTCUSDT",
  timeframe: "1m",
  bars: exactBars,
  trades: exactTrades,
  settings: volumeSettings,
  sourceRevision: "matrix-volume-fixture-v1"
});
assert.ok(volumeSnapshot);
assert.equal(volumeSnapshot.rows.find(row => row.low <= 63000 && row.high > 63000)?.value, 3, "volume profile must use exact executed quantity at price");
assert.equal(volumeSnapshot.rows.find(row => row.low <= 63050 && row.high > 63050)?.value, 4);
assert.equal(volumeSnapshot.rows.find(row => row.low <= 63100 && row.high > 63100)?.value, 6);
assert.notEqual(volumeSnapshot.keyLevels.poc, tpoSnapshot.keyLevels.poc, "volume POC and time-at-price POC must derive independently when their distributions differ");

const volatilitySettings = migrateAuctionProfileSettings(configureAuctionProfileEngine(exactSettings, "PARKINSON_VOLATILITY"));
const volatilitySnapshot = calculateAuctionProfile({
  venue: "bybit",
  symbol: "BTCUSDT",
  timeframe: "1m",
  bars: exactBars,
  trades: exactTrades,
  settings: volatilitySettings,
  sourceRevision: "matrix-volatility-fixture-v1"
});
assert.ok(volatilitySnapshot);
assert.ok(volatilitySnapshot.rows.some(row => row.value > 0), "volatility-at-price must be populated from OHLC range estimators even when exact trades cover the bars");
assert.equal(volatilitySnapshot.quality.exactTradeCoveragePercent, 0, "bar-derived volatility must never claim exact trade-at-price coverage");
assert.equal(volatilitySnapshot.quality.chartBarCoveragePercent, 100);
const frozenValue = exactCell(0, 63000)!.rawValue;
const developingBefore = exactCell(1, 63100)!.rawValue;
appendTradesToAuctionProfile(exactSnapshot, [{
  venue: "bybit", symbol: "BTCUSDT", timestamp: exactBars[1]!.time + 5, tradeId: "matrix-increment",
  price: 63100, quantity: 2, notional: 126200, aggressorSide: "SELL", source: "EXCHANGE_AGGRESSOR_FLAG"
}], exactSettings);
assert.equal(exactCell(0, 63000)?.rawValue, frozenValue, "incremental updates must not mutate finalized historical cells");
assert.equal(exactCell(1, 63100)?.rawValue, developingBefore - 2, "incremental trades must update only their active cell");
assert.deepEqual(validateAuctionProfileInvariants(exactSnapshot), []);

assert.equal(AUCTION_PROFILE_RENDERER_KIND, "RANGE_PRICE_PROFILE");
assert.equal(CVD_FOOTPRINT_RENDERER_KIND, "TIME_PRICE_FOOTPRINT");
assert.notEqual(AUCTION_PROFILE_RENDERER_KIND, CVD_FOOTPRINT_RENDERER_KIND, "profile and footprint must remain separate renderer contracts");
const profileRows = buildAuctionProfileRows(exactSnapshot, exactSettings);
assert.equal(profileRows.length, exactSnapshot.rows.length, "profile renderer projects one CVD matrix chain per price row");
const aggregate63000 = profileRows.find(row => row.priceLow <= 63000 && row.priceHigh > 63000);
const aggregate63050 = profileRows.find(row => row.priceLow <= 63050 && row.priceHigh > 63050);
const aggregate63100 = profileRows.find(row => row.priceLow <= 63100 && row.priceHigh > 63100);
assert.equal(aggregate63000?.netCvd, 3);
assert.equal(aggregate63050?.netCvd, -4);
assert.equal(aggregate63100?.netCvd, 4, "profile row must dynamically include the developing-cell update");
assert.ok(profileRows.some(row => row.timeSegments.length > 0), "the HDLX profile body must retain chronological matrix cells");
assert.equal(aggregate63100?.timeSegments.at(-1)?.deltaValue, 4, "the developing cell must expose its real signed block delta");
assert.equal(aggregate63100?.timeSegments.at(-1)?.cumulativeValue, 4, "the displayed developing CVD must track the row history");
const segmentedRows = buildAuctionProfileRows(exactSnapshot, migrateAuctionProfileSettings({
  ...exactSettings,
  rendering: { ...exactSettings.rendering, timeSegmentsMode: "STACKED" }
}));
assert.ok(segmentedRows.some(row => row.timeSegments.length > 0), "optional segmented profile mode must retain time contribution detail inside price rows");
const syntheticSegments = [
  { startTime: 1, endTime: 2, value: 3, deltaValue: 3, cumulativeValue: 3, normalizedWidth: 0.2, finalized: true, sourceCount: 1 },
  { startTime: 2, endTime: 3, value: 1, deltaValue: -2, cumulativeValue: 1, normalizedWidth: 0.3, finalized: true, sourceCount: 1 },
  { startTime: 3, endTime: 4, value: 5, deltaValue: 4, cumulativeValue: 5, normalizedWidth: 0.5, finalized: false, sourceCount: 1 }
];
const compressed = compressAuctionProfileSegments(syntheticSegments, 2, "CUMULATIVE_CVD");
assert.equal(compressed.length, 2);
assert.equal(compressed.reduce((sum, block) => sum + block.deltaValue, 0), 5, "render compression must conserve signed CVD delta");
assert.equal(compressed.at(-1)?.cumulativeValue, 5, "render compression must retain the final developing CVD");
assert.equal(compressed.at(-1)?.sourceCount, 2, "compressed blocks must disclose their real source-cell count");
const rightBounds = resolveAuctionProfilePlacement("RIGHT", 1000, 100, 900, 32);
assert.deepEqual(rightBounds, { left: 680, right: 1000, center: 840, width: 320 });
const rangeStartBounds = resolveAuctionProfilePlacement("RANGE_START", 1000, 100, 900, 48);
assert.deepEqual(rangeStartBounds, { left: 100, right: 580, center: 340, width: 480 });
const rangeEndBounds = resolveAuctionProfilePlacement("RANGE_END", 1000, 100, 900, 30);
assert.deepEqual(rangeEndBounds, { left: 600, right: 900, center: 750, width: 300 });
assert.deepEqual(resolveAuctionProfileRangeBounds(1000, 100, 900), { left: 100, right: 900, width: 800 });
assert.equal(auctionProfileEffectiveWidthPercent(30, 75), 22.5, "default matrix length must contract the profile body only");
assert.equal(auctionProfileEffectiveWidthPercent(30, 160), 48, "stretch control must expand the matrix body independently");
const negativeSpan = auctionProfileBarSpans(aggregate63050!, "BIDIRECTIONAL_DELTA", rightBounds)[0]!;
const positiveSpan = auctionProfileBarSpans(aggregate63000!, "BIDIRECTIONAL_DELTA", rightBounds)[0]!;
assert.equal(negativeSpan.right, rightBounds.center, "negative delta must grow left from the profile centerline");
assert.ok(negativeSpan.left < rightBounds.center);
assert.equal(positiveSpan.left, rightBounds.center, "positive delta must grow right from the profile centerline");
assert.ok(positiveSpan.right > rightBounds.center);
const splitSpans = auctionProfileBarSpans(aggregate63100!, "POSITIVE_NEGATIVE_SPLIT", rightBounds);
assert.equal(splitSpans.length, 2, "split geometry must expose sell and buy sides independently");

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

const fixedSettings = migrateAuctionProfileSettings({
  ...settings,
  scopeMode: "FIXED_START",
  fixedStartTime: scopeBars[12]!.time,
  lookbackBars: 48,
  dataSource: "CHART_BARS"
});
const fixedWindow = resolveAuctionScopeWindows(scopeBars, fixedSettings);
assert.equal(fixedWindow.length, 1);
assert.equal(fixedWindow[0]!.startBarIndex, 12);
assert.equal(fixedWindow[0]!.endBarIndex, 47, "Fixed Start must remain anchored and develop through the latest bar");
const fixedSnapshot = calculateAuctionProfile({ ...input, bars: scopeBars, trades: [], settings: fixedSettings, visibleRange: { start: scopeBars[30]!.time, end: scopeBars[35]!.time } });
assert.ok(fixedSnapshot);
assert.equal(fixedSnapshot.range.loadedBars, 36);
assert.equal(fixedSnapshot.diagnostics.viewportAffectsCalculation, false);

const rollingSettings = migrateAuctionProfileSettings({ ...settings, scopeMode: "ROLLING", lookbackBars: 24, dataSource: "CHART_BARS" });
const rollingWindow = resolveAuctionScopeWindows(scopeBars, rollingSettings);
assert.equal(rollingWindow[0]!.startBarIndex, 24);
assert.equal(rollingWindow[0]!.endBarIndex, 47);

const macroSettings = migrateAuctionProfileSettings({ ...settings, scopeMode: "MACRO_COMPOSITE", lookbackBars: 48, dataSource: "CHART_BARS" });
const macroA = calculateAuctionProfile({ ...input, bars: scopeBars, trades: [], settings: macroSettings, visibleRange: { start: scopeBars[0]!.time, end: scopeBars[10]!.time } });
const macroB = calculateAuctionProfile({ ...input, bars: scopeBars, trades: [], settings: macroSettings, visibleRange: { start: scopeBars[30]!.time, end: scopeBars[47]!.time } });
assert.ok(macroA && macroB);
assert.equal(macroA.profileVersion, macroB.profileVersion, "Macro profile hash must be camera-independent");
assert.deepEqual(macroA.rows, macroB.rows, "zoom and pan ranges must not alter Macro aggregate rows");
assert.equal(macroA.diagnostics.viewportAffectsCalculation, false);
assert.equal(macroA.keyLevels.ibHigh, null, "Macro Composite must not calculate a synthetic Initial Balance");
assert.equal(macroA.keyLevels.ibLow, null, "Macro Composite must not calculate a synthetic Initial Balance");
assert.equal(auctionScopeUsesSessionControls("SESSION"), true);
assert.equal(auctionScopeUsesSessionControls("COMPOSITE"), false);
assert.equal(auctionScopeUsesSessionControls("MACRO_COMPOSITE"), false);

const composite = calculateAuctionProfiles({
  ...input,
  bars: scopeBars,
  trades: [],
  settings: migrateAuctionProfileSettings({ ...settings, scopeMode: "COMPOSITE", lookbackBars: 48, dataSource: "CHART_BARS" })
});
assert.equal(composite.length, 1, "Composite mode must emit one combined range profile");
assert.equal(composite[0]!.range.loadedBars, 48);
assert.equal(composite[0]!.keyLevels.ibHigh, null, "Composite must not expose session-only Initial Balance levels");
assert.equal(composite[0]!.keyLevels.ibLow, null, "Composite must not expose session-only Initial Balance levels");

const sessionProfiles = calculateAuctionProfiles({
  ...input,
  bars: scopeBars,
  trades: [],
  settings: migrateAuctionProfileSettings({ ...settings, scopeMode: "SESSION", lookbackBars: 48, dataSource: "CHART_BARS" })
});
assert.ok(sessionProfiles.length > 0);
assert.notEqual(sessionProfiles.at(-1)!.keyLevels.ibHigh, null, "Session mode must retain its Initial Balance calculation");
assert.notEqual(sessionProfiles.at(-1)!.keyLevels.ibLow, null, "Session mode must retain its Initial Balance calculation");

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

const inlineFallbackClient = new AuctionProfileWorkerClient(() => {
  throw new Error("module workers unavailable");
});
assert.equal(inlineFallbackClient.executionMode, "INLINE");
const inlineSnapshots = await inlineFallbackClient.initialize(input);
assert.equal(inlineSnapshots.length, 1, "RADAP must calculate through the inline fallback when iPad WebKit rejects its module worker");
inlineFallbackClient.dispose();

const failingWorker = {
  onmessage: null,
  onerror: null,
  postMessage() {
    this.onerror?.({ message: "worker script blocked" } as ErrorEvent);
  },
  terminate() {}
} satisfies import("../src/modules/auction-profile/worker/AuctionProfileWorkerClient.ts").AuctionProfileWorkerLike;
const asynchronousFallbackClient = new AuctionProfileWorkerClient(() => failingWorker);
const asynchronousFallbackSnapshots = await asynchronousFallbackClient.initialize(input);
assert.equal(asynchronousFallbackClient.executionMode, "INLINE");
assert.equal(asynchronousFallbackSnapshots.length, 1, "a browser worker load error must replay the pending RADAP calculation inline");
asynchronousFallbackClient.dispose();

console.log("RADAP certification passed", {
  profileVersion: snapshot.profileVersion,
  rows: snapshot.rows.length,
  nodes: snapshot.nodes.length,
  exactCoverage: snapshot.quality.exactTradeCoveragePercent,
  anomaliesRetained: PINE_CVD_PROFILE_KNOWN_ANOMALIES.length
});
