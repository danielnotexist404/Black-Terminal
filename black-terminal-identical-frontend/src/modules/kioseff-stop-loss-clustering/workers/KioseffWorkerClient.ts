import { KIOSEFF_ENGINE_VERSION, type KioseffSnapshot } from "../core/canonical.ts";
import type { KioseffEngineContext } from "../core/engineTypes.ts";
import { kioseffSettingsVersion } from "../core/settings.ts";
import type { KioseffChartBarInput } from "../data/types.ts";
import type {
  KioseffWorkerRequest,
  KioseffWorkerResponse,
  KioseffWorkerTelemetry
} from "./protocol.ts";

export type KioseffWorkerLike = {
  onmessage: ((event: MessageEvent<KioseffWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: KioseffWorkerRequest): void;
  terminate(): void;
};

type Pending = {
  resolve: (snapshot: KioseffSnapshot) => void;
  reject: (error: Error) => void;
  generation: number;
};

export class KioseffWorkerClient {
  private worker: KioseffWorkerLike;
  private context: KioseffEngineContext;
  private generation = 0;
  private sequence = 0;
  private pending = new Map<string, Pending>();
  private disposed = false;
  private telemetry: KioseffWorkerTelemetry = {
    workerChartBarsReceived: 0,
    workerIntrabarsReceived: 0,
    outputClusters: 0,
    outputPanePoints: 0,
    outputDiagnostics: 0
  };
  private calculationMs = 0;

  constructor(
    context: KioseffEngineContext,
    workerFactory: () => KioseffWorkerLike = () =>
      new Worker(new URL("./kioseff.worker.ts", import.meta.url), {
        type: "module",
        name: "kioseff-stop-loss-clustering"
      })
  ) {
    this.context = structuredClone(context);
    this.worker = workerFactory();
    this.worker.onmessage = (event) => this.receive(event.data);
    this.worker.onerror = (event) => this.rejectAll(new Error(event.message || "Kioseff worker failure."));
  }

  private envelope(requestId: string) {
    return {
      requestId,
      generation: this.generation,
      sourceVersion: this.context.sourceVersion,
      engineVersion: KIOSEFF_ENGINE_VERSION,
      settingsVersion: kioseffSettingsVersion(this.context.settings)
    };
  }

  private nextId(prefix: string) {
    return `${prefix}:${this.generation}:${this.sequence++}`;
  }

  private receive(response: KioseffWorkerResponse) {
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    if (pending.generation !== this.generation || response.generation !== this.generation) {
      pending.reject(new Error("stale-source-generation"));
      return;
    }
    if (response.type === "error") {
      pending.reject(new Error(`${response.code}: ${response.message}`));
      return;
    }
    this.telemetry = response.telemetry;
    this.calculationMs = response.calculationMs;
    pending.resolve(response.snapshot);
  }

  private send(request: KioseffWorkerRequest) {
    if (this.disposed) return Promise.reject(new Error("Kioseff worker client is disposed."));
    return new Promise<KioseffSnapshot>((resolve, reject) => {
      this.pending.set(request.requestId, { resolve, reject, generation: this.generation });
      this.worker.postMessage(request);
    });
  }

  reset(context = this.context) {
    this.rejectAll(new Error("stale-source-generation"));
    this.context = structuredClone(context);
    this.generation += 1;
    const requestId = this.nextId("reset");
    return this.send({ type: "reset", ...this.envelope(requestId), context: this.context });
  }

  calculate(input: KioseffChartBarInput) {
    const requestId = this.nextId("calculate");
    return {
      requestId,
      promise: this.send({ type: "calculate", ...this.envelope(requestId), input })
    };
  }

  calculateBatch(inputs: KioseffChartBarInput[]) {
    const requestId = this.nextId("calculate-batch");
    return {
      requestId,
      promise: this.send({
        type: "calculate-batch",
        ...this.envelope(requestId),
        inputs
      })
    };
  }

  cancel(requestId: string) {
    const pending = this.pending.get(requestId);
    if (pending) {
      this.pending.delete(requestId);
      pending.reject(new Error("cancelled"));
    }
    const cancelId = this.nextId("cancel");
    this.worker.postMessage({
      type: "cancel",
      ...this.envelope(cancelId),
      cancelRequestId: requestId
    });
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  dispose() {
    if (this.disposed) return;
    const requestId = this.nextId("dispose");
    this.worker.postMessage({ type: "dispose", ...this.envelope(requestId) });
    this.disposed = true;
    this.rejectAll(new Error("Kioseff worker client disposed."));
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
  }

  get pendingCount() {
    return this.pending.size;
  }

  get activeGeneration() {
    return this.generation;
  }

  get lastTelemetry() {
    return { ...this.telemetry };
  }

  get lastCalculationMs() {
    return this.calculationMs;
  }
}
