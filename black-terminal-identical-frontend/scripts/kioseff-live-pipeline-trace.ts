import type { Candle } from "../src/chart-engine/types.ts";
import { bybitMarketDataAdapter } from "../src/market-data/adapters/bybit.ts";
import type { MarketSymbol, Timeframe } from "../src/market-data/types.ts";
import { KIOSEFF_ENGINE_VERSION } from "../src/modules/kioseff-stop-loss-clustering/core/canonical.ts";
import { KIOSEFF_DEFAULT_SETTINGS } from "../src/modules/kioseff-stop-loss-clustering/core/settings.ts";
import { KioseffHistoryCoordinator } from "../src/modules/kioseff-stop-loss-clustering/data/historyCoordinator.ts";
import { buildKioseffRenderModel } from "../src/modules/kioseff-stop-loss-clustering/rendering/renderModel.ts";
import { KioseffWorkerRuntime } from "../src/modules/kioseff-stop-loss-clustering/workers/KioseffWorker.ts";

const chartTimeframe: Timeframe = "1h";
const lowerTimeframe: Timeframe = "1m";
const targetChartBars = 5000;
const timeframeSeconds = 3600;
const pageLimit = 1000;

function stage(name: string, value: Record<string, unknown>) {
  console.log(JSON.stringify({ stage: name, ...value }));
}

async function loadChartHistory(symbol: MarketSymbol) {
  const collected: Candle[] = [];
  const seen = new Set<number>();
  let before: number | undefined;
  for (let page = 0; page < 8 && collected.length < targetChartBars; page += 1) {
    const remaining = targetChartBars - collected.length;
    const candles = await bybitMarketDataAdapter.getHistoricalCandles({
      exchange: "bybit",
      symbol: symbol.rawSymbol,
      timeframe: chartTimeframe,
      marketKind: "perpetual",
      limit: Math.min(pageLimit, remaining),
      to: before === undefined ? undefined : before - timeframeSeconds
    });
    const eligible = before === undefined
      ? candles
      : candles.filter((candle) => candle.time < before!);
    for (const candle of eligible) {
      if (!seen.has(candle.time)) {
        seen.add(candle.time);
        collected.push(candle);
      }
    }
    stage("fetching-chart-history", {
      page: page + 1,
      inputCount: candles.length,
      outputCount: collected.length,
      firstTimestamp: candles[0]?.time ?? null,
      lastTimestamp: candles.at(-1)?.time ?? null,
      source: "bybit",
      rejectionReason: null
    });
    if (!eligible.length) break;
    before = Math.min(...eligible.map((candle) => candle.time));
  }
  return [...collected]
    .sort((left, right) => left.time - right.time)
    .slice(-targetChartBars);
}

