import type {
  AuctionIncrementalUpdate,
  AuctionProfileCalculationInput,
  AuctionProfileSettings,
  AuctionProfileSnapshot,
  CanonicalTrade
} from "../core/types.ts";

export const AUCTION_PROFILE_WORKER_PROTOCOL_VERSION = 1;

export type AuctionProfileWorkerEnvelope = {
  protocolVersion: 1;
  requestId: string;
  generation: number;
};

export type AuctionProfileWorkerRequest =
  | (AuctionProfileWorkerEnvelope & { type: "INITIALIZE"; input: AuctionProfileCalculationInput })
  | (AuctionProfileWorkerEnvelope & { type: "APPEND_TRADES"; trades: CanonicalTrade[]; sourceRevision: string })
  | (AuctionProfileWorkerEnvelope & { type: "APPEND_BARS"; update: AuctionIncrementalUpdate })
  | (AuctionProfileWorkerEnvelope & { type: "REBUILD"; input?: AuctionProfileCalculationInput })
  | (AuctionProfileWorkerEnvelope & { type: "SETTINGS_UPDATE"; settings: AuctionProfileSettings })
  | (AuctionProfileWorkerEnvelope & { type: "CANCEL"; cancelGeneration: number })
  | (AuctionProfileWorkerEnvelope & { type: "DISPOSE" });

export type AuctionProfileWorkerResponse =
  | (AuctionProfileWorkerEnvelope & {
      type: "RESULT";
      snapshots: AuctionProfileSnapshot[];
      calculationMs: number;
      incremental: boolean;
    })
  | (AuctionProfileWorkerEnvelope & {
      type: "PROGRESS";
      progress: number;
      phase: "PREPARING" | "AGGREGATING" | "VALUE_AREA" | "NODES" | "SERIALIZING";
    })
  | (AuctionProfileWorkerEnvelope & {
      type: "ERROR";
      code: "NOT_INITIALIZED" | "CANCELLED" | "STALE_GENERATION" | "CALCULATION_FAILED" | "DISPOSED";
      message: string;
    });
