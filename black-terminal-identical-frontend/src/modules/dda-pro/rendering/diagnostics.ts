import type { DDAProEngineMode, DDAProSeries } from "../core/types.ts";

export function nearestDDAProTailLabel(
  engineMode: DDAProEngineMode,
  series: Pick<DDAProSeries, "p05" | "p10" | "p25" | "p50" | "p75" | "p90" | "p95" | "p99">,
  index: number,
  depth: number
) {
  const candidates = engineMode === "pine-compatibility"
    ? [[series.p05[index], "P05"], [series.p10[index], "P10"], [series.p25[index], "P25"], [series.p50[index], "P50"]] as const
    : [[series.p99[index], "P99"], [series.p95[index], "P95"], [series.p90[index], "P90"], [series.p75[index], "P75"]] as const;
  for (const [rawThreshold, label] of candidates) {
    const threshold = Math.abs(rawThreshold ?? Number.NaN);
    if (Number.isFinite(threshold) && threshold > 0 && depth >= threshold) return label;
  }
  return "P50";
}

export function ddaProSigmaUnit(
  mean: number,
  lower: number,
  upper: number,
  encodedMultiplier: number,
  downsideOnly: boolean
) {
  if (!Number.isFinite(mean) || !Number.isFinite(lower) || !(encodedMultiplier > 0)) return Number.NaN;
  const lowerUnit = Math.abs(mean - lower) / encodedMultiplier;
  if (downsideOnly || !Number.isFinite(upper)) return lowerUnit;
  const upperUnit = Math.abs(upper - mean) / encodedMultiplier;
  const tolerance = Math.max(1e-9, Math.max(lowerUnit, upperUnit) * 1e-8);
  return Math.abs(lowerUnit - upperUnit) <= tolerance ? (lowerUnit + upperUnit) / 2 : lowerUnit;
}
