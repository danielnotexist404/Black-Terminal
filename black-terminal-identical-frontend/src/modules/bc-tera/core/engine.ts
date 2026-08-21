import { INITIAL_CUSUM_STATE, updateDirectionalCUSUM } from "./changePoint.ts";
import { createBCTERAEvent, createTerminalEpisodeId } from "./identity.ts";
import { migrateBCTERASettings } from "./settings.ts";
import { clamp100, robustZ, sigmoid, weightedNullable } from "./statistics.ts";
import {
  BC_TERA_FEATURE_SCHEMA_VERSION,
  BC_TERA_MODEL_VERSION,
  type BCTERADataQuality,
  type BCTERAEvidenceFamily,
  type BCTERAEventType,
  type BCTERAFeatureBar,
  type BCTERAPoint,
  type BCTERASnapshot,
  type BCTERASettings,
  type BCTERAState,
  type BCTERASourceStatus
} from "./types.ts";

const QUALITY_WEIGHT: Record<BCTERADataQuality, number> = {
  AUTHORITATIVE: 1,
  VERIFIED_PARTIAL: 0.82,
  STALE: 0.28,
  DEGRADED: 0.42,
  SYNTHETIC: 0,
  UNAVAILABLE: 0
};

const EVENT_BY_STATE: Partial<Record<BCTERAState, BCTERAEventType>> = {
  TOP_EXTREMITY: "TOP_EXTREMITY",
  TOP_EXHAUSTION: "TOP_EXHAUSTION",
  TOP_REVERSAL_CONFIRMED: "TOP_REVERSAL_CONFIRMED",
  BOTTOM_EXTREMITY: "BOTTOM_EXTREMITY",
  BOTTOM_CAPITULATION: "BOTTOM_CAPITULATION",
  BOTTOM_ABSORPTION: "BOTTOM_ABSORPTION",
  BOTTOM_REVERSAL_CONFIRMED: "BOTTOM_REVERSAL_CONFIRMED",
  DATA_DEGRADED: "DATA_DEGRADED"
};

const ALL_FAMILIES: BCTERAEvidenceFamily[] = [
  "MARKET", "VALUATION", "SPOT_FLOW", "ORDER_BOOK", "DERIVATIVES",
  "LIQUIDATIONS", "OPTIONS", "STABLECOIN_LIQUIDITY"
];

function sourceStatus(bars: readonly BCTERAFeatureBar[]): BCTERASourceStatus[] {
  const latest = bars[bars.length - 1];
  return ALL_FAMILIES.map((family) => {
    const block = family === "MARKET" ? latest?.market
      : family === "VALUATION" ? latest?.valuation
        : family === "SPOT_FLOW" ? latest?.spotFlow
          : family === "ORDER_BOOK" ? latest?.orderBook
            : family === "DERIVATIVES" ? latest?.derivatives
              : family === "LIQUIDATIONS" ? latest?.liquidations
                : family === "OPTIONS" ? latest?.options
                  : latest?.stablecoinLiquidity;
    const quality: BCTERADataQuality = block?.quality ?? "UNAVAILABLE";
    return {
      family,
      quality,
      sourceCount: block?.sources.length ?? 0,
      latestSourceCutoff: block?.sources.reduce((max, source) => Math.max(max, source.sourceCutoff), 0) || null,
      explanation: quality === "UNAVAILABLE"
        ? `${family.replaceAll("_", " ").toLowerCase()} evidence is not connected; it contributes no score.`
        : `${block?.sources.length ?? 0} provenance-recorded source(s), quality ${quality.toLowerCase()}.`
    };
  });
}

function confidenceFor(bar: BCTERAFeatureBar, settings: BCTERASettings) {
  const requirements: Array<readonly [unknown, number, BCTERADataQuality | undefined]> = [
    [bar.market, 2, bar.market.quality],
    [settings.dataSources.useOnChain ? bar.valuation : true, 1.2, bar.valuation?.quality],
    [settings.dataSources.useSpotFlow ? bar.spotFlow : true, 2, bar.spotFlow?.quality],
    [settings.dataSources.useOrderBook ? bar.orderBook : true, 0.8, bar.orderBook?.quality],
    [settings.dataSources.useDerivatives ? bar.derivatives : true, 1.4, bar.derivatives?.quality],
    [settings.dataSources.useLiquidations ? bar.liquidations : true, 0.8, bar.liquidations?.quality],
    [settings.dataSources.useOptions ? bar.options : true, 0.6, bar.options?.quality]
  ];
  let achieved = 0;
  let total = 0;
  for (const [block, weight, quality] of requirements) {
    total += weight;
    if (block === true) achieved += weight;
    else if (block) achieved += weight * QUALITY_WEIGHT[quality ?? "UNAVAILABLE"];
  }
  const agreement = bar.spotFlow?.values.venueAgreement ?? bar.orderBook?.values.venueAgreement ?? null;
  const disagreementPenalty = settings.dataSources.requireMultiVenue && agreement != null
    ? 0.65 + 0.35 * Math.max(0, Math.min(1, agreement / 100))
    : 1;
  return clamp100((total > 0 ? achieved / total : 0) * 100 * disagreementPenalty);
}

