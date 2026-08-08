import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BclifHealthState } from "../server/liquidation-intelligence/collector/health.ts";
import { parseSymbols } from "../server/liquidation-intelligence/collector/runtimeConfig.ts";
import { deriveMeaningfulClusterPredictions } from "../server/liquidation-intelligence/model/calibrationRuntime.ts";
import { buildCanonicalFrame, consumeOpenInterestObservation } from "../server/liquidation-intelligence/normalization/canonicalFrame.ts";
import { BclifCalibrationRepository } from "../server/liquidation-intelligence/state/calibrationRepository.ts";
import { assertBclifCoverageCutoffCoherent, BCLIF_MAX_COVERAGE_INTERVALS_PER_SOURCE, BclifCoverageTracker } from "../server/liquidation-intelligence/state/coverageRepository.ts";
import { BclifSourceRepository } from "../server/liquidation-intelligence/state/sourceRepository.ts";
import { makeModelColumn, makeOpenInterest, TEST_SOURCE_VERSION } from "./bclif-test-fixtures.ts";

const first = makeOpenInterest(60_000, 1_000);
const next = makeOpenInterest(120_000, 1_125);
const initial = consumeOpenInterestObservation(first, null);
assert.equal(initial.advanced, true);
assert.equal(initial.previous?.singleSideOpenInterest, 1_000, "the first observation establishes a zero-delta baseline");
const repeated = consumeOpenInterestObservation(first, initial.nextConsumed);
assert.equal(repeated.advanced, false);
assert.equal(repeated.previous?.singleSideOpenInterest, 1_000);
const advanced = consumeOpenInterestObservation(next, repeated.nextConsumed);
assert.equal(advanced.advanced, true);
assert.equal(advanced.previous?.singleSideOpenInterest, 1_000);
const repeatedNext = consumeOpenInterestObservation(next, advanced.nextConsumed);
assert.equal(repeatedNext.advanced, false, "one OI observation must be consumed exactly once across faster model frames");
assert.throws(() => consumeOpenInterestObservation({ ...next, singleSideOpenInterest: 2_000 }, next), /identity changed value/);

const ticker = {
  exchangeTimestamp: 120_000,
  receivedTimestamp: 120_000,
  lastPrice: 64_000,
  markPrice: 64_005,
  indexPrice: 64_000,
  basisBps: 0.78,
  singleSideOpenInterest: next.singleSideOpenInterest,
  fundingRate: 0.0001,
  bestBid: 64_004,
  bestAsk: 64_006
};
const frame = buildCanonicalFrame({
  symbol: "BTCUSDT",
  frameStart: 115_000,
  frameEnd: 120_000,
  sourceCutoffTimestamp: 120_000,
  generatedAt: 120_000,
  sourceVersion: TEST_SOURCE_VERSION,
  trades: [],
  liquidations: [],
  currentOpenInterest: next,
  previousOpenInterest: first,
  ticker,
  ratio: null,
  book: null,
  sourceAvailability: { trades: true, liquidations: true, orderbook: false, openInterest: true, funding: true, positioning: false }
});
assert.equal(frame.frame.openInterestDelta, 125);
assert.equal(frame.frame.aggressiveBuyNotional, 0);
assert.equal(frame.frame.certainty.trades, "OBSERVED", "a quiet but continuously subscribed trade stream is observed zero flow");
assert.equal(frame.frame.certainty.liquidations, "OBSERVED", "a quiet liquidation stream is not an invented coverage gap");

assert.throws(() => buildCanonicalFrame({
  symbol: "BTCUSDT", frameStart: 115_000, frameEnd: 120_000, sourceCutoffTimestamp: 120_000,
  sourceVersion: TEST_SOURCE_VERSION, trades: [], liquidations: [], currentOpenInterest: next, previousOpenInterest: first,
  ticker: { ...ticker, receivedTimestamp: 120_001 }, ratio: null, book: null,
  sourceAvailability: { trades: true, liquidations: true, orderbook: false, openInterest: true, funding: true, positioning: false }
}), /future data/);

const health = new BclifHealthState();
for (const prerequisite of ["configuration", "database", "schema", "storage", "adapters", "checkpoint", "identity", "clock"] as const) health.prerequisite(prerequisite, true);
health.setPhase("LIVE");
health.degrade("OI_STALE", true, "BTCUSDT");
health.degrade("OI_STALE", true, "ETHUSDT");
health.degrade("OI_STALE", false, "BTCUSDT");
assert.equal(health.ready(), true);
assert.deepEqual((health.snapshot().degradedScopes as Record<string, string[]>).OI_STALE, ["ETHUSDT"], "clearing one symbol must not hide another symbol's degradation");

