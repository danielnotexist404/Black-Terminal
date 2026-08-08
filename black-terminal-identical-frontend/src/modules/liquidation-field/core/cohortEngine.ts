import { confidenceForFrame } from "./certainty.ts";
import { bybitLiquidationInput, estimateBybitLinearLiquidationDistribution } from "./bybitLiquidationModel.ts";
import { buildCohortEntryDistribution, entryDistributionMoments, validateEntryDistribution } from "./entryDistribution.ts";
import { createLeveragePrior } from "./leveragePriors.ts";
import {
  classifyBclifOiChange,
  DEFAULT_BCLIF_COHORT_CONFIGURATION,
  validateBclifCohortConfiguration
} from "./oiMateriality.ts";
import type {
  BclifCohortLifecycleEvent,
  BclifCohortModelConfiguration,
  BclifModelMassLedger,
  CohortEntryDistribution,
  ConfirmedLiquidationEvent,
  LiquidationCohortEngineState,
  LiquidationExposureParticle,
  LiquidationFieldModelPreset,
  LiquidationInstrumentRules,
  LiquidationMarketFrame,
  LiquidationPositionCohort
} from "./types.ts";
import { BCLIF_MODEL_VERSION } from "./types.ts";

const MAX_ACTIVE_COHORTS = 320;
const MAX_PARTICLES = 24_576;
const MAX_LIFECYCLE_EVENTS = 4_096;
const MAX_OI_DELTA_HISTORY = 192;
export const BCLIF_CLOSURE_ALLOCATION_VERSION = "BCLIF_DETERMINISTIC_CLOSURE_ALLOCATION_V1";

function weightedMean(values: Array<{ value: number; weight: number }>) {
  const total = values.reduce((sum, item) => sum + item.weight, 0) || 1;
  return values.reduce((sum, item) => sum + item.value * item.weight, 0) / total;
}

function weightedDeviation(values: Array<{ value: number; weight: number }>, mean: number) {
  const total = values.reduce((sum, item) => sum + item.weight, 0) || 1;
  return Math.sqrt(values.reduce((sum, item) => sum + (item.value - mean) ** 2 * item.weight, 0) / total);
}

