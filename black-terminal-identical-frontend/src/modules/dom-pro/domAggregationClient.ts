import { blackCorePerformanceMonitor } from "../../performance/performanceMonitor";
import { blackCoreResourceTracker } from "../../performance/resourceTracker";
import { DomAggregationEngine, type DomAggregationInput } from "./domAggregationEngine";
import type { AggregatedDomSnapshot } from "./types";
import { domPerformanceTrace } from "./domPerformanceTrace";

type Pending = {
  id: string;
  key: string;
  version: number;
  startedAt: number;
  timeout: number | null;
  posted: boolean;
  fallback: DomAggregationEngine;
  input: DomAggregationInput;
  inputBytes: number;
  resolve: (snapshot: AggregatedDomSnapshot | null) => void;
};

let worker: Worker | null = null;
let releaseWorker: (() => void) | null = null;
let idleTimer: number | null = null;
let version = 0;
let dropped = 0;
let submitted = 0;
let processed = 0;
let coalesced = 0;
let stale = 0;
let queuePeak = 0;
let transferredInputUnits = 0;
let transferredOutputUnits = 0;
let transferredInputBytes = 0;
const pending = new Map<string, Pending>();
const latestByKey = new Map<string, number>();
const heatmapByKey = new Map<string, AggregatedDomSnapshot["heatmap"]>();

export function aggregateDomSnapshot(input: DomAggregationInput, fallback: DomAggregationEngine) {
  if (typeof Worker === "undefined") return Promise.resolve(fallback.aggregate(input));
  const key = [input.marketSymbol.exchange, input.marketSymbol.marketKind, input.marketSymbol.rawSymbol].join(":");
  const requestVersion = ++version;
  submitted += 1;
  latestByKey.set(key, requestVersion);
  for (const [id, request] of pending) {
    if (request.key !== key || request.posted) continue;
    if (request.timeout !== null) window.clearTimeout(request.timeout);
    pending.delete(id);
    request.resolve(null);
    dropped += 1;
    coalesced += 1;
  }
  const id = crypto.randomUUID?.() ?? `${Date.now()}:${Math.random()}`;
  return new Promise<AggregatedDomSnapshot | null>((resolve) => {
    pending.set(id, { id, key, version: requestVersion, startedAt: performance.now(), timeout: null, posted: false, fallback, input, inputBytes: 0, resolve });
    updateMetrics();
    dispatchNext();
  });
}

export function shutdownDomAggregationWorker() {
  if (idleTimer !== null) window.clearTimeout(idleTimer);
  idleTimer = null;
  for (const [id, request] of pending) {
    if (request.timeout !== null) window.clearTimeout(request.timeout);
    pending.delete(id);
    request.resolve(null);
  }
  worker?.terminate();
  worker = null;
  releaseWorker?.();
  releaseWorker = null;
  updateMetrics();
}

function ensureWorker() {
  if (idleTimer !== null) window.clearTimeout(idleTimer);
  idleTimer = null;
  if (worker) return worker;
  worker = new Worker(new URL("./domAggregationWorker.ts", import.meta.url), { type: "module" });
  releaseWorker = blackCoreResourceTracker.acquire("worker", "dom-pro-live-aggregation");
  worker.onmessage = (event: MessageEvent<{ id: string; version: number; type: string; snapshot?: AggregatedDomSnapshot; metrics?: { processingMs: number; inputUnits?: number; outputUnits?: number } }>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    if (request.timeout !== null) window.clearTimeout(request.timeout);
    pending.delete(event.data.id);
    updateMetrics();
    const current = latestByKey.get(request.key) === request.version && event.data.version === request.version;
    const resolved = current && event.data.type === "done" && event.data.snapshot
      ? materializeSnapshot(request.key, event.data.snapshot, request.input)
      : null;
    if (!current) stale += 1;
    if (resolved) processed += 1;
    request.resolve(resolved);
    transferredInputUnits += event.data.metrics?.inputUnits ?? 0;
    transferredOutputUnits += event.data.metrics?.outputUnits ?? 0;
    blackCorePerformanceMonitor.recordMetric("worker.dom_aggregation_ms", event.data.metrics?.processingMs ?? performance.now() - request.startedAt, "ms");
    domPerformanceTrace.record("worker.aggregate", event.data.metrics?.processingMs ?? performance.now() - request.startedAt, event.data.metrics?.inputUnits, event.data.metrics?.outputUnits);
    domPerformanceTrace.record("worker.transfer_roundtrip", Math.max(0, performance.now() - request.startedAt - (event.data.metrics?.processingMs ?? 0)), request.inputBytes, event.data.metrics?.outputUnits ?? 0);
    for (const [name, trace] of Object.entries(event.data.snapshot?.trace ?? {})) domPerformanceTrace.record(`worker.${name}`, trace.durationMs, trace.inputSize, trace.outputSize);
    dispatchNext();
    scheduleIdleShutdown();
  };
  worker.onerror = () => shutdownDomAggregationWorker();
  return worker;
}

