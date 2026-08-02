import assert from "node:assert/strict";
import type { SymbolMetadata } from "../src/market-data/types.ts";
import {
  KIOSEFF_ENGINE_VERSION,
  canonicalSnapshotHash
} from "../src/modules/kioseff-stop-loss-clustering/core/canonical.ts";
import { KioseffParityEngine } from "../src/modules/kioseff-stop-loss-clustering/core/parityEngine.ts";
import {
  KIOSEFF_DEFAULT_SETTINGS,
  kioseffSettingsVersion
} from "../src/modules/kioseff-stop-loss-clustering/core/settings.ts";
import { certifiedKioseffInputTail } from "../src/modules/kioseff-stop-loss-clustering/data/qualityGate.ts";
import type {
  IntrabarQualityReport,
  KioseffChartBarInput,
  NormalizedCandle
} from "../src/modules/kioseff-stop-loss-clustering/data/types.ts";
import type { KioseffWorkerLike } from "../src/modules/kioseff-stop-loss-clustering/workers/KioseffWorkerClient.ts";
import { KioseffWorkerClient } from "../src/modules/kioseff-stop-loss-clustering/workers/KioseffWorkerClient.ts";
import { KioseffWorkerRuntime } from "../src/modules/kioseff-stop-loss-clustering/workers/KioseffWorker.ts";
import type {
  KioseffWorkerRequest,
  KioseffWorkerResponse
} from "../src/modules/kioseff-stop-loss-clustering/workers/protocol.ts";

const metadata: SymbolMetadata = {
  exchange: "mock",
  rawSymbol: "ROLLBACKUSDT",
  normalizedSymbol: "ROLLBACK/USDT",
  assetClass: "crypto",
  marketKind: "perpetual",
  tickSize: "0.1",
  timezone: "UTC",
  sessionPolicy: "24x7",
  source: "fixture"
};
const settings = structuredClone(KIOSEFF_DEFAULT_SETTINGS);
settings.model = "volatility-at-entry";
settings.volatilityAtEntry.granularity = "higher";
const context = {
  metadata,
  timeframe: "5m" as const,
  sourceVersion: "rollback-v1",
  settings,
  diagnostics: true
};

function candle(time: number, close: number, volume = 10): NormalizedCandle {
  return {
    time,
    open: close - 0.1,
    high: close + 0.4,
    low: close - 0.4,
    close,
    volume,
    originalTime: time,
    source: "fixture",
    sourceRevision: "1"
  };
}

function quality(count: number): IntrabarQualityReport {
  return {
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
  };
}

function barInput(index: number, revision = 0, closed = true): KioseffChartBarInput {
  const chart = candle(index * 300, 100 + index * 0.05 + revision * 0.02, 100);
  const intrabars = Array.from({ length: 5 }, (_, intrabarIndex) =>
    candle(chart.time + intrabarIndex * 60, chart.close + (intrabarIndex - 2) * 0.03 + revision * 0.01)
  );
  return {
    chartBar: chart,
    intrabars,
    chartBarClosed: closed,
    sourceVersion: "rollback-v1",
    quality: quality(5)
  };
}

const revisions = new KioseffParityEngine(context);
const historical = new KioseffParityEngine(context);
for (let index = 0; index < 20; index += 1) {
  revisions.processBar(barInput(index));
  historical.processBar(barInput(index));
}
revisions.processBar(barInput(20, 0, false));
const replayed = revisions.processBar(barInput(20, 2, false));
const direct = historical.processBar(barInput(20, 2, false));
assert.equal(
  canonicalSnapshotHash(replayed),
  canonicalSnapshotHash(direct),
  "replaying the full provisional bar must equal one final historical execution"
);
assert.equal(revisions.exportState().provisionalBarTime, 20 * 300);
revisions.processBar(barInput(20, 2, true));
assert.equal(revisions.exportState().committedThrough, 20 * 300);
assert.equal(revisions.exportState().provisionalBarTime, null);

