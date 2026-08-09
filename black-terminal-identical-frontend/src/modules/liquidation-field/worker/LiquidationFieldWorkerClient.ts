import { buildLiquidationFieldSnapshot } from "../core/exposureRaster.ts";
import type { LiquidationFieldSnapshot } from "../core/types.ts";
import type { LiquidationFieldWorkerRequest, LiquidationFieldWorkerResponse } from "./protocol.ts";

type RequestPayload = Omit<LiquidationFieldWorkerRequest, "id">;

export class LiquidationFieldWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (snapshot: LiquidationFieldSnapshot) => void; reject: (error: Error) => void }>();

  constructor() {
    if (typeof Worker === "undefined") return;
    try {
      this.worker = new Worker(new URL("./rasterWorker.ts", import.meta.url), { type: "module", name: "black-core-liquidation-field" });
      this.worker.onmessage = (message: MessageEvent<LiquidationFieldWorkerResponse>) => {
        const response = message.data;
        const pending = this.pending.get(response.id);
        if (!pending) return;
        this.pending.delete(response.id);
        if ("error" in response) pending.reject(new Error(response.error));
        else pending.resolve(response.snapshot);
      };
      this.worker.onerror = (event) => {
        const error = new Error(event.message || "Liquidation field worker failed");
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
      };
    } catch (error) {
      console.warn("BCLIF worker unavailable; using synchronous fallback", error);
      this.worker = null;
    }
  }

  build(payload: RequestPayload): Promise<LiquidationFieldSnapshot> {
    if (!this.worker) {
      return Promise.resolve().then(() => buildLiquidationFieldSnapshot(
        payload.frames,
        payload.events,
        payload.rules,
        payload.settings,
        payload.coverage,
        payload.absoluteGrid
      ));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, ...payload } satisfies LiquidationFieldWorkerRequest);
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    const error = new Error("Liquidation field worker disposed");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
