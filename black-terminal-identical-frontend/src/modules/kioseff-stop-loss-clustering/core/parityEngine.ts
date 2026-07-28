import type { KioseffChartBarInput } from "../data/types.ts";
import { assertKioseffInputQuality } from "../data/qualityGate.ts";
import {
  AbsorbtionExtremesEngine,
  type AbsorbtionEngineState
} from "./absorbtionEngine.ts";
import type { KioseffSnapshot } from "./canonical.ts";
import type { KioseffEngineContext } from "./engineTypes.ts";
import {
  VolatilityAtEntryEngine,
  type VolatilityAtEntryEngineState
} from "./volatilityAtEntryEngine.ts";

export type KioseffModelState = AbsorbtionEngineState | VolatilityAtEntryEngineState;

export type KioseffTransactionalState = {
  model: KioseffEngineContext["settings"]["model"];
  committed: KioseffModelState;
  committedThrough: number | null;
  provisionalBarTime: number | null;
  committedStateId: number;
  provisionalStateId: number;
};

export class KioseffParityEngine {
  private context: KioseffEngineContext;
  private engine: AbsorbtionExtremesEngine | VolatilityAtEntryEngine;
  private committedState: KioseffModelState;
  private committedThrough: number | null = null;
  private provisionalBarTime: number | null = null;
  private committedStateId = 0;
  private provisionalStateId = 0;
  private lastSnapshot: KioseffSnapshot;

  constructor(context: KioseffEngineContext) {
    this.context = structuredClone(context);
    this.engine = this.createEngine();
    this.committedState = this.exportModelState();
    this.lastSnapshot = this.engine.snapshot();
  }

  private createEngine() {
    return this.context.settings.model === "absorbtion-extremes"
      ? new AbsorbtionExtremesEngine(this.context)
      : new VolatilityAtEntryEngine(this.context);
  }

  private exportModelState() {
    return this.engine.exportState();
  }

  private importModelState(state: KioseffModelState) {
    if (this.engine instanceof AbsorbtionExtremesEngine) {
      this.engine.importState(state as AbsorbtionEngineState);
    } else {
      this.engine.importState(state as VolatilityAtEntryEngineState);
    }
  }

  processBar(input: KioseffChartBarInput, emitSnapshot = true) {
    assertKioseffInputQuality([input]);
    const barTime = input.chartBar.time;
    if (
      this.provisionalBarTime !== null &&
      this.provisionalBarTime !== barTime &&
      !input.chartBarClosed
    ) {
      throw new Error(
        `Cannot advance provisional bar from ${this.provisionalBarTime} to ${barTime} without a closed commit.`
      );
    }
    this.importModelState(this.committedState);
    this.lastSnapshot = this.engine.processBar(input, emitSnapshot);
    this.provisionalStateId += 1;
    if (input.chartBarClosed) {
      this.committedState = this.exportModelState();
      this.committedThrough = barTime;
      this.provisionalBarTime = null;
      this.committedStateId += 1;
    } else {
      this.provisionalBarTime = barTime;
    }
    return this.lastSnapshot;
  }

  processBatch(inputs: readonly KioseffChartBarInput[]) {
    if (!inputs.length) return this.lastSnapshot;
    assertKioseffInputQuality(inputs);
    this.importModelState(this.committedState);
    const finalIndex = inputs.length - 1;
    const finalIsProvisional = !inputs[finalIndex]!.chartBarClosed;
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index]!;
      if (!input.chartBarClosed && index !== finalIndex) {
        throw new Error("Only the final batch bar may be provisional.");
      }
      if (finalIsProvisional && index === finalIndex) {
        this.committedState = this.exportModelState();
        this.committedThrough = inputs[index - 1]?.chartBar.time ?? this.committedThrough;
        this.committedStateId += Math.max(0, index);
      }
      const emitSnapshot = index === finalIndex;
      this.lastSnapshot = this.engine.processBar(input, emitSnapshot);
      this.provisionalStateId += 1;
    }
    if (finalIsProvisional) {
      this.provisionalBarTime = inputs[finalIndex]!.chartBar.time;
    } else {
      this.committedState = this.exportModelState();
      this.committedThrough = inputs[finalIndex]!.chartBar.time;
      this.provisionalBarTime = null;
      this.committedStateId += inputs.length;
    }
    return this.lastSnapshot;
  }

  snapshot() {
    return this.lastSnapshot;
  }

  exportState(): KioseffTransactionalState {
    return {
      model: this.context.settings.model,
      committed: structuredClone(this.committedState),
      committedThrough: this.committedThrough,
      provisionalBarTime: this.provisionalBarTime,
      committedStateId: this.committedStateId,
      provisionalStateId: this.provisionalStateId
    };
  }

  importState(state: KioseffTransactionalState) {
    if (state.model !== this.context.settings.model) {
      throw new Error(`Kioseff state model mismatch: ${state.model}`);
    }
    this.committedState = structuredClone(state.committed);
    this.committedThrough = state.committedThrough;
    this.provisionalBarTime = state.provisionalBarTime;
    this.committedStateId = state.committedStateId;
    this.provisionalStateId = state.provisionalStateId;
    this.importModelState(this.committedState);
    this.lastSnapshot = this.engine.snapshot();
  }

  reset(context = this.context) {
    this.context = structuredClone(context);
    this.engine = this.createEngine();
    this.committedState = this.exportModelState();
    this.committedThrough = null;
    this.provisionalBarTime = null;
    this.committedStateId += 1;
    this.provisionalStateId = 0;
    this.lastSnapshot = this.engine.snapshot();
  }
}
