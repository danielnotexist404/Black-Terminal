import { calculateBCTERA } from "../core/engine.ts";
import type { BCTERAWorkerRequest, BCTERAWorkerResponse } from "./protocol.ts";

export const BC_TERA_MAX_WORKER_BARS = 2_000;

export class BCTERAWorkerRuntime {
  private readonly post: (message: BCTERAWorkerResponse) => void;

  constructor(post: (message: BCTERAWorkerResponse) => void) {
    this.post = post;
  }

  handle(request: BCTERAWorkerRequest) {
    if (request.protocolVersion !== 1) {
      this.post({
        protocolVersion: 1,
        type: "ERROR",
        requestId: request.requestId,
        generation: request.generation,
        code: "INVALID_PROTOCOL",
        message: "Unsupported BC-TERA worker protocol version."
      });
      return;
    }
    if (!Array.isArray(request.bars) || request.bars.length > BC_TERA_MAX_WORKER_BARS) {
      this.post({
        protocolVersion: 1,
        type: "ERROR",
        requestId: request.requestId,
        generation: request.generation,
        code: "INPUT_TOO_LARGE",
        message: `BC-TERA accepts at most ${BC_TERA_MAX_WORKER_BARS} normalized feature bars.`
      });
      return;
    }
    try {
      const startedAt = performance.now();
      const snapshot = calculateBCTERA(request.bars, request.settings);
      this.post({
        protocolVersion: 1,
        type: "RESULT",
        requestId: request.requestId,
        generation: request.generation,
        snapshot,
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