const started = Date.now();
try {
  stage("selected-symbol", {
    entered: true,
    rawSymbol: "BTCUSDT",
    normalizedSymbol: bybitMarketDataAdapter.normalizeSymbol("BTCUSDT", "perpetual"),
    category: "linear",
    chartTimeframe,
    lowerTimeframe,
    generation: 1,
    sourceVersion: null,
    rejectionReason: null
  });
  stage("symbol-normalization", {
    entered: true,
    inputCount: 1,
    outputCount: 1,
    rawSymbol: "BTCUSDT",
    normalizedSymbol: bybitMarketDataAdapter.normalizeSymbol(
      "BTCUSDT",
      "perpetual"
    ),
    source: "bybit",
    generation: 1,
    sourceVersion: null,
    rejectionReason: null
  });
  stage("bybit-category-selection", {
    entered: true,
    inputCount: 1,
    outputCount: 1,
    marketKind: "perpetual",
    category: "linear",
    source: "bybit",
    generation: 1,
    sourceVersion: null,
    rejectionReason: null
  });
  const symbols = await bybitMarketDataAdapter.getSymbols("perpetual");
  const selected = symbols.find((symbol) => symbol.rawSymbol === "BTCUSDT");
  if (!selected?.metadata) throw new Error("BTCUSDT linear metadata unavailable");
  stage("symbol-metadata", {
    entered: true,
    inputCount: symbols.length,
    outputCount: 1,
    tickSize: selected.metadata.tickSize,
    source: selected.metadata.source,
    rejectionReason: null
  });
  const chartCandles = await loadChartHistory(selected);
  stage("chart-history-ready", {
    inputCount: chartCandles.length,
    outputCount: chartCandles.length,
    firstTimestamp: chartCandles[0]?.time ?? null,
    lastTimestamp: chartCandles.at(-1)?.time ?? null,
    source: "bybit",
    rejectionReason: null
  });
  stage("one-minute-history-request", {
    entered: true,
    inputCount: chartCandles.length,
    outputCount: 0,
    firstTimestamp: chartCandles[0]?.time ?? null,
    lastTimestamp: chartCandles.at(-1)?.time ?? null,
    interval: "1",
    limitPerPage: 1000,
    source: "bybit",
    generation: 1,
    sourceVersion: null,
    rejectionReason: null
  });
  const history = await new KioseffHistoryCoordinator().load({
    adapter: bybitMarketDataAdapter,
    symbol: selected,
    chartCandles,
    chartTimeframe,
    lowerTimeframe,
    transport: "browser"
  });
  const intrabarCount = history.chartBars.reduce((sum, bar) => sum + bar.intrabars.length, 0);
  stage("raw-candle-response", {
    entered: true,
    inputCount: intrabarCount,
    outputCount: intrabarCount,
    firstTimestamp: history.coverage.firstReceivedTime,
    lastTimestamp: history.coverage.lastReceivedTime,
    source: history.provenance.historicalSource,
    generation: history.generation,
    sourceVersion: history.sourceVersion,
    rejectionReason: null
  });
  stage("timestamp-normalization", {
    entered: true,
    inputCount: intrabarCount,
    outputCount: intrabarCount,
    firstTimestamp: history.coverage.firstReceivedTime,
    lastTimestamp: history.coverage.lastReceivedTime,
    timestampUnit: "seconds",
    source: history.provenance.historicalSource,
    generation: history.generation,
    sourceVersion: history.sourceVersion,
    rejectionReason: null
  });
  stage("deduplication", {
    entered: true,
    inputCount: intrabarCount + history.coverage.duplicateIntervals,
    outputCount: intrabarCount,
    duplicateIntervals: history.coverage.duplicateIntervals,
    outOfOrderIntervals: history.coverage.outOfOrderIntervals,
    firstTimestamp: history.coverage.firstReceivedTime,
    lastTimestamp: history.coverage.lastReceivedTime,
    source: history.provenance.historicalSource,
    generation: history.generation,
    sourceVersion: history.sourceVersion,
    rejectionReason: null
  });
  stage("grouped-intrabars", {
    inputCount: intrabarCount,
    outputCount: history.chartBars.length,
    firstTimestamp: history.quality.coverageStart,
    lastTimestamp: history.quality.coverageEnd,
    complete: history.quality.complete,
    expected: history.quality.expectedCount,
    actual: history.quality.actualCount,
    generation: history.generation,
    sourceVersion: history.sourceVersion,
    source: history.provenance.historicalSource,
    rejectionReason: history.quality.flags[0] ?? null
  });
  stage("coverage-validation", {
    entered: true,
    inputCount: history.coverage.receivedIntrabars,
    outputCount: history.coverage.chartBarsWithCompleteIntrabars +
      history.coverage.chartBarsWithPartialIntrabars,
    expectedIntrabars: history.coverage.expectedIntrabars,
    receivedIntrabars: history.coverage.receivedIntrabars,
    completeChartBars: history.coverage.chartBarsWithCompleteIntrabars,
    partialChartBars: history.coverage.chartBarsWithPartialIntrabars,
    missingChartBars: history.coverage.chartBarsWithNoIntrabars,
    firstTimestamp: history.coverage.firstReceivedTime,
    lastTimestamp: history.coverage.lastReceivedTime,
    source: history.provenance.historicalSource,
    generation: history.generation,
    sourceVersion: history.sourceVersion,
    rejectionReason: history.quality.flags[0] ?? null
  });
  const settings = structuredClone(KIOSEFF_DEFAULT_SETTINGS);
  settings.model = "volatility-at-entry";
  settings.volatilityAtEntry.granularity = "lower";
  const context = {
    metadata: history.provenance.metadata,
    timeframe: chartTimeframe,
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
  const worker = new KioseffWorkerRuntime();
  const reset = worker.handle({
    type: "reset",
    requestId: "trace-reset",
    ...envelope,
    context
  });
  if (reset.type === "error") throw new Error(`Worker reset: ${reset.code}: ${reset.message}`);
  stage("worker-request", {
    chartBarsSent: history.chartBars.length,
    intrabarsSent: intrabarCount,
    generation: history.generation,
    sourceVersion: history.sourceVersion,
    rejectionReason: null
  });
  const response = worker.handle({
    type: "calculate-batch",
    requestId: "trace-calculate",
    ...envelope,
    inputs: history.chartBars
  });
  if (response.type === "error") {
    throw new Error(`Worker calculate: ${response.code}: ${response.message}`);
  }
  const snapshot = response.snapshot;
  stage("engine-snapshot", {
    activeClusters: snapshot.activeClusters.length,
    violatedClusters: snapshot.violatedClusters.length,
    panePoints: snapshot.pane.length,
    diagnostics: snapshot.diagnostics.length,
    generation: response.generation,
    sourceVersion: response.sourceVersion,
    rejectionReason: null
  });
  const render = buildKioseffRenderModel(snapshot, settings);
  stage("render-model", {
    activeZones: render.activeZones.length,
    violatedZones: render.violatedZones.length,
    panePoints: render.pane.length,
    curves: render.curves.length,
    geometryCommands: render.geometryCommandCount,
    elapsedMs: Date.now() - started,
    rejectionReason: null
  });
} catch (error) {
  stage("pipeline-rejected", {
    elapsedMs: Date.now() - started,
    rejectionReason: error instanceof Error ? error.message : String(error)
  });
  throw error;
}
