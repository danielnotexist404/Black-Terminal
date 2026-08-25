import type { AcvdCalculationInput, AcvdSnapshot } from "../core/types.ts";

export const ACVD_WORKER_PROTOCOL_VERSION = 1 as const;

export type AcvdWorkerRequest = {
  protocolVersion: typeof ACVD_WORKER_PROTOCOL_VERSION;
  type: "CALCULATE";
  requestId: string;
  generation: number;
  input: AcvdCalculationInput;
};

export type AcvdWorkerResponse =
  | {
      protocolVersion: typeof ACVD_WORKER_PROTOCOL_VERSION;
      type: "RESULT";
      requestId: string;
      generation: number;
      snapshot: AcvdSnapshot;
      calculationMs: number;
    }
  | {
      protocolVersion: typeof ACVD_WORKER_PROTOCOL_VERSION;
      type: "ERROR";
      requestId: string;
      generation: number;
      code: "CALCULATION_FAILED" | "INVALID_PROTOCOL";
      message: string;
    };
