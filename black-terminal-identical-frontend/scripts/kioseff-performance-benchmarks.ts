import { performance } from "node:perf_hooks";
import type { SymbolMetadata } from "../src/market-data/types.ts";
import { canonicalSnapshotHash, stableCanonicalJson } from "../src/modules/kioseff-stop-loss-clustering/core/canonical.ts";
import { KioseffParityEngine } from "../src/modules/kioseff-stop-loss-clustering/core/parityEngine.ts";
import { KIOSEFF_DEFAULT_SETTINGS } from "../src/modules/kioseff-stop-loss-clustering/core/settings.ts";
import type {
  IntrabarQualityReport,
  KioseffChartBarInput,
  NormalizedCandle
} from "../src/modules/kioseff-stop-loss-clustering/data/types.ts";

const metadata: SymbolMetadata = {
  exchange: "mock",
  rawSymbol: "PERFUSDT",
  normalizedSymbol: "PERF/USDT",
  assetClass: "crypto",
  marketKind: "perpetual",
  tickSize: "0.05",
  timezone: "UTC",
  sessionPolicy: "24x7",
  source: "benchmark"
};

const completeQuality: IntrabarQualityReport = {
  complete: true,
  partial: false,
  expectedIntervalSeconds: 60,
  expectedCount: 5,
  actualCount: 5,
  coverageStart: null,
  coverageEnd: null,
  missingTimes: [],
  duplicateTimes: [],
  outOfOrderTimes: [],
  conflictingTimes: [],
  sourceMismatch: false,
  flags: [],
  notes: []
};

function candle(time: number, open: number, close: number, volume: number): NormalizedCandle {
  return {
    time,
    open,
    high: Math.max(open, close) + 0.18,
    low: Math.min(open, close) - 0.18,
    close,
    volume,
    originalTime: time,
    source: "benchmark",
    sourceRevision: "v1"
  };
}

function benchmarkInputs(count: number): KioseffChartBarInput[] {
  return Array.from({ length: count }, (_, index) => {
    const base = 100 + Math.sin(index / 31) * 2 + index * 0.0002;
    const chart = candle(index * 300, base, base + Math.sin(index / 7) * 0.12, 500);
    const intrabars = Array.from({ length: 5 }, (_, intrabarIndex) => {
      const open = base + Math.sin((index * 5 + intrabarIndex) / 9) * 0.1;
      return candle(
        chart.time + intrabarIndex * 60,
        open,
        open + (intrabarIndex % 2 ? -0.06 : 0.06),
        20 + (index + intrabarIndex) % 17
      );
    });
    return {
      chartBar: chart,
      intrabars,
      chartBarClosed: true,
      sourceVersion: "benchmark-v1",
      quality: completeQuality
    };
  });
}

function context(granularity: "higher" | "lower") {
  const settings = structuredClone(KIOSEFF_DEFAULT_SETTINGS);
  settings.model = "volatility-at-entry";
  settings.volatilityAtEntry.granularity = granularity;
  return {
    metadata,
    timeframe: "5m" as const,
    sourceVersion: "benchmark-v1",
    settings,
    diagnostics: false
  };
}

const warmups = [1_000, 2_500, 5_000, 10_000, 20_000];
const results: Array<Record<string, unknown>> = [];
for (const count of warmups) {
  const inputs = benchmarkInputs(count);
  const heapBefore = process.memoryUsage().heapUsed;
  const engine = new KioseffParityEngine(context("higher"));
  const started = performance.now();
  const snapshot = engine.processBatch(inputs);
  const elapsed = performance.now() - started;
  const heapAfter = process.memoryUsage().heapUsed;
  const state = engine.exportState();
  results.push({
    scenario: `higher-warmup-${count}`,
    bars: count,
    intrabars: count * 5,
    workerCpuMs: Number(elapsed.toFixed(3)),
    msPerChartBar: Number((elapsed / count).toFixed(6)),
    heapDeltaBytes: heapAfter - heapBefore,
    payloadBytes: Buffer.byteLength(stableCanonicalJson(snapshot)),
    activeClusters: snapshot.activeClusters.length,
    violatedClusters: snapshot.violatedClusters.length,
    hash: canonicalSnapshotHash(snapshot),
    committedStateId: state.committedStateId
  });
}

const lowerInputs = benchmarkInputs(5_000);
const lower = new KioseffParityEngine(context("lower"));
const lowerStarted = performance.now();
const lowerSnapshot = lower.processBatch(lowerInputs);
results.push({
  scenario: "lower-warmup-5000",
  bars: 5_000,
  workerCpuMs: Number((performance.now() - lowerStarted).toFixed(3)),
  payloadBytes: Buffer.byteLength(stableCanonicalJson(lowerSnapshot)),
  activeClusters: lowerSnapshot.activeClusters.length,
  violatedClusters: lowerSnapshot.violatedClusters.length,
  hash: canonicalSnapshotHash(lowerSnapshot)
});

const transactional = new KioseffParityEngine(context("higher"));
transactional.processBatch(benchmarkInputs(1_000));
const next = benchmarkInputs(1_001).at(-1)!;
const commitStarted = performance.now();
transactional.processBar(next);
const closedCommitMs = performance.now() - commitStarted;
const provisional = structuredClone(benchmarkInputs(1_002).at(-1)!);
provisional.chartBarClosed = false;
const replayStarted = performance.now();
for (let revision = 0; revision < 20; revision += 1) {
  const revised = structuredClone(provisional);
  revised.chartBar.close += revision * 0.0001;
  transactional.processBar(revised);
}
results.push({
  scenario: "transactional-realtime",
  closedCommitMs: Number(closedCommitMs.toFixed(3)),
  provisionalRevisions: 20,
  provisionalReplayTotalMs: Number((performance.now() - replayStarted).toFixed(3)),
  finalHash: canonicalSnapshotHash(transactional.snapshot())
});

const switchStarted = performance.now();
for (let index = 0; index < 100; index += 1) {
  new KioseffParityEngine(context(index % 2 ? "higher" : "lower"));
}
results.push({
  scenario: "model-granularity-reset-100",
  elapsedMs: Number((performance.now() - switchStarted).toFixed(3))
});

console.log(JSON.stringify({ benchmark: "kioseff-stop-loss-clustering", results }, null, 2));
