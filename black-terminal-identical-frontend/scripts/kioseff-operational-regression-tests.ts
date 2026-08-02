import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Candle, VisibleIndicators } from "../src/chart-engine/types.ts";
import {
  ADMIN_ALLOWED_INDICATORS,
  canUseIndicator,
  DEFAULT_ALLOWED_INDICATORS,
  MARKET_MAKER_HEATMAP_KEY,
  restrictVisibleIndicators
} from "../src/features/premium.ts";
import {
  assertBybitCandleQuery,
  parseBybitKlineRows
} from "../src/market-data/adapters/bybitKline.ts";
import type {
  MarketDataAdapter,
  MarketSymbol,
  SymbolMetadata
} from "../src/market-data/types.ts";
import {
  KIOSEFF_ENGINE_VERSION,
  KIOSEFF_SCHEMA_VERSION
} from "../src/modules/kioseff-stop-loss-clustering/core/canonical.ts";
import {
  KIOSEFF_DEFAULT_SETTINGS,
  KIOSEFF_HISTORY_LOOKBACK_OPTIONS,
  KIOSEFF_TIMEFRAME_INPUTS,
  kioseffSettingsVersion,
  migrateKioseffSettings
} from "../src/modules/kioseff-stop-loss-clustering/core/settings.ts";
import { migrateKioseffWorkspaceFields } from "../src/modules/kioseff-stop-loss-clustering/core/workspaceMigration.ts";
import {
  aggregateKioseffQuality,
  groupKioseffIntrabars
} from "../src/modules/kioseff-stop-loss-clustering/data/grouping.ts";
import {
  constructKioseffRequestRange,
  isKioseffHistoryRateLimitError,
  KioseffHistoryCoordinator
} from "../src/modules/kioseff-stop-loss-clustering/data/historyCoordinator.ts";
import { normalizeKioseffCandles } from "../src/modules/kioseff-stop-loss-clustering/data/normalization.ts";
import { kioseffUnavailableDiagnostic } from "../src/modules/kioseff-stop-loss-clustering/data/unavailability.ts";
import {
  KioseffDataUnavailableError,
  type IntrabarQualityReport,
  type KioseffChartBarInput,
  type NormalizedCandle
} from "../src/modules/kioseff-stop-loss-clustering/data/types.ts";
import { buildKioseffRenderModel } from "../src/modules/kioseff-stop-loss-clustering/rendering/renderModel.ts";
import { kioseffLoadProgress } from "../src/modules/kioseff-stop-loss-clustering/data/loadProgress.ts";
import { KioseffWorkerRuntime } from "../src/modules/kioseff-stop-loss-clustering/workers/KioseffWorker.ts";

const fixturePath = fileURLToPath(
  new URL(
    "../tests/fixtures/kioseff-stop-loss-clustering/bybit-btcusdt-linear-1m.json",
    import.meta.url
  )
);
const captured = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  request: { category: string; symbol: string; interval: string };
  response: { result: { list: string[][] } };
};
assert.equal(captured.request.category, "linear");
assert.equal(captured.request.symbol, "BTCUSDT");
assert.equal(captured.request.interval, "1");
const capturedCandles = parseBybitKlineRows(captured.response.result.list);
assert.equal(capturedCandles.length, 3);
assert.deepEqual(
  capturedCandles.map((candle) => candle.time),
  [...capturedCandles.map((candle) => candle.time)].sort((a, b) => a - b),
  "captured Bybit minutes normalize to strict chronology"
);
assert.ok(
  capturedCandles.every((candle) => candle.time < 10_000_000_000),
  "Bybit millisecond timestamps normalize to integer seconds"
);

assert.throws(
  () => assertBybitCandleQuery({
    exchange: "binance",
    symbol: "BTCUSDT",
    marketKind: "perpetual",
    timeframe: "1m",
    limit: 3
  }),
  /adapter-symbol-category-mismatch/
);

