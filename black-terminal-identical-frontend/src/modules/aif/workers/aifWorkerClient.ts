import type { AifCalculationRequest, AifRenderModel } from "../core/aifTypes";
import { AifBoundedCache } from "../state/aifCache";
import { domInteractionCoordinator } from "../../dom-pro/domInteractionCoordinator";

type Pending = { generation: number; sourceVersion: string; resolve: (result: AifRenderModel | null) => void; reject: (error: Error) => void };

export class AifWorkerClient {
  private worker: Worker | null = null;
  private generation = 0;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private cache = new AifBoundedCache<AifRenderModel>(8);

  async calculate(input: Omit<AifCalculationRequest, "id" | "generation">) {
    if (domInteractionCoordinator.isActive()) await waitForDomInteraction();
    return this.calculateNow(input);
  }

  private calculateNow(input: Omit<AifCalculationRequest, "id" | "generation">) {
    const key = cacheKey(input);
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve({ ...cached, cacheState: "hit" } as AifRenderModel);
    this.generation += 1;
    const generation = this.generation;
    for (const [id, pending] of this.pending) {
      if (pending.generation < generation) { pending.resolve(null); this.pending.delete(id); }
    }
    const request = { ...input, id: ++this.sequence, generation };
    return new Promise<AifRenderModel | null>((resolve, reject) => {
      this.pending.set(request.id, { generation, sourceVersion: request.sourceVersion, resolve, reject });
      const worker = this.ensureWorker();
      worker.postMessage(request);
      const originalResolve = resolve;
      this.pending.set(request.id, { generation, sourceVersion: request.sourceVersion, reject, resolve: (result) => { if (result) this.cache.set(key, result); originalResolve(result); } });
    });
  }

  dispose() {
    this.generation += 1;
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.pending.values()) pending.resolve(null);
    this.pending.clear();
    this.cache.clear();
  }

  private ensureWorker() {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL("./aifWorker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<{ id: number; generation: number; sourceVersion: string; ok: boolean; result?: AifRenderModel; error?: string }>) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      if (event.data.generation !== this.generation || event.data.sourceVersion !== pending.sourceVersion) { pending.resolve(null); return; }
      if (!event.data.ok || !event.data.result) pending.reject(new Error(event.data.error || "A.I.F. calculation failed"));
      else pending.resolve(event.data.result);
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "A.I.F. worker failed");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
    };
    return this.worker;
  }
}

async function waitForDomInteraction() {
  const startedAt = Date.now();
  while (domInteractionCoordinator.isActive() && Date.now() - startedAt < 1200) {
    await new Promise((resolve) => window.setTimeout(resolve, 80));
  }
}

function cacheKey(input: Omit<AifCalculationRequest, "id" | "generation">) {
  const first = input.candles[0]?.time ?? 0;
  const last = input.candles.at(-1)?.time ?? 0;
  return `aif-engine/1.1.0:profiles/1.1.0:${input.marketSymbol.exchange}:${input.marketSymbol.rawSymbol}:${input.marketSymbol.marketKind}:${input.timeframe}:${first}:${last}:${input.candles.length}:${input.sourceVersion}:${JSON.stringify(input.settings)}`;
}