function deterministicHash(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function cohortId(input: {
  frame: LiquidationMarketFrame;
  side: "LONG" | "SHORT";
  distribution: CohortEntryDistribution;
  leveragePriorVersion: string;
}) {
  return [
    input.frame.venue,
    input.frame.symbol,
    input.side,
    input.distribution.intervalStart,
    input.distribution.intervalEnd,
    input.distribution.hash,
    input.leveragePriorVersion,
    BCLIF_MODEL_VERSION
  ].join(":") + `:${deterministicHash(input.distribution.hash + input.side + input.leveragePriorVersion + BCLIF_MODEL_VERSION)}`;
}

function gaussianLikelihood(value: number, mean: number, deviation: number) {
  const sigma = Math.max(1e-9, deviation);
  const z = (value - mean) / sigma;
  return Math.exp(-0.5 * z * z);
}

function emptyMassLedger(): BclifModelMassLedger {
  return {
    totalCreatedMass: 0,
    voluntaryClosureMass: 0,
    confirmedLiquidationMass: 0,
    decayExpiryMass: 0,
    totalRemainingMass: 0,
    conservationError: 0,
    tolerance: 0.01
  };
}

export class LiquidationCohortEngine {
  private readonly rules: LiquidationInstrumentRules;
  private readonly modelPreset: LiquidationFieldModelPreset;
  private configuration: BclifCohortModelConfiguration;
  private cohorts: LiquidationPositionCohort[] = [];
  private particles: LiquidationExposureParticle[] = [];
  private previousFrame?: LiquidationMarketFrame;
  private cohortOrdinal = 0;
  private traversedCohorts = new Set<string>();
  private oiDeltaHistory: number[] = [];
  private massLedger = emptyMassLedger();
  private lifecycleEvents: BclifCohortLifecycleEvent[] = [];

  constructor(
    rules: LiquidationInstrumentRules,
    modelPreset: LiquidationFieldModelPreset,
    configuration: Partial<BclifCohortModelConfiguration> = {}
  ) {
    this.rules = rules;
    this.modelPreset = modelPreset;
    this.configuration = normalizedConfiguration({ ...DEFAULT_BCLIF_COHORT_CONFIGURATION, ...configuration });
  }

  reset() {
    this.cohorts = [];
    this.particles = [];
    this.previousFrame = undefined;
    this.cohortOrdinal = 0;
    this.traversedCohorts.clear();
    this.oiDeltaHistory = [];
    this.massLedger = emptyMassLedger();
    this.lifecycleEvents = [];
  }

  processFrame(frame: LiquidationMarketFrame, events: readonly ConfirmedLiquidationEvent[] = []) {
    if (this.previousFrame && frame.timestamp <= this.previousFrame.timestamp) throw new Error("BCLIF cohort clock must advance monotonically");
    this.propagate(frame);
    const openInterestUsable = frame.certainty.openInterest !== "UNAVAILABLE"
      && frame.certainty.openInterest !== "MISSING";
    const materiality = classifyBclifOiChange({
      delta: openInterestUsable ? frame.openInterestDelta : 0,
      openInterest: frame.openInterest,
      markPrice: frame.markPrice,
      history: this.oiDeltaHistory,
      configuration: this.configuration
    });
    const isOiObservation = frame.oiIntervalStart !== undefined && frame.oiIntervalEnd !== undefined;
    if (isOiObservation) {
      this.oiDeltaHistory.push(frame.openInterestDelta);
      if (this.oiDeltaHistory.length > MAX_OI_DELTA_HISTORY) this.oiDeltaHistory.splice(0, this.oiDeltaHistory.length - MAX_OI_DELTA_HISTORY);
    }
    const canonicalFrame = { ...frame, oiMateriality: materiality };
    if (isOiObservation && openInterestUsable && materiality.effectiveDelta > 0 && frame.openInterest > 0) {
      this.createPairedCohorts(canonicalFrame, materiality.effectiveDelta);
    }
    if (isOiObservation && openInterestUsable && materiality.effectiveDelta < 0 && this.previousFrame?.openInterest) {
      this.reduceFromOiContraction(canonicalFrame, materiality.effectiveDelta);
    }
    for (const event of events) {
      const knownAt = Math.max(event.timestamp, event.receivedAt);
      if (knownAt > (this.previousFrame?.timestamp ?? -Infinity) && knownAt <= frame.timestamp) this.assimilateConfirmedEvent(event);
    }
    this.prune(frame.timestamp);
    this.reconcileMass();
    this.previousFrame = cloneFrame(canonicalFrame);
    return this.snapshot();
  }

  snapshot() {
    return {
      cohorts: this.cohorts.map(cloneCohort),
      particles: this.particles.map((particle) => ({ ...particle })),
      massLedger: { ...this.massLedger },
      lifecycleEvents: this.lifecycleEvents.map((event) => ({ ...event }))
    };
  }

  exportState(): LiquidationCohortEngineState {
    return {
      schemaVersion: 2,
      modelVersion: BCLIF_MODEL_VERSION,
      sourceVersion: this.rules.sourceVersion,
      modelPreset: this.modelPreset,
      previousFrame: this.previousFrame ? cloneFrame(this.previousFrame) : null,
      cohortOrdinal: this.cohortOrdinal,
      cohorts: this.cohorts.map(cloneCohort),
      particles: this.particles.map((particle) => ({ ...particle })),
      traversedCohortIds: [...this.traversedCohorts].sort(),
      oiDeltaHistory: [...this.oiDeltaHistory],
      configuration: { ...this.configuration },
      massLedger: { ...this.massLedger },
      lifecycleEvents: this.lifecycleEvents.map((event) => ({ ...event }))
    };
  }

  importState(state: LiquidationCohortEngineState) {
    validateCheckpointState(state, this.rules.sourceVersion, this.modelPreset);
    this.previousFrame = state.previousFrame ? cloneFrame(state.previousFrame) : undefined;
    this.cohortOrdinal = state.cohortOrdinal;
    this.cohorts = state.cohorts.map(cloneCohort);
    this.particles = state.particles.map((particle) => ({ ...particle }));
    this.traversedCohorts = new Set(state.traversedCohortIds);
    this.oiDeltaHistory = [...state.oiDeltaHistory];
    this.configuration = { ...state.configuration };
    this.massLedger = { ...state.massLedger };
    this.lifecycleEvents = state.lifecycleEvents.map((event) => ({ ...event }));
    this.reconcileMass();
  }

  private createPairedCohorts(frame: LiquidationMarketFrame, effectiveDelta: number) {
    const prior = createLeveragePrior(this.modelPreset, frame, this.rules.maxLeverage);
    const grossNotionalPerSide = Math.max(0, effectiveDelta * frame.markPrice * this.rules.contractMultiplier);
    if (grossNotionalPerSide <= 0) return;
    const distribution = this.entryDistributionFor(frame);
    validateEntryDistribution(distribution);
    const moments = entryDistributionMoments(distribution);
    const marginPrior = [
      { model: "ISOLATED" as const, label: "ISOLATED_ESTIMATE" as const, weight: this.configuration.isolatedContributionCap },
      { model: "CROSS" as const, label: "CROSS_ESTIMATE" as const, weight: this.configuration.crossContributionCap },
      { model: "UNKNOWN" as const, label: "UNKNOWN" as const, weight: this.configuration.unknownContributionCap }
    ].filter((margin) => margin.weight > 0);
    const frameConfidence = confidenceForFrame(frame).total / 100;

    for (const side of ["LONG", "SHORT"] as const) {
      const id = cohortId({ frame, side, distribution, leveragePriorVersion: prior.version });
      if (this.cohorts.some((cohort) => cohort.id === id)) continue;
      const cohortParticles: LiquidationExposureParticle[] = [];
      for (let entryIndex = 0; entryIndex < distribution.priceRows.length; entryIndex += 1) {
        const entryPrice = distribution.priceRows[entryIndex]!;
        const entryWeight = distribution.weights[entryIndex]!;
        for (const bucket of prior.buckets) {
          for (const margin of marginPrior) {
            const particleWeight = entryWeight * bucket.probability * margin.weight;
            const allocatedNotional = grossNotionalPerSide * particleWeight;
            if (allocatedNotional <= 0) continue;
            const liquidation = estimateBybitLinearLiquidationDistribution(
              bybitLiquidationInput(side, entryPrice, frame.markPrice, allocatedNotional, bucket.leverage, this.rules, margin.model)
            );
            const tier = [...this.rules.riskTiers]
              .sort((left, right) => left.riskLimitValue - right.riskLimitValue)
              .find((candidate) => allocatedNotional <= candidate.riskLimitValue) ?? this.rules.riskTiers.at(-1);
            const sourceCap = distribution.source === "EXACT_TRADES" ? 0.95
              : distribution.source === "LOWER_TF_VOLUME_AT_PRICE" ? 0.82
                : distribution.source === "LOWER_TF_APPROXIMATION" ? 0.6 : 0.42;
            const browserHistoricalCap = frame.certainty.trades === "UNAVAILABLE" || frame.certainty.trades === "MISSING" ? 0.6 : 1;
            const confidence = Math.max(0.04, Math.min(sourceCap, browserHistoricalCap,
              frameConfidence * prior.confidence * distribution.confidence * liquidation.confidence));
            cohortParticles.push({
              cohortId: id,
              side,
              entryPrice,
              leverage: bucket.leverage,
              marginMode: margin.label,
              riskTier: tier?.tierId ?? "UNAVAILABLE",
              notional: grossNotionalPerSide,
              liquidationPrice: liquidation.mean,
              liquidationStdDev: liquidation.standardDeviation,
              survival: 1,
              weight: particleWeight,
              confidence,
              entrySource: distribution.source,
              uncertaintyClass: margin.label
            });
          }
        }
      }
      if (!cohortParticles.length) continue;
      const leverageMean = weightedMean(cohortParticles.map((particle) => ({ value: particle.leverage, weight: particle.weight })));
      const liquidationMean = weightedMean(cohortParticles.map((particle) => ({ value: particle.liquidationPrice, weight: particle.weight })));
      const leverageStdDev = weightedDeviation(cohortParticles.map((particle) => ({ value: particle.leverage, weight: particle.weight })), leverageMean);
      const liquidationStdDev = weightedDeviation(cohortParticles.map((particle) => ({ value: particle.liquidationPrice, weight: particle.weight })), liquidationMean)
        + weightedMean(cohortParticles.map((particle) => ({ value: particle.liquidationStdDev, weight: particle.weight })));
      const confidence = weightedMean(cohortParticles.map((particle) => ({ value: particle.confidence, weight: particle.weight })));
      const birth = lifecycleEvent(id, frame.timestamp, "BIRTH", 0, null,
        `Material positive OI (${effectiveDelta.toFixed(8)}) allocated from ${distribution.source} interval ${distribution.intervalStart}-${distribution.intervalEnd}`);
      const cohort: LiquidationPositionCohort = {
        id,
        venue: frame.venue,
        symbol: frame.symbol,
        side,
        createdAt: frame.timestamp,
        updatedAt: frame.timestamp,
        sourceIntervalStart: distribution.intervalStart,
        sourceIntervalEnd: distribution.intervalEnd,
        initialOpenMass: grossNotionalPerSide,
        remainingMass: grossNotionalPerSide,
        massUnit: "QUOTE_NOTIONAL",
        entryDistribution: cloneDistribution(distribution),
        leverageDistribution: prior.buckets.map((bucket) => ({ ...bucket })),
        evidenceChannels: evidenceChannels(frame, distribution),
        creationReason: birth.reason,
        fundingAdjustmentBps: 0,
        lastLifecycleEvent: birth,
        entryMean: moments.mean,
        entryStdDev: Math.max(moments.standardDeviation, moments.mean * (distribution.source === "EXACT_TRADES" ? 0.0002 : 0.0008)),
        entryLower: Math.min(...distribution.priceRows),
        entryUpper: Math.max(...distribution.priceRows),
        leverageMean,
        leverageStdDev,
        leverageLower: Math.min(...cohortParticles.map((particle) => particle.leverage)),
        leverageUpper: Math.max(...cohortParticles.map((particle) => particle.leverage)),
        estimatedInitialNotional: grossNotionalPerSide,
        estimatedRemainingNotional: grossNotionalPerSide,
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
      this.cohortOrdinal += 1;
      this.cohorts.push(cohort);
      this.particles.push(...cohortParticles);
      this.massLedger.totalCreatedMass += grossNotionalPerSide;
      this.recordLifecycle(birth);
    }
  }

  private entryDistributionFor(frame: LiquidationMarketFrame) {
    if (frame.entryDistribution) {
      if (frame.oiIntervalStart !== frame.entryDistribution.intervalStart
        || frame.oiIntervalEnd !== frame.entryDistribution.intervalEnd) {
        throw new Error("BCLIF entry distribution is not anchored to its OI observation interval");
      }
      return cloneDistribution(frame.entryDistribution);
    }
    const intervalEnd = frame.oiIntervalEnd ?? frame.timestamp;
    const intervalStart = Math.min(intervalEnd - 1, frame.oiIntervalStart ?? this.previousFrame?.timestamp ?? intervalEnd - 1);
    return buildCohortEntryDistribution({
      observations: [{ price: frame.markPrice, weight: 1 }],
      source: "CHART_BAR_APPROXIMATION",
      intervalStart,
      intervalEnd,
      confidence: 0.32,
      fallbackPrice: frame.markPrice,
      maximumRows: 1
    });
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
    const decayRate = 0.00035 + Math.max(0, Math.min(0.002, frame.realizedVolatility * 0.04));
    const survivalFactor = Math.exp(-elapsedHours * decayRate);
    for (const cohort of this.cohorts) {
      if (["LIQUIDATED", "EXPIRED", "INVALIDATED"].includes(cohort.state)) continue;
      cohort.updatedAt = frame.timestamp;
      const before = cohort.estimatedRemainingNotional;
      const after = before * survivalFactor;
      const removed = Math.max(0, before - after);
      cohort.estimatedRemainingNotional = after;
      cohort.remainingMass = after;
      cohort.survivalProbability = Math.max(0, cohort.survivalProbability * survivalFactor);
      this.massLedger.decayExpiryMass += removed;
      if (cohort.state === "FORMING") cohort.state = "ACTIVE";
      const previousMark = this.previousFrame.markPrice;
      const crossedLiquidationCore = cohort.side === "LONG"
        ? previousMark > cohort.liquidationMean && frame.markPrice <= cohort.liquidationMean
        : previousMark < cohort.liquidationMean && frame.markPrice >= cohort.liquidationMean;
      if (crossedLiquidationCore && !this.traversedCohorts.has(cohort.id)) {
        this.traversedCohorts.add(cohort.id);
        const eventCoverageMissing = frame.certainty.confirmedLiquidations === "UNAVAILABLE"
          || frame.certainty.confirmedLiquidations === "MISSING";
        if (eventCoverageMissing) {
          const unresolvedRemoved = cohort.estimatedRemainingNotional * 0.1;
          cohort.estimatedRemainingNotional -= unresolvedRemoved;
          cohort.remainingMass = cohort.estimatedRemainingNotional;
          cohort.survivalProbability *= 0.88;
          cohort.confidence *= 0.72;
          cohort.state = "PARTIALLY_LIQUIDATED";
          this.massLedger.decayExpiryMass += unresolvedRemoved;
          const event = lifecycleEvent(cohort.id, frame.timestamp, "UNRESOLVED_TRAVERSAL", unresolvedRemoved, null,
            "Price traversed the estimated shelf while confirmed-liquidation coverage was unavailable; outcome remains uncertain");
          cohort.lastLifecycleEvent = event;
          this.recordLifecycle(event);
        }
      }
      if (cohort.survivalProbability < 0.035 || cohort.estimatedRemainingNotional < 1) this.expireCohort(cohort, frame.timestamp, "Cohort fell below survival or mass floor");
    }
    this.syncParticlesToCohorts();
  }

  private reduceFromOiContraction(frame: LiquidationMarketFrame, effectiveDelta: number) {
    const closeNotionalPerSide = Math.abs(effectiveDelta) * frame.markPrice * this.rules.contractMultiplier;
    for (const side of ["LONG", "SHORT"] as const) {
      const active = this.cohorts.filter((cohort) => cohort.side === side
        && !["LIQUIDATED", "EXPIRED", "INVALIDATED"].includes(cohort.state)
        && cohort.estimatedRemainingNotional > 0);
      let remainingTarget = Math.min(closeNotionalPerSide, active.reduce((sum, cohort) => sum + cohort.estimatedRemainingNotional, 0));
      const targetAtStart = remainingTarget;
      let pool = [...active];
      for (let pass = 0; pass < 8 && remainingTarget > 1e-8 && pool.length; pass += 1) {
        const weights = pool.map((cohort) => ({ cohort, score: closureScore(cohort, frame) }));
        const scoreTotal = weights.reduce((sum, item) => sum + item.score, 0) || weights.length;
        let removedThisPass = 0;
        for (const { cohort, score } of weights) {
          const requested = remainingTarget * score / scoreTotal;
          const removed = Math.min(cohort.estimatedRemainingNotional, requested);
          if (!(removed > 0)) continue;
          this.removeMass(cohort, removed);
          cohort.survivalProbability *= Math.max(0, 1 - removed / Math.max(1, cohort.estimatedInitialNotional) * 0.72);
          cohort.state = cohort.survivalProbability < 0.12 ? "LIKELY_CLOSED" : "REDUCING";
          const event = lifecycleEvent(cohort.id, frame.timestamp, "OI_CONTRACTION", removed, null,
            `${BCLIF_CLOSURE_ALLOCATION_VERSION}: material negative OI allocated by age, price/entry distance, profitability and survival`);
          cohort.lastLifecycleEvent = event;
          this.recordLifecycle(event);
          removedThisPass += removed;
        }
        remainingTarget -= removedThisPass;
        pool = pool.filter((cohort) => cohort.estimatedRemainingNotional > 1e-8);
        if (removedThisPass <= 1e-8) break;
      }
      this.massLedger.voluntaryClosureMass += targetAtStart - remainingTarget;
    }
    this.syncParticlesToCohorts();
  }

  private assimilateConfirmedEvent(event: ConfirmedLiquidationEvent) {
    const matching = this.cohorts.filter((cohort) => cohort.side === event.liquidatedPositionSide
      && !["LIQUIDATED", "EXPIRED", "INVALIDATED"].includes(cohort.state)
      && cohort.estimatedRemainingNotional > 0);
    const scored = matching.map((cohort) => ({
      cohort,
      likelihood: gaussianLikelihood(event.bankruptcyPrice, cohort.liquidationMean, cohort.liquidationStdDev)
        * Math.max(0.05, cohort.confidence)
        * Math.sqrt(cohort.estimatedRemainingNotional)
    })).filter((item) => item.likelihood > 1e-12);
    let remainingEventNotional = Math.min(event.notional, scored.reduce((sum, item) => sum + item.cohort.estimatedRemainingNotional, 0));
    let removedTotal = 0;
    for (let pass = 0; pass < 8 && remainingEventNotional > 1e-8 && scored.length; pass += 1) {
      const totalLikelihood = scored.reduce((sum, item) => sum + (item.cohort.estimatedRemainingNotional > 0 ? item.likelihood : 0), 0) || 1;
      let removedThisPass = 0;
      for (const item of scored) {
        const cohort = item.cohort;
        if (!(cohort.estimatedRemainingNotional > 0)) continue;
        const removed = Math.min(cohort.estimatedRemainingNotional, remainingEventNotional * item.likelihood / totalLikelihood);
        if (!(removed > 0)) continue;
        this.removeMass(cohort, removed);
        cohort.survivalProbability *= Math.max(0, 1 - removed / Math.max(1, cohort.estimatedInitialNotional));
        cohort.posteriorWeight *= 0.7 + Math.min(1, item.likelihood) * 0.6;
        cohort.confidence = Math.min(0.98, cohort.confidence + Math.min(1, item.likelihood) * 0.12);
        cohort.state = cohort.survivalProbability < 0.06 ? "LIQUIDATED" : "PARTIALLY_LIQUIDATED";
        const error = event.bankruptcyPrice - cohort.liquidationMean;
        const lifecycle = lifecycleEvent(cohort.id, Math.max(event.timestamp, event.receivedAt), "CONFIRMED_LIQUIDATION", removed, event.id,
          `Observed liquidation matched predicted range; price error ${error.toFixed(4)}`);
        cohort.lastLifecycleEvent = lifecycle;
        this.recordLifecycle(lifecycle);
        removedThisPass += removed;
        removedTotal += removed;
      }
      remainingEventNotional -= removedThisPass;
      if (removedThisPass <= 1e-8) break;
    }
    this.massLedger.confirmedLiquidationMass += removedTotal;
    this.syncParticlesToCohorts();
  }

  private removeMass(cohort: LiquidationPositionCohort, removed: number) {
    cohort.estimatedRemainingNotional = Math.max(0, cohort.estimatedRemainingNotional - removed);
    cohort.remainingMass = cohort.estimatedRemainingNotional;
  }

  private syncParticlesToCohorts() {
    const byId = new Map(this.cohorts.map((cohort) => [cohort.id, cohort]));
    for (const particle of this.particles) {
      const cohort = byId.get(particle.cohortId);
      particle.survival = cohort?.survivalProbability ?? 0;
      particle.notional = cohort?.estimatedRemainingNotional ?? 0;
    }
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

  private expireCohort(cohort: LiquidationPositionCohort, timestamp: number, reason: string) {
    const removed = cohort.estimatedRemainingNotional;
    if (removed > 0) this.massLedger.decayExpiryMass += removed;
    cohort.estimatedRemainingNotional = 0;
    cohort.remainingMass = 0;
    cohort.survivalProbability = 0;
    cohort.state = "EXPIRED";
    const event = lifecycleEvent(cohort.id, timestamp, "EXPIRY", removed, null, reason);
    cohort.lastLifecycleEvent = event;
    this.recordLifecycle(event);
  }

  private prune(timestamp: number) {
    const rank = (cohort: LiquidationPositionCohort) => cohort.estimatedRemainingNotional * cohort.survivalProbability * cohort.confidence;
    const live = this.cohorts.filter((cohort) => !["EXPIRED", "INVALIDATED"].includes(cohort.state));
    const particleCount = (ids: Set<string>) => this.particles.reduce((count, particle) => count + (ids.has(particle.cohortId) ? 1 : 0), 0);
    while (live.length > MAX_ACTIVE_COHORTS || particleCount(new Set(live.map((cohort) => cohort.id))) > MAX_PARTICLES) {
      live.sort((left, right) => rank(left) - rank(right) || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      const retired = live.shift();
      if (!retired) break;
      this.expireCohort(retired, timestamp, "Bounded-state expiry with explicit mass accounting");
    }
    const activeIds = new Set(live.filter((cohort) => cohort.estimatedRemainingNotional > 0).map((cohort) => cohort.id));
    this.cohorts = this.cohorts.filter((cohort) => activeIds.has(cohort.id));
    for (const id of this.traversedCohorts) if (!activeIds.has(id)) this.traversedCohorts.delete(id);
    this.particles = this.particles.filter((particle) => activeIds.has(particle.cohortId) && particle.notional > 0 && particle.survival > 0);
    this.normalizeParticleWeights();
  }

  private reconcileMass() {
    const remaining = this.cohorts.reduce((sum, cohort) => sum + cohort.estimatedRemainingNotional, 0);
    const expected = this.massLedger.totalCreatedMass
      - this.massLedger.voluntaryClosureMass
      - this.massLedger.confirmedLiquidationMass
      - this.massLedger.decayExpiryMass;
    const error = expected - remaining;
    const tolerance = Math.max(0.01, this.massLedger.totalCreatedMass * 1e-9);
    this.massLedger.totalRemainingMass = remaining;
    this.massLedger.conservationError = error;
    this.massLedger.tolerance = tolerance;
    if (Math.abs(error) > tolerance) throw new Error(`BCLIF model mass conservation failed (${error})`);
  }

  private recordLifecycle(event: BclifCohortLifecycleEvent) {
    this.lifecycleEvents.push(event);
    if (this.lifecycleEvents.length > MAX_LIFECYCLE_EVENTS) this.lifecycleEvents.splice(0, this.lifecycleEvents.length - MAX_LIFECYCLE_EVENTS);
  }
}

function closureScore(cohort: LiquidationPositionCohort, frame: LiquidationMarketFrame) {
  const ageHours = Math.max(0, (frame.timestamp - cohort.createdAt) / 3_600_000);
  const distance = Math.abs(cohort.entryMean - frame.markPrice) / Math.max(1, frame.markPrice);
  const profitable = cohort.side === "LONG" ? frame.markPrice > cohort.entryMean : frame.markPrice < cohort.entryMean;
  return 0.35 + Math.min(1, ageHours / 168) * 0.25 + Math.min(1, distance * 8) * 0.2
    + (profitable ? 0.12 : 0.04) + (1 - cohort.survivalProbability) * 0.08;
}

function lifecycleEvent(
  cohortId: string,
  timestamp: number,
  kind: BclifCohortLifecycleEvent["kind"],
  massRemoved: number,
  evidenceId: string | null,
  reason: string
): BclifCohortLifecycleEvent {
  return {
    id: `${cohortId}:${timestamp}:${kind}:${deterministicHash(`${massRemoved}:${evidenceId ?? "NONE"}:${reason}`)}`,
    cohortId,
    timestamp,
    kind,
    massRemoved,
    evidenceId,
    reason
  };
}

function evidenceChannels(frame: LiquidationMarketFrame, distribution: CohortEntryDistribution) {
  const channels = [`OPEN_INTEREST:${frame.certainty.openInterest}`, `ENTRY:${distribution.source}`];
  for (const name of ["trades", "confirmedLiquidations", "orderbook", "funding", "markPrice", "positioning"] as const) {
    const certainty = frame.certainty[name];
    if (certainty) channels.push(`${name.toUpperCase()}:${certainty}`);
  }
  return channels;
}

function normalizedConfiguration(value: BclifCohortModelConfiguration) {
  const total = value.isolatedContributionCap + value.crossContributionCap + value.unknownContributionCap;
  const configuration = total > 0 ? {
    ...value,
    isolatedContributionCap: value.isolatedContributionCap / total,
    crossContributionCap: value.crossContributionCap / total,
    unknownContributionCap: value.unknownContributionCap / total
  } : { ...DEFAULT_BCLIF_COHORT_CONFIGURATION };
  validateBclifCohortConfiguration(configuration);
  return configuration;
}

function cloneDistribution(distribution: CohortEntryDistribution): CohortEntryDistribution {
  return { ...distribution, priceRows: [...distribution.priceRows], weights: [...distribution.weights] };
}

function cloneCohort(cohort: LiquidationPositionCohort): LiquidationPositionCohort {
  return {
    ...cohort,
    entryDistribution: cloneDistribution(cohort.entryDistribution),
    leverageDistribution: cohort.leverageDistribution.map((bucket) => ({ ...bucket })),
    evidenceChannels: [...cohort.evidenceChannels],
    lastLifecycleEvent: { ...cohort.lastLifecycleEvent },
    riskTierDistribution: cohort.riskTierDistribution.map((tier) => ({ ...tier }))
  };
}

function cloneFrame(frame: LiquidationMarketFrame): LiquidationMarketFrame {
  return {
    ...frame,
    entryDistribution: frame.entryDistribution ? cloneDistribution(frame.entryDistribution) : undefined,
    oiMateriality: frame.oiMateriality ? { ...frame.oiMateriality } : undefined,
    bidDepthCurve: { ...frame.bidDepthCurve, points: frame.bidDepthCurve.points.map((point) => ({ ...point })) },
    askDepthCurve: { ...frame.askDepthCurve, points: frame.askDepthCurve.points.map((point) => ({ ...point })) },
    certainty: { ...frame.certainty }
  };
}

function validateCheckpointState(
  state: LiquidationCohortEngineState,
  expectedSourceVersion: string,
  expectedPreset: LiquidationFieldModelPreset
) {
  if (state?.schemaVersion !== 2) throw new Error("Unsupported BCLIF cohort checkpoint schema");
  if (state.modelVersion !== BCLIF_MODEL_VERSION) throw new Error("BCLIF cohort checkpoint model version mismatch");
  if (state.sourceVersion !== expectedSourceVersion) throw new Error("BCLIF cohort checkpoint source version mismatch");
  if (state.modelPreset !== expectedPreset) throw new Error("BCLIF cohort checkpoint model preset mismatch");
  if (!Number.isSafeInteger(state.cohortOrdinal) || state.cohortOrdinal < 0) throw new Error("Invalid BCLIF cohort checkpoint ordinal");
  if (!Array.isArray(state.cohorts) || state.cohorts.length > MAX_ACTIVE_COHORTS) throw new Error("Invalid BCLIF cohort checkpoint cohorts");
  if (!Array.isArray(state.particles) || state.particles.length > MAX_PARTICLES) throw new Error("Invalid BCLIF cohort checkpoint particles");
  if (!Array.isArray(state.traversedCohortIds) || state.traversedCohortIds.length > MAX_ACTIVE_COHORTS) throw new Error("Invalid BCLIF cohort checkpoint traversal state");
  if (!Array.isArray(state.oiDeltaHistory) || state.oiDeltaHistory.length > MAX_OI_DELTA_HISTORY || state.oiDeltaHistory.some((value) => !Number.isFinite(value))) throw new Error("Invalid BCLIF OI materiality history");
  if (!Array.isArray(state.lifecycleEvents) || state.lifecycleEvents.length > MAX_LIFECYCLE_EVENTS) throw new Error("Invalid BCLIF lifecycle history");
  validateBclifCohortConfiguration(state.configuration);
  const cohortIds = new Set(state.cohorts.map((cohort) => cohort.id));
  if (cohortIds.size !== state.cohorts.length || state.particles.some((particle) => !cohortIds.has(particle.cohortId))) throw new Error("BCLIF cohort checkpoint relationships are corrupt");
  for (const cohort of state.cohorts) validateEntryDistribution(cohort.entryDistribution);
  const numericValues = [
    ...state.cohorts.flatMap((cohort) => [
      cohort.createdAt, cohort.updatedAt, cohort.sourceIntervalStart, cohort.sourceIntervalEnd,
      cohort.entryMean, cohort.estimatedInitialNotional, cohort.estimatedRemainingNotional,
      cohort.initialOpenMass, cohort.remainingMass, cohort.survivalProbability
    ]),
    ...state.particles.flatMap((particle) => [particle.entryPrice, particle.leverage, particle.notional, particle.liquidationPrice, particle.survival, particle.weight]),
    ...Object.values(state.massLedger)
  ];
  if (numericValues.some((value) => !Number.isFinite(value))) throw new Error("BCLIF cohort checkpoint contains non-finite values");
  const remaining = state.cohorts.reduce((sum, cohort) => sum + cohort.estimatedRemainingNotional, 0);
  const expected = state.massLedger.totalCreatedMass - state.massLedger.voluntaryClosureMass
    - state.massLedger.confirmedLiquidationMass - state.massLedger.decayExpiryMass;
  if (Math.abs(expected - remaining) > Math.max(0.01, state.massLedger.totalCreatedMass * 1e-9)) throw new Error("BCLIF checkpoint violates model mass conservation");
}
