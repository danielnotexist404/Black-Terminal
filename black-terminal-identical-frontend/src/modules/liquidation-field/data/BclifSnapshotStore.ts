import { LIQUIDATION_FIELD_SETTINGS_VERSION } from "../core/settings.ts";
import { BCLIF_MODEL_VERSION, type LiquidationFieldSnapshot } from "../core/types.ts";

export type BclifSnapshotHandler = (snapshot: LiquidationFieldSnapshot) => void;
export type BclifSnapshotUnsubscribe = () => void;

export interface BclifSnapshotStore {
  getLatestSnapshot(): LiquidationFieldSnapshot | null;
  subscribe(handler: BclifSnapshotHandler): BclifSnapshotUnsubscribe;
  publish(snapshot: LiquidationFieldSnapshot): LiquidationFieldSnapshot;
  clear(): void;
}

/**
 * Retains exactly one completed compatible snapshot. Subscription is replaying:
 * model-before-renderer and renderer-before-model mount orders are equivalent.
 */
export class InMemoryBclifSnapshotStore implements BclifSnapshotStore {
  private latest: LiquidationFieldSnapshot | null = null;
  private readonly handlers = new Set<BclifSnapshotHandler>();
  private generation = 0;

  getLatestSnapshot() {
    return this.latest;
  }

  subscribe(handler: BclifSnapshotHandler) {
    this.handlers.add(handler);
    if (this.latest) handler(this.latest);
    return () => this.handlers.delete(handler);
  }

  publish(snapshot: LiquidationFieldSnapshot) {
    if (snapshot.header.modelVersion !== BCLIF_MODEL_VERSION) {
      throw new Error("BCLIF_SNAPSHOT_MODEL_INCOMPATIBLE");
    }
    if (this.latest && snapshot.generatedAt < this.latest.generatedAt) return this.latest;
    if (this.latest
      && (snapshot.header.sourceCutoffTimestamp ?? snapshot.header.endTime)
        < (this.latest.header.sourceCutoffTimestamp ?? this.latest.header.endTime)) return this.latest;
    const nextGeneration = Math.max(this.generation + 1, snapshot.generations?.modelGeneration ?? 0);
    this.generation = nextGeneration;
    const next: LiquidationFieldSnapshot = {
      ...snapshot,
      generations: {
        modelGeneration: nextGeneration,
        exposureGeneration: Math.max(nextGeneration, snapshot.generations?.exposureGeneration ?? 0),
        rendererGeneration: snapshot.generations?.rendererGeneration ?? 0,
        settingsGeneration: LIQUIDATION_FIELD_SETTINGS_VERSION,
        authority: snapshot.authority,
        modelVersion: snapshot.header.modelVersion
      }
    };
    this.latest = next;
    for (const handler of this.handlers) handler(next);
    return next;
  }

  clear() {
    this.latest = null;
    this.generation = 0;
  }
}
