import { blackCorePerformanceMonitor } from "../../performance/performanceMonitor";
import { blackCoreResourceTracker } from "../../performance/resourceTracker";
import { DomAggregationEngine, type DomAggregationInput } from "./domAggregationEngine";
import type { AggregatedDomSnapshot } from "./types";

type Pending = {
  id: string;
  key: string;
  version: number;
  startedAt: number;
  timeout: number | null;
  posted: boolean;
  fallback: DomAggregationEngine;
  input: DomAggregationInput;
  resolve: (snapshot: AggregatedDomSnapshot | null) => void;
};

let worker: Worker | null = null;
let releaseWorker: (() => void) | null = null;
let idleTimer: number | null = null;
let version = 0;
let dropped = 0;
const pending = new Map<string, Pending>();
const latestByKey = new Map<string, number>();

export function aggregateDomSnapshot(input: DomAggregationInput, fallback: DomAggregationEngine) {
  if (typeof Worker === "undefined") return Promise.resolve(fallback.aggregate(input));
  const key = [input.marketSymbol.exchange, input.marketSymbol.marketKind, input.marketSymbol.rawSymbol].join(":");
  const requestVersion = ++version;
  latestByKey.set(key, requestVersion);
  for (const [id, request] of pending) {
    if (request.key !== key || request.posted) continue;
    if (request.timeout !== null) window.clearTimeout(request.timeout);
    pending.delete(id);
    request.resolve(null);
    dropped += 1;
  }
  const id = crypto.randomUUID?.() ?? `${Date.now()}:${Math.random()}`;
  return new Promise<AggregatedDomSnapshot | null>((resolve) => {
    pending.set(id, { id, key, version: requestVersion, startedAt: performance.now(), timeout: null, posted: false, fallback, input, resolve });
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
  worker.onmessage = (event: MessageEvent<{ id: string; version: number; type: string; snapshot?: AggregatedDomSnapshot; metrics?: { processingMs: number } }>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    if (request.timeout !== null) window.clearTimeout(request.timeout);
    pending.delete(event.data.id);
    updateMetrics();
    const current = latestByKey.get(request.key) === request.version && event.data.version === request.version;
    request.resolve(current && event.data.type === "done" ? event.data.snapshot ?? null : null);
    blackCorePerformanceMonitor.recordMetric("worker.dom_aggregation_ms", event.data.metrics?.processingMs ?? performance.now() - request.startedAt, "ms");
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
  }
  if (!next) {
    updateMetrics();
    return;
  }
  next.posted = true;
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
  ensureWorker().postMessage({ id: next.id, version: next.version, key: next.key, input: next.input });
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
}
