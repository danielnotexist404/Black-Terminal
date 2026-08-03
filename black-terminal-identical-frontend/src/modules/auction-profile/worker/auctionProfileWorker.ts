import type { AuctionProfileCalculationInput, AuctionProfileSnapshot } from "../core/types.ts";
import { appendTradesToAuctionProfile, calculateAuctionProfiles } from "../engines/nativeEngine.ts";
import type { AuctionProfileWorkerRequest, AuctionProfileWorkerResponse } from "./protocol.ts";

type WorkerPayload = AuctionProfileWorkerResponse extends infer Response
  ? Response extends unknown ? Omit<Response, "protocolVersion" | "requestId" | "generation"> : never
  : never;


export type AuctionProfileWorkerPort = {
  postMessage(message: AuctionProfileWorkerResponse): void;
};

export class AuctionProfileWorkerRuntime {
  private input: AuctionProfileCalculationInput | null = null;
  private snapshots: AuctionProfileSnapshot[] = [];
  private cancelledGenerations = new Set<number>();
  private disposed = false;
  private readonly port: AuctionProfileWorkerPort;

  private clone<T>(value: T): T {
    if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
    return JSON.parse(JSON.stringify(value)) as T;
  }

  constructor(port: AuctionProfileWorkerPort) {
    this.port = port;
  }

  private response(request: AuctionProfileWorkerRequest, response: WorkerPayload) {
    this.port.postMessage({ ...response, protocolVersion: 1, requestId: request.requestId, generation: request.generation } as AuctionProfileWorkerResponse);
  }

  private rebuild(request: AuctionProfileWorkerRequest, input = this.input) {
    if (!input) {
      this.response(request, { type: "ERROR", code: "NOT_INITIALIZED", message: "RADAP worker has not been initialized." });
      return;
    }
    const started = performance.now();
    this.response(request, { type: "PROGRESS", progress: 0.08, phase: "PREPARING" });
    if (this.cancelledGenerations.has(request.generation)) {
      this.response(request, { type: "ERROR", code: "CANCELLED", message: "Generation cancelled." });
      return;
    }
    this.response(request, { type: "PROGRESS", progress: 0.28, phase: "AGGREGATING" });
    this.snapshots = calculateAuctionProfiles(input);
    this.response(request, { type: "PROGRESS", progress: 0.74, phase: "NODES" });
    this.response(request, { type: "RESULT", snapshots: this.snapshots, calculationMs: performance.now() - started, incremental: false });
  }

  handle(request: AuctionProfileWorkerRequest) {
    if (this.disposed && request.type !== "DISPOSE") {
      this.response(request, { type: "ERROR", code: "DISPOSED", message: "RADAP worker is disposed." });
      return;
    }
    try {
      if (request.type === "CANCEL") {
        this.cancelledGenerations.add(request.cancelGeneration);
        this.response(request, { type: "ERROR", code: "CANCELLED", message: "Generation cancelled." });
        return;
      }
      if (request.type === "DISPOSE") {
        this.disposed = true;
        this.input = null;
        this.snapshots = [];
        return;
      }
      if (request.type === "INITIALIZE") {
        this.input = this.clone(request.input);
        this.rebuild(request);
        return;
      }
      if (!this.input) {
        this.response(request, { type: "ERROR", code: "NOT_INITIALIZED", message: "RADAP worker has not been initialized." });
        return;
      }
      if (request.type === "SETTINGS_UPDATE") {
        this.input.settings = this.clone(request.settings);
        this.rebuild(request);
        return;
      }
      if (request.type === "REBUILD") {
        if (request.input) this.input = this.clone(request.input);
        this.rebuild(request);
        return;
      }
      if ((request.type === "APPEND_BARS" || request.type === "APPEND_TRADES") && this.input.settings.compositeLocked) {
        this.response(request, { type: "RESULT", snapshots: this.snapshots, calculationMs: 0, incremental: true });
        return;
      }
      if (request.type === "APPEND_BARS") {
        this.input.bars.push(...(request.update.bars ?? []));
        this.input.trades.push(...(request.update.trades ?? []));
        this.input.sourceRevision = request.update.sourceRevision;
        this.rebuild(request);
        return;
      }
      if (request.type === "APPEND_TRADES") {
        const started = performance.now();
        this.input.trades.push(...request.trades);
        this.input.sourceRevision = request.sourceRevision;
        this.snapshots = this.snapshots.map(snapshot => appendTradesToAuctionProfile(snapshot, request.trades, this.input!.settings));
        this.response(request, { type: "RESULT", snapshots: this.snapshots, calculationMs: performance.now() - started, incremental: true });
      }
    } catch (error) {
      this.response(request, { type: "ERROR", code: "CALCULATION_FAILED", message: error instanceof Error ? error.message : String(error) });
    }
  }
}
