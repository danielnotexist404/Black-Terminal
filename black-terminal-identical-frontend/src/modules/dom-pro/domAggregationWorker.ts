import { DomAggregationEngine, type DomAggregationInput } from "./domAggregationEngine";

type Request = { id: string; version: number; key: string; input: DomAggregationInput };

const engines = new Map<string, DomAggregationEngine>();

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, version, key, input } = event.data;
  const startedAt = performance.now();
  try {
    let engine = engines.get(key);
    if (!engine) {
      engine = new DomAggregationEngine();
      engines.set(key, engine);
      while (engines.size > 8) {
        const oldest = engines.keys().next().value as string | undefined;
        if (!oldest) break;
        engines.delete(oldest);
      }
    }
    const snapshot = engine.aggregate(input);
    self.postMessage({ id, version, type: "done", snapshot, metrics: { processingMs: performance.now() - startedAt } });
  } catch (error) {
    self.postMessage({ id, version, type: "error", error: error instanceof Error ? error.message : String(error) });
  }
};

export {};
