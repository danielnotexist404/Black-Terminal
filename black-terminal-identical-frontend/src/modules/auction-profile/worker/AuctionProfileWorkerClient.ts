import type { AuctionProfileCalculationInput, AuctionProfileSettings, AuctionProfileSnapshot, CanonicalTrade } from "../core/types.ts";
import type { AuctionProfileWorkerRequest, AuctionProfileWorkerResponse } from "./protocol.ts";

type Pending = {
  resolve: (snapshots: AuctionProfileSnapshot[]) => void;
  reject: (error: Error) => void;
  generation: number;
};

export type AuctionProfileWorkerLike = {
  onmessage: ((event: MessageEvent<AuctionProfileWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: AuctionProfileWorkerRequest): void;
  terminate(): void;
};

export class AuctionProfileWorkerClient {
  private worker: AuctionProfileWorkerLike;
  private generation = 0;
  private sequence = 0;
  private pending = new Map<string, Pending>();
  private disposed = false;
  private progress = 0;
  private lastCalculationMs = 0;

  constructor(workerFactory: () => AuctionProfileWorkerLike = () => new Worker(new URL("./auction-profile.worker.ts", import.meta.url), { type: "module", name: "black-core-auction-profile" })) {
    this.worker = workerFactory();
    this.worker.onmessage = event => this.receive(event.data);
    this.worker.onerror = event => this.rejectAll(new Error(event.message || "RADAP worker failed."));
  }

  private nextId(prefix: string) {
    return prefix + ":" + this.generation + ":" + this.sequence++;
  }

  private envelope(requestId: string) {
    return { protocolVersion: 1 as const, requestId, generation: this.generation };
  }

  private receive(response: AuctionProfileWorkerResponse) {
    if (response.type === "PROGRESS") {
      if (response.generation === this.generation) this.progress = response.progress;
      return;
    }
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    if (response.generation !== this.generation || pending.generation !== this.generation) {
      pending.reject(new Error("STALE_GENERATION"));
      return;
    }
    if (response.type === "ERROR") {
      pending.reject(new Error(response.code + ": " + response.message));
      return;
    }
    this.progress = 1;
    this.lastCalculationMs = response.calculationMs;
    pending.resolve(response.snapshots);
  }

  private send(request: AuctionProfileWorkerRequest) {
    if (this.disposed) return Promise.reject(new Error("RADAP worker client is disposed."));
    return new Promise<AuctionProfileSnapshot[]>((resolve, reject) => {
      this.pending.set(request.requestId, { resolve, reject, generation: this.generation });
      this.worker.postMessage(request);
    });
  }

  initialize(input: AuctionProfileCalculationInput) {
    this.cancelActive();
    const requestId = this.nextId("initialize");
    return this.send({ type: "INITIALIZE", ...this.envelope(requestId), input });
  }

  rebuild(input?: AuctionProfileCalculationInput) {
    this.cancelActive();
    const requestId = this.nextId("rebuild");
    return this.send({ type: "REBUILD", ...this.envelope(requestId), input });
  }

  updateSettings(settings: AuctionProfileSettings) {
    this.cancelActive();
    const requestId = this.nextId("settings");
    return this.send({ type: "SETTINGS_UPDATE", ...this.envelope(requestId), settings });
  }

  appendTrades(trades: CanonicalTrade[], sourceRevision: string) {
    const requestId = this.nextId("trades");
    return this.send({ type: "APPEND_TRADES", ...this.envelope(requestId), trades, sourceRevision });
  }

  private cancelActive() {
    if (this.pending.size) {
      const cancelGeneration = this.generation;
      const requestId = this.nextId("cancel");
      this.worker.postMessage({ type: "CANCEL", ...this.envelope(requestId), cancelGeneration });
      this.rejectAll(new Error("CANCELLED"));
    }
    this.generation += 1;
    this.progress = 0;
  }

  private rejectAll(error: Error) {
    this.pending.forEach(pending => pending.reject(error));
    this.pending.clear();
  }

  dispose() {
    if (this.disposed) return;
    const requestId = this.nextId("dispose");
    this.worker.postMessage({ type: "DISPOSE", ...this.envelope(requestId) });
    this.disposed = true;
    this.rejectAll(new Error("DISPOSED"));
    this.worker.terminate();
  }

  get activeGeneration() { return this.generation; }
  get buildProgress() { return this.progress; }
  get calculationMs() { return this.lastCalculationMs; }
}