const runtime = new KioseffWorkerRuntime();
const envelope = {
  generation: 1,
  sourceVersion: "rollback-v1",
  engineVersion: KIOSEFF_ENGINE_VERSION,
  settingsVersion: kioseffSettingsVersion(settings)
};
const resetResponse = runtime.handle({
  type: "reset",
  requestId: "reset",
  ...envelope,
  context
});
assert.equal(resetResponse.type, "result");
const directWorkerResult = runtime.handle({
  type: "calculate",
  requestId: "calculate",
  ...envelope,
  input: barInput(0)
});
assert.equal(directWorkerResult.type, "result");
const stale = runtime.handle({
  type: "calculate",
  requestId: "stale",
  ...envelope,
  generation: 0,
  input: barInput(1)
});
assert.equal(stale.type, "error");
if (stale.type === "error") assert.equal(stale.code, "stale-source-generation");

class LoopbackWorker implements KioseffWorkerLike {
  maxBatchSize = 0;
  onmessage: ((event: MessageEvent<KioseffWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private runtime = new KioseffWorkerRuntime();
  private terminated = false;

  postMessage(message: KioseffWorkerRequest) {
    if (message.type === "calculate-batch") {
      this.maxBatchSize = Math.max(this.maxBatchSize, message.inputs.length);
    }
    const delay = message.type === "calculate" ? 5 : 0;
    setTimeout(() => {
      if (this.terminated) return;
      this.onmessage?.({ data: this.runtime.handle(message) } as MessageEvent<KioseffWorkerResponse>);
    }, delay);
  }

  terminate() {
    this.terminated = true;
  }
}

const client = new KioseffWorkerClient(context, () => new LoopbackWorker());
await client.reset();
const clientResult = await client.calculate(barInput(0)).promise;
assert.equal(
  canonicalSnapshotHash(clientResult),
  directWorkerResult.type === "result" ? canonicalSnapshotHash(directWorkerResult.snapshot) : ""
);
const superseded = client.calculate(barInput(1)).promise;
const supersededRejection = assert.rejects(superseded, /stale-source-generation/);
const nextContext = { ...context, sourceVersion: "rollback-v2" };
await client.reset(nextContext);
await supersededRejection;
assert.equal(client.pendingCount, 0);
client.dispose();
assert.equal(client.pendingCount, 0);

const incomplete = barInput(4);
incomplete.quality = {
  ...incomplete.quality,
  complete: false,
  missingTimes: [incomplete.chartBar.time]
};
const certifiedTail = certifiedKioseffInputTail([
  barInput(0),
  incomplete,
  barInput(5),
  barInput(6)
]);
assert.deepEqual(
  certifiedTail.map((input) => input.chartBar.time),
  [barInput(5).chartBar.time, barInput(6).chartBar.time],
  "only the newest contiguous certified history is calculated"
);

const chunkInputs = Array.from({ length: 11 }, (_, index) => barInput(index));
const chunkExpected = new KioseffParityEngine(context).processBatch(chunkInputs);
const chunkWorker = new LoopbackWorker();
const chunkClient = new KioseffWorkerClient(context, () => chunkWorker);
await chunkClient.reset();
const chunkProgress: number[] = [];
const chunkSnapshot = await chunkClient.calculateBatchChunked(
  chunkInputs,
  4,
  (progress) => chunkProgress.push(progress.completedBars)
);
assert.equal(canonicalSnapshotHash(chunkSnapshot), canonicalSnapshotHash(chunkExpected));
assert.equal(chunkWorker.maxBatchSize, 4, "large histories are never cloned to the worker as one payload");
assert.deepEqual(chunkProgress, [4, 8, 11]);
assert.equal(chunkClient.lastTelemetry.workerChartBarsReceived, 11);
assert.equal(
  chunkClient.lastTelemetry.workerIntrabarsReceived,
  chunkInputs.reduce((sum, input) => sum + input.intrabars.length, 0)
);
chunkClient.dispose();

console.log("Kioseff transactional worker tests passed.");