const symbolErrors: string[] = [];
assert.deepEqual(parseSymbols("btcusdt, ETHUSDT,btcusdt", symbolErrors), ["BTCUSDT", "ETHUSDT"]);
assert.deepEqual(symbolErrors, []);

const clusterColumn = makeModelColumn(15 * 60_000, 64, 12);
const predictions = deriveMeaningfulClusterPredictions(clusterColumn, 50_000, 25, "model-test", clusterColumn.timestamp);
assert.ok(predictions.length > 0 && predictions.length <= 4);
assert.ok(predictions.every((prediction) => prediction.sourceCutoffTimestamp === clusterColumn.timestamp && prediction.createdAt === clusterColumn.timestamp));

class Query {
  private readonly response: any;
  constructor(response: any) { this.response = response; }
  select() { return this; }
  eq() { return this; }
  order() { return this; }
  limit() { return this; }
  then(resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) { return Promise.resolve(this.response).then(resolve, reject); }
}
const fakeSupabase = {
  from(table: string) {
    if (table === "bclif_cluster_predictions") return new Query({ data: null, error: null, count: 2 });
    return new Query({
      data: [
        { outcome: "HIT", price_error: 10, timing_error_ms: 1_000, confirmed_event_overlap: 0.8, observed_sample_count: 2, immutable_evidence: {}, bclif_cluster_predictions: { confidence: 0.7 } },
        { outcome: "FALSE_POSITIVE", price_error: null, timing_error_ms: null, confirmed_event_overlap: 0, observed_sample_count: 1, immutable_evidence: {}, bclif_cluster_predictions: { confidence: 0.6 } }
      ], error: null
    });
  }
};
const calibrationStatus = await new BclifCalibrationRepository(fakeSupabase, "00000000-0000-8000-8000-000000000001", {
  nodeId: "LIQUIDATION_INTELLIGENCE_NODE_01",
  instanceId: "instance-test-0001",
  fencingEpoch: 1
}).status();
assert.equal(calibrationStatus.hitRate, 0.5);
assert.equal(calibrationStatus.falsePositiveRate, 0.5);
assert.equal(calibrationStatus.missedRate, null, "missed-event rate must stay unavailable without an event-centric evaluator");

const emptyCoverage = new BclifCoverageTracker().calculate({
  venue: "BYBIT",
  symbol: "BTCUSDT",
  horizon: "6H",
  requestedStart: 1_000,
  requestedEnd: 2_000,
  sourceCutoffTimestamp: null
});
assert.equal(emptyCoverage.sourceMode, "UNAVAILABLE");
assert.equal(emptyCoverage.modelAuthority, "BROWSER_FALLBACK", "an empty ledger must satisfy the unavailable/fallback authority contract");
assert.equal(emptyCoverage.continuityPercent, null);
const boundedCoverage = new BclifCoverageTracker();
for (let index = 0; index <= BCLIF_MAX_COVERAGE_INTERVALS_PER_SOURCE; index += 1) {
  boundedCoverage.record("TRADE", index * 2, index * 2 + 1);
}
const boundedTradeCoverage = boundedCoverage.snapshot().TRADE;
assert.equal(boundedTradeCoverage.length, BCLIF_MAX_COVERAGE_INTERVALS_PER_SOURCE, "live coverage state must remain bounded in memory and checkpoints");
assert.equal(boundedTradeCoverage[0]?.start, 2, "bounded coverage must evict the oldest fragmented interval first");
assert.equal(boundedCoverage.calculate({
  venue: "BYBIT",
  symbol: "BTCUSDT",
  horizon: "6H",
  requestedStart: 0,
  requestedEnd: BCLIF_MAX_COVERAGE_INTERVALS_PER_SOURCE * 2 + 1,
  sourceCutoffTimestamp: BCLIF_MAX_COVERAGE_INTERVALS_PER_SOURCE * 2 + 1
}).requestedStart, 2, "coverage calculations must not claim a prefix evicted by the in-memory bound");
const restoredBoundedCoverage = new BclifCoverageTracker();
restoredBoundedCoverage.restore(boundedCoverage.snapshot());
assert.equal(restoredBoundedCoverage.calculate({
  venue: "BYBIT",
  symbol: "BTCUSDT",
  horizon: "6H",
  requestedStart: 0,
  requestedEnd: BCLIF_MAX_COVERAGE_INTERVALS_PER_SOURCE * 2 + 1,
  sourceCutoffTimestamp: BCLIF_MAX_COVERAGE_INTERVALS_PER_SOURCE * 2 + 1
}).requestedStart, 2, "a checkpoint restore must preserve the conservative retained-evidence floor");
const laggingCutoffCoverage = new BclifCoverageTracker();
laggingCutoffCoverage.record("OPEN_INTEREST", 1_000, 1_500);
const laggingCutoffResult = laggingCutoffCoverage.calculate({
  venue: "BYBIT",
  symbol: "BTCUSDT",
  horizon: "6H",
  requestedStart: 1_000,
  requestedEnd: 2_000,
  sourceCutoffTimestamp: 1_500
});
assert.equal(laggingCutoffResult.sourceCutoffTimestamp, 1_500, "the v2 API uses a lagging cutoff to mark the trailing request suffix as unknown");
assert.equal(laggingCutoffResult.openInterestCoveragePercent, null);
assert.equal(laggingCutoffResult.continuityPercent, null);
assert.equal(laggingCutoffResult.quality, "INSUFFICIENT");
assert.ok(laggingCutoffResult.gaps.some((gap) => gap.start === 1_500 && gap.end === 2_000 && gap.missingSources.includes("OPEN_INTEREST_COVERAGE_UNKNOWN")));
const incoherentCutoffCoverage = new BclifCoverageTracker();
incoherentCutoffCoverage.record("OPEN_INTEREST", 1_000, 1_500);
incoherentCutoffCoverage.record("TRADE", 1_000, 1_800);
const coherentCutoffBaseline = incoherentCutoffCoverage.calculate({
  venue: "BYBIT",
  symbol: "BTCUSDT",
  horizon: "6H",
  requestedStart: 1_000,
  requestedEnd: 2_000,
  sourceCutoffTimestamp: 2_000
});
assert.throws(() => assertBclifCoverageCutoffCoherent({
  ...coherentCutoffBaseline,
  sourceIntervals: { ...coherentCutoffBaseline.sourceIntervals, TRADE: [{ start: 1_000, end: 2_001 }] }
}), /source interval exceeds/, "the writer must reject a ledger containing observations after its declared causal cutoff");

