import type { Candle } from "../../../chart-engine/types";
import type {
  ExchangeId,
  MarketKind,
  SymbolAssetClass,
  SymbolMetadata,
  Timeframe
} from "../../../market-data/types";

export type KioseffUnavailableReason =
  | "missing-authoritative-tick-size"
  | "missing-intrabar-history"
  | "incomplete-intrabar-coverage"
  | "source-history-live-mismatch"
  | "unsupported-lower-timeframe"
  | "stale-source-generation"
  | "invalid-time-bucketing"
  | "unsupported-symbol-metadata"
  | "worker-failure";

export type NormalizedCandle = Candle & {
  originalTime: string | number;
  source: string;
  sourceRevision: string;
};

export type IntrabarQualityReport = {
  complete: boolean;
  partial: boolean;
  expectedIntervalSeconds: number;
  expectedCount: number;
  actualCount: number;
  coverageStart: number | null;
  coverageEnd: number | null;
  missingTimes: number[];
  duplicateTimes: number[];
  outOfOrderTimes: number[];
  conflictingTimes: number[];
  sourceMismatch: boolean;
  flags: KioseffUnavailableReason[];
  notes: string[];
};

export type KioseffChartBarInput = {
  chartBar: NormalizedCandle;
  intrabars: NormalizedCandle[];
  chartBarClosed: boolean;
  sourceVersion: string;
  quality: IntrabarQualityReport;
};

export type KioseffSourceProvenance = {
  exchange: ExchangeId;
  rawSymbol: string;
  normalizedSymbol: string;
  assetClass: SymbolAssetClass;
  marketKind: MarketKind;
  chartTimeframe: Timeframe;
  lowerTimeframe: Timeframe;
  historicalSource: string;
  realtimeSource: string;
  transport: "browser" | "tauri" | "fixture";
  metadata: SymbolMetadata;
};

export type KioseffHistoryResult = {
  generation: number;
  sourceVersion: string;
  chartBars: KioseffChartBarInput[];
  provenance: KioseffSourceProvenance;
  quality: IntrabarQualityReport;
};

export class KioseffDataUnavailableError extends Error {
  readonly reason: KioseffUnavailableReason;
  readonly details: Record<string, unknown>;

  constructor(
    reason: KioseffUnavailableReason,
    details: Record<string, unknown> = {}
  ) {
    super(reason);
    this.name = "KioseffDataUnavailableError";
    this.reason = reason;
    this.details = details;
  }
}
