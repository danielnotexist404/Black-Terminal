import type { LiquidationFieldModelPreset, LiquidationMarketFrame } from "./types.ts";

export interface LeveragePrior {
  buckets: Array<{ leverage: number; probability: number }>;
  side: "LONG" | "SHORT" | "BOTH";
  source: "DEFAULT" | "CALIBRATED" | "ADAPTIVE" | "USER_DEFINED";
  confidence: number;
  version: string;
}

const bases: Record<Exclude<LiquidationFieldModelPreset, "CUSTOM">, Array<[number, number]>> = {
  CONSERVATIVE: [[2, 0.12], [3, 0.22], [5, 0.30], [10, 0.22], [20, 0.10], [50, 0.04]],
  BALANCED: [[2, 0.06], [3, 0.10], [5, 0.24], [10, 0.28], [20, 0.18], [50, 0.10], [100, 0.04]],
  VENUE_CALIBRATED: [[2, 0.05], [3, 0.08], [5, 0.20], [10, 0.28], [25, 0.20], [50, 0.13], [100, 0.06]],
  REGIME_ADAPTIVE: [[2, 0.05], [3, 0.08], [5, 0.20], [10, 0.28], [20, 0.20], [50, 0.13], [100, 0.06]]
};

function normalize(buckets: Array<{ leverage: number; probability: number }>) {
  const total = buckets.reduce((sum, bucket) => sum + Math.max(0, bucket.probability), 0) || 1;
  return buckets.map((bucket) => ({ ...bucket, probability: Math.max(0, bucket.probability) / total }));
}

export function createLeveragePrior(
  preset: LiquidationFieldModelPreset,
  frame: LiquidationMarketFrame,
  maximumVenueLeverage: number
): LeveragePrior {
  const selected = preset === "CUSTOM" ? bases.BALANCED : bases[preset];
  let buckets = selected
    .filter(([leverage]) => leverage <= maximumVenueLeverage)
    .map(([leverage, probability]) => ({ leverage, probability }));

  if (preset === "REGIME_ADAPTIVE") {
    const volatilityPressure = Math.max(0, Math.min(1, frame.realizedVolatility * 22));
    const oiExpansion = frame.openInterest > 0
      ? Math.max(0, Math.min(1, frame.openInterestDelta / frame.openInterest * 80))
      : 0;
    const fundingPressure = Math.max(0, Math.min(1, Math.abs(frame.fundingRate ?? 0) * 8_000));
    const speculative = Math.max(volatilityPressure, oiExpansion, fundingPressure);
    buckets = buckets.map((bucket) => ({
      ...bucket,
      probability: bucket.probability * (bucket.leverage >= 25
        ? 0.72 + speculative * 0.9
        : 1.18 - speculative * 0.28)
    }));
  }

  return {
    buckets: normalize(buckets),
    side: "BOTH",
    source: preset === "REGIME_ADAPTIVE" ? "ADAPTIVE" : preset === "VENUE_CALIBRATED" ? "CALIBRATED" : "DEFAULT",
    confidence: preset === "VENUE_CALIBRATED" ? 0.72 : preset === "REGIME_ADAPTIVE" ? 0.66 : 0.54,
    version: "BCLIF_LEVERAGE_PRIOR_V2"
  };
}
