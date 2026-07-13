/// <reference lib="webworker" />
import { calculateAif } from "../core/aifEngine";
import type { AifCalculationRequest } from "../core/aifTypes";

self.onmessage = (event: MessageEvent<AifCalculationRequest>) => {
  try {
    const result = calculateAif(event.data);
    self.postMessage({ id: event.data.id, generation: event.data.generation, sourceVersion: event.data.sourceVersion, ok: true, result });
  } catch (error) {
    self.postMessage({ id: event.data.id, generation: event.data.generation, sourceVersion: event.data.sourceVersion, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

export {};
