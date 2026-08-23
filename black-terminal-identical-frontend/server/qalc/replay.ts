import { performance } from "node:perf_hooks";
import type { QalcTelemetry } from "./contracts.ts";
import { replayArchivedEvents } from "./archive.ts";
import { QalcEngine } from "./engine.ts";

export async function replayQalcArchive(path: string, options: { speed?: number; noWait?: boolean; tickSize?: number; quantityStep?: number } = {}) {
  const engine = new QalcEngine({ mode: "REPLAY", paperEnabled: false, shadowEnabled: false }, { tickSize: options.tickSize, quantityStep: options.quantityStep });
  let previousExchangeTime: number | undefined;
  let events = 0;
  const started = performance.now();
  let final: QalcTelemetry = engine.telemetry();
  for await (const event of replayArchivedEvents(path)) {
    if (!options.noWait && previousExchangeTime !== undefined) {
      const delay = Math.max(0, event.exchangeTimestamp - previousExchangeTime) / Math.max(0.001, options.speed || 1);
      if (delay) await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 5_000)));
    }
    // Replay clock is pegged to event time and never enables real submission.
    engine.observeClock(event.exchangeTimestamp, event.exchangeTimestamp, event.exchangeTimestamp);
    final = engine.process(event);
    previousExchangeTime = event.exchangeTimestamp;
    events += 1;
  }
  return { events, elapsedMs: performance.now() - started, telemetry: final };
}
