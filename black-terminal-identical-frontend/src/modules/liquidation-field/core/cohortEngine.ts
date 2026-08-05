import { confidenceForFrame } from "./certainty.ts";
import { bybitLiquidationInput, estimateBybitLinearLiquidationDistribution } from "./bybitLiquidationModel.ts";
import { createLeveragePrior } from "./leveragePriors.ts";
import type {
  ConfirmedLiquidationEvent,
  LiquidationExposureParticle,
  LiquidationFieldModelPreset,
  LiquidationInstrumentRules,
  LiquidationMarketFrame,
  LiquidationPositionCohort
} from "./types.ts";
import { BCLIF_MODEL_VERSION } from "./types.ts";

const MAX_ACTIVE_COHORTS = 640;
const MAX_PARTICLES = 4_096;
const MARGIN_MODE_PRIOR = [
  { model: "ISOLATED" as const, label: "ISOLATED_ESTIMATE", weight: 0.72 },
  { model: "UNKNOWN" as const, label: "CROSS_ESTIMATE", weight: 0.28 }
] as const;

function weightedMean(values: Array<{ value: number; weight: number }>) {
  const total = values.reduce((sum, item) => sum + item.weight, 0) || 1;
  return values.reduce((sum, item) => sum + item.value * item.weight, 0) / total;
}

function weightedDeviation(values: Array<{ value: number; weight: number }>, mean: number) {
  const total = values.reduce((sum, item) => sum + item.weight, 0) || 1;
  return Math.sqrt(values.reduce((sum, item) => sum + (item.value - mean) ** 2 * item.weight, 0) / total);
}

function cohortId(frame: LiquidationMarketFrame, side: "LONG" | "SHORT", ordinal: number) {
  return `${frame.venue}:${frame.symbol}:${frame.timestamp}:${side}:${ordinal}`;
}

function gaussianLikelihood(value: number, mean: number, deviation: number) {
  const sigma = Math.max(1e-9, deviation);
  const z = (value - mean) / sigma;
  return Math.exp(-0.5 * z * z);
}

export class LiquidationCohortEngine {
  private readonly rules: LiquidationInstrumentRules;
  private readonly modelPreset: LiquidationFieldModelPreset;
  private cohorts: LiquidationPositionCohort[] = [];
  private particles: LiquidationExposureParticle[] = [];
  private previousFrame?: LiquidationMarketFrame;
  private cohortOrdinal = 0;
  private traversedCohorts = new Set<string>();

  constructor(rules: LiquidationInstrumentRules, modelPreset: LiquidationFieldModelPreset) {
    this.rules = rules;
    this.modelPreset = modelPreset;
  }

  reset() {
    this.cohorts = [];
    this.particles = [];
    this.previousFrame = undefined;
    this.cohortOrdinal = 0;
    this.traversedCohorts.clear();
  }

  processFrame(frame: LiquidationMarketFrame, events: readonly ConfirmedLiquidationEvent[] = []) {
    this.propagate(frame);
    if (frame.openInterestDelta > 0 && frame.openInterest > 0) this.createPairedCohorts(frame);
    if (frame.openInterestDelta < 0 && this.previousFrame?.openInterest) this.reduceFromOiContraction(frame);
    for (const event of events) {
      if (event.timestamp > (this.previousFrame?.timestamp ?? -Infinity) && event.timestamp <= frame.timestamp) {
        this.assimilateConfirmedEvent(event);
      }
    }
    this.prune();
    this.previousFrame = frame;
    return this.snapshot();
  }

  snapshot() {
    return {
      cohorts: this.cohorts.map((cohort) => ({ ...cohort, riskTierDistribution: [...cohort.riskTierDistribution] })),
      particles: this.particles.map((particle) => ({ ...particle }))
    };
  }