assert.throws(
  () =>
    normalizeKioseffCandles(
      [{ ...capturedCandles[0]!, time: capturedCandles[0]!.time * 1000 }],
      { source: "milliseconds-fixture", sourceRevision: "1" }
    ),
  (error) =>
    error instanceof KioseffDataUnavailableError &&
    error.reason === "invalid-timestamp-units"
);

assert.throws(
  () => constructKioseffRequestRange([], "1h", "1m"),
  (error) =>
    error instanceof KioseffDataUnavailableError &&
    error.reason === "missing-request-range"
);
const noRangeDiagnostic = kioseffUnavailableDiagnostic({
  reason: "missing-request-range",
  venue: "bybit",
  symbol: "BTCUSDT",
  chartTimeframe: "1h",
  requestedLowerTimeframe: "1m"
});
assert.equal(noRangeDiagnostic.historyCoverage.expected, 0);
assert.equal(noRangeDiagnostic.historyCoverage.actual, 0);
assert.equal(noRangeDiagnostic.reason, "missing-request-range");
assert.equal(
  isKioseffHistoryRateLimitError(
    new Error("Bybit request failed (10006): Too many visits!")
  ),
  true
);
assert.equal(
  isKioseffHistoryRateLimitError(
    new Error("Market data request failed with 403: access too frequent")
  ),
  true
);

const base = 1_704_067_200;
const maximumLookbackChart = Array.from({ length: 22_000 }, (_, index) => ({
  time: base + index * 3600,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 60
}));
assert.equal(
  constructKioseffRequestRange(
    maximumLookbackChart,
    "1h",
    "1m",
    base + 22_000 * 3600
  ).expectedIntrabars,
  1_320_000,
  "22,000 one-hour bars request 1.32 million ordered one-minute intrabars"
);
const maximumFourHourLookbackChart = maximumLookbackChart.map((bar, index) => ({
  ...bar,
  time: base + index * 14_400
}));
assert.equal(
  constructKioseffRequestRange(
    maximumFourHourLookbackChart,
    "4h",
    "1m",
    base + 22_000 * 14_400
  ).expectedIntrabars,
  5_280_000,
  "22,000 four-hour bars retain the exact 5.28-million one-minute input target"
);
const normalizedBoundary = normalizeKioseffCandles(
  [
    { time: base + 3540, open: 1, high: 2, low: 1, close: 2, volume: 1 },
    { time: base + 3600, open: 2, high: 3, low: 2, close: 3, volume: 1 }
  ],
  { source: "boundary", sourceRevision: "1" }
).candles;
const boundaryChart = normalizeKioseffCandles(
  [
    { time: base, open: 1, high: 2, low: 1, close: 2, volume: 1 },
    { time: base + 3600, open: 2, high: 3, low: 2, close: 3, volume: 1 }
  ],
  { source: "boundary-chart", sourceRevision: "1" }
).candles;
const boundaryGroups = groupKioseffIntrabars(
  boundaryChart,
  normalizedBoundary,
  { chartTimeframe: "1h", lowerTimeframe: "1m", now: base + 7200 }
);
assert.deepEqual(boundaryGroups[0]!.intrabars.map((bar) => bar.time), [base + 3540]);
assert.deepEqual(boundaryGroups[1]!.intrabars.map((bar) => bar.time), [base + 3600]);

const largeQuality = (count: number): IntrabarQualityReport => ({
  complete: true,
  partial: false,
  expectedIntervalSeconds: 60,
  expectedCount: count,
  actualCount: count,
  coverageStart: null,
  coverageEnd: null,
  missingTimes: [],
  duplicateTimes: [],
  outOfOrderTimes: [],
  conflictingTimes: [],
  sourceMismatch: false,
  flags: [],
  notes: []
});
const largeInputs: KioseffChartBarInput[] = Array.from(
  { length: 5000 },
  (_, chartIndex) => {
    const chartTime = base + chartIndex * 3600;
    const intrabars: NormalizedCandle[] = Array.from(
      { length: 60 },
      (_, minuteIndex) => ({
        time: chartTime + minuteIndex * 60,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1,
        originalTime: chartTime + minuteIndex * 60,
        source: "large",
        sourceRevision: "1"
      })
    );
    return {
      chartBar: {
        time: chartTime,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 60,
        originalTime: chartTime,
        source: "large-chart",
        sourceRevision: "1"
      },
      intrabars,
      chartBarClosed: true,
      sourceVersion: "large",
      quality: largeQuality(60)
    };
  }
);
const largeAggregate = aggregateKioseffQuality(largeInputs);
assert.equal(largeAggregate.actualCount, 300_000);
assert.equal(largeAggregate.coverageStart, base);
assert.equal(largeAggregate.coverageEnd, base + 5000 * 3600 - 60);

