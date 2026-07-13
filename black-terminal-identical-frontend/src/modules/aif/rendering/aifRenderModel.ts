import type { AifAuctionNode, AifProfileConfluence, AifProfileResult, AifRenderModel, AifTimelineEvent } from "../core/aifTypes";
import type { AifImmContext } from "../imm/aifImmBridge";

export function buildAifRenderModel(primary: AifProfileResult, primaryNodes: AifAuctionNode[], secondary: AifProfileResult | undefined, secondaryNodes: AifAuctionNode[], confluence: AifProfileConfluence[], events: AifTimelineEvent[], chob: AifRenderModel["auctionStateSummary"]["chob"], imm: AifImmContext, currentPrice: number, calculationMs: number, timings: AifRenderModel["timings"]): AifRenderModel {
  const nearest = [...primaryNodes].sort((a, b) => Math.abs(a.center - currentPrice) - Math.abs(b.center - currentPrice))[0] ?? null;
  const projectedLvns = primaryNodes.filter((node) => node.nodeType === "lvn" && !node.tested).sort((a, b) => b.confidence - a.confidence).slice(0, 5);
  const zones = primaryNodes.filter((node) => node.nodeType !== "lvn" && node.confidence >= 60).sort((a, b) => b.confidence - a.confidence).slice(0, 6);
  const rejection = events.filter((event) => event.type === "node-rejected").at(-1)?.confidence ?? 0;
  const acceptance = events.filter((event) => event.type === "node-accepted").at(-1)?.confidence ?? 0;
  return {
    profileHistogram: primary,
    primaryNodes,
    secondaryProfile: secondary,
    secondaryNodes,
    confluenceMarkers: confluence,
    supportResistanceZones: zones,
    projectedLvns,
    activeNode: nearest,
    auctionStateSummary: { profile: primary.profileType.toUpperCase(), nearestStructure: nearest ? `${nearest.nodeType.toUpperCase()} ${formatPrice(nearest.center)}` : "NONE", state: nearest?.status.toUpperCase() ?? "UNTESTED", rejection, acceptance, imm: imm.status.toUpperCase(), chob, dataQuality: primary.quality.toUpperCase() },
    timelineEvents: events,
    provenance: primary.provenance,
    renderVersion: "aif-render/1.0.0",
    calculationMs,
    timings,
    cacheState: "miss"
  };
}

function formatPrice(value: number) { return value.toLocaleString(undefined, { maximumFractionDigits: 2 }); }
