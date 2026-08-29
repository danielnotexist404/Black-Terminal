import type { AuctionNodeZone, AuctionProfileRow, AuctionProfileSettings } from "./types.ts";

function percentile(values: readonly number[], percent: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((percent / 100) * (sorted.length - 1))));
  return sorted[index]!;
}

function nodeSource(row: AuctionProfileRow, settings: AuctionProfileSettings) {
  switch (settings.nodeDetection.source) {
    case "SELECTED_ENGINE": return Math.abs(row.value);
    case "NET_CVD": return Math.abs(row.buyQuantity - row.sellQuantity);
    case "CVD_EFFICIENCY": return Math.abs(row.cvdEfficiency);
    case "BUY_VOLUME": return row.buyQuantity;
    case "SELL_VOLUME": return row.sellQuantity;
    case "DELTA_IMBALANCE": return Math.abs(row.buyQuantity - row.sellQuantity) / Math.max(row.totalQuantity, Number.EPSILON);
    case "TPO": return row.tpoCount;
    case "VOLUME": return row.totalQuantity;
    case "VOLATILITY": return row.realizedVariance;
    case "PARKINSON": return row.parkinsonVariance;
    case "HYBRID": return Math.abs(row.hybridScore);
    case "ABSOLUTE_CVD":
    default: return Math.abs(row.buyQuantity - row.sellQuantity);
  }
}

function lvnClassification(
  settings: AuctionProfileSettings,
  rows: readonly AuctionProfileRow[],
  componentRowIndices: readonly number[]
): AuctionNodeZone["classification"] {
  const engine = settings.calculationEngine;
  if (settings.nodeDetection.source === "TPO" || engine === "TPO") {
    return componentRowIndices.every(index => rows[index]!.tpoCount === 1)
      ? "TPO_SINGLE_PRINT_ZONE"
      : "TPO_LOW_ACCEPTANCE_ZONE";
  }
  if (settings.nodeDetection.source === "HYBRID" || engine === "HYBRID_AUCTION_SCORE") return "HYBRID_STRUCTURAL_NODE";
  if (
    settings.nodeDetection.source === "VOLATILITY"
    || settings.nodeDetection.source === "PARKINSON"
    || ["REALIZED_VOLATILITY", "PARKINSON_VOLATILITY", "GARMAN_KLASS_VOLATILITY", "RANGE_EXPANSION"].includes(engine)
  ) return "VOLATILITY_NODE";
  if (settings.nodeDetection.source.includes("CVD") || ["CVD_REAL_TRADES", "CVD_PINE_COMPATIBLE", "DELTA_VOLUME", "IMBALANCE_RATIO"].includes(engine)) return "CVD_LVN";
  return "DIRECTIONAL_INEFFICIENCY";
}

function mergeCandidates(candidates: number[], maximumGap: number) {
  const groups: number[][] = [];
  for (const index of candidates) {
    const group = groups[groups.length - 1];
    if (group && index - group[group.length - 1]! <= maximumGap + 1) group.push(index);
    else groups.push([index]);
  }
  return groups;
}