const metadata: SymbolMetadata = {
  exchange: "bybit",
  rawSymbol: "BTCUSDT",
  normalizedSymbol: "BTCUSDT",
  assetClass: "crypto",
  marketKind: "perpetual",
  tickSize: "0.10",
  quantityStep: "0.001",
  timezone: "UTC",
  sessionPolicy: "24x7",
  source: "captured-bybit-fixture"
};
const symbol: MarketSymbol = {
  exchange: "bybit",
  rawSymbol: "BTCUSDT",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  marketKind: "perpetual",
  metadata
};
const chartCount = 70;
const finalMinuteCount = 15;
const now = base + (chartCount - 1) * 3600 + finalMinuteCount * 60;
const minuteCandles: Candle[] = Array.from(
  { length: (chartCount - 1) * 60 + finalMinuteCount },
  (_, index) => {
    const open = 100 + Math.sin(index / 11) * 2 + Math.sin(index / 3) * 0.35;
    const close = open + Math.sin(index / 5) * 0.22;
    return {
      time: base + index * 60,
      open,
      high: Math.max(open, close) + 0.32,
      low: Math.min(open, close) - 0.32,
      close,
      volume: 20 + (index % 37) * 3
    };
  }
);
const chartCandles: Candle[] = Array.from({ length: chartCount }, (_, index) => {
  const values = minuteCandles.filter(
    (candle) =>
      candle.time >= base + index * 3600 &&
      candle.time < base + (index + 1) * 3600
  );
  return {
    time: base + index * 3600,
    open: values[0]!.open,
    high: Math.max(...values.map((candle) => candle.high)),
    low: Math.min(...values.map((candle) => candle.low)),
    close: values.at(-1)!.close,
    volume: values.reduce((sum, candle) => sum + candle.volume, 0)
  };
});
const fixtureAdapter = {
  id: "bybit",
  label: "Bybit captured fixture",
  capabilities: {
    historicalCandles: true,
    liveCandles: false,
    trades: false,
    orderBook: false,
    fundingRates: false,
    openInterest: false,
    liquidations: false
  },
  normalizeSymbol: (value: string) => value,
  getSymbolMetadata: async () => metadata,
  getHistoricalCandles: async (query) =>
    minuteCandles.filter(
      (candle) =>
        candle.time >= (query.from ?? Number.NEGATIVE_INFINITY) &&
        candle.time <= (query.to ?? Number.POSITIVE_INFINITY)
    )
} as MarketDataAdapter;
const warmups: number[] = [];
const history = await new KioseffHistoryCoordinator().load({
  adapter: fixtureAdapter,
  symbol,
  chartCandles,
  chartTimeframe: "1h",
  lowerTimeframe: "1m",
  transport: "fixture",
  now,
  onWarmup: (result) => warmups.push(result.warmup.completedChartBars)
});
assert.ok(history.coverage.receivedIntrabars > 0);
assert.equal(history.coverage.chartBarsWithCompleteIntrabars, chartCount - 1);
assert.equal(history.coverage.chartBarsWithPartialIntrabars, 1);
assert.equal(history.coverage.chartBarsWithNoIntrabars, 0);
assert.equal(history.chartBars.at(-1)!.chartBarClosed, false);
assert.equal(history.chartBars.at(-1)!.intrabars.length, finalMinuteCount);
assert.equal(history.quality.complete, true);
assert.ok(warmups.length > 0);