  private createPairedCohorts(frame: LiquidationMarketFrame) {
    const prior = createLeveragePrior(this.modelPreset, frame, this.rules.maxLeverage);
    const grossNotionalPerSide = Math.max(0, frame.openInterestDelta * frame.markPrice * this.rules.contractMultiplier);
    if (grossNotionalPerSide <= 0) return;
    const flowTotal = frame.aggressiveBuyNotional + frame.aggressiveSellNotional;
    const flowBias = flowTotal > 0 ? (frame.aggressiveBuyNotional - frame.aggressiveSellNotional) / flowTotal : 0;
    const entrySigma = Math.max(frame.markPrice * 0.0008, frame.markPrice * Math.max(frame.realizedVolatility, frame.parkinsonVolatility) * 0.55);
    const frameConfidence = confidenceForFrame(frame).total / 100;

    for (const side of ["LONG", "SHORT"] as const) {
      const sideBias = side === "LONG" ? flowBias : -flowBias;
      const vulnerability = Math.max(0.72, Math.min(1.28, 1 - sideBias * 0.18));
      const entryMean = frame.markPrice * (1 + (side === "LONG" ? 1 : -1) * flowBias * Math.max(0.0001, frame.realizedVolatility) * 0.12);
      const id = cohortId(frame, side, this.cohortOrdinal++);
      const cohortParticles: LiquidationExposureParticle[] = [];
      const cohortNotional = grossNotionalPerSide * vulnerability;

      for (const bucket of prior.buckets) {
        for (const margin of MARGIN_MODE_PRIOR) {
          const particleWeight = bucket.probability * margin.weight;
          const allocatedNotional = cohortNotional * particleWeight;
          if (allocatedNotional <= 0) continue;
          const distribution = estimateBybitLinearLiquidationDistribution(
            bybitLiquidationInput(side, entryMean, frame.markPrice, allocatedNotional, bucket.leverage, this.rules, margin.model)
          );
          const tier = [...this.rules.riskTiers]
            .sort((a, b) => a.riskLimitValue - b.riskLimitValue)
            .find((candidate) => allocatedNotional <= candidate.riskLimitValue) ?? this.rules.riskTiers.at(-1);
          cohortParticles.push({
            cohortId: id,
            side,
            entryPrice: entryMean,
            leverage: bucket.leverage,
            marginMode: margin.label,
            riskTier: tier?.tierId ?? "UNAVAILABLE",
            notional: cohortNotional,
            liquidationPrice: distribution.mean,
            liquidationStdDev: distribution.standardDeviation,
            survival: 1,
            weight: particleWeight,
            confidence: Math.max(0.08, frameConfidence * prior.confidence * distribution.confidence)
          });
        }
      }

      if (!cohortParticles.length) continue;
      const leverageMean = weightedMean(cohortParticles.map((particle) => ({ value: particle.leverage, weight: particle.weight })));
      const liquidationMean = weightedMean(cohortParticles.map((particle) => ({ value: particle.liquidationPrice, weight: particle.weight })));
      const leverageStdDev = weightedDeviation(cohortParticles.map((particle) => ({ value: particle.leverage, weight: particle.weight })), leverageMean);
      const liquidationStdDev = weightedDeviation(
        cohortParticles.map((particle) => ({
          value: particle.liquidationPrice,
          weight: particle.weight + particle.liquidationStdDev / Math.max(1, frame.markPrice)
        })),
        liquidationMean
      ) + weightedMean(cohortParticles.map((particle) => ({ value: particle.liquidationStdDev, weight: particle.weight })));
      const confidence = weightedMean(cohortParticles.map((particle) => ({ value: particle.confidence, weight: particle.weight })));
      const cohort: LiquidationPositionCohort = {
        id,
        venue: frame.venue,
        symbol: frame.symbol,
        side,
        createdAt: frame.timestamp,
        updatedAt: frame.timestamp,
        entryMean,
        entryStdDev: entrySigma,
        entryLower: entryMean - entrySigma * 2,
        entryUpper: entryMean + entrySigma * 2,
        leverageMean,
        leverageStdDev,
        leverageLower: Math.min(...cohortParticles.map((particle) => particle.leverage)),
        leverageUpper: Math.max(...cohortParticles.map((particle) => particle.leverage)),
        estimatedInitialNotional: cohortNotional,
        estimatedRemainingNotional: cohortNotional,
        marginMode: "MIXED",
        riskTierDistribution: this.riskTierDistribution(cohortParticles),
        liquidationMean,
        liquidationStdDev,
        liquidationLower: Math.max(0, liquidationMean - liquidationStdDev * 2.2),
        liquidationUpper: liquidationMean + liquidationStdDev * 2.2,
        survivalProbability: 1,
        posteriorWeight: 1,
        confidence,
        state: "FORMING",
        modelVersion: BCLIF_MODEL_VERSION
      };
      this.cohorts.push(cohort);
      this.particles.push(...cohortParticles);
    }
  }

