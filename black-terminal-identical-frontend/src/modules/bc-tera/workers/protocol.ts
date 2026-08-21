import type { BCTERAFeatureBar, BCTERASettings, BCTERASnapshot } from "../core/types.ts";

export const BC_TERA_WORKER_PROTOCOL_VERSION = 1 as const;

export type BCTERAWorkerRequest = {
  protocolVersion: typeof BC_TERA_WORKER_PROTOCOL_VERSION;
  type: "CALCULATE";
  requestId: string;
  generation: number;
  bars: BCTERAFeatureBar[];
  settings: Partial<BCTERASettings>;
};

export type BCTERAWorkerResponse =
  | {
      protocolVersion: typeof BC_TERA_WORKER_PROTOCOL_VERSION;
      type: "RESULT";
      requestId: string;
      generation: number;
      snapshot: BCTERASnapshot;
      calculationMs: number;
    }
  | {
      protocolVersion: typeof BC_TERA_WORKER_PROTOCOL_VERSION;
      type: "ERROR";
      requestId: string;
      generation: number;
      code: "CALCULATION_FAILED" | "INVALID_PROTOCOL" | "INPUT_TOO_LARGE";
      message: string;
    };
