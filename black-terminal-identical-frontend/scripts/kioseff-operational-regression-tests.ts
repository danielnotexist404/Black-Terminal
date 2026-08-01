import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Candle } from "../src/chart-engine/types.ts";
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

const base = 1_704_067_200;
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
  assert.ok(render.pane.length > 0, "canonical worker output reaches the render model");
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
  "showClusterRatioMeter"
]) {
  assert.match(settingsPanelSource, new RegExp(`data-kioseff-field="${field.replaceAll(".", "\\.")}"`));
}
assert.match(settingsPanelSource, /settings\.model === "absorbtion-extremes"/);
assert.equal(KIOSEFF_DEFAULT_SETTINGS.absorbtion.showXRay, true);
assert.equal(KIOSEFF_DEFAULT_SETTINGS.absorbtion.intensityBySize, false);
assert.equal(KIOSEFF_DEFAULT_SETTINGS.absorbtion.stopClusterBuys, 2);
assert.equal(KIOSEFF_DEFAULT_SETTINGS.absorbtion.stopClusterSells, 2);
assert.equal(KIOSEFF_DEFAULT_SETTINGS.absorbtion.oldStopClusterSells, 2);
assert.equal(KIOSEFF_DEFAULT_SETTINGS.absorbtion.oldStopClusterBuys, 2);
assert.equal(KIOSEFF_DEFAULT_SETTINGS.absorbtion.lowerTimeframe, "1");
assert.equal(KIOSEFF_DEFAULT_SETTINGS.absorbtion.clusterColor, "#55ffda");
assert.equal(KIOSEFF_DEFAULT_SETTINGS.absorbtion.oldClusterColor, "#ff65fb");
assert.equal(KIOSEFF_DEFAULT_SETTINGS.volatilityAtEntry.granularity, "lower");
assert.equal(
  KIOSEFF_DEFAULT_SETTINGS.volatilityAtEntry.timeScaledVolatilityTimeframe,
  "1"
);
assert.equal(
  KIOSEFF_DEFAULT_SETTINGS.volatilityAtEntry.strongClusterColor,
  "#ff65fb"
);
assert.equal(
  KIOSEFF_DEFAULT_SETTINGS.volatilityAtEntry.weakClusterColor,
  "#6929F2"
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
assert.deepEqual(
  KIOSEFF_TIMEFRAME_INPUTS.map((option) => option.value),
  ["1", "3", "5", "15", "30", "60", "240"]
);

console.log("Kioseff operational regression tests passed.");
