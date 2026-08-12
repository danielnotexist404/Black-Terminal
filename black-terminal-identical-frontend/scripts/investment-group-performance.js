import { performance } from "node:perf_hooks";
import { aggregateMemberSnapshots } from "../server/investment-groups/policy.js";

const sizes = [10, 100, 500];
const iterations = 2_000;
for (const size of sizes) {
  const snapshots = Array.from({ length: size }, (_, index) => ({
    membershipState: index % 11 === 0 ? "PAUSED_BY_USER" : "ACTIVE",
    freshness: index % 17 === 0 ? "STALE" : "LIVE",
    equity: 10_000 + index,
    allocatedEquity: 2_000 + index,
    grossExposure: 1_000 + index,
    netExposure: index % 2 ? -200 : 200,
    longExposure: 600,
    shortExposure: 400,
    realizedPnl: index % 2 ? -5 : 7,
    unrealizedPnl: index % 3 ? 3 : -4,
    grossPnl: 2,
    fees: 0.5,
    funding: 0.25,
    netPnl: 1.25,
    usedMargin: 250,
    effectiveLeverage: 3,
    currentDrawdownPercent: index % 9,
    maximumDrawdownPercent: index % 15
  }));
  const samples = [];
  for (let run = 0; run < iterations; run += 1) {
    const started = performance.now();
    aggregateMemberSnapshots(snapshots);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const percentile = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
  console.log(JSON.stringify({ members: size, iterations, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maximumMs: samples.at(-1) }));
}
