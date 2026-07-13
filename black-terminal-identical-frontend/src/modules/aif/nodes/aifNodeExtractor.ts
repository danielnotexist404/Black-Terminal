import type { AifAuctionNode, AifNodeType, AifProfileResult } from "../core/aifTypes";

export function extractAifNodes(profile: AifProfileResult, sensitivity: number, now: number): AifAuctionNode[] {
  const rows = profile.rows;
  if (rows.length < 3) return [];
  const highThreshold = 0.58 + Math.max(0, Math.min(100, sensitivity)) * 0.0025;
  const lowThreshold = Math.max(0.035, 0.22 - sensitivity * 0.0012);
  const candidates: Array<{ index: number; type: AifNodeType; strength: number }> = [];
  for (let index = 1; index < rows.length - 1; index += 1) {
    const value = rows[index].normalized;
    const high = value >= highThreshold && value >= rows[index - 1].normalized && value >= rows[index + 1].normalized;
    const low = value <= lowThreshold && value <= rows[index - 1].normalized && value <= rows[index + 1].normalized;
    if (high) candidates.push({ index, type: nodeType(profile, rows[index].value, true), strength: value });
    if (low) candidates.push({ index, type: "lvn", strength: 1 - value });
  }
  return mergeCandidates(candidates, profile, now);
}

function mergeCandidates(candidates: Array<{ index: number; type: AifNodeType; strength: number }>, profile: AifProfileResult, now: number) {
  const nodes: AifAuctionNode[] = [];
  for (const candidate of candidates) {
    const row = profile.rows[candidate.index];
    const previous = nodes.at(-1);
    if (previous && previous.nodeType === candidate.type && row.low <= previous.high * 1.000001) {
      previous.high = row.high;
      previous.center = (previous.low + previous.high) / 2;
      previous.weightedCenter = (previous.weightedCenter * previous.rawStrength + row.center * candidate.strength) / (previous.rawStrength + candidate.strength);
      previous.rawStrength += candidate.strength;
      previous.normalizedStrength = Math.max(previous.normalizedStrength, candidate.strength);
      continue;
    }
    const stableId = `${profile.profileType}:${candidate.type}:${Math.round(row.center / Math.max(1e-8, row.high - row.low))}`;
    nodes.push({
      id: stableId,
      profileType: profile.profileType,
      nodeType: candidate.type,
      low: row.low,
      high: row.high,
      center: row.center,
      weightedCenter: row.center,
      rawStrength: candidate.strength,
      normalizedStrength: candidate.strength,
      confidence: Math.round(Math.min(99, 45 + candidate.strength * 48)),
      stability: 0,
      firstObserved: now,
      lastObserved: now,
      sourceRange: { start: profile.provenance.calculationStart ?? 0, end: profile.provenance.calculationEnd ?? 0 },
      status: "untested",
      touchCount: 0,
      tested: false,
      provenance: profile.provenance
    });
  }
  return nodes;
}

function nodeType(profile: AifProfileResult, value: number, high: boolean): AifNodeType {
  if (!high) return "lvn";
  if (profile.profileType === "delta") return value >= 0 ? "positive-delta" : "negative-delta";
  if (profile.profileType === "volatility") return "expansion";
  if (profile.profileType === "pressure") return value >= 0 ? "buy-pressure" : "sell-pressure";
  return "hvn";
}

export function applyNodeStability(nodes: AifAuctionNode[], nearby: AifAuctionNode[][]) {
  for (const node of nodes) {
    let matches = 1;
    for (const set of nearby) if (set.some((candidate) => candidate.nodeType === node.nodeType && overlap(node.low, node.high, candidate.low, candidate.high) > 0.3)) matches += 1;
    node.stability = Math.round(matches / (nearby.length + 1) * 100);
    node.confidence = Math.round(Math.min(99, node.confidence * 0.7 + node.stability * 0.3));
  }
  return nodes;
}

function overlap(aLow: number, aHigh: number, bLow: number, bHigh: number) {
  return Math.max(0, Math.min(aHigh, bHigh) - Math.max(aLow, bLow)) / Math.max(1e-12, Math.max(aHigh, bHigh) - Math.min(aLow, bLow));
}