const originalDateNow = Date.now;
Date.now = () => (now + 30) * 1000;
try {
  const rolloverAdapter = {
    ...fixtureAdapter,
    getHistoricalCandles: async (
      query: Parameters<MarketDataAdapter["getHistoricalCandles"]>[0]
    ) => {
      Date.now = () => (now + 90) * 1000;
      return fixtureAdapter.getHistoricalCandles(query);
    }
  } as MarketDataAdapter;
  const rolloverHistory = await new KioseffHistoryCoordinator().load({
    adapter: rolloverAdapter,
    symbol,
    chartCandles,
    chartTimeframe: "1h",
    lowerTimeframe: "1m",
    transport: "fixture"
  });
  assert.equal(
    rolloverHistory.chartBars.at(-1)!.intrabars.length,
    finalMinuteCount
  );
  assert.equal(
    rolloverHistory.quality.complete,
    true,
    "a minute rollover during pagination cannot change the immutable request range"
  );
} finally {
  Date.now = originalDateNow;
}

const settings = structuredClone(KIOSEFF_DEFAULT_SETTINGS);
settings.model = "volatility-at-entry";
settings.volatilityAtEntry.granularity = "lower";
const context = {
  metadata,
  timeframe: "1h" as const,
  sourceVersion: history.sourceVersion,
  settings,
  diagnostics: true
};
const envelope = {
  generation: history.generation,
  sourceVersion: history.sourceVersion,
  engineVersion: KIOSEFF_ENGINE_VERSION,
  settingsVersion: JSON.stringify(settings)
};
const runtime = new KioseffWorkerRuntime();
const reset = runtime.handle({
  type: "reset",
  requestId: "operational-reset",
  ...envelope,
  context
});
assert.equal(reset.type, "result");
const response = runtime.handle({
  type: "calculate-batch",
  requestId: "operational-calculate",
  ...envelope,
  inputs: history.chartBars
});
assert.equal(response.type, "result");
if (response.type === "result") {
  assert.ok(response.telemetry.workerIntrabarsReceived > 0);
  assert.equal(response.telemetry.workerChartBarsReceived, chartCount);
  assert.ok(response.snapshot.pane.length > 0);
  assert.equal(response.snapshot.schemaVersion, KIOSEFF_SCHEMA_VERSION);
  const render = buildKioseffRenderModel(response.snapshot, settings);
  assert.equal(render.pane.length, 0, "oscillator output is hidden by default");
  const oscillatorSettings = structuredClone(settings);
  oscillatorSettings.style.showOscillator = true;
  const oscillatorRender = buildKioseffRenderModel(response.snapshot, oscillatorSettings);
  assert.ok(oscillatorRender.pane.length > 0, "canonical worker output reaches the render model when enabled");
}

const legacyWorkspacePath = fileURLToPath(
  new URL(
    "../tests/fixtures/kioseff-stop-loss-clustering/legacy-workspace-v3.json",
    import.meta.url
  )
);
const legacyWorkspace = JSON.parse(readFileSync(legacyWorkspacePath, "utf8")) as {
  visibleIndicators: { volatilityHeatmap: boolean };
  indicatorPeriods: { volatilityHeatmap: number };
  indicatorVisualSettings: {
    volatilityHeatmap: { color: string; intensity: number };
  };
  kioseffSettings: unknown;
};
const migrated = migrateKioseffWorkspaceFields({
  visibility: legacyWorkspace.visibleIndicators.volatilityHeatmap,
  period: legacyWorkspace.indicatorPeriods.volatilityHeatmap,
  visual: legacyWorkspace.indicatorVisualSettings.volatilityHeatmap,
  settings: legacyWorkspace.kioseffSettings
});
assert.equal(migrated.visibility, true);
assert.equal(migrated.legacyPeriod, 34);
assert.equal(migrated.settings.absorbtion.stopClusterBuys, 2);
assert.equal(migrated.settings.absorbtion.clusterColor, "#ff334f");
assert.equal(migrateKioseffSettings(migrated.settings).version, 1);
const persistedRoundTrip = migrateKioseffSettings(
  JSON.parse(JSON.stringify(migrated.settings))
);
assert.deepEqual(persistedRoundTrip, migrated.settings);