const predictionPage = Array.from({ length: 500 }, (_, index) => predictionRow(`evaluated-${index}`, index));
const laterPrediction = predictionRow("pending-500", 500);
const paginationLog: Array<{ table: string; method: string; args: unknown[] }> = [];
class CalibrationPagingQuery {
  private start = 0;
  private ids: string[] = [];
  private readonly table: string;
  constructor(table: string) { this.table = table; }
  select() { return this; }
  eq() { return this; }
  order(...args: unknown[]) { paginationLog.push({ table: this.table, method: "order", args }); return this; }
  range(start: number, end: number) { this.start = start; paginationLog.push({ table: this.table, method: "range", args: [start, end] }); return this; }
  in(_column: string, ids: string[]) { this.ids = ids; return this; }
  then(resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) {
    const response = this.table === "bclif_cluster_predictions"
      ? { data: this.start === 0 ? predictionPage : this.start === 500 ? [laterPrediction] : [], error: null }
      : { data: this.ids.filter((id) => id !== laterPrediction.id).map((prediction_id) => ({ prediction_id })), error: null };
    return Promise.resolve(response).then(resolve, reject);
  }
}
const pagedCalibration = new BclifCalibrationRepository({
  from(table: string) { return new CalibrationPagingQuery(table); }
}, "00000000-0000-8000-8000-000000000001", {
  nodeId: "LIQUIDATION_INTELLIGENCE_NODE_01",
  instanceId: "instance-test-0001",
  fencingEpoch: 1
});
assert.deepEqual((await pagedCalibration.loadUnevaluated(1)).map((prediction) => prediction.id), [laterPrediction.id]);
assert.ok(paginationLog.some((entry) => entry.method === "range" && entry.args[0] === 500 && entry.args[1] === 999), "calibration must page beyond evaluated predictions");
assert.ok(paginationLog.some((entry) => entry.method === "order" && entry.args[0] === "id"), "calibration paging must use a deterministic ID tiebreaker");

