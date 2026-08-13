import type { DDAProCalculationInput, DDAProSettings, DDAProSnapshot } from "../core/types.ts";

export const DDA_PRO_WORKER_PROTOCOL_VERSION = 1 as const;

type WorkerEnvelope = {
  protocolVersion: typeof DDA_PRO_WORKER_PROTOCOL_VERSION;
  requestId: string;
  generation: number;
};

export type DDAProWorkerRequest =
  | (WorkerEnvelope & { type: "CALCULATE"; input: DDAProCalculationInput })
  | (WorkerEnvelope & { type: "INITIALIZE"; config: DDAProSettings; timeframeSeconds?: number })
  | (WorkerEnvelope & { type: "LOAD_HISTORY"; values: Float64Array; timestamps: BigInt64Array })
  | (WorkerEnvelope & { type: "APPEND"; value: number; timestamp: number; confirmed: boolean })
  | (WorkerEnvelope & { type: "UPDATE_CONFIG"; config: Partial<DDAProSettings> })
  | (WorkerEnvelope & { type: "REBUILD" })
  | (WorkerEnvelope & { type: "CANCEL" });

export type DDAProWorkerResponse =
  | {
      protocolVersion: typeof DDA_PRO_WORKER_PROTOCOL_VERSION;
      type: "ACK";
      requestId: string;
      generation: number;
      operation: Exclude<DDAProWorkerRequest["type"], "CALCULATE" | "REBUILD">;
    }
  | {
      protocolVersion: typeof DDA_PRO_WORKER_PROTOCOL_VERSION;
      type: "RESULT";
      requestId: string;
      generation: number;
      snapshot: DDAProSnapshot;
      calculationMs: number;
    }
  | {
      protocolVersion: typeof DDA_PRO_WORKER_PROTOCOL_VERSION;
      type: "ERROR";
      requestId: string;
      generation: number;
      code: "CALCULATION_FAILED" | "INVALID_PROTOCOL";
      message: string;
    };