const absorbtionSettings = structuredClone(migrated.settings);
absorbtionSettings.model = "absorbtion-extremes";
absorbtionSettings.absorbtion.stopClusterBuys = 3;
absorbtionSettings.volatilityAtEntry.granularity = "higher";
const absorbtionEnvelope = {
  generation: history.generation + 1,
  sourceVersion: history.sourceVersion,
  engineVersion: KIOSEFF_ENGINE_VERSION,
  settingsVersion: kioseffSettingsVersion(absorbtionSettings)
};
const absorbtionContext = {
  ...context,
  settings: absorbtionSettings
};
assert.equal(
  runtime.handle({
    type: "reset",
    requestId: "model-switch-reset",
    ...absorbtionEnvelope,
    context: absorbtionContext
  }).type,
  "result"
);
const absorbtionResponse = runtime.handle({
  type: "calculate-batch",
  requestId: "model-switch-calculate",
  ...absorbtionEnvelope,
  inputs: history.chartBars
});
assert.equal(absorbtionResponse.type, "result");
if (absorbtionResponse.type === "result") {
  assert.equal(absorbtionResponse.snapshot.model, "absorbtion-extremes");
  assert.equal(absorbtionResponse.settingsVersion, kioseffSettingsVersion(absorbtionSettings));
}
absorbtionSettings.model = "volatility-at-entry";
assert.equal(
  absorbtionSettings.volatilityAtEntry.granularity,
  "higher",
  "model switching preserves the inactive model's settings"
);
assert.equal(
  absorbtionSettings.absorbtion.stopClusterBuys,
  3,
  "model switching preserves Absorbtion settings"
);