function scoreBar(
  bar: BCTERAFeatureBar,
  cpProbability: number,
  cpDirection: string,
  confidence: number,
  settings: BCTERASettings
) {
  const valuation = settings.dataSources.useOnChain ? bar.valuation : null;
  const flow = settings.dataSources.useSpotFlow ? bar.spotFlow : null;
  const book = settings.dataSources.useOrderBook ? bar.orderBook : null;
  const derivatives = settings.dataSources.useDerivatives ? bar.derivatives : null;
  const liquidations = settings.dataSources.useLiquidations ? bar.liquidations : null;
  const options = settings.dataSources.useOptions ? bar.options : null;
  const valuationTop = valuation ? weightedNullable([
    [valuation.values.topExtremity, settings.extremity.valuationWeight],
    [valuation.values.costBasisTop, settings.extremity.costBasisWeight],
    [valuation.values.holderDistribution, settings.extremity.holderDistributionWeight]
  ]) : null;
  const valuationBottom = valuation ? weightedNullable([
    [valuation.values.bottomExtremity, settings.extremity.valuationWeight],
    [valuation.values.costBasisBottom, settings.extremity.costBasisWeight],
    [valuation.values.realizedLoss, settings.extremity.holderDistributionWeight]
  ]) : null;
  const structuralTop = clamp100(Math.max(0, bar.market.values.distanceFromMean) * 100);
  const structuralBottom = clamp100(Math.max(0, -bar.market.values.distanceFromMean) * 100);
  const topExtremity = Math.max(structuralTop, valuationTop ?? 0);
  const bottomExtremity = Math.max(structuralBottom, valuationBottom ?? 0);
  const leverageFragility = weightedNullable([
    [derivatives?.values.oiIntensity ?? null, settings.leverage.oiWeight],
    [derivatives?.values.fundingCrowding ?? null, settings.leverage.fundingWeight],
    [derivatives?.values.annualizedBasis ?? null, settings.leverage.basisWeight],
    [liquidations?.values.shortLiquidationShock ?? null, settings.leverage.liquidationWeight]
  ]);
  const leverageReset = weightedNullable([
    [derivatives?.values.leverageReset ?? null, settings.leverage.oiWeight],
    [liquidations?.values.longLiquidationShock ?? null, settings.leverage.liquidationWeight]
  ]);
  const tradeConfirmed = flow?.values.tradeConfirmed === true;
  const buyerExhaustion = tradeConfirmed
    ? weightedNullable([
        [flow?.values.aggressiveBuy ?? null, 0.42],
        [flow?.values.buyerImpactCollapse ?? null, 0.58]
      ])
    : null;
  const sellerExhaustion = tradeConfirmed
    ? weightedNullable([
        [flow?.values.aggressiveSell ?? null, 0.42],
        [flow?.values.sellerImpactCollapse ?? null, 0.58]
      ])
    : null;
  const topAbsorption = tradeConfirmed && book?.values.tradeConfirmed
    ? weightedNullable([
        [flow?.values.aggressiveBuy ?? null, 0.32],
        [flow?.values.buyerImpactCollapse ?? null, 0.42],
        [book?.values.offerReplenishment ?? null, 0.26]
      ])
    : null;
  const bottomAbsorption = tradeConfirmed && book?.values.tradeConfirmed
    ? weightedNullable([
        [flow?.values.aggressiveSell ?? null, 0.32],
        [flow?.values.sellerImpactCollapse ?? null, 0.42],
        [book?.values.bidReplenishment ?? null, 0.26]
      ])
    : null;
  const spotAbsorption = weightedNullable([[topAbsorption, 1], [bottomAbsorption, 1]]);
  const distributionPressure = weightedNullable([
    [valuation?.values.holderDistribution ?? null, 0.34],
    [buyerExhaustion, 0.4],
    [leverageFragility, 0.26]
  ]);
  const capitulationPressure = weightedNullable([
    [valuation?.values.realizedLoss ?? null, 0.3],
    [liquidations?.values.longLiquidationShock ?? null, 0.35],
    [flow?.values.aggressiveSell ?? null, 0.35]
  ]);
  const optionsTop = weightedNullable([
    [options?.values.downsideSkew ?? null, 0.65],
    [options?.values.panicVolatility ?? null, 0.35]
  ]);
  const optionsBottom = weightedNullable([
    [options?.values.panicVolatility ?? null, 0.55],
    [options?.values.normalization ?? null, 0.45]
  ]);
  const topRaw = weightedNullable([
    [topExtremity, 1], [leverageFragility, 1.1], [buyerExhaustion, 1.35],
    [distributionPressure, 1.2], [cpDirection === "BEARISH" ? cpProbability * 100 : 0, 1.2],
    [optionsTop, 0.4]
  ]) ?? 0;
  const bottomRaw = weightedNullable([
    [bottomExtremity, 0.9], [leverageReset, 1.1], [sellerExhaustion, 1.35],
    [bottomAbsorption, 1.2], [cpDirection === "BULLISH" ? cpProbability * 100 : 0, 1.2],
    [optionsBottom, 0.4]
  ]) ?? 0;
  const coverageGate = 0.35 + 0.65 * confidence / 100;
  const topHazard = clamp100(100 * sigmoid(-5.2 + 8.4 * (topRaw / 100) * coverageGate));
  const bottomHazard = clamp100(100 * sigmoid(-5.2 + 8.4 * (bottomRaw / 100) * coverageGate));
  return {
    valuationTop, valuationBottom, topExtremity, bottomExtremity,
    aggressiveBuy: flow?.values.aggressiveBuy ?? null,
    aggressiveSell: flow?.values.aggressiveSell ?? null,
    venueAgreement: flow?.values.venueAgreement ?? book?.values.venueAgreement ?? null,
    leverageFragility, leverageReset, buyerExhaustion,
    sellerExhaustion, topAbsorption, bottomAbsorption, spotAbsorption,
    distributionPressure, capitulationPressure, optionsTop, optionsBottom,
    topHazard, bottomHazard
  };
}

