import type { BlackCoreDepthReplayPoint } from "./marketDepthMemoryClient";
import type { MacroLiquidityRange } from "./types";

type PendingRequest = {
  resolve: (points: BlackCoreDepthReplayPoint[]) => void;
  reject: (error: Error) => void;
  timeout: number;
};

let worker: Worker | null = null;
const pending = new Map<string, PendingRequest>();

export async function shapeBlackCoreReplayPoints(
  points: BlackCoreDepthReplayPoint[],
  range: MacroLiquidityRange,
  maxPoints = 360
): Promise<BlackCoreDepthReplayPoint[]> {
  if (typeof Worker === "undefined") return shapeOnMainThread(points, range, maxPoints);
  try {
    const instance = ensureWorker();
    const id = crypto.randomUUID?.() ?? `${Date.now()}:${Math.random()}`;
    return await new Promise<BlackCoreDepthReplayPoint[]>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pending.delete(id);
        resolve(shapeOnMainThread(points, range, maxPoints));
      }, 1500);
      pending.set(id, { resolve, reject, timeout });
      instance.postMessage({
        id,
        type: "shape-depth-replay",
        points,
        range: { min: range.min, max: range.max },
        maxPoints
      });
    });
  } catch {
    return shapeOnMainThread(points, range, maxPoints);
  }
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./immAggregationWorker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<{ id: string; type: string; points?: BlackCoreDepthReplayPoint[]; error?: string }>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    window.clearTimeout(request.timeout);
    pending.delete(event.data.id);
    if (event.data.type === "error") {
      request.reject(new Error(event.data.error || "IMM worker failed."));
      return;
    }
    request.resolve(event.data.points || []);
  };
  worker.onerror = (event) => {
    for (const [id, request] of pending.entries()) {
      window.clearTimeout(request.timeout);
      pending.delete(id);
      request.reject(new Error(event.message || "IMM worker error."));
    }
    worker?.terminate();
    worker = null;
  };
  return worker;
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
