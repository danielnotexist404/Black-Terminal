import type { KioseffSnapshot } from "../core/canonical.ts";
import type { KioseffEngineContext } from "../core/engineTypes.ts";
import type { KioseffChartBarInput } from "../data/types.ts";
import type { KioseffUnavailableReason } from "../data/types.ts";

export type KioseffWorkerEnvelope = {
  requestId: string;
  generation: number;
  sourceVersion: string;
  engineVersion: string;
  settingsVersion: string;
};

export type KioseffWorkerRequest =
  | (KioseffWorkerEnvelope & {
      type: "calculate";
      input: KioseffChartBarInput;
    })
  | (KioseffWorkerEnvelope & {
      type: "calculate-batch";
      inputs: KioseffChartBarInput[];
    })
  | (KioseffWorkerEnvelope & {
      type: "reset";
      context: KioseffEngineContext;
    })
  | (KioseffWorkerEnvelope & {
      type: "cancel";
      cancelRequestId: string;
    })
  | (KioseffWorkerEnvelope & {
      type: "dispose";
    });

export type KioseffWorkerSuccess = KioseffWorkerEnvelope & {
  type: "result";
  snapshot: KioseffSnapshot;
  calculationMs: number;
};

export type KioseffWorkerFailure = KioseffWorkerEnvelope & {
  type: "error";
  code:
    | "worker-failure"
    | "stale-source-generation"
    | "cancelled"
    | "not-initialized"
    | "disposed"
    | KioseffUnavailableReason;
  message: string;
  calculationMs: number;
};

export type KioseffWorkerResponse = KioseffWorkerSuccess | KioseffWorkerFailure;

export function workerFailure(
  request: KioseffWorkerRequest,
  code: KioseffWorkerFailure["code"],
  message: string,
  calculationMs = 0
): KioseffWorkerFailure {
  return {
    type: "error",
    requestId: request.requestId,
    generation: request.generation,
    sourceVersion: request.sourceVersion,
    engineVersion: request.engineVersion,
    settingsVersion: request.settingsVersion,
    code,
    message,
    calculationMs
  };
}
