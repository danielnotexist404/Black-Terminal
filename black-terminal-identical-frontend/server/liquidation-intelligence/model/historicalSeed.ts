import type { BclifOpenInterestPoint } from "../contracts.ts";

export interface BclifHistoricalOiSeed {
  authority: "OFFICIAL_HISTORICAL_BACKFILL";
  modelAuthority: "REPLAY";
  establishedAt: number;
  baseline: BclifOpenInterestPoint;
  chronologicalDeltas: Array<{ timestamp: number; delta: number; availableAt: number }>;
  historicalCohortsCreated: 0;
  limitation: string;
}

/**
 * Chronologically validates official OI history and seeds the live delta
 * baseline without pretending the records were available in real time.
 * Historical cohort reconstruction remains disabled until versioned risk-rule
 * snapshots (known at each market timestamp) exist.
 */
export function prepareHistoricalOpenInterestSeed(points: readonly BclifOpenInterestPoint[], establishedAt = Date.now()): BclifHistoricalOiSeed | null {
  const ordered = [...points].sort((a, b) => a.timestamp - b.timestamp || a.availableAt - b.availableAt);
  if (!ordered.length) return null;
  const chronologicalDeltas: BclifHistoricalOiSeed["chronologicalDeltas"] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const point = ordered[index]!;
    if (point.availabilityMode !== "OFFICIAL_HISTORICAL_BACKFILL" || point.availableAt !== point.receivedTimestamp || point.availableAt > establishedAt || point.timestamp > establishedAt) {
      throw new Error("Historical OI seed contains unavailable or mislabeled observations");
    }
    if (index && point.timestamp <= ordered[index - 1]!.timestamp) throw new Error("Historical OI seed timestamps must be unique and chronological");
    if (index) chronologicalDeltas.push({
      timestamp: point.timestamp,
      delta: point.singleSideOpenInterest - ordered[index - 1]!.singleSideOpenInterest,
      availableAt: point.availableAt
    });
  }
  return {
    authority: "OFFICIAL_HISTORICAL_BACKFILL",
    modelAuthority: "REPLAY",
    establishedAt,
    baseline: ordered.at(-1)!,
    chronologicalDeltas,
    historicalCohortsCreated: 0,
    limitation: "OI baseline only: pre-observation risk-tier/trade history is unavailable, so historical exposure cohorts are not backdated."
  };
}

export function historicalObservationEligibleAt(point: BclifOpenInterestPoint, frameEnd: number, riskRulesKnownAt: number | null) {
  return point.timestamp <= frameEnd
    && point.availableAt <= frameEnd
    && riskRulesKnownAt !== null
    && riskRulesKnownAt <= point.timestamp;
}
