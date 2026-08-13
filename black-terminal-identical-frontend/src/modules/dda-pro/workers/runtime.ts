import { calculateDDAPro } from "../core/engine.ts";
import { migrateDDAProSettings } from "../core/settings.ts";
import type { DDAProCalculationInput, DDAProSettings } from "../core/types.ts";
import type { Candle } from "../../../chart-engine/types.ts";
import type { DDAProWorkerRequest, DDAProWorkerResponse } from "./protocol.ts";

export class DDAProWorkerRuntime {
  private readonly post: (message: DDAProWorkerResponse) => void;
  private config: DDAProSettings | null = null;
  private timeframeSeconds: number | undefined;
  private candles: Candle[] = [];
  private readonly cancelledGenerations = new Set<number>();

  constructor(post: (message: DDAProWorkerResponse) => void) { this.post = post; }

  private error(request: DDAProWorkerRequest, code: "CALCULATION_FAILED" | "INVALID_PROTOCOL", message: string) {
    this.post({ protocolVersion: 1, type: "ERROR", requestId: request.requestId, generation: request.generation, code, message });
  }

  private ack(request: DDAProWorkerRequest, operation: "INITIALIZE" | "LOAD_HISTORY" | "APPEND" | "UPDATE_CONFIG" | "CANCEL") {
    this.post({ protocolVersion: 1, type: "ACK", requestId: request.requestId, generation: request.generation, operation });
  }

  private rebuild(request: DDAProWorkerRequest) {
    if (!this.config) throw new Error("DDA_PRO_NOT_INITIALIZED");
    if (this.cancelledGenerations.has(request.generation)) return;
    const startedAt = performance.now();
    const input: DDAProCalculationInput = { candles: this.candles, settings: this.config, timeframeSeconds: this.timeframeSeconds };
    const snapshot = calculateDDAPro(input);
    if (this.cancelledGenerations.has(request.generation)) return;
    this.post({ protocolVersion: 1, type: "RESULT", requestId: request.requestId, generation: request.generation, snapshot, calculationMs: performance.now() - startedAt });
  }

  handle(request: DDAProWorkerRequest) {
    if (request.protocolVersion !== 1) {
      this.error(request, "INVALID_PROTOCOL", "Unsupported DDA Pro worker protocol version.");
      return;
    }
    try {
      if (request.type === "CALCULATE") {
        const startedAt = performance.now();
        const snapshot = calculateDDAPro(request.input);
        if (!this.cancelledGenerations.has(request.generation)) {
          this.post({ protocolVersion: 1, type: "RESULT", requestId: request.requestId, generation: request.generation, snapshot, calculationMs: performance.now() - startedAt });
        }
        return;
      }
      if (request.type === "INITIALIZE") {
        this.config = migrateDDAProSettings(request.config);
        this.timeframeSeconds = request.timeframeSeconds;
        this.candles = [];
        this.cancelledGenerations.delete(request.generation);
        this.ack(request, "INITIALIZE");
        return;
      }
      if (request.type === "LOAD_HISTORY") {
        if (!this.config) throw new Error("DDA_PRO_NOT_INITIALIZED");
        if (request.values.length !== request.timestamps.length) throw new Error("DDA_PRO_HISTORY_LENGTH_MISMATCH");
        const next: Candle[] = [];
        let priorTime = Number.NEGATIVE_INFINITY;
        for (let index = 0; index < request.values.length; index++) {
          const value = request.values[index]!;
          const time = Number(request.timestamps[index]!);
          if (!Number.isFinite(value) || !Number.isSafeInteger(time) || time <= priorTime) throw new Error("DDA_PRO_HISTORY_INVALID");
          next.push({ time, open: value, high: value, low: value, close: value, volume: 0 });
          priorTime = time;
        }
        this.candles = next;
        this.ack(request, "LOAD_HISTORY");
        return;
      }
      if (request.type === "APPEND") {
        if (!this.config) throw new Error("DDA_PRO_NOT_INITIALIZED");
        if (!Number.isFinite(request.value) || !Number.isSafeInteger(request.timestamp)) throw new Error("DDA_PRO_APPEND_INVALID");
        const last = this.candles.at(-1);
        const candle: Candle = { time: request.timestamp, open: request.value, high: request.value, low: request.value, close: request.value, volume: 0 };
        if (last?.time === request.timestamp) this.candles[this.candles.length - 1] = candle;
        else if (!last || request.timestamp > last.time) this.candles.push(candle);
        else throw new Error("DDA_PRO_APPEND_OUT_OF_ORDER");
        this.ack(request, "APPEND");
        return;
      }
      if (request.type === "UPDATE_CONFIG") {
        if (!this.config) throw new Error("DDA_PRO_NOT_INITIALIZED");
        this.config = migrateDDAProSettings({ ...this.config, ...request.config });
        this.ack(request, "UPDATE_CONFIG");
        return;
      }
      if (request.type === "CANCEL") {
        this.cancelledGenerations.add(request.generation);
        this.ack(request, "CANCEL");
        return;
      }
      if (request.type === "REBUILD") {
        this.rebuild(request);
        return;
      }
      this.error(request, "INVALID_PROTOCOL", "Unsupported DDA Pro worker request.");
    } catch (error) {
      this.error(request, "CALCULATION_FAILED", error instanceof Error ? error.message : String(error));
    }
  }
}
