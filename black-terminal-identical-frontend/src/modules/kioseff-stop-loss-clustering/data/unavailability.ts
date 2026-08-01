import type { Timeframe } from "../../../market-data/types";
import type {
  IntrabarCoverage,
  KioseffUnavailableReason
} from "./types.ts";

export type KioseffUnavailableDiagnostic = {
  reason: KioseffUnavailableReason;
  capability: string;
  venue: string;
  symbol: string;
  chartTimeframe: Timeframe;
  requestedLowerTimeframe: Timeframe;
  historyCoverage: {
    expected: number;
    actual: number;
    start: number | null;
    end: number | null;
    requestedChartBars: number;
    completeChartBars: number;
    partialChartBars: number;
    missingChartBars: number;
    missingIntervals: number;
  };
  realtimeSource: string;
  retryable: boolean;
  message: string;
};

const capabilityByReason: Record<KioseffUnavailableReason, string> = {
  "missing-request-range": "Valid lower-timeframe request range",
  "missing-authoritative-tick-size": "Authoritative exchange minimum tick",
  "missing-intrabar-history": "Ordered lower-timeframe history",
  "incomplete-intrabar-coverage": "Complete lower-timeframe coverage",
  "source-history-live-mismatch": "One certified history/realtime venue",
  "adapter-symbol-category-mismatch": "Matching venue, symbol, and market category",
  "invalid-timestamp-units": "Integer-second exchange timestamps",
  "rate-limited": "Exchange history request capacity",
  "unsupported-lower-timeframe": "Supported fixed lower timeframe",
  "stale-source-generation": "Current immutable source generation",
  "invalid-time-bucketing": "Deterministic fixed-duration bucketing",
  "unsupported-symbol-metadata": "Certified symbol metadata",
  "worker-failure": "Dedicated calculation worker"
};

export function kioseffUnavailableDiagnostic(input: {
  reason: KioseffUnavailableReason;
  venue: string;
  symbol: string;
  chartTimeframe: Timeframe;
  requestedLowerTimeframe: Timeframe;
  expected?: number;
  actual?: number;
  start?: number | null;
  end?: number | null;
  realtimeSource?: string;
  message?: string;
  coverage?: IntrabarCoverage;
}): KioseffUnavailableDiagnostic {
  const coverage = input.coverage;
  return {
    reason: input.reason,
    capability: capabilityByReason[input.reason],
    venue: input.venue,
    symbol: input.symbol,
    chartTimeframe: input.chartTimeframe,
    requestedLowerTimeframe: input.requestedLowerTimeframe,
    historyCoverage: {
      expected: coverage?.expectedIntrabars ?? input.expected ?? 0,
      actual: coverage?.receivedIntrabars ?? input.actual ?? 0,
      start: coverage?.firstReceivedTime ?? input.start ?? null,
      end: coverage?.lastReceivedTime ?? input.end ?? null,
      requestedChartBars: coverage?.requestedChartBars ?? 0,
      completeChartBars: coverage?.chartBarsWithCompleteIntrabars ?? 0,
      partialChartBars: coverage?.chartBarsWithPartialIntrabars ?? 0,
      missingChartBars: coverage?.chartBarsWithNoIntrabars ?? 0,
      missingIntervals: coverage?.missingIntervals ?? 0
    },
    realtimeSource: input.realtimeSource ?? input.venue,
    retryable: ![
      "unsupported-lower-timeframe",
      "unsupported-symbol-metadata",
      "invalid-time-bucketing"
    ].includes(input.reason),
    message: input.message ?? capabilityByReason[input.reason]
  };
}