const settingsPanelPath = fileURLToPath(
  new URL(
    "../src/modules/kioseff-stop-loss-clustering/components/KioseffSettingsPanel.tsx",
    import.meta.url
  )
);
const settingsPanelSource = readFileSync(settingsPanelPath, "utf8");
for (const field of [
  "model",
  "historyLookbackBars",
  "absorbtion.showXRay",
  "absorbtion.intensityBySize",
  "absorbtion.stopClusterBuys",
  "absorbtion.stopClusterSells",
  "absorbtion.oldStopClusterSells",
  "absorbtion.oldStopClusterBuys",
  "absorbtion.lowerTimeframe",
  "absorbtion.clusterColor",
  "absorbtion.oldClusterColor",
  "volatilityAtEntry.granularity",
  "volatilityAtEntry.timeScaledVolatilityTimeframe",
  "volatilityAtEntry.strongClusterColor",
  "volatilityAtEntry.weakClusterColor",
  "volatilityAtEntry.showHistoricalTriggers",
  "volatilityAtEntry.showActiveClusterSize",
  "forceTypicalMove",
  "showClusterRatioMeter",
  "style.showSummaryTable",
  "style.buyWallColor",
  "style.showOscillator",
  "style.oscillatorBuyColor",
  "style.oscillatorSellColor",
  "style.activityDashboardWidth"
]) {
  assert.match(settingsPanelSource, new RegExp(`data-kioseff-field="${field.replaceAll(".", "\\.")}"`));
}
const overlaysPath = fileURLToPath(
  new URL(
    "../src/modules/kioseff-stop-loss-clustering/components/KioseffOverlays.tsx",
    import.meta.url
  )
);
const overlaysSource = readFileSync(overlaysPath, "utf8");
assert.match(overlaysSource, /<summary>Parity Diagnostics<\/summary>/);
assert.match(overlaysSource, /settings\.style\.showSummaryTable/);
assert.match(overlaysSource, /settings\.showClusterRatioMeter/);
assert.match(overlaysSource, /kioseff-energy-loader/);
assert.match(overlaysSource, /loadState\.stage !== "degraded"/);
assert.match(overlaysSource, /Market Maker Activity Dashboard/);
assert.match(overlaysSource, /Nearest Buy Wall/);
assert.match(overlaysSource, /Nearest Sell Wall/);
assert.match(overlaysSource, /const parityPanel = import\.meta\.env\.DEV/);
assert.doesNotMatch(overlaysSource, /Stop[- ]Loss Clustering/i);
assert.doesNotMatch(settingsPanelSource, /Stop[- ]Loss Clustering/i);
assert.equal(Array.from<string>(DEFAULT_ALLOWED_INDICATORS).includes(MARKET_MAKER_HEATMAP_KEY), false);
assert.equal(ADMIN_ALLOWED_INDICATORS.includes(MARKET_MAKER_HEATMAP_KEY), true);
assert.equal(canUseIndicator(MARKET_MAKER_HEATMAP_KEY, { role: "user", allowedIndicators: [] }), false);
assert.equal(canUseIndicator(MARKET_MAKER_HEATMAP_KEY, { role: "admin", allowedIndicators: [] }), true);
assert.equal(
  canUseIndicator(MARKET_MAKER_HEATMAP_KEY, { role: "user", allowedIndicators: [MARKET_MAKER_HEATMAP_KEY] }),
  true
);
assert.equal(
  restrictVisibleIndicators(
    { volatilityHeatmap: true } as VisibleIndicators,
    { role: "user", allowedIndicators: [] }
  ).volatilityHeatmap,
  false,
  "revoked workspace state cannot reactivate Market Maker Heatmap"
);
const chartSource = readFileSync(
  fileURLToPath(new URL("../src/components/PixiBlackChart.tsx", import.meta.url)),
  "utf8"
);
assert.match(chartSource, /MAX_RETAINED_CHART_BARS = 22_000/);
assert.match(chartSource, /targetChartBars: availableChartBarTarget/);
assert.match(chartSource, /The setting is a maximum ceiling/);
assert.match(chartSource, /calculateBatchChunked/);
assert.match(chartSource, /certifiedKioseffInputTail/);
assert.match(chartSource, /Certified partial warmup retained/);
assert.match(chartSource, /canUseIndicator\(key, \{ allowedIndicators \}\)/);
const appSource = readFileSync(
  fileURLToPath(new URL("../src/App.tsx", import.meta.url)),
  "utf8"
);
assert.match(appSource, /restrictVisibleIndicators\(snapshot\.visibleIndicators, currentUser\)/);
assert.match(appSource, /allowedIndicators=\{effectiveAllowedIndicators\}/);
const adminSource = readFileSync(
  fileURLToPath(new URL("../src/components/AdminPanel.tsx", import.meta.url)),
  "utf8"
);
assert.match(adminSource, /ADMIN CONTROLLED/);
const indicatorLibrarySource = readFileSync(
  fileURLToPath(new URL("../src/components/IndicatorLibrary.tsx", import.meta.url)),
  "utf8"
);
assert.match(indicatorLibrarySource, /ADMIN GRANT/);
assert.match(indicatorLibrarySource, /!indicator\.adminControlled \|\| canUseIndicator/);
const upgradeSource = readFileSync(
  fileURLToPath(new URL("../src/components/UpgradePanel.tsx", import.meta.url)),
  "utf8"
);
assert.doesNotMatch(upgradeSource, /"volatilityHeatmap"/);
const accessMigrationSource = readFileSync(
  fileURLToPath(new URL("../supabase/migrations/202608010001_market_maker_heatmap_admin_gate.sql", import.meta.url)),
  "utf8"
);
assert.match(accessMigrationSource, /where role <> 'admin'/);
assert.match(accessMigrationSource, /array_remove\(active_indicators, 'volatilityHeatmap'\)/);
assert.match(accessMigrationSource, /where role = 'admin'/);
const themeSource = readFileSync(
  fileURLToPath(new URL("../src/styles/theme.css", import.meta.url)),
  "utf8"
);
assert.match(themeSource, /@keyframes kioseff-energy-sweep/);
assert.match(themeSource, /linear-gradient\(90deg, #4b000a 0%, #850012 32%, #b00018 64%, #ff1d1d 86%, #cfd3da 96%, #fff 100%\)/);
assert.match(themeSource, /\.kioseff-summary > \.buy-wall strong \{ color: #fff; \}/);
assert.match(themeSource, /\.kioseff-summary > \.sell-wall strong \{ color: #d0001f; \}/);
assert.doesNotMatch(themeSource, /#(?:55ffda|ff65fb|72ffe2|65ffe0|96ffe8|ffa5fc|c69cff|2ef0ce|6effe2|e46cff)/i);
const pixiRendererSource = readFileSync(
  fileURLToPath(new URL("../src/modules/kioseff-stop-loss-clustering/rendering/KioseffPixiRenderer.ts", import.meta.url)),
  "utf8"
);
assert.match(pixiRendererSource, /settings\.style\.buyWallColor/);
assert.match(pixiRendererSource, /settings\.volatilityAtEntry\.strongClusterColor/);
assert.doesNotMatch(pixiRendererSource, /0x(?:55ffda|ff65fb|ff22cc|6929f2)/i);
assert.match(pixiRendererSource, /const weakActiveWall = !violated && !zone\.fillZone/);
const chartEngineSource = readFileSync(
  fileURLToPath(new URL("../src/chart-engine/BlackChartEngine.ts", import.meta.url)),
  "utf8"
);
assert.match(chartEngineSource, /this\.kioseffSettings = migrateKioseffSettings\(settings\)/);

for (const relativePath of [
  "../src/features/premium.ts",
  "../src/components/IndicatorLibrary.tsx",
  "../src/components/UpgradePanel.tsx",
  "../src/components/AdminPanel.tsx"
]) {
  const productSurfaceSource = readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8"
  );
  assert.match(productSurfaceSource, /Market Maker Heatmap/);
  assert.doesNotMatch(productSurfaceSource, /Stop[- ]Loss Clustering/i);
}
assert.match(settingsPanelSource, /settings\.model === "absorbtion-extremes"/);
assert.equal(KIOSEFF_DEFAULT_SETTINGS.historyLookbackBars, 11000);
assert.deepEqual(
  KIOSEFF_HISTORY_LOOKBACK_OPTIONS.map((option) => option.value),
  [5000, 11000, 22000]
);
assert.equal(kioseffLoadProgress({ stage: "fetching-chart-history", loaded: 5500, target: 11000 }), 10);
assert.equal(kioseffLoadProgress({ stage: "fetching-intrabar-history", loaded: 660000, target: 1320000 }), 46);
assert.equal(kioseffLoadProgress({ stage: "ready" }), 100);
const progressiveWarmup = [
  kioseffLoadProgress({ stage: "fetching-intrabar-history", loaded: 6000, target: 1_320_000 }),
  kioseffLoadProgress({ stage: "grouping-intrabars", bars: 100, intrabars: 6000, targetBars: 22_000 }),
  kioseffLoadProgress({ stage: "validating", bars: 100, intrabars: 6000, targetBars: 22_000 }),
  kioseffLoadProgress({ stage: "starting-worker", bars: 100, targetBars: 22_000 }),
  kioseffLoadProgress({ stage: "calculating", bars: 100, intrabars: 6000, targetBars: 22_000 }),
  kioseffLoadProgress({ stage: "rendering", clusters: 1, completedBars: 100, targetBars: 22_000 }),
  kioseffLoadProgress({ stage: "warming", completedBars: 100, targetBars: 22_000 }),
  kioseffLoadProgress({ stage: "fetching-intrabar-history", loaded: 12000, target: 1_320_000 })
];
assert.deepEqual(
  progressiveWarmup,
  [...progressiveWarmup].sort((left, right) => left - right),
  "progressive warmup energy remains monotonic across worker previews"
);
assert.equal(KIOSEFF_DEFAULT_SETTINGS.absorbtion.showXRay, true);
assert.equal(KIOSEFF_DEFAULT_SETTINGS.absorbtion.intensityBySize, false);
assert.equal(KIOSEFF_DEFAULT_SETTINGS.absorbtion.stopClusterBuys, 2);
assert.equal(KIOSEFF_DEFAULT_SETTINGS.absorbtion.stopClusterSells, 2);
assert.equal(KIOSEFF_DEFAULT_SETTINGS.absorbtion.oldStopClusterSells, 2);
assert.equal(KIOSEFF_DEFAULT_SETTINGS.absorbtion.oldStopClusterBuys, 2);
assert.equal(KIOSEFF_DEFAULT_SETTINGS.absorbtion.lowerTimeframe, "1");
assert.equal(KIOSEFF_DEFAULT_SETTINGS.absorbtion.clusterColor, "#f4f6f7");
assert.equal(KIOSEFF_DEFAULT_SETTINGS.absorbtion.oldClusterColor, "#b00018");
assert.equal(KIOSEFF_DEFAULT_SETTINGS.volatilityAtEntry.granularity, "lower");
assert.equal(
  KIOSEFF_DEFAULT_SETTINGS.volatilityAtEntry.timeScaledVolatilityTimeframe,
  "1"
);
assert.equal(
  KIOSEFF_DEFAULT_SETTINGS.volatilityAtEntry.strongClusterColor,
  "#b00018"
);
assert.equal(
  KIOSEFF_DEFAULT_SETTINGS.volatilityAtEntry.weakClusterColor,
  "#7d838a"
);
assert.equal(
  KIOSEFF_DEFAULT_SETTINGS.volatilityAtEntry.showHistoricalTriggers,
  false
);
assert.equal(
  KIOSEFF_DEFAULT_SETTINGS.volatilityAtEntry.showActiveClusterSize,
  false
);
assert.equal(KIOSEFF_DEFAULT_SETTINGS.forceTypicalMove, false);
assert.equal(KIOSEFF_DEFAULT_SETTINGS.showClusterRatioMeter, true);
assert.equal(KIOSEFF_DEFAULT_SETTINGS.style.showSummaryTable, true);
assert.equal(KIOSEFF_DEFAULT_SETTINGS.style.buyWallColor, "#f4f6f7");
assert.equal(KIOSEFF_DEFAULT_SETTINGS.style.showOscillator, false);
assert.equal(KIOSEFF_DEFAULT_SETTINGS.style.oscillatorBuyColor, "#cfd3da");
assert.equal(KIOSEFF_DEFAULT_SETTINGS.style.oscillatorSellColor, "#b00018");
assert.equal(KIOSEFF_DEFAULT_SETTINGS.style.activityDashboardWidth, 560);
const migratedLegacyPalette = migrateKioseffSettings({
  version: 1,
  absorbtion: { clusterColor: "#55ffda", oldClusterColor: "#ff65fb" },
  volatilityAtEntry: { strongClusterColor: "#ff65fb", weakClusterColor: "#6929F2" },
  style: {
    buyWallColor: "#55ffda",
    oscillatorBuyColor: "#55ffda",
    oscillatorSellColor: "#ff65fb"
  }
});
assert.equal(migratedLegacyPalette.absorbtion.clusterColor, "#f4f6f7");
assert.equal(migratedLegacyPalette.absorbtion.oldClusterColor, "#b00018");
assert.equal(migratedLegacyPalette.volatilityAtEntry.strongClusterColor, "#b00018");
assert.equal(migratedLegacyPalette.volatilityAtEntry.weakClusterColor, "#7d838a");
assert.equal(migratedLegacyPalette.style.buyWallColor, "#f4f6f7");
assert.equal(migratedLegacyPalette.style.oscillatorBuyColor, "#cfd3da");
assert.equal(migratedLegacyPalette.style.oscillatorSellColor, "#b00018");
assert.deepEqual(
  KIOSEFF_TIMEFRAME_INPUTS.map((option) => option.value),
  ["1", "3", "5", "15", "30", "60", "240"]
);

console.log("Kioseff operational regression tests passed.");
