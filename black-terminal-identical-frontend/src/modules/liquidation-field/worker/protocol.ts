import type {
  ConfirmedLiquidationEvent,
  LiquidationCoverage,
  LiquidationFieldSettings,
  LiquidationFieldSnapshot,
  LiquidationInstrumentRules,
  LiquidationMarketFrame
} from "../core/types.ts";

export interface LiquidationFieldWorkerRequest {
  id: number;
  frames: LiquidationMarketFrame[];
  events: ConfirmedLiquidationEvent[];
  rules: LiquidationInstrumentRules;
  settings: LiquidationFieldSettings;
  coverage: LiquidationCoverage;
}

export type LiquidationFieldWorkerResponse =
  | { id: number; snapshot: LiquidationFieldSnapshot }
  | { id: number; error: string };
