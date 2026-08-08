import { LiquidationCohortEngine } from "../../../src/modules/liquidation-field/core/cohortEngine.ts";
import { BCLIF_MODEL_VERSION, type ConfirmedLiquidationEvent, type LiquidationCohortEngineState, type LiquidationInstrumentRules } from "../../../src/modules/liquidation-field/core/types.ts";
import type { BclifFrameEnvelope } from "../contracts.ts";

/** Single authoritative chronological cohort engine owned by the collector. */
export class BclifCohortRuntime {
  private engine: LiquidationCohortEngine;
  private lastFrameEnd: number | null = null;
  private lastSourceCutoff: number | null = null;
  private readonly processedEventIds = new Set<string>();

  constructor(rules: LiquidationInstrumentRules) {
    if (rules.sourceVersion.length < 1) throw new Error("BCLIF rules require a source version");
    this.engine = new LiquidationCohortEngine(rules, "VENUE_CALIBRATED");
  }

  process(envelope: BclifFrameEnvelope, events: readonly ConfirmedLiquidationEvent[]) {
    if (envelope.authority !== "PERSISTENT_NODE" && envelope.authority !== "REPLAY") throw new Error("BCLIF cohort runtime rejected non-authoritative frame");
    if (envelope.frame.timestamp !== envelope.frameEnd || envelope.sourceCutoffTimestamp !== envelope.frameEnd) {
      throw new Error("BCLIF cohort frames require an exact as-of cutoff at frame end");
    }
    if (this.lastFrameEnd !== null && envelope.frameEnd <= this.lastFrameEnd) throw new Error("BCLIF cohort frames must be strictly chronological");
    const previousCutoff = this.lastSourceCutoff ?? -Infinity;
    const accepted = events
      .filter((event) => {
        const knownAt = Math.max(event.timestamp, event.receivedAt);
        return event.timestamp <= envelope.frameEnd && event.receivedAt <= envelope.frameEnd && knownAt > previousCutoff;
      })
      .filter((event) => {
        if (this.processedEventIds.has(event.id)) return false;
        this.processedEventIds.add(event.id);
        return true;
      })
      .sort((a, b) => Math.max(a.timestamp, a.receivedAt) - Math.max(b.timestamp, b.receivedAt) || a.timestamp - b.timestamp || a.id.localeCompare(b.id));
    const snapshot = this.engine.processFrame(envelope.frame, accepted);
    this.lastFrameEnd = envelope.frameEnd;
    this.lastSourceCutoff = envelope.sourceCutoffTimestamp;
    this.pruneProcessedEvents();
    return snapshot;
  }

  snapshot() { return this.engine.snapshot(); }
  exportState() { return this.engine.exportState(); }
  processedIds() { return [...this.processedEventIds].sort(); }
  cutoff() { return this.lastFrameEnd; }
  sourceCutoff() { return this.lastSourceCutoff; }

  importState(state: LiquidationCohortEngineState, processedEventIds: readonly string[] = [], sourceCutoffTimestamp?: number) {
    if (state.modelVersion !== BCLIF_MODEL_VERSION) throw new Error("Unsupported BCLIF cohort checkpoint model version");
    this.engine.importState(state);
    this.lastFrameEnd = state.previousFrame?.timestamp ?? null;
    this.lastSourceCutoff = sourceCutoffTimestamp ?? this.lastFrameEnd;
    this.processedEventIds.clear();
    for (const eventId of processedEventIds.slice(-200_000)) this.processedEventIds.add(eventId);
  }

  updateRules(rules: LiquidationInstrumentRules) {
    const state = this.engine.exportState();
    if (rules.sourceVersion !== state.sourceVersion || rules.venue !== "BYBIT") throw new Error("BCLIF point-in-time rule update is incompatible with cohort state");
    const next = new LiquidationCohortEngine(rules, "VENUE_CALIBRATED");
    next.importState(state);
    this.engine = next;
  }

  private pruneProcessedEvents() {
    if (this.processedEventIds.size <= 200_000) return;
    const remove = this.processedEventIds.size - 150_000;
    let count = 0;
    for (const eventId of this.processedEventIds) {
      this.processedEventIds.delete(eventId);
      if (++count >= remove) break;
    }
  }
}
