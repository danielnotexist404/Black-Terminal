import type { Candle } from "../../../chart-engine/types";
import type {
  ExchangeId,
  MarketKind,
  SymbolAssetClass,
  SymbolMetadata,
  Timeframe
} from "../../../market-data/types";

export type KioseffUnavailableReason =
  | "missing-request-range"
  | "missing-authoritative-tick-size"
  | "missing-intrabar-history"
  | "incomplete-intrabar-coverage"
  | "source-history-live-mismatch"
  | "adapter-symbol-category-mismatch"
  | "invalid-timestamp-units"
  | "rate-limited"
  | "unsupported-lower-timeframe"
  | "stale-source-generation"
  | "invalid-time-bucketing"
  | "unsupported-symbol-metadata"
  | "worker-failure";

export type IntrabarCoverage = {
  requestedChartBars: number;
  chartBarsWithCompleteIntrabars: number;
  chartBarsWithPartialIntrabars: number;
  chartBarsWithNoIntrabars: number;
  expectedIntrabars: number;
  receivedIntrabars: number;
  firstRequiredTime: number | null;
  lastRequiredTime: number | null;
  firstReceivedTime: number | null;
  lastReceivedTime: number | null;
  missingIntervals: number;
  duplicateIntervals: number;
  outOfOrderIntervals: number;
};

export type KioseffRequestRange = {
  start: number;
  end: number;
  intervalSeconds: number;
  expectedIntrabars: number;
};

export type KioseffWarmup = {
  completedChartBars: number;
  targetChartBars: number;
  full: boolean;
};

export type KioseffHistoryProgress =
  | {
      stage: "requesting-symbol-metadata";
      loaded: 0;
      target: 0;
    }
  | {
      stage: "fetching-intrabar-history";
      loaded: number;
      target: number;
      completedPages: number;
      targetPages: number;
      requestRange: KioseffRequestRange;
    }
  | {
      stage: "grouping-intrabars";
      bars: number;
      intrabars: number;
      requestRange: KioseffRequestRange;
    };

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
  coverage: IntrabarCoverage;
  requestRange: KioseffRequestRange;
  warmup: KioseffWarmup;
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