function nextState(
  previous: BCTERAState,
  previousDuration: number,
  bar: BCTERAFeatureBar,
  score: ReturnType<typeof scoreBar>,
  cpProbability: number,
  cpDirection: string,
  confidence: number,
  settings: BCTERASettings
): BCTERAState {
  if (confidence < settings.dataSources.minimumConfidence) return "DATA_DEGRADED";
  const topDurationReady = previousDuration >= settings.confirmation.minimumStateDuration;
  const bottomDurationReady = previousDuration >= Math.max(
    settings.confirmation.minimumStateDuration,
    settings.exhaustion.absorptionPersistence
  );
  const cpReady = cpProbability * 100 >= settings.changePoint.confirmationProbability;
  const topExtreme = score.topExtremity >= settings.extremity.percentile;
  const bottomExtreme = score.bottomExtremity >= settings.extremity.percentile;
  const agreementReady = !settings.dataSources.requireMultiVenue ||
    (score.venueAgreement ?? 0) >= settings.exhaustion.multiVenueAgreement;
  const topExhausted = topExtreme && (score.buyerExhaustion ?? 0) >= settings.exhaustion.impactCollapseThreshold &&
    (score.aggressiveBuy ?? 0) >= settings.exhaustion.minimumAggressiveFlow && agreementReady &&
    Math.max(score.distributionPressure ?? 0, score.leverageFragility ?? 0) >= settings.leverage.fragilityThreshold;
  const capitulation = bottomExtreme && (score.capitulationPressure ?? 0) >= settings.leverage.fragilityThreshold;
  const absorbed = capitulation && (score.bottomAbsorption ?? 0) >= settings.exhaustion.impactCollapseThreshold &&
    (score.aggressiveSell ?? 0) >= settings.exhaustion.minimumAggressiveFlow && agreementReady;
  const structureTop = !settings.changePoint.requireStructureBreak || bar.market.values.structureBreakDown;
  const structureBottom = !settings.changePoint.requireStructureBreak || bar.market.values.structureBreakUp;
  const topDirectionReady = score.topHazard - score.bottomHazard >= settings.confirmation.directionalEvidenceMargin;
  const bottomDirectionReady = score.bottomHazard - score.topHazard >= settings.confirmation.directionalEvidenceMargin;
  if (previous === "TOP_REVERSAL_CONFIRMED" && topExhausted) return previous;
  if (previous === "BOTTOM_REVERSAL_CONFIRMED" && absorbed) return previous;
  if ((previous === "TOP_EXHAUSTION" || previous === "TOP_EXTREMITY") && topDurationReady && topExhausted &&
      cpReady && cpDirection === "BEARISH" && structureTop && topDirectionReady &&
      score.topHazard >= settings.confirmation.topHazardThreshold) {
    return "TOP_REVERSAL_CONFIRMED";
  }
  if ((previous === "BOTTOM_ABSORPTION" || previous === "BOTTOM_CAPITULATION") && bottomDurationReady && absorbed &&
      cpReady && cpDirection === "BULLISH" && structureBottom && bottomDirectionReady &&
      score.bottomHazard >= settings.confirmation.bottomHazardThreshold) {
    return "BOTTOM_REVERSAL_CONFIRMED";
  }
  if (topExhausted) return "TOP_EXHAUSTION";
  if (topExtreme) return "TOP_EXTREMITY";
  if (absorbed) return "BOTTOM_ABSORPTION";
  if (capitulation) return "BOTTOM_CAPITULATION";
  if (bottomExtreme) return "BOTTOM_EXTREMITY";
  if (bar.market.values.trend > 0.3) return bar.market.values.distanceFromMean > 0.55 ? "MATURE_EXPANSION" : "NORMAL_EXPANSION";
  if (bar.market.values.trend < -0.3) return bar.market.values.distanceFromMean < -0.55 ? "MATURE_CONTRACTION" : "NORMAL_CONTRACTION";
  return "TRANSITION";
}

