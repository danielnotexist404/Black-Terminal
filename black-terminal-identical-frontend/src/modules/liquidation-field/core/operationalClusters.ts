import type {
  BclifEvidenceClass,
  BclifEvidenceComposition,
  BclifOperationalCluster,
  LiquidationFieldSettings,
  LiquidationFieldSnapshot
} from "./types.ts";

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

export function bclifEvidenceComposition(
  snapshot: LiquidationFieldSnapshot,
  sourceIndex?: number
): BclifEvidenceComposition {
  const persistent = snapshot.persistentCoverage;
  const legacy = snapshot.coverage;
  const percent = (value: number | null | undefined, fallback: number) => clamp01((value ?? fallback) / 100);
  const confirmedCell = sourceIndex === undefined ? 0 : (snapshot.confirmedIntensity[sourceIndex] ?? 0) / 255;
  return {
    openInterest: percent(persistent?.openInterestCoveragePercent, legacy.openInterestCoveragePercent),
    trades: percent(persistent?.tradeCoveragePercent, legacy.observedTradeCoveragePercent),
    confirmedLiquidations: Math.max(
      percent(persistent?.liquidationCoveragePercent, legacy.liquidationEventCoveragePercent),
      confirmedCell
    ),
    orderBook: percent(persistent?.orderbookCoveragePercent, legacy.orderbookCoveragePercent),
    funding: percent(persistent?.fundingCoveragePercent, 0),
    markPrice: snapshot.validity[sourceIndex ?? 0] ? 1 : 0,
    positioning: clamp01(snapshot.confidenceBreakdown.entryPrice / 100)
  };
}

export function bclifMeaningfulEvidenceChannels(composition: BclifEvidenceComposition) {
  return [
    composition.openInterest,
    composition.trades,
    composition.confirmedLiquidations,
    composition.orderBook,
    composition.funding
  ].filter((weight) => weight >= 0.35).length;
}

export function classifyBclifEvidence(composition: BclifEvidenceComposition): BclifEvidenceClass {
  const trades = composition.trades >= 0.35;
  const events = composition.confirmedLiquidations >= 0.05;
  const book = composition.orderBook >= 0.35;
  const funding = composition.funding >= 0.35;
  if (trades && events && book && funding) return "FULL_CONTEXT";
  if (trades && events) return "OI_PLUS_TRADES_PLUS_LIQUIDATIONS";
  if (trades && book) return "OI_PLUS_TRADES_PLUS_BOOK";
  if (trades) return "OI_PLUS_TRADES";
  if (composition.markPrice >= 0.5) return "OI_PLUS_PRICE";
  return "OI_ONLY";
}

