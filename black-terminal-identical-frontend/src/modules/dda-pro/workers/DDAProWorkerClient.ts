import type { DDAProCalculationInput, DDAProSnapshot } from "../core/types.ts";
import type { DDAProWorkerRequest, DDAProWorkerResponse } from "./protocol.ts";
import { DDAProWorkerRuntime } from "./runtime.ts";
import { blackCoreResourceTracker } from "../../../performance/resourceTracker.ts";

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
  private unavailable = false;
  private startupError: Error | null = null;
  private releaseWorkerResource: () => void = () => undefined;
  private readonly allowDevelopmentInlineFallback: boolean;
  private readonly developmentInlineBarLimit: number;
  private lastCalculationMs: number | null = null;

  constructor(
    factory: () => WorkerLike = () => new Worker(new URL("./ddaPro.worker.ts", import.meta.url), { type: "module", name: "black-core-dda-pro" }),
    options: { allowDevelopmentInlineFallback?: boolean; developmentInlineBarLimit?: number } = {}
  ) {
    this.allowDevelopmentInlineFallback = options.allowDevelopmentInlineFallback === true;
    this.developmentInlineBarLimit = Math.max(1, Math.min(2_000, options.developmentInlineBarLimit ?? 1_000));
    try {
      this.worker = factory();
      this.releaseWorkerResource = blackCoreResourceTracker.acquire("worker", "bc-rda-calculation");
    } catch (error) {
      this.startupError = error instanceof Error ? error : new Error(String(error));
      this.unavailable = true;
      this.worker = this.unavailableWorker();
    }
    this.attach();
  }

  private unavailableWorker(): WorkerLike {
    return { onmessage: null, onerror: null, postMessage: () => { throw new Error("DDA_PRO_WORKER_UNAVAILABLE"); }, terminate: () => undefined };
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
    this.worker.onerror = (event) => this.failWorker(new Error(event.message || "BC-RDA worker failed."));
  }

  private failWorker(error: Error) {
    if (this.disposed) return;
    const mayUseBoundedDevelopmentFallback = this.allowDevelopmentInlineFallback &&
      [...this.pending.values()].every((pending) => pending.request.type !== "CALCULATE" || pending.request.input.candles.length <= this.developmentInlineBarLimit);
    this.worker.terminate();
    this.releaseWorkerResource();
    if (mayUseBoundedDevelopmentFallback) {
      this.worker = new InlineDDAProWorker();
      this.inline = true;
      this.unavailable = false;
      this.attach();
      for (const pending of this.pending.values()) this.worker.postMessage(pending.request);
      return;
    }
    this.unavailable = true;
    this.startupError = error;
    this.worker = this.unavailableWorker();
    this.attach();
    for (const pending of this.pending.values()) pending.reject(new Error("DDA_PRO_WORKER_UNAVAILABLE"));
    this.pending.clear();
  }

  calculate(input: DDAProCalculationInput) {
    if (this.disposed) return Promise.reject(new Error("BC-RDA worker client is disposed."));
    if (this.unavailable) {
      if (this.allowDevelopmentInlineFallback && input.candles.length <= this.developmentInlineBarLimit) {
        this.worker = new InlineDDAProWorker();
        this.inline = true;
        this.unavailable = false;
        this.attach();
      } else {
        return Promise.reject(new Error(`DDA_PRO_WORKER_UNAVAILABLE${this.startupError ? ": STARTUP" : ""}`));
      }
    }
    this.generation += 1;
    for (const pending of this.pending.values()) pending.reject(new Error("DDA_PRO_STALE_GENERATION"));
    this.pending.clear();
    const requestId = `dda:${this.generation}:${this.sequence++}`;
    const request: DDAProWorkerRequest = { protocolVersion: 1, type: "CALCULATE", requestId, generation: this.generation, input };
    return new Promise<DDAProSnapshot>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, generation: this.generation, request });
      try { this.worker.postMessage(request); }
      catch (error) { this.failWorker(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  executionMode() { return this.unavailable ? "UNAVAILABLE" as const : this.inline ? "INLINE" as const : "WORKER" as const; }
  failureCode() { return this.unavailable ? "DDA_PRO_WORKER_UNAVAILABLE" as const : null; }
  lastCalculationTimeMs() { return this.lastCalculationMs; }

  dispose() {
    this.disposed = true;
    this.worker.terminate();
    this.releaseWorkerResource();
    for (const pending of this.pending.values()) pending.reject(new Error("BC-RDA worker client disposed."));
    this.pending.clear();
  }
}