export function calculateBCTERA(
  input: readonly BCTERAFeatureBar[],
  settingsInput?: Partial<BCTERASettings> | null
): BCTERASnapshot {
  const settings = migrateBCTERASettings(settingsInput);
  const canonicalByTimestamp = new Map<number, BCTERAFeatureBar>();
  for (const bar of input) {
    if (bar.schemaVersion !== BC_TERA_FEATURE_SCHEMA_VERSION) continue;
    const existing = canonicalByTimestamp.get(bar.time);
    if (!existing || bar.receivedTimestamp > existing.receivedTimestamp ||
        (bar.receivedTimestamp === existing.receivedTimestamp && bar.revisionId > existing.revisionId)) {
      canonicalByTimestamp.set(bar.time, bar);
    }
  }
  const bars = [...canonicalByTimestamp.values()]
    .sort((left, right) => left.time - right.time)
    .slice(-Math.max(30, settings.timeHorizon.featureLookback));
  const latest = bars[bars.length - 1];
  const points: BCTERAPoint[] = [];
  const events: BCTERASnapshot["events"] = [];
  const seenEvents = new Set<string>();
  let cpState = INITIAL_CUSUM_STATE;
  let previousState: BCTERAState = "INSUFFICIENT_DATA";
  let previousDuration = 0;
  let topEpisode: string | null = null;
  let bottomEpisode: string | null = null;
  let lastConfirmedEventIndex = -Infinity;
  const returns: number[] = [];
  const warmup = Math.min(12, Math.max(4, Math.floor(settings.timeHorizon.regimeLookback / 10)));

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    returns.push(bar.market.values.logReturn);
    const window = returns.slice(Math.max(0, returns.length - Math.max(10, settings.timeHorizon.regimeLookback)));
    const standardized = robustZ(bar.market.values.logReturn, window);
    cpState = updateDirectionalCUSUM(
      cpState,
      standardized,
      settings.changePoint.sensitivity,
      settings.changePoint.minimumRunLength
    );
    const confidence = confidenceFor(bar, settings);
    const score = scoreBar(bar, cpState.probability, cpState.direction, confidence, settings);
    let state: BCTERAState = index + 1 < warmup
      ? "INSUFFICIENT_DATA"
      : nextState(previousState, previousDuration, bar, score, cpState.probability, cpState.direction, confidence, settings);
    if (!bar.confirmed && settings.confirmation.confirmedCandlesOnly && state.endsWith("REVERSAL_CONFIRMED")) {
      state = previousState === "INSUFFICIENT_DATA" ? "TRANSITION" : previousState;
    }
    if (["TOP_EXTREMITY", "TOP_EXHAUSTION"].includes(state) && !topEpisode) topEpisode = createTerminalEpisodeId(bar, "TOP");
    if (["BOTTOM_EXTREMITY", "BOTTOM_CAPITULATION", "BOTTOM_ABSORPTION"].includes(state) && !bottomEpisode) {
      bottomEpisode = createTerminalEpisodeId(bar, "BOTTOM");
    }
    const episodeId = state.startsWith("TOP_")
      ? topEpisode
      : state.startsWith("BOTTOM_")
        ? bottomEpisode
        : state === "DATA_DEGRADED"
          ? topEpisode ?? bottomEpisode ?? createTerminalEpisodeId(bar, "DATA")
          : null;
    const point: BCTERAPoint = {
      time: bar.time,
      confirmed: bar.confirmed,
      state,
      topHazard: score.topHazard,
      bottomHazard: score.bottomHazard,
      buyerExhaustion: score.buyerExhaustion,
      sellerExhaustion: score.sellerExhaustion,
      leverageFragility: score.leverageFragility,
      valuationExtremity: weightedNullable([[score.valuationTop, 1], [score.valuationBottom, 1]]),
      spotAbsorption: score.spotAbsorption,
      distributionPressure: score.distributionPressure,
      capitulationPressure: score.capitulationPressure,
      changePointProbability: cpState.probability * 100,
      changeDirection: cpState.direction,
      changePointRunLength: cpState.runLength,
      dataConfidence: confidence,
      evidence: {
        valuationExtremity: state.startsWith("BOTTOM_") ? score.valuationBottom : score.valuationTop,
        buyerExhaustion: score.buyerExhaustion,
        sellerExhaustion: score.sellerExhaustion,
        spotAbsorption: score.spotAbsorption,
        leverageFragility: score.leverageFragility,
        leverageReset: score.leverageReset,
        distributionPressure: score.distributionPressure,
        capitulationPressure: score.capitulationPressure,
        bullishChangePoint: cpState.direction === "BULLISH" ? cpState.probability * 100 : 0,
        bearishChangePoint: cpState.direction === "BEARISH" ? cpState.probability * 100 : 0,
        optionsConfirmation: state.startsWith("BOTTOM_") ? score.optionsBottom : score.optionsTop
      },
      unavailable: [...new Set(bar.unavailable)],
      provisional: !bar.confirmed,
      episodeId
    };
    points.push(point);
    const eventType = EVENT_BY_STATE[state];
    const changedState = state !== previousState;
    const cooldownReady = index - lastConfirmedEventIndex >= settings.confirmation.cooldownBars || !state.endsWith("REVERSAL_CONFIRMED");
    if (bar.confirmed && eventType && changedState && episodeId && cooldownReady) {
      const event = createBCTERAEvent(bar, point, eventType, episodeId);
      if (!seenEvents.has(event.id)) {
        seenEvents.add(event.id);
        events.push(event);
        if (state.endsWith("REVERSAL_CONFIRMED")) lastConfirmedEventIndex = index;
      }
    }
    previousDuration = state === previousState ? previousDuration + 1 : 1;
    previousState = state;
    if (!state.startsWith("TOP_") && ["NORMAL_CONTRACTION", "BOTTOM_REVERSAL_CONFIRMED"].includes(state)) topEpisode = null;
    if (!state.startsWith("BOTTOM_") && ["NORMAL_EXPANSION", "TOP_REVERSAL_CONFIRMED"].includes(state)) bottomEpisode = null;
  }

  return {
    modelVersion: BC_TERA_MODEL_VERSION,
    featureSchemaVersion: BC_TERA_FEATURE_SCHEMA_VERSION,
    automationState: "RESEARCH_ONLY",
    liveExecutionLocked: true,
    profile: latest?.profile ?? "UNAVAILABLE",
    symbol: latest?.symbol ?? "UNKNOWN",
    exchangeScope: latest?.exchangeScope ?? "UNAVAILABLE",
    timeframe: latest?.timeframe ?? settings.timeHorizon.decisionTimeframe,
    generatedAt: latest?.receivedTimestamp ?? Date.now(),
    revisionId: latest?.revisionId ?? "no-data",
    points,
    events,
    sourceStatus: sourceStatus(bars)
  };
}
