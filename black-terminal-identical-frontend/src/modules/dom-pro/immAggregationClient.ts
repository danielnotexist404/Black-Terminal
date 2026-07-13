import { blackCorePerformanceMonitor } from "../../performance/performanceMonitor";
import { blackCoreResourceTracker } from "../../performance/resourceTracker";
import type { BlackCoreDepthReplayPoint } from "./marketDepthMemoryClient";
import type { MacroLiquidityRange } from "./types";

type PendingRequest = {
  version: number;
  resolve: (points: BlackCoreDepthReplayPoint[]) => void;
  timeout: number;
  startedAt: number;
};

let worker: Worker | null = null;
let releaseWorker: (() => void) | null = null;
let idleTimer: number | null = null;
let version = 0;
let coalescedTasks = 0;
const pending = new Map<string, PendingRequest>();
const maxPendingVisualTasks = 2;

export async function shapeBlackCoreReplayPoints(
  points: BlackCoreDepthReplayPoint[],
  range: MacroLiquidityRange,
  maxPoints = 360
): Promise<BlackCoreDepthReplayPoint[]> {
  if (typeof Worker === "undefined") return shapeOnMainThread(points, range, maxPoints);
  const requestVersion = ++version;
  coalesceObsoleteTasks(requestVersion);
  try {
    const instance = ensureWorker();
    const id = crypto.randomUUID?.() ?? `${Date.now()}:${Math.random()}`;
    return await new Promise<BlackCoreDepthReplayPoint[]>((resolve) => {
      const startedAt = performance.now();
      const timeout = window.setTimeout(() => {
        pending.delete(id);
        updateQueueMetric();
        scheduleIdleShutdown();
        resolve(requestVersion === version ? shapeOnMainThread(points, range, maxPoints) : []);
      }, 1500);
      pending.set(id, { version: requestVersion, resolve, timeout, startedAt });
      updateQueueMetric();
      instance.postMessage({
        requestId: id,
        id,
        taskType: "shape-depth-replay",
        type: "shape-depth-replay",
        version: requestVersion,
        startedAt: Date.now(),
        points,
        range: { min: range.min, max: range.max },
        maxPoints
      });
    });
  } catch {
    return requestVersion === version ? shapeOnMainThread(points, range, maxPoints) : [];
  }
}

export function immWorkerDiagnostics() {
  return { running: Boolean(worker), queueDepth: pending.size, version, coalescedTasks };
}

export function shutdownImmAggregationWorker() {
  if (idleTimer !== null) window.clearTimeout(idleTimer);
  idleTimer = null;
  for (const [id, request] of pending) {
    window.clearTimeout(request.timeout);
    pending.delete(id);
    request.resolve([]);
  }
  worker?.terminate();
  worker = null;
  releaseWorker?.();
  releaseWorker = null;
  updateQueueMetric();
}

function ensureWorker() {
  if (idleTimer !== null) window.clearTimeout(idleTimer);
  idleTimer = null;
  if (worker) return worker;
  worker = new Worker(new URL("./immAggregationWorker.ts", import.meta.url), { type: "module" });
  releaseWorker = blackCoreResourceTracker.acquire("worker", "dom-pro-imm-aggregation");
  worker.onmessage = (event: MessageEvent<{ id: string; version?: number; type: string; points?: BlackCoreDepthReplayPoint[]; metrics?: { processingMs?: number }; error?: string }>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    window.clearTimeout(request.timeout);
    pending.delete(event.data.id);
    updateQueueMetric();
    const stale = request.version !== version || (event.data.version !== undefined && event.data.version !== request.version);
    if (!stale && event.data.type !== "error") request.resolve(event.data.points || []);
    else request.resolve([]);
    blackCorePerformanceMonitor.recordMetric("worker.imm_processing_ms", event.data.metrics?.processingMs ?? performance.now() - request.startedAt, "ms");
    scheduleIdleShutdown();
  };
  worker.onerror = () => shutdownImmAggregationWorker();
  return worker;
}

function coalesceObsoleteTasks(nextVersion: number) {
  const obsolete = [...pending.entries()].filter(([, request]) => request.version < nextVersion);
  const removeCount = Math.max(0, pending.size - maxPendingVisualTasks + 1);
  for (const [id, request] of obsolete.slice(0, Math.max(removeCount, obsolete.length))) {
    window.clearTimeout(request.timeout);
    pending.delete(id);
    request.resolve([]);
    coalescedTasks += 1;
  }
  updateQueueMetric();
}

function scheduleIdleShutdown() {
  if (pending.size || typeof window === "undefined") return;
  if (idleTimer !== null) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => shutdownImmAggregationWorker(), 30_000);
}

function updateQueueMetric() {
  blackCoreResourceTracker.setGauge("worker-queue", "dom-pro-imm-aggregation", pending.size);
  blackCorePerformanceMonitor.recordMetric("worker.imm_queue_depth", pending.size, "count");
  blackCorePerformanceMonitor.recordMetric("worker.imm_coalesced", coalescedTasks, "count");
}

function shapeOnMainThread(points: BlackCoreDepthReplayPoint[], range: MacroLiquidityRange, maxPoints: number) {
  const now = Date.now();
  const inside = points
    .filter((point) => Number.isFinite(point.price) && point.price >= range.min && point.price <= range.max)
    .sort((a, b) => scorePoint(b, now) - scorePoint(a, now));
  const perSide = Math.max(10, Math.floor(maxPoints / 2));
  const bids = inside.filter((point) => point.side === "bid").slice(0, perSide);
  const asks = inside.filter((point) => point.side === "ask").slice(0, perSide);
  const used = new Set([...bids, ...asks].map((point) => point.id));
  return [...bids, ...asks, ...inside.filter((point) => !used.has(point.id)).slice(0, maxPoints - bids.length - asks.length)]
    .sort((a, b) => b.price - a.price);
}

function scorePoint(point: BlackCoreDepthReplayPoint, now: number) {
  const ageHours = Math.max(0, (now - point.lastSeen) / 3600000);
  const persistenceHours = Math.max(0.1, (point.lastSeen - point.firstSeen) / 3600000);
  return point.strength * (1 + Math.log1p(point.observations) * 0.2 + Math.min(0.45, persistenceHours * 0.03)) / (1 + ageHours / 96);
}
