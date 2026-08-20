import type { DDAProCalculationInput, DDAProSnapshot } from "../core/types.ts";
import type { DDAProWorkerRequest, DDAProWorkerResponse } from "./protocol.ts";
import { DDAProWorkerRuntime } from "./runtime.ts";

type WorkerLike = {
  onmessage: ((event: MessageEvent<DDAProWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: DDAProWorkerRequest): void;
  terminate(): void;
};

class InlineDDAProWorker implements WorkerLike {
  onmessage: WorkerLike["onmessage"] = null;
  onerror: WorkerLike["onerror"] = null;
  private terminated = false;
  private runtime = new DDAProWorkerRuntime((message) => queueMicrotask(() => {
    if (!this.terminated) this.onmessage?.({ data: message } as MessageEvent<DDAProWorkerResponse>);
  }));
  postMessage(message: DDAProWorkerRequest) {
    globalThis.setTimeout(() => {
      if (!this.terminated) this.runtime.handle(message);
    }, 0);
  }
  terminate() { this.terminated = true; }
}

type Pending = {
  resolve: (snapshot: DDAProSnapshot) => void;
  reject: (error: Error) => void;
  generation: number;
  request: DDAProWorkerRequest;
};

export class DDAProWorkerClient {
  private worker: WorkerLike;
  private pending = new Map<string, Pending>();
  private generation = 0;
  private sequence = 0;
  private disposed = false;
  private inline = false;
  private lastCalculationMs: number | null = null;

  constructor(factory: () => WorkerLike = () => new Worker(new URL("./ddaPro.worker.ts", import.meta.url), { type: "module", name: "black-core-dda-pro" })) {
    try {
      this.worker = factory();
    } catch {
      this.worker = new InlineDDAProWorker();
      this.inline = true;
    }
    this.attach();
  }

  private attach() {
    this.worker.onmessage = (event) => {
      const response = event.data;
      const pending = this.pending.get(response.requestId);
      if (!pending) return;
      this.pending.delete(response.requestId);
      if (response.generation !== pending.generation || response.generation !== this.generation) {
        pending.reject(new Error("DDA_PRO_STALE_GENERATION"));
      } else if (response.type === "ERROR") {
        pending.reject(new Error(`${response.code}: ${response.message}`));
      } else if (response.type === "RESULT") {
        this.lastCalculationMs = response.calculationMs;
        pending.resolve(response.snapshot);
      } else {
        pending.reject(new Error("DDA_PRO_UNEXPECTED_ACK"));
      }
    };
    this.worker.onerror = (event) => this.fallback(new Error(event.message || "BC-RDA worker failed."));
  }

  private fallback(error: Error) {
    if (this.disposed) return;
    if (this.inline) {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      return;
    }
    this.worker.terminate();
    this.worker = new InlineDDAProWorker();
    this.inline = true;
    this.attach();
    for (const pending of this.pending.values()) this.worker.postMessage(pending.request);
  }

  calculate(input: DDAProCalculationInput) {
    if (this.disposed) return Promise.reject(new Error("BC-RDA worker client is disposed."));
    this.generation += 1;
    for (const pending of this.pending.values()) pending.reject(new Error("DDA_PRO_STALE_GENERATION"));
    this.pending.clear();
    const requestId = `dda:${this.generation}:${this.sequence++}`;
    const request: DDAProWorkerRequest = { protocolVersion: 1, type: "CALCULATE", requestId, generation: this.generation, input };
    return new Promise<DDAProSnapshot>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, generation: this.generation, request });
      try { this.worker.postMessage(request); }
      catch (error) { this.fallback(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  executionMode() { return this.inline ? "INLINE" as const : "WORKER" as const; }
  lastCalculationTimeMs() { return this.lastCalculationMs; }

  dispose() {
    this.disposed = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error("BC-RDA worker client disposed."));
    this.pending.clear();
  }
}