const adoptionPredicates: Array<[string, unknown]> = [];
const adoptionUpdates: Array<Record<string, unknown>> = [];
let nodeUpdates = 0;
class AdoptionQuery {
  private operation = "";
  private updateIndex = 0;
  private readonly table: string;
  constructor(table: string) { this.table = table; }
  insert() { this.operation = "insert"; return this; }
  update(payload: Record<string, unknown>) {
    this.operation = "update";
    if (this.table === "bclif_collector_nodes") {
      this.updateIndex = ++nodeUpdates;
      adoptionUpdates.push(payload);
    }
    return this;
  }
  eq(column: string, value: unknown) { if (this.operation === "update") adoptionPredicates.push([column, value]); return this; }
  select() { return this; }
  then(resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) {
    if (this.table === "bclif_collector_nodes" && this.operation === "update" && this.updateIndex === 1) {
      return Promise.reject(new Error("simulated adoption transport rejection")).then(resolve, reject);
    }
    const key = this.table === "bclif_collector_instances" ? "instance_id" : "node_id";
    return Promise.resolve({ data: this.operation === "insert" ? null : [{ [key]: "ok" }], error: null }).then(resolve, reject);
  }
}
const sourceRepository = new BclifSourceRepository({
  from(table: string) { return new AdoptionQuery(table); },
  async rpc() { return { data: { fencing_epoch: 7 }, error: null }; }
});
const adoptionNode = {
  nodeId: "LIQUIDATION_INTELLIGENCE_NODE_01",
  instanceId: "instance-adoption-test",
  environment: "DEVELOPMENT" as const,
  region: "local",
  deploymentCommit: "test-commit",
  imageDigest: "sha256:test",
  modelVersion: "BCLIF_MODEL_V4_CAUSAL",
  startedAt: 1_000,
  lastHeartbeatAt: 1_000,
  status: "STARTING" as const,
  fencingEpoch: 0
};
await assert.rejects(() => sourceRepository.registerNode(adoptionNode, "DATABASE_CONNECTING"), /adoption transport rejection/);
assert.equal(nodeUpdates, 2, "a rejected adoption must issue one fenced release update after the failed adoption update");
assert.equal(adoptionUpdates[1]?.current_instance_id, null);
assert.equal(adoptionUpdates[1]?.lease_expires_at, null);
assert.ok(adoptionPredicates.some(([column, value]) => column === "current_instance_id" && value === adoptionNode.instanceId));
assert.ok(adoptionPredicates.some(([column, value]) => column === "fencing_epoch" && value === 7));
assert.throws(() => sourceRepository.fence(), /not acquired/, "a failed adoption must clear its in-memory fence");

const workerSource = readFileSync(new URL("../server/liquidation-intelligence/collector/worker.ts", import.meta.url), "utf8");
assert.match(workerSource, /for \(const collector of this\.symbols\) await collector\.startLive\(\)/, "collector startup must await every source-authority transition");
assert.ok(
  (workerSource.match(/archived\.has\(bclifArchivedEventIdentity\(event\)\)/g) || []).length >= 3,
  "historical accept and spool recovery must compare composite event identities"
);
const archiveRepositorySource = readFileSync(new URL("../server/liquidation-intelligence/state/eventChunkRepository.ts", import.meta.url), "utf8");
assert.match(archiveRepositorySource, /new Set\(selected\.map\(bclifArchivedEventIdentity\)\)/, "archive reconciliation must search composite kind/dedup identities");
assert.match(archiveRepositorySource, /const identity = bclifArchivedEventIdentity\(event\)/, "archive reconciliation must return composite identities");
const retentionSource = readFileSync(new URL("../server/liquidation-intelligence/tiles/retention.ts", import.meta.url), "utf8");
const completionFence = retentionSource.slice(retentionSource.indexOf('state: "OBJECT_DELETED"'), retentionSource.indexOf("completed += 1"));
const failureStart = retentionSource.indexOf("last_error_code: safeCode(error)");
const failureFence = retentionSource.slice(failureStart, retentionSource.indexOf("} catch {", failureStart));
for (const predicate of ['.eq("state", "CLAIMED")', '.eq("claimed_by_node_id", this.nodeId)', '.eq("writer_instance_id", this.fence.instanceId)', '.eq("fencing_epoch", this.fence.fencingEpoch)']) {
  assert.ok(completionFence.includes(predicate), `retention completion is missing fenced predicate ${predicate}`);
  assert.ok(failureFence.includes(predicate), `retention failure is missing fenced predicate ${predicate}`);
}

console.log(JSON.stringify({ decision: "PASS", oiDeltaAppliedOnce: true, quietStreamCoverage: true, scopedDegradation: true, calibrationMissedRate: calibrationStatus.missedRate }, null, 2));

function predictionRow(id: string, offset: number) {
  return {
    id,
    model_version: "BCLIF_MODEL_V4_CAUSAL",
    source_cutoff_at: new Date(1_000 + offset).toISOString(),
    created_at: new Date(2_000 + offset).toISOString(),
    price_min: 60_000,
    price_max: 61_000,
    notional_min: 1,
    notional_max: 2,
    confidence: 0.5,
    predicted_side: "LONG_LIQUIDATION",
    immutable_context: {}
  };
}
