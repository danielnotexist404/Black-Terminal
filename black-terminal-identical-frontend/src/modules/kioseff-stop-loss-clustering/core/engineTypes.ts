import type { SymbolMetadata, Timeframe } from "../../../market-data/types";
import type { KioseffChartBarInput } from "../data/types.ts";
import type { KioseffSnapshot } from "./canonical.ts";
import type { KioseffSettingsV1 } from "./settings.ts";

export type KioseffEngineContext = {
  metadata: SymbolMetadata;
  timeframe: Timeframe;
  sourceVersion: string;
  settings: KioseffSettingsV1;
  diagnostics: boolean;
};

export interface KioseffCalculationEngine<State> {
  processBar(input: KioseffChartBarInput): KioseffSnapshot;
  exportState(): State;
  importState(state: State): void;
  snapshot(): KioseffSnapshot;
  reset(): void;
}