function dispatchNext() {
  if ([...pending.values()].some((request) => request.posted)) return;
  const queued = [...pending.values()].filter((request) => !request.posted).sort((a, b) => b.version - a.version);
  const next = queued.shift();
  for (const obsolete of queued) {
    pending.delete(obsolete.id);
    obsolete.resolve(null);
    dropped += 1;
    coalesced += 1;
  }
  if (!next) {
    updateMetrics();
    return;
  }
  next.posted = true;
  queuePeak = Math.max(queuePeak, pending.size);
  next.startedAt = performance.now();
  next.timeout = window.setTimeout(() => {
    pending.delete(next.id);
    if (latestByKey.get(next.key) === next.version) next.resolve(next.fallback.aggregate(next.input));
    else next.resolve(null);
    dropped += 1;
    updateMetrics();
    shutdownDomAggregationWorker();
    dispatchNext();
  }, 1200);
  const compactBook = packOrderBook(next.input.book);
  const input = compactBook ? { ...next.input, book: null } : next.input;
  const transfer = compactBook ? [compactBook.bids.buffer, compactBook.asks.buffer] : [];
  next.inputBytes = compactBook ? compactBook.bids.byteLength + compactBook.asks.byteLength : 0;
  transferredInputBytes += next.inputBytes;
  ensureWorker().postMessage({ id: next.id, version: next.version, key: next.key, input, compactBook }, transfer);
  updateMetrics();
}

function scheduleIdleShutdown() {
  if (pending.size) return;
  if (idleTimer !== null) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => shutdownDomAggregationWorker(), 30_000);
}

function updateMetrics() {
  blackCoreResourceTracker.setGauge("worker-queue", "dom-pro-live-aggregation", pending.size);
  blackCorePerformanceMonitor.recordMetric("worker.dom_queue_depth", pending.size, "count");
  blackCorePerformanceMonitor.recordMetric("worker.dom_frames_dropped", dropped, "count");
  domPerformanceTrace.setCounter("worker.submitted", submitted);
  domPerformanceTrace.setCounter("worker.processed", processed);
  domPerformanceTrace.setCounter("worker.coalesced", coalesced);
  domPerformanceTrace.setCounter("worker.dropped", dropped);
  domPerformanceTrace.setCounter("worker.stale", stale);
  domPerformanceTrace.setCounter("worker.queue_peak", queuePeak);
  domPerformanceTrace.setCounter("worker.transfer_input_units", transferredInputUnits);
  domPerformanceTrace.setCounter("worker.transfer_output_units", transferredOutputUnits);
  domPerformanceTrace.setCounter("worker.transfer_input_bytes", transferredInputBytes);
  blackCorePerformanceMonitor.recordMetric("worker.dom_queue_peak", queuePeak, "count");
  blackCorePerformanceMonitor.recordMetric("worker.dom_transfer_input_units", transferredInputUnits, "count");
  blackCorePerformanceMonitor.recordMetric("worker.dom_transfer_output_units", transferredOutputUnits, "count");
}

function materializeSnapshot(key: string, snapshot: AggregatedDomSnapshot, input: DomAggregationInput) {
  if (snapshot.transport?.heatmapMode !== "delta") return snapshot;
  const history = heatmapByKey.get(key) ?? [];
  const frame = snapshot.heatmap[0];
  if (frame) {
    const latest = history.at(-1);
    if (latest?.time === frame.time) history[history.length - 1] = frame;
    else history.push(frame);
    const limit = Math.max(1, snapshot.transport.heatmapMaxFrames);
    if (history.length > limit) history.splice(0, history.length - limit);
  }
  heatmapByKey.set(key, history);
  while (heatmapByKey.size > 8) heatmapByKey.delete(heatmapByKey.keys().next().value!);
  return { ...snapshot, sourceBook: input.book, ticker: input.ticker, trades: input.trades, heatmap: history.slice() };
}

function packOrderBook(book: DomAggregationInput["book"]) {
  if (!book) return null;
  const bids = new Float64Array(book.bids.length * 2);
  const asks = new Float64Array(book.asks.length * 2);
  for (let index = 0; index < book.bids.length; index += 1) {
    bids[index * 2] = book.bids[index].price;
    bids[index * 2 + 1] = book.bids[index].quantity;
  }
  for (let index = 0; index < book.asks.length; index += 1) {
    asks[index * 2] = book.asks[index].price;
    asks[index * 2 + 1] = book.asks[index].quantity;
  }
  return { exchange: book.exchange, symbol: book.symbol, time: book.time, bids, asks };
}
