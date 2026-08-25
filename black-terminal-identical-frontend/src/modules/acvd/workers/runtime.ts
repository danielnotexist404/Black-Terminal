import { calculateAcvd } from "../core/engine.ts";
import type { AcvdWorkerRequest, AcvdWorkerResponse } from "./protocol.ts";

export class AcvdWorkerRuntime {
  private readonly post: (message: AcvdWorkerResponse) => void;
  constructor(post: (message: AcvdWorkerResponse) => void) { this.post = post; }

  handle(request: AcvdWorkerRequest) {
    if (request.protocolVersion !== 1 || request.type !== "CALCULATE") {
      this.post({
        protocolVersion: 1,
        type: "ERROR",
        requestId: request.requestId,
        generation: request.generation,
        code: "INVALID_PROTOCOL",
        message: "Unsupported BC-ACVD worker protocol."
      });
      return;
    }
    try {
      const startedAt = performance.now();
      this.post({
        protocolVersion: 1,
        type: "RESULT",
        requestId: request.requestId,
        generation: request.generation,
        snapshot: calculateAcvd(request.input),
        calculationMs: performance.now() - startedAt
      });
    } catch (error) {
      this.post({
        protocolVersion: 1,
        type: "ERROR",
        requestId: request.requestId,
        generation: request.generation,
        code: "CALCULATION_FAILED",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
