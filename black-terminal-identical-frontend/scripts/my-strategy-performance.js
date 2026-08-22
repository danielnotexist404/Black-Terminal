import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const strategies = Array.from({ length: 50 }, (_, index) => ({ id: `strategy-${index}`, name: `Strategy ${index}`, paperPnl: index * 3.17, paperTrades: index * 10, updatedAt: new Date(Date.now() - index * 1000).toISOString() }));
const targets = Array.from({ length: 10 }, (_, index) => ({ id: `target-${index}`, slotIndex: index + 1, equity: 10_000 + index, status: "READY" }));
const trades = Array.from({ length: 500 }, (_, index) => ({ id: `trade-${index}`, symbol: "BTCUSDT", netPnl: (index % 7 - 3) * 4.25, closedAt: Date.now() - index * 60_000 }));
const logs = Array.from({ length: 1_000 }, (_, index) => ({ id: index, type: index % 8 === 0 ? "WORKER_CHECKPOINT" : "SIGNAL_ACCEPTED", createdAt: Date.now() - index * 1_000 }));

const rows = [];
for (let iteration = 0; iteration < 2_000; iteration += 1) {
  const start = performance.now();
  const library = [...strategies].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((item) => ({ ...item, status: item.paperTrades ? "PAPER READY" : "DRAFT" }));
  const matrix = Array.from({ length: 10 }, (_, index) => targets.find((target) => target.slotIndex === index + 1) || null);
  const windowStart = iteration % 450;
  const tradeWindow = trades.slice(windowStart, windowStart + 48);
  const readableLogs = logs.filter((item) => !item.type.includes("DEBUG")).slice(0, 50);
  assert.equal(library.length, 50); assert.equal(matrix.filter(Boolean).length, 10); assert.ok(tradeWindow.length <= 48); assert.equal(readableLogs.length, 50);
  rows.push(performance.now() - start);
}
rows.sort((a, b) => a - b);
const percentile = (value) => rows[Math.min(rows.length - 1, Math.floor(rows.length * value))];
const report = { samples: rows.length, p50Ms: Number(percentile(.5).toFixed(3)), p95Ms: Number(percentile(.95).toFixed(3)), p99Ms: Number(percentile(.99).toFixed(3)), maximumMs: Number(rows.at(-1).toFixed(3)), fixtures: { strategies: 50, occupiedTargets: 10, paperTrades: 500, runtimeLogs: 1_000 } };
assert.ok(report.p99Ms < 20, `My Strategy model p99 exceeded 20ms: ${report.p99Ms}ms`);
console.table([report]);
console.log("My Strategy performance PASS — 50 strategies, 10 targets, 500 trades and 1,000 logs remain within the interaction model budget.");
