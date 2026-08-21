import type { BCTERAFeatureBar, BCTERASettings, BCTERASnapshot } from "../core/types.ts";
import type { BCTERAWorkerRequest, BCTERAWorkerResponse } from "./protocol.ts";
import { BCTERAWorkerRuntime } from "./runtime.ts";

type WorkerLike = {
  onmessage: ((event: MessageEvent<BCTERAWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: BCTERAWorkerRequest): void;
  terminate(): void;
};

class InlineBCTERAWorker implements WorkerLike {
  onmessage: WorkerLike["onmessage"] = null;
  onerror: WorkerLike["onerror"] = null;
  private terminated = false;
  private runtime = new BCTERAWorkerRuntime((message) => queueMicrotask(() => {
    if (!this.terminated) this.onmessage?.({ data: message } as MessageEvent<BCTERAWorkerResponse>);
  }));
  postMessage(message: BCTERAWorkerRequest) {
    globalThis.setTimeout(() => { if (!this.terminated) this.runtime.handle(message); }, 0);
  }
  terminate() { this.terminated = true; }
}

type Pending = {
  resolve: (snapshot: BCTERASnapshot) => void;
  reject: (error: Error) => void;
  generation: number;
  request: BCTERAWorkerRequest;
};

export class BCTERAWorkerClient {
  private worker: WorkerLike;
  private pending = new Map<string, Pending>();
  private generation = 0;
  private sequence = 0;
  private disposed = false;
  private inline = false;
  private calculationMs: number | null = null;

  constructor(factory: () => WorkerLike = () => new Worker(
    new URL("./bcTera.worker.ts", import.meta.url),
    { type: "module", name: "black-core-bc-tera" }
  )) {
    try { this.worker = factory(); }
    catch { this.worker = new InlineBCTERAWorker(); this.inline = true; }
    this.attach();
  }

  private attach() {
    this.worker.onmessage = (event) => {
      const response = event.data;
      const pending = this.pending.get(response.requestId);
      if (!pending) return;
      this.pending.delete(response.requestId);
      if (response.generation !== pending.generation || response.generation !== this.generation) {
        pending.reject(new Error("BC_TERA_STALE_GENERATION"));
      } else if (response.type === "ERROR") {
        pending.reject(new Error(`${response.code}: ${response.message}`));
      } else {
        this.calculationMs = response.calculationMs;
        pending.resolve(response.snapshot);
      }
    };
    this.worker.onerror = (event) => this.fallback(new Error(event.message || "BC-TERA worker failed."));
  }

  private fallback(error: Error) {
    if (this.disposed) return;
    if (this.inline) {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      return;
    }
    this.worker.terminate();
    this.worker = new InlineBCTERAWorker();
    this.inline = true;
    this.attach();
    for (const pending of this.pending.values()) this.worker.postMessage(pending.request);
  }

  calculate(bars: BCTERAFeatureBar[], settings: Partial<BCTERASettings>) {
    if (this.disposed) return Promise.reject(new Error("BC-TERA worker client is disposed."));
    this.generation += 1;
    for (const pending of this.pending.values()) pending.reject(new Error("BC_TERA_STALE_GENERATION"));
    this.pending.clear();
    const requestId = `bc-tera:${this.generation}:${this.sequence++}`;
    const request: BCTERAWorkerRequest = {
      protocolVersion: 1,
      type: "CALCULATE",
      requestId,
      generation: this.generation,
      bars: bars.slice(-2_000),
      settings
    };
    return new Promise<BCTERASnapshot>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, generation: this.generation, request });
      try { this.worker.postMessage(request); }
      catch (error) { this.fallback(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  executionMode() { return this.inline ? "INLINE" as const : "WORKER" as const; }
  lastCalculationTimeMs() { return this.calculationMs; }
  dispose() {
    this.disposed = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error("BC-TERA worker client disposed."));
    this.pending.clear();
  }
}
