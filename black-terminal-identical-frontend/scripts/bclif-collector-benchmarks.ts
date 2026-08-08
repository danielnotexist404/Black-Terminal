import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { BclifTileInput } from "../server/liquidation-intelligence/contracts.ts";
import { buildCumulativeLiveEdges } from "../server/liquidation-intelligence/tiles/liveEdgeRollup.ts";
import { encodeBclifTile } from "../server/liquidation-intelligence/tiles/tileCodec.ts";
import { makeColumns, TEST_CADENCE_MS, TEST_MODEL_VERSION, TEST_SOURCE_VERSION } from "./bclif-test-fixtures.ts";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT", "LTCUSDT"];
const rows = 512;
const columns = makeColumns(360, rows);
const results = [] as Array<Record<string, unknown>>;

for (const symbolCount of [1, 5, 10]) {
  const resident: BclifTileInput[] = [];
  const generationSamples: number[] = [];
  const incrementalSamples: number[] = [];
  const cpuStart = process.cpuUsage();
  const rssStart = process.memoryUsage().rss;
  let representativeCompressedBytes = 0;
  let fullTileResidentBytes = 0;
  for (const symbol of SYMBOLS.slice(0, symbolCount)) {
    const options = {
      symbol,
      modelVersion: TEST_MODEL_VERSION,
      sourceVersion: TEST_SOURCE_VERSION,
      minPrice: 20_000,
      priceStep: 100,
      rows,
      baseTimeStepMs: TEST_CADENCE_MS,
      coverageQuality: "HIGH" as const,
      createdAt: columns.at(-1)!.timestamp
    };
    const started = performance.now();
    const edges = buildCumulativeLiveEdges([], columns, options);
    generationSamples.push(performance.now() - started);
    assert.deepEqual([...edges.keys()], ["6H", "12H", "1D", "3D", "1W", "3W", "1M"]);
    resident.push(...edges.values());
    fullTileResidentBytes ||= tileBytes(edges.get("6H")!);

    const prefix = buildCumulativeLiveEdges([], columns.slice(0, 359), options);
    const incrementalStarted = performance.now();
    const incremented = buildCumulativeLiveEdges([], columns, { ...options, priorLiveEdges: prefix });
    incrementalSamples.push(performance.now() - incrementalStarted);
    assert.equal(incremented.get("6H")?.columns, 360);

    if (!representativeCompressedBytes) {
      representativeCompressedBytes = [...edges.values()].reduce((total, tile) => total + encodeBclifTile(tile).bytes.byteLength, 0);
    }
  }
  const cpu = process.cpuUsage(cpuStart);
  const rssEnd = process.memoryUsage().rss;
  const residentBytes = resident.reduce((total, tile) => total + tileBytes(tile), 0);
  const activeBucketBytesPerSymbol = columns.reduce((total, column) => total + Object.values(column)
    .filter((value): value is ArrayBufferView => ArrayBuffer.isView(value))
    .reduce((columnTotal, value) => columnTotal + value.byteLength, 0), 0);
  const structuralSteadyStateUpperBoundBytes = symbolCount * (fullTileResidentBytes * 9 + activeBucketBytesPerSymbol);
  const structuralPublicationPeakUpperBoundBytes = symbolCount * (fullTileResidentBytes * 16 + activeBucketBytesPerSymbol);
  // Encoding one deterministic representative gives an exact workload-sized
  // estimate for this synthetic equal-grid fixture. It is not a production
  // bandwidth measurement and intentionally does not certify host capacity.
  results.push({
    symbols: symbolCount,
    horizons: 7,
    rows,
    baseColumns: columns.length,
    tileGenerationMs: percentiles(generationSamples),
    incrementalAppendMs: percentiles(incrementalSamples),
    cpuUserMs: Number((cpu.user / 1_000).toFixed(2)),
    cpuSystemMs: Number((cpu.system / 1_000).toFixed(2)),
    exactCandidateRevisionArrayBytes: residentBytes,
    exactCandidateRevisionArrayMiB: Number((residentBytes / 1024 / 1024).toFixed(2)),
    structuralSteadyStateUpperBoundBytes,
    structuralSteadyStateUpperBoundMiB: Number((structuralSteadyStateUpperBoundBytes / 1024 / 1024).toFixed(2)),
    structuralPublicationPeakUpperBoundBytes,
    structuralPublicationPeakUpperBoundMiB: Number((structuralPublicationPeakUpperBoundBytes / 1024 / 1024).toFixed(2)),
    observedRssDeltaMiB: Number(((rssEnd - rssStart) / 1024 / 1024).toFixed(2)),
    estimatedCompressedBytesPerSyntheticRevision: representativeCompressedBytes * symbolCount,
    queueDelay: "NOT_MEASURED_WITHOUT_PERSISTENT_IO",
    recoveryTime: "NOT_MEASURED_WITHOUT_CHECKPOINT_OBJECT_STORE",
    capacityCertification: "NOT_CERTIFIED"
  });
}

const ten = results.find((result) => result.symbols === 10)!;
assert.ok(Number.isFinite(Number(ten.structuralSteadyStateUpperBoundMiB)));
assert.ok(Number(ten.structuralPublicationPeakUpperBoundMiB) >= Number(ten.structuralSteadyStateUpperBoundMiB));
assert.ok(Number(ten.structuralPublicationPeakUpperBoundMiB) < 1_024, "synthetic publication-peak array regression budget exceeded; this is not a host-capacity certification");

console.log(JSON.stringify({
  decision: "MEASURED_KERNEL_ONLY",
  hostCapacityClaim: "NONE",
  warning: "Synthetic CPU/array/codec evidence only; network, durable storage, restart, and soak require the deployed persistent host.",
  results
}, null, 2));

function tileBytes(tile: BclifTileInput) {
  return Object.values(tile.channels).reduce((total, channel) => total + (channel?.byteLength || 0), 0);
}

function percentiles(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] ?? 0;
  return { p50: Number(at(0.5).toFixed(2)), p95: Number(at(0.95).toFixed(2)), p99: Number(at(0.99).toFixed(2)) };
}
