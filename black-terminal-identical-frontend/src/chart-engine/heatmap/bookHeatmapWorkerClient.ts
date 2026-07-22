import type { OrderBookSnapshot } from "../../market-data/types";
import { compactBookSnapshot, type CompactedBookSnapshot } from "./bookHeatmapProcessor.ts";

type PendingSnapshot = { snapshot: OrderBookSnapshot; receivedAt: number };

export type BookHeatmapWorkerStats = {
  submitted: number;
  completed: number;
  dropped: number;
  inFlight: boolean;
  queued: boolean;
};

export class BookHeatmapWorkerClient {
  private worker: Worker | null = null;
  private inFlight = false;
  private current: { id: number; pending: PendingSnapshot } | null = null;
  private queuedByVenue = new Map<string, PendingSnapshot>();
  private venueQueue: string[] = [];
  private disposed = false;
  private sequence = 0;
  private stats = { submitted: 0, completed: 0, dropped: 0 };
  private readonly onResult: (result: CompactedBookSnapshot) => void;
  private readonly onDrop?: (count: number) => void;

  constructor(
    onResult: (result: CompactedBookSnapshot) => void,
    onDrop?: (count: number) => void
  ) {
    this.onResult = onResult;
    this.onDrop = onDrop;
  }

  submit(snapshot: OrderBookSnapshot) {
    if (this.disposed) return;
    this.stats.submitted += 1;
    const pending = { snapshot, receivedAt: Date.now() };
    if (this.inFlight) {
      if (this.queuedByVenue.has(snapshot.exchange)) {
        this.stats.dropped += 1;
        this.onDrop?.(1);
      } else {
        this.venueQueue.push(snapshot.exchange);
      }
      this.queuedByVenue.set(snapshot.exchange, pending);
      return;
    }
    this.dispatch(pending);
  }

  getStats(): BookHeatmapWorkerStats {
    return { ...this.stats, inFlight: this.inFlight, queued: this.queuedByVenue.size > 0 };
  }

  dispose() {
    this.disposed = true;
    this.queuedByVenue.clear();
    this.venueQueue = [];
    this.inFlight = false;
    this.current = null;
    this.worker?.terminate();
    this.worker = null;
  }

  private dispatch(pending: PendingSnapshot) {
    this.inFlight = true;
    const id = ++this.sequence;
    this.current = { id, pending };
    if (typeof Worker === "undefined") {
      queueMicrotask(() => this.complete(id, compactBookSnapshot(pending.snapshot, pending.receivedAt)));
      return;
    }
    const worker = this.ensureWorker();
    worker.postMessage({ id, ...pending });
  }

  private complete(id: number, result: CompactedBookSnapshot) {
    if (this.disposed) return;
    if (!this.current || this.current.id !== id) return;
    this.inFlight = false;
    this.current = null;
    this.stats.completed += 1;
    this.onResult(result);
    const nextVenue = this.venueQueue.shift();
    const next = nextVenue ? this.queuedByVenue.get(nextVenue) : undefined;
    if (nextVenue) this.queuedByVenue.delete(nextVenue);
    if (next) this.dispatch(next);
  }

  private ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./bookHeatmapWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ id: number; result: CompactedBookSnapshot }>) => {
      this.complete(event.data.id, event.data.result);
    };
    worker.onerror = () => {
      const failed = this.current;
      worker.terminate();
      this.worker = null;
      if (failed && !this.disposed) {
        this.complete(failed.id, compactBookSnapshot(failed.pending.snapshot, failed.pending.receivedAt));
      }
    };
    this.worker = worker;
    return worker;
  }
}
