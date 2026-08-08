import type { BclifCohortModelConfiguration, BclifOiMaterialityDecision } from "./types.ts";

export const BCLIF_OI_MATERIALITY_VERSION = "BCLIF_ROBUST_OI_CHANGE_V1";
export const DEFAULT_BCLIF_COHORT_CONFIGURATION: BclifCohortModelConfiguration = {
  oiNoiseMethod: "HYBRID_ROBUST",
  oiNoiseAbsoluteNotionalUsd: 100_000,
  oiNoisePercent: 0.000075,
  oiNoiseMadMultiplier: 3.5,
  isolatedContributionCap: 0.82,
  crossContributionCap: 0.12,
  unknownContributionCap: 0.06
};

export function classifyBclifOiChange(input: {
  delta: number;
  openInterest: number;
  markPrice: number;
  history: readonly number[];
  configuration: BclifCohortModelConfiguration;
}): BclifOiMaterialityDecision {
  const absoluteBaseFloor = input.configuration.oiNoiseAbsoluteNotionalUsd / Math.max(1e-9, input.markPrice);
  const percentageFloor = Math.max(0, input.openInterest) * input.configuration.oiNoisePercent;
  const robustFloor = robustMad(input.history) * input.configuration.oiNoiseMadMultiplier;
  const threshold = input.configuration.oiNoiseMethod === "ABSOLUTE_NOTIONAL" ? absoluteBaseFloor
    : input.configuration.oiNoiseMethod === "OI_PERCENT" ? percentageFloor
      : input.configuration.oiNoiseMethod === "ROBUST_MAD" ? robustFloor
        : Math.max(absoluteBaseFloor, percentageFloor, robustFloor);
  const material = Number.isFinite(input.delta) && Math.abs(input.delta) >= Math.max(1e-12, threshold);
  return {
    rawDelta: input.delta,
    effectiveDelta: material ? input.delta : 0,
    threshold,
    method: input.configuration.oiNoiseMethod,
    version: BCLIF_OI_MATERIALITY_VERSION,
    material
  };
}

export function validateBclifCohortConfiguration(value: BclifCohortModelConfiguration) {
  const caps = [value.isolatedContributionCap, value.crossContributionCap, value.unknownContributionCap];
  if (!Number.isFinite(value.oiNoiseAbsoluteNotionalUsd) || value.oiNoiseAbsoluteNotionalUsd < 0) throw new Error("Invalid BCLIF absolute OI noise floor");
  if (!Number.isFinite(value.oiNoisePercent) || value.oiNoisePercent < 0 || value.oiNoisePercent > 0.1) throw new Error("Invalid BCLIF percentage OI noise floor");
  if (!Number.isFinite(value.oiNoiseMadMultiplier) || value.oiNoiseMadMultiplier < 0 || value.oiNoiseMadMultiplier > 20) throw new Error("Invalid BCLIF OI MAD multiplier");
  if (caps.some((cap) => !Number.isFinite(cap) || cap < 0 || cap > 1) || Math.abs(caps.reduce((sum, cap) => sum + cap, 0) - 1) > 1e-9) {
    throw new Error("BCLIF margin contribution caps must conserve unit mass");
  }
}

function robustMad(values: readonly number[]) {
  const sample = values.filter(Number.isFinite).slice(-96).map(Math.abs).sort((left, right) => left - right);
  if (sample.length < 7) return 0;
  const center = median(sample);
  const deviations = sample.map((value) => Math.abs(value - center)).sort((left, right) => left - right);
  return median(deviations) * 1.4826;
}

function median(sorted: readonly number[]) {
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
