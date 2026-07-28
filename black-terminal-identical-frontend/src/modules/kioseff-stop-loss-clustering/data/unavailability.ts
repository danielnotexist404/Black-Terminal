import type { Timeframe } from "../../../market-data/types";
import type { KioseffUnavailableReason } from "./types.ts";

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
  };
  realtimeSource: string;
  retryable: boolean;
  message: string;
};

const capabilityByReason: Record<KioseffUnavailableReason, string> = {
  "missing-authoritative-tick-size": "Authoritative exchange minimum tick",
  "missing-intrabar-history": "Ordered lower-timeframe history",
  "incomplete-intrabar-coverage": "Complete lower-timeframe coverage",
  "source-history-live-mismatch": "One certified history/realtime venue",
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
}): KioseffUnavailableDiagnostic {
  return {
    reason: input.reason,
    capability: capabilityByReason[input.reason],
    venue: input.venue,
    symbol: input.symbol,
    chartTimeframe: input.chartTimeframe,
    requestedLowerTimeframe: input.requestedLowerTimeframe,
    historyCoverage: {
      expected: input.expected ?? 0,
      actual: input.actual ?? 0,
      start: input.start ?? null,
      end: input.end ?? null
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
