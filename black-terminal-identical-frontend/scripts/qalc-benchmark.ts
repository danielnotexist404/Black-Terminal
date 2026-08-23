import { performance } from "node:perf_hooks";
import { QalcFeatureEngine } from "../server/qalc/features.ts";
import { directionModel } from "../server/qalc/models.ts";
import { QalcOrderBook } from "../server/qalc/order-book.ts";
import { defaultQalcConfig, type QalcMarketEvent } from "../server/qalc/contracts.ts";

const iterations = Number(process.argv.find((arg) => arg.startsWith("--iterations="))?.split("=")[1] || 20_000);
const book = new QalcOrderBook("BTCUSDT");
const features = new QalcFeatureEngine(0.1);
const config = defaultQalcConfig({ mode: "REPLAY" });
const base = event("BOOK_SNAPSHOT", 1, 1_000, [[100, 3], [99.9, 2]], [[100.1, 3], [100.2, 2]]);
const initial = book.apply(base); features.observeBook(base, initial, book.view(1_000));
const bookTimes: number[] = [];
const featureTimes: number[] = [];
const modelTimes: number[] = [];
for (let index = 0; index < iterations; index += 1) {
  const now = 1_001 + index;
  const next = event("BOOK_DELTA", index + 2, now, [[100, 3 + (index % 7) / 10]], [[100.1, 3 + (index % 5) / 10]]);
  let started = performance.now();
  const mutation = book.apply(next);
  bookTimes.push(performance.now() - started);
  started = performance.now();
  features.observeBook(next, mutation, book.view(now));
  const snapshot = features.snapshot(book.view(now), now)!;
  featureTimes.push(performance.now() - started);
  started = performance.now();
  directionModel(snapshot, config);
  modelTimes.push(performance.now() - started);
}
const result = { iterations, orderBookMs: stats(bookTimes), featureMs: stats(featureTimes), modelMs: stats(modelTimes) };
console.log(JSON.stringify(result, null, 2));
if (result.orderBookMs.p99 >= 2 || result.featureMs.p99 >= 3 || result.modelMs.p99 >= 2) process.exitCode = 1;

function event(type: "BOOK_SNAPSHOT" | "BOOK_DELTA", update: number, time: number, bids: number[][], asks: number[][]): QalcMarketEvent {
  return { id: `bench-${update}`, venue: "BYBIT", category: "linear", symbol: "BTCUSDT", eventType: type, exchangeTimestamp: time, receiveTimestamp: time, processTimestamp: time, sequence: String(update), updateId: String(update), payloadVersion: 1, payload: { bids, asks, updateId: String(update), crossSequence: String(update), systemTimestamp: time, depth: 200 } as any };
}
function stats(values: number[]) { const sorted = [...values].sort((a, b) => a - b); return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), max: sorted.at(-1) || 0 }; }
function percentile(sorted: number[], value: number) { return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] || 0; }