export function extractBclifOperationalClusters(
  snapshot: LiquidationFieldSnapshot,
  markPrice: number,
  settings: Pick<LiquidationFieldSettings, "minimumConfidence" | "sideFilter">
): BclifOperationalCluster[] {
  if (!Number.isFinite(markPrice) || markPrice <= 0 || snapshot.header.columns < 1 || snapshot.header.rows < 3) return [];
  const { rows, columns, minPrice, priceStep } = snapshot.header;
  const recentColumns = Math.min(24, columns);
  const candidates: BclifOperationalCluster[] = [];
  const sides = settings.sideFilter === "LONG"
    ? (["LONG_LIQUIDATION"] as const)
    : settings.sideFilter === "SHORT"
      ? (["SHORT_LIQUIDATION"] as const)
      : (["LONG_LIQUIDATION", "SHORT_LIQUIDATION"] as const);

  for (const side of sides) {
    const exposure = side === "LONG_LIQUIDATION" ? snapshot.longExposure : snapshot.shortExposure;
    const normalized = side === "LONG_LIQUIDATION" ? snapshot.longNormalizedIntensity : snapshot.shortNormalizedIntensity;
    const latestColumn = columns - 1;
    const profile = new Float64Array(rows);
    let maximum = 0;
    for (let row = 0; row < rows; row++) {
      let weighted = 0;
      let weight = 0;
      for (let offset = 0; offset < recentColumns; offset++) {
        const column = latestColumn - offset;
        const recency = 1 - offset / Math.max(1, recentColumns) * 0.65;
        weighted += (exposure[column * rows + row] ?? 0) * recency;
        weight += recency;
      }
      profile[row] = weight ? weighted / weight : 0;
      maximum = Math.max(maximum, profile[row]!);
    }
    if (maximum <= 0) continue;

    for (let row = 1; row < rows - 1; row++) {
      const value = profile[row]!;
      if (value < maximum * 0.1 || value < profile[row - 1]! || value < profile[row + 1]!) continue;
      const peakPrice = minPrice + row * priceStep;
      if (side === "LONG_LIQUIDATION" ? peakPrice >= markPrice : peakPrice <= markPrice) continue;
      let lowRow = row;
      let highRow = row;
      while (lowRow > 0 && profile[lowRow - 1]! >= value * 0.42) lowRow -= 1;
      while (highRow < rows - 1 && profile[highRow + 1]! >= value * 0.42) highRow += 1;
      if (candidates.some((candidate) => peakPrice >= candidate.priceLow && peakPrice <= candidate.priceHigh && candidate.side === side)) continue;

      const sourceIndex = latestColumn * rows + row;
      const confidence = (snapshot.confidence[sourceIndex] ?? 0) / 2.55;
      if (confidence + 8 < settings.minimumConfidence) continue;
      const evidenceComposition = bclifEvidenceComposition(snapshot, sourceIndex);
      let activeColumns = 0;
      let priorIntensity = 0;
      let latestIntensity = normalized[sourceIndex] ?? 0;
      for (let offset = 0; offset < recentColumns; offset++) {
        const intensity = normalized[(latestColumn - offset) * rows + row] ?? 0;
        if (intensity >= Math.max(12, latestIntensity * 0.35)) activeColumns += 1;
        if (offset >= 4 && offset <= 8) priorIntensity += intensity / 5;
      }
      const persistence = activeColumns / recentColumns;
      const bandLow = minPrice + lowRow * priceStep;
      const bandHigh = minPrice + highRow * priceStep;
      const matchingCohorts = snapshot.cohorts.filter((cohort) => {
        if ((side === "LONG_LIQUIDATION" ? cohort.side !== "LONG" : cohort.side !== "SHORT")) return false;
        // A shelf can be a shoulder of a multi-entry/multi-leverage mixture,
        // not only the aggregate cohort core. Keep the provenance envelope
        // conservative enough to capture those contributing tails.
        const provenancePadding = Math.max(priceStep * 2, cohort.liquidationStdDev * 2);
        return cohort.liquidationUpper + provenancePadding >= bandLow
          && cohort.liquidationLower - provenancePadding <= bandHigh;
      });
      const survivalProbability = matchingCohorts.length
        ? matchingCohorts.reduce((sum, cohort) => sum + cohort.survivalProbability, 0) / matchingCohorts.length
        : 0.45;
      const observedLiquidationNotionalNearby = snapshot.confirmedEvents
        .filter((event) => event.bankruptcyPrice >= minPrice + lowRow * priceStep && event.bankruptcyPrice <= minPrice + highRow * priceStep)
        .reduce((sum, event) => sum + event.notional, 0);
      const prominence = Math.max(0, Math.min(1, value / maximum));
      const localValues = Array.from(profile.slice(lowRow, highRow + 1));
      const localTotal = localValues.reduce((sum, item) => sum + item, 0) || 1;
      const priceEntropy = localValues.reduce((entropy, item) => {
        const probability = item / localTotal;
        return probability > 0 ? entropy - probability * Math.log(probability) : entropy;
      }, 0) / Math.max(1e-9, Math.log(Math.max(2, localValues.length)));
      const exposureConcentration = value / Math.max(1e-9, profile.reduce((sum, item) => sum + item, 0));
      const distanceFromMarkBps = (peakPrice - markPrice) / markPrice * 10_000;
      const exposureScore = Math.min(1, Math.log1p(value) / Math.max(1, Math.log1p(maximum)));
      const proximityScore = Math.exp(-Math.abs(distanceFromMarkBps) / 2_000);
      const observedScore = Math.min(1, Math.log1p(observedLiquidationNotionalNearby) / Math.log(1_000_000_001));
      const rankScore = 0.28 * exposureScore
        + 0.22 * confidence / 100
        + 0.14 * prominence
        + 0.1 * persistence
        + 0.1 * survivalProbability
        + 0.1 * observedScore
        + 0.06 * proximityScore;
      const state = observedLiquidationNotionalNearby > 0
        ? "TRIGGERED"
        : latestIntensity > priorIntensity * 1.18
          ? "STRENGTHENING"
          : latestIntensity < priorIntensity * 0.68
            ? "DECAYING"
            : persistence < 0.25
              ? "FORMING"
              : "ACTIVE";
      candidates.push({
        id: `${side}:${Math.round(peakPrice / Math.max(priceStep, 1e-8))}`,
        side,
        priceLow: bandLow,
        priceHigh: bandHigh,
        peakPrice,
        distanceFromMarkBps,
        estimatedExposureLow: value * 0.82,
        estimatedExposureHigh: value * 1.18,
        confidence,
        persistence,
        survivalProbability,
        evidenceComposition,
        observedLiquidationNotionalNearby,
        state,
        prominence,
        rankScore,
        exposureConcentration,
        shelfWidth: (highRow - lowRow + 1) * priceStep,
        priceEntropy,
        cohortOverlapCount: matchingCohorts.length,
        cohortIds: matchingCohorts.map((cohort) => cohort.id).sort(),
        provenanceCoverage: matchingCohorts.length ? 1 : 0
      });
    }
  }
  return candidates.sort((left, right) => right.rankScore - left.rankScore);
}

export function selectBclifOperationalLabels(
  clusters: readonly BclifOperationalCluster[],
  markPrice: number,
  maximum: number
) {
  if (maximum <= 0) return [];
  const above = clusters.filter((cluster) => cluster.peakPrice > markPrice);
  const below = clusters.filter((cluster) => cluster.peakPrice < markPrice);
  const ordered = [
    [...above].sort((a, b) => a.peakPrice - b.peakPrice)[0],
    [...below].sort((a, b) => b.peakPrice - a.peakPrice)[0],
    above.filter((cluster) => cluster.confidence >= 75).sort((a, b) => b.rankScore - a.rankScore)[0],
    below.filter((cluster) => cluster.confidence >= 75).sort((a, b) => b.rankScore - a.rankScore)[0]
  ].filter((cluster): cluster is BclifOperationalCluster => Boolean(cluster));
  const selected = new Map<string, BclifOperationalCluster>();
  for (const cluster of ordered) selected.set(cluster.id, cluster);
  for (const cluster of clusters) if (selected.size < maximum) selected.set(cluster.id, cluster);
  return [...selected.values()].slice(0, maximum);
}
