import type { AifAuctionNode, AifProfileConfluence } from "../core/aifTypes";

export function calculateAifConfluence(primary: AifAuctionNode[], secondary: AifAuctionNode[]): AifProfileConfluence[] {
  const output: AifProfileConfluence[] = [];
  for (const left of primary) for (const right of secondary) {
    const overlapWidth = Math.max(0, Math.min(left.high, right.high) - Math.max(left.low, right.low));
    const union = Math.max(left.high, right.high) - Math.min(left.low, right.low);
    const overlapPercent = union > 0 ? overlapWidth / union * 100 : 0;
    const distance = Math.abs(left.weightedCenter - right.weightedCenter);
    if (overlapPercent < 15 && distance > Math.max(left.high - left.low, right.high - right.low)) continue;
    output.push({ primaryNodeId: left.id, secondaryNodeId: right.id, overlapPercent, distance, relationship: left.nodeType === right.nodeType ? "confirming" : "cross-lens", confidence: Math.round(Math.min(99, (left.confidence + right.confidence) / 2 + overlapPercent * 0.2)) });
  }
  return output.sort((a, b) => b.confidence - a.confidence).slice(0, 24);
}