function average(values: readonly number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function inclusiveIndices(first: number, last: number) {
  return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
}

export function detectAuctionNodes(
  rows: readonly AuctionProfileRow[],
  settings: AuctionProfileSettings,
  createdAt: number,
  profileVersion: string
): AuctionNodeZone[] {
  if (rows.length < 3) return [];
  const values = rows.map(row => nodeSource(row, settings));
  const lowThreshold = percentile(values, settings.nodeDetection.sensitivityPercentile);
  const highThreshold = percentile(values, 100 - settings.nodeDetection.sensitivityPercentile);
  const neighborhood = settings.nodeDetection.neighborhood;
  const local = (index: number, type: "LVN" | "HVN") => {
    const from = Math.max(0, index - neighborhood);
    const to = Math.min(values.length - 1, index + neighborhood);
    const peers = values.slice(from, to + 1);
    return type === "LVN" ? values[index]! <= Math.min(...peers) : values[index]! >= Math.max(...peers);
  };
  const hasCompleteNeighborhood = (index: number) => rows.length <= neighborhood * 2 + 1
    || (index >= neighborhood && index <= rows.length - neighborhood - 1);
  const nodes: AuctionNodeZone[] = [];
  for (const type of ["LVN", "HVN"] as const) {
    if ((type === "LVN" && !settings.nodeDetection.showLvns) || (type === "HVN" && !settings.nodeDetection.showHvns)) continue;
    const candidates = values
      .map((value, index) => ({ value, index }))
      .filter(({ value, index }) => hasCompleteNeighborhood(index)
        && (type === "LVN" ? value <= lowThreshold : value >= highThreshold)
        && (type === "LVN" && settings.nodeDetection.lvnGapAware ? true : local(index, type)))
      .map(({ index }) => index);
    const groups = settings.nodeDetection.mergeContiguousRows ? mergeCandidates(candidates, settings.nodeDetection.maximumGapRows) : candidates.map(index => [index]);
    for (const group of groups) {
      const firstIndex = group[0]!;
      const lastIndex = group[group.length - 1]!;
      const componentRowIndices = inclusiveIndices(firstIndex, lastIndex);
      if (componentRowIndices.length < settings.nodeDetection.minimumWidthRows) continue;
      const first = rows[firstIndex]!;
      const last = rows[lastIndex]!;
      const rawScore = average(componentRowIndices.map(index => values[index]!));
      const maximum = Math.max(...values, Number.EPSILON);
      const normalizedScore = rawScore / maximum;
      const leftAcceptance = values.slice(Math.max(0, firstIndex - neighborhood), firstIndex);
      const rightAcceptance = values.slice(lastIndex + 1, Math.min(values.length, lastIndex + neighborhood + 1));
      const neighborValues = [...leftAcceptance, ...rightAcceptance];
      const neighborAverage = average(neighborValues);
      let prominence = type === "LVN"
        ? (neighborAverage - rawScore) / Math.max(neighborAverage, Number.EPSILON)
        : (rawScore - neighborAverage) / Math.max(rawScore, Number.EPSILON);
      if (type === "LVN" && settings.nodeDetection.lvnGapAware) {
        const hasLeftAcceptance = leftAcceptance.length > 0;
        const hasRightAcceptance = rightAcceptance.length > 0;
        if (settings.nodeDetection.lvnRequireTwoSidedAcceptance && (!hasLeftAcceptance || !hasRightAcceptance)) continue;
        const leftAverage = average(leftAcceptance);
        const rightAverage = average(rightAcceptance);
        const acceptanceReference = settings.nodeDetection.lvnRequireTwoSidedAcceptance
          ? Math.min(leftAverage, rightAverage)
          : Math.max(leftAverage, rightAverage);
        if (acceptanceReference <= Number.EPSILON) continue;
        const activityRatio = rawScore / acceptanceReference;
        if (activityRatio > settings.nodeDetection.lvnMaximumActivityRatio) continue;
        prominence = Math.max(0, 1 - activityRatio);
      }
      if (prominence < settings.nodeDetection.prominence && settings.nodeDetection.method !== "PERCENTILE") continue;
      const weight = componentRowIndices.reduce((sum, index) => sum + Math.max(values[index]!, Number.EPSILON), 0);
      const weightedCenter = componentRowIndices.reduce((sum, index) => sum + rows[index]!.center * Math.max(values[index]!, Number.EPSILON), 0) / weight;
      const directional = componentRowIndices.reduce((sum, index) => sum + rows[index]!.buyQuantity - rows[index]!.sellQuantity, 0);
      const tpoSource = settings.nodeDetection.source === "TPO" || settings.calculationEngine === "TPO";
      const classification = type === "LVN"
        ? lvnClassification(settings, rows, componentRowIndices)
        : tpoSource ? "TPO_ACCEPTANCE_NODE"
        : Math.abs(directional) < componentRowIndices.reduce((sum, index) => sum + rows[index]!.totalQuantity, 0) * 0.1 ? "BALANCED_ACCEPTANCE_NODE"
          : directional > 0 ? "BUY_DOMINANT_HVN" : "SELL_DOMINANT_HVN";
      nodes.push({
        id: type.toLowerCase() + ":" + first.index + ":" + last.index,
        type,
        classification,
        sourceEngine: settings.nodeDetection.source === "SELECTED_ENGINE" ? settings.calculationEngine : settings.nodeDetection.source,
        low: first.low,
        high: last.high,
        center: (first.low + last.high) / 2,
        weightedCenter,
        componentRowIndices,
        widthRows: componentRowIndices.length,
        rawScore,
        normalizedScore,
        prominence,
        createdAt,
        profileVersion,
        status: "ACTIVE"
      });
    }
  }
  return nodes;
}
