import { KioseffParityEngine } from "../core/parityEngine.ts";
import type {
  KioseffWorkerRequest,
  KioseffWorkerResponse
} from "./protocol.ts";
import { workerFailure } from "./protocol.ts";
import { assertKioseffInputQuality } from "../data/qualityGate.ts";
import { KioseffDataUnavailableError } from "../data/types.ts";

export class KioseffWorkerRuntime {
  private engine: KioseffParityEngine | null = null;
  private generation = -1;
  private sourceVersion = "";
  private engineVersion = "";
  private settingsVersion = "";
  private cancelled = new Set<string>();
  private disposed = false;

  handle(request: KioseffWorkerRequest): KioseffWorkerResponse {
    const started = performance.now();
    if (this.disposed) return workerFailure(request, "disposed", "Kioseff worker is disposed.");
    if (request.type === "cancel") {
      this.cancelled.add(request.cancelRequestId);
      return workerFailure(request, "cancelled", `Cancelled ${request.cancelRequestId}.`);
    }
    if (request.type === "dispose") {
      this.engine = null;
      this.cancelled.clear();
      this.disposed = true;
      return workerFailure(request, "disposed", "Kioseff worker disposed.");
    }
    if (request.type === "reset") {
      this.engine = new KioseffParityEngine(request.context);
      this.generation = request.generation;
      this.sourceVersion = request.sourceVersion;
      this.engineVersion = request.engineVersion;
      this.settingsVersion = request.settingsVersion;
      this.cancelled.clear();
      return {
        type: "result",
        requestId: request.requestId,
        generation: request.generation,
        sourceVersion: request.sourceVersion,
        engineVersion: request.engineVersion,
        settingsVersion: request.settingsVersion,
        snapshot: this.engine.snapshot(),
        calculationMs: performance.now() - started
      };
    }
    if (!this.engine) {
      return workerFailure(request, "not-initialized", "Kioseff worker has not been reset.");
    }
    if (
      request.generation !== this.generation ||
      request.sourceVersion !== this.sourceVersion ||
      request.engineVersion !== this.engineVersion ||
      request.settingsVersion !== this.settingsVersion
    ) {
      return workerFailure(
        request,
        "stale-source-generation",
        "Request envelope does not match the active worker generation.",
        performance.now() - started
      );
    }
    if (this.cancelled.delete(request.requestId)) {
      return workerFailure(
        request,
        "cancelled",
        `Request ${request.requestId} was cancelled.`,
        performance.now() - started
      );
    }
    try {
      const inputs = request.type === "calculate-batch" ? request.inputs : [request.input];
      assertKioseffInputQuality(inputs);
      const snapshot =
        request.type === "calculate-batch"
          ? this.engine.processBatch(request.inputs)
          : this.engine.processBar(request.input);
      return {
        type: "result",
        requestId: request.requestId,
        generation: request.generation,
        sourceVersion: request.sourceVersion,
        engineVersion: request.engineVersion,
        settingsVersion: request.settingsVersion,
        snapshot,
        calculationMs: performance.now() - started
      };
    } catch (error) {
      if (error instanceof KioseffDataUnavailableError) {
        return workerFailure(
          request,
          error.reason,
          error.message,
          performance.now() - started
        );
      }
      return workerFailure(
        request,
        "worker-failure",
        error instanceof Error ? error.message : String(error),
        performance.now() - started
      );
    }
  }
}

type WorkerScope = {
  onmessage: ((event: MessageEvent<KioseffWorkerRequest>) => void) | null;
  postMessage(message: KioseffWorkerResponse): void;
};

export function installKioseffWorker(scope: WorkerScope) {
  const runtime = new KioseffWorkerRuntime();
  scope.onmessage = (event) => {
    scope.postMessage(runtime.handle(event.data));
  };
}
