import type { AuctionNodeZone, AuctionProfileRow, AuctionProfileSettings } from "./types.ts";

function percentile(values: readonly number[], percent: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((percent / 100) * (sorted.length - 1))));
  return sorted[index]!;
}

function nodeSource(row: AuctionProfileRow, settings: AuctionProfileSettings) {
  switch (settings.nodeDetection.source) {
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

function mergeCandidates(candidates: number[], maximumGap: number) {
  const groups: number[][] = [];
  for (const index of candidates) {
    const group = groups[groups.length - 1];
    if (group && index - group[group.length - 1]! <= maximumGap + 1) group.push(index);
    else groups.push([index]);
  }
  return groups;
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
      .filter(({ value, index }) => hasCompleteNeighborhood(index) && (type === "LVN" ? value <= lowThreshold : value >= highThreshold) && local(index, type))
      .map(({ index }) => index);
    const groups = settings.nodeDetection.mergeContiguousRows ? mergeCandidates(candidates, settings.nodeDetection.maximumGapRows) : candidates.map(index => [index]);
    for (const group of groups.filter(item => item.length >= settings.nodeDetection.minimumWidthRows)) {
      const first = rows[group[0]!]!;
      const last = rows[group[group.length - 1]!]!;
      const rawScore = group.reduce((sum, index) => sum + values[index]!, 0) / group.length;
      const maximum = Math.max(...values, Number.EPSILON);
      const normalizedScore = rawScore / maximum;
      const neighborValues = values.slice(Math.max(0, group[0]! - neighborhood), Math.min(values.length, group[group.length - 1]! + neighborhood + 1));
      const neighborAverage = neighborValues.reduce((sum, value) => sum + value, 0) / Math.max(1, neighborValues.length);
      const prominence = type === "LVN" ? (neighborAverage - rawScore) / Math.max(neighborAverage, Number.EPSILON) : (rawScore - neighborAverage) / Math.max(rawScore, Number.EPSILON);
      if (prominence < settings.nodeDetection.prominence && settings.nodeDetection.method !== "PERCENTILE") continue;
      const weight = group.reduce((sum, index) => sum + Math.max(values[index]!, Number.EPSILON), 0);
      const weightedCenter = group.reduce((sum, index) => sum + rows[index]!.center * Math.max(values[index]!, Number.EPSILON), 0) / weight;
      const directional = group.reduce((sum, index) => sum + rows[index]!.buyQuantity - rows[index]!.sellQuantity, 0);
      const classification = type === "LVN"
        ? settings.nodeDetection.source === "TPO" ? "TPO_SINGLE_PRINT_ZONE" : settings.nodeDetection.source.includes("CVD") ? "CVD_LVN" : "DIRECTIONAL_INEFFICIENCY"
        : Math.abs(directional) < group.reduce((sum, index) => sum + rows[index]!.totalQuantity, 0) * 0.1 ? "BALANCED_ACCEPTANCE_NODE"
          : directional > 0 ? "BUY_DOMINANT_HVN" : "SELL_DOMINANT_HVN";
      nodes.push({
        id: type.toLowerCase() + ":" + first.index + ":" + last.index,
        type,
        classification,
        sourceEngine: settings.nodeDetection.source,
        low: first.low,
        high: last.high,
        center: (first.low + last.high) / 2,
        weightedCenter,
        componentRowIndices: group,
        widthRows: group.length,
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