  private riskTierDistribution(particles: LiquidationExposureParticle[]) {
    const totals = new Map<string, number>();
    for (const particle of particles) totals.set(particle.riskTier, (totals.get(particle.riskTier) ?? 0) + particle.weight);
    const total = [...totals.values()].reduce((sum, value) => sum + value, 0) || 1;
    return [...totals.entries()].map(([tierId, weight]) => ({ tierId, weight: weight / total }));
  }

  private propagate(frame: LiquidationMarketFrame) {
    if (!this.previousFrame) return;
    const elapsedHours = Math.max(0, (frame.timestamp - this.previousFrame.timestamp) / 3_600_000);
    const volatilityDecay = Math.max(frame.realizedVolatility, frame.parkinsonVolatility) * 0.45;
    const decay = Math.exp(-elapsedHours * (0.0018 + volatilityDecay));
    for (const cohort of this.cohorts) {
      if (["LIQUIDATED", "EXPIRED", "INVALIDATED"].includes(cohort.state)) continue;
      cohort.updatedAt = frame.timestamp;
      cohort.survivalProbability *= decay;
      cohort.estimatedRemainingNotional *= decay;
      if (cohort.state === "FORMING") cohort.state = "ACTIVE";
      const previousMark = this.previousFrame.markPrice;
      const crossedLiquidationCore = cohort.side === "LONG"
        ? previousMark > cohort.liquidationMean && frame.markPrice <= cohort.liquidationMean
        : previousMark < cohort.liquidationMean && frame.markPrice >= cohort.liquidationMean;
      if (crossedLiquidationCore && !this.traversedCohorts.has(cohort.id)) {
        this.traversedCohorts.add(cohort.id);
        cohort.state = "PARTIALLY_LIQUIDATED";
        cohort.survivalProbability *= 0.82;
        cohort.estimatedRemainingNotional *= 0.82;
      }
      if (cohort.survivalProbability < 0.035 || cohort.estimatedRemainingNotional < 1) cohort.state = "EXPIRED";
    }
    const cohortById = new Map(this.cohorts.map((cohort) => [cohort.id, cohort]));
    for (const particle of this.particles) {
      const cohort = cohortById.get(particle.cohortId);
      particle.survival = cohort?.survivalProbability ?? 0;
      particle.notional = Math.min(particle.notional, cohort?.estimatedRemainingNotional ?? 0);
    }
  }

  private reduceFromOiContraction(frame: LiquidationMarketFrame) {
    const previousOi = Math.max(1e-9, this.previousFrame?.openInterest ?? frame.openInterest);
    const contraction = Math.max(0, Math.min(0.95, Math.abs(frame.openInterestDelta) / previousOi));
    for (const cohort of this.cohorts) {
      if (["LIQUIDATED", "EXPIRED", "INVALIDATED"].includes(cohort.state)) continue;
      const distance = Math.abs(cohort.entryMean - frame.markPrice) / Math.max(1, frame.markPrice);
      const voluntaryCloseLikelihood = Math.max(0.35, Math.min(1, 0.55 + distance * 4));
      const reduction = contraction * voluntaryCloseLikelihood;
      cohort.estimatedRemainingNotional *= 1 - reduction;
      cohort.survivalProbability *= 1 - reduction * 0.72;
      cohort.state = cohort.survivalProbability < 0.12 ? "LIKELY_CLOSED" : "REDUCING";
    }
    const cohortById = new Map(this.cohorts.map((cohort) => [cohort.id, cohort]));
    for (const particle of this.particles) {
      const cohort = cohortById.get(particle.cohortId);
      if (cohort) {
        particle.survival = cohort.survivalProbability;
        particle.notional *= 1 - contraction;
      }
    }
  }

