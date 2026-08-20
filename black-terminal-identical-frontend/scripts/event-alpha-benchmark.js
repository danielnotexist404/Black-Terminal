import { performance } from "node:perf_hooks";
import { normalizeRawEventEnvelope, normalizeTokenUnlock } from "../server/event-alpha/domain.js";
import { assessEventSurprise, forecastEventResponse } from "../server/event-alpha/engine.js";

const iterations = 20_000;
const envelopeInput = {
  sourceKey: "BENCH_PROVIDER",
  sourceEventId: "bench-1",
  eventFamily: "TOKEN_SUPPLY",
  observedAt: "2026-08-01T00:00:00Z",
  firstActionableAt: "2026-08-01T00:00:00Z",
  sourcePublishedAt: "2026-08-01T00:00:00Z",
  payload: { assetId: "BENCH", symbol: "BENCHUSDT", eventTime: "2026-08-02T00:00:00Z", unlockTokens: 20, circulatingSupply: 1_000, beneficiaryClass: "TEAM", sourceConfidence: 0.9 }
};
const samples = [];
const rssBefore = process.memoryUsage().rss;
for (let index = 0; index < iterations; index += 1) {
  const started = performance.now();
  const canonicalEvent = normalizeTokenUnlock(normalizeRawEventEnvelope({ ...envelopeInput, sourceEventId: `bench-${index}` }));
  const expectation = { canonicalEventKey: canonicalEvent.canonicalKey, asOf: "2026-07-31T00:00:00Z", firstActionableAt: canonicalEvent.firstActionableAt, modelKey: "BENCH", modelVersion: "1", expectedValue: 15, expectedTime: canonicalEvent.eventTime, expectedProbability: null, dispersion: 1, confidence: 0.9, contributors: [], featureManifest: {} };
  const surprise = assessEventSurprise({ canonicalEvent, expectation, assetProfile: { knownAt: "2026-07-31T00:00:00Z", circulatingSupply: 1_000, averageDailyDollarVolume: 100_000, liquidSupplyRatio: 0.8, valueCaptureScore: 0.2 }, assessedAt: canonicalEvent.firstActionableAt });
  forecastEventResponse({ surprise, realizedAssetReturnBps: -10, realizedBenchmarkReturnBps: 1, horizonSeconds: 3_600, costs: { spreadBps: 2, slippageBps: 3, feesBps: 5, fundingBps: 0 } });
  samples.push(performance.now() - started);
}
const elapsedMs = samples.reduce((sum, value) => sum + value, 0);
const sorted = samples.toSorted((a, b) => a - b);
const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
const report = {
  evidenceClass: "MEASURED_LOCAL_KERNEL_ONLY",
  hostCapacityClaim: "NONE",
  iterations,
  elapsedMs: Number(elapsedMs.toFixed(3)),
  throughputPerSecond: Number((iterations / (elapsedMs / 1_000)).toFixed(1)),
  latencyMs: { p50: Number(percentile(0.5).toFixed(4)), p95: Number(percentile(0.95).toFixed(4)), p99: Number(percentile(0.99).toFixed(4)) },
  rssDeltaMiB: Number(((process.memoryUsage().rss - rssBefore) / 1024 / 1024).toFixed(2)),
  persistentIo: "NOT_MEASURED",
  apiLatency: "NOT_MEASURED",
  uiLatency: "NOT_MEASURED"
};
if (!Number.isFinite(report.throughputPerSecond) || report.throughputPerSecond <= 0 || report.latencyMs.p99 > 100) throw new Error("EVENT_ALPHA_KERNEL_BENCHMARK_REGRESSION");
console.log(JSON.stringify(report, null, 2));
