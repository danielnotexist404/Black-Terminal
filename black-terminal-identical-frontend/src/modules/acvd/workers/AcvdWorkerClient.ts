import type { AcvdCalculationInput, AcvdSnapshot } from "../core/types.ts";
import type { AcvdWorkerRequest, AcvdWorkerResponse } from "./protocol.ts";
import { AcvdWorkerRuntime } from "./runtime.ts";

type WorkerLike = {
  onmessage: ((event: MessageEvent<AcvdWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: AcvdWorkerRequest): void;
  terminate(): void;
};

class InlineAcvdWorker implements WorkerLike {
  onmessage: WorkerLike["onmessage"] = null;
  onerror: WorkerLike["onerror"] = null;
  private terminated = false;
  private runtime = new AcvdWorkerRuntime((message) => queueMicrotask(() => {
    if (!this.terminated) this.onmessage?.({ data: message } as MessageEvent<AcvdWorkerResponse>);
  }));
  postMessage(message: AcvdWorkerRequest) {
    globalThis.setTimeout(() => {
      if (!this.terminated) this.runtime.handle(message);
    }, 0);
  }
  terminate() { this.terminated = true; }
}

type Pending = {
  resolve: (snapshot: AcvdSnapshot) => void;
  reject: (error: Error) => void;
  generation: number;
  request: AcvdWorkerRequest;
};

export class AcvdWorkerClient {
  private worker: WorkerLike;
  private pending = new Map<string, Pending>();
  private generation = 0;
  private sequence = 0;
  private disposed = false;
  private inline = false;
  private calculationMs: number | null = null;

  constructor(factory: () => WorkerLike = () => new Worker(new URL("./acvd.worker.ts", import.meta.url), { type: "module", name: "black-core-acvd" })) {
    try { this.worker = factory(); }
    catch { this.worker = new InlineAcvdWorker(); this.inline = true; }
    this.attach();
  }

  private attach() {
    this.worker.onmessage = (event) => {
      const response = event.data;
      const pending = this.pending.get(response.requestId);
      if (!pending) return;
      this.pending.delete(response.requestId);
      if (response.generation !== pending.generation || response.generation !== this.generation) {
        pending.reject(new Error("ACVD_STALE_GENERATION"));
      } else if (response.type === "ERROR") {
        pending.reject(new Error(`${response.code}: ${response.message}`));
      } else {
        this.calculationMs = response.calculationMs;
        pending.resolve(response.snapshot);
      }
    };
    this.worker.onerror = (event) => this.fallback(new Error(event.message || "BC-ACVD worker failed."));
  }

  private fallback(error: Error) {
    if (this.disposed) return;
    if (this.inline) {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      return;
    }
    this.worker.terminate();
    this.worker = new InlineAcvdWorker();
    this.inline = true;
    this.attach();
    for (const pending of this.pending.values()) this.worker.postMessage(pending.request);
  }

  calculate(input: AcvdCalculationInput) {
    if (this.disposed) return Promise.reject(new Error("BC-ACVD worker client is disposed."));
    this.generation += 1;
    for (const pending of this.pending.values()) pending.reject(new Error("ACVD_STALE_GENERATION"));
    this.pending.clear();
    const requestId = `acvd:${this.generation}:${this.sequence++}`;
    const request: AcvdWorkerRequest = { protocolVersion: 1, type: "CALCULATE", requestId, generation: this.generation, input };
    return new Promise<AcvdSnapshot>((resolve, reject) => {
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
    for (const pending of this.pending.values()) pending.reject(new Error("BC-ACVD worker client disposed."));
    this.pending.clear();
  }
}