  private assimilateConfirmedEvent(event: ConfirmedLiquidationEvent) {
    const matching = this.cohorts.filter((cohort) =>
      cohort.side === event.liquidatedPositionSide &&
      !["LIQUIDATED", "EXPIRED", "INVALIDATED"].includes(cohort.state)
    );
    const likelihoods = matching.map((cohort) => ({
      cohort,
      likelihood: gaussianLikelihood(event.bankruptcyPrice, cohort.liquidationMean, cohort.liquidationStdDev)
    }));
    const totalLikelihood = likelihoods.reduce((sum, item) => sum + item.likelihood, 0) || 1;
    for (const { cohort, likelihood } of likelihoods) {
      const share = likelihood / totalLikelihood;
      const removed = Math.min(cohort.estimatedRemainingNotional, event.notional * share);
      cohort.estimatedRemainingNotional -= removed;
      cohort.survivalProbability *= 1 - Math.min(0.95, removed / Math.max(1, cohort.estimatedInitialNotional));
      cohort.posteriorWeight *= 0.7 + likelihood * 0.6;
      cohort.confidence = Math.min(0.98, cohort.confidence + likelihood * 0.12);
      cohort.state = cohort.survivalProbability < 0.06 ? "LIQUIDATED" : "PARTIALLY_LIQUIDATED";
    }
    for (const particle of this.particles) {
      if (particle.side !== event.liquidatedPositionSide) continue;
      const likelihood = gaussianLikelihood(event.bankruptcyPrice, particle.liquidationPrice, particle.liquidationStdDev);
      particle.weight *= 0.5 + likelihood;
      particle.notional *= 1 - Math.min(0.95, event.notional * likelihood / Math.max(1, particle.notional));
    }
    this.normalizeParticleWeights();
  }

  private normalizeParticleWeights() {
    const byCohort = new Map<string, LiquidationExposureParticle[]>();
    for (const particle of this.particles) {
      const current = byCohort.get(particle.cohortId) ?? [];
      current.push(particle);
      byCohort.set(particle.cohortId, current);
    }
    for (const particles of byCohort.values()) {
      const total = particles.reduce((sum, particle) => sum + Math.max(0, particle.weight), 0) || 1;
      for (const particle of particles) particle.weight = Math.max(0, particle.weight) / total;
    }
  }

  private prune() {
    const activeIds = new Set(
      this.cohorts
        .filter((cohort) => !["EXPIRED", "INVALIDATED"].includes(cohort.state))
        .sort((a, b) => b.estimatedRemainingNotional * b.survivalProbability - a.estimatedRemainingNotional * a.survivalProbability)
        .slice(0, MAX_ACTIVE_COHORTS)
        .map((cohort) => cohort.id)
    );
    this.cohorts = this.cohorts.filter((cohort) => activeIds.has(cohort.id));
    for (const cohortId of this.traversedCohorts) {
      if (!activeIds.has(cohortId)) this.traversedCohorts.delete(cohortId);
    }
    this.particles = this.particles
      .filter((particle) => activeIds.has(particle.cohortId) && particle.notional > 0 && particle.survival > 0)
      .sort((a, b) => b.notional * b.weight * b.survival - a.notional * a.weight * a.survival)
      .slice(0, MAX_PARTICLES);
  }
}
