import { createAuctionDomain } from "./aifAuctionDomain.ts";
import { normalizeAifCandles } from "./aifDataNormalizer.ts";
import type { AifAuctionNode, AifCalculationRequest, AifImplementedProfileType, AifProvenance, AifRenderModel } from "./aifTypes";
import { calculateAifProfile } from "../profiles/profileCalculators.ts";
import { applyNodeStability, extractAifNodes } from "../nodes/aifNodeExtractor.ts";
import { calculateAifConfluence } from "../nodes/aifConfluence.ts";
import { buildAifTimeline } from "../events/aifEventEngine.ts";
import { resolveAifImmContext } from "../imm/aifImmBridge.ts";
import { buildAifRenderModel } from "../rendering/aifRenderModel.ts";
import { applyAifLvnLifecycle, applyAifLvnStability, buildAifLvnZoneEvents, extractAifLvnZones, selectProjectedAifLvns } from "../nodes/aifLvnZones.ts";

export function calculateAif(request: AifCalculationRequest): AifRenderModel {
  const started = performance.now();
  const interval = timeframeSeconds(request.timeframe);
  const data = normalizeAifCandles(request.candles, request.settings.lookbackBars, interval);
  const normalizedAt = performance.now();
  const provenance = baseProvenance(request, data.coverage);
  const primaryDomain = createAuctionDomain(data, request.settings, request.currentPrice, request.settings.primaryProfile);
  const primary = calculateAifProfile(request.settings.primaryProfile, data, primaryDomain, request.settings, provenance);
  const profileAt = performance.now();
  const primaryNodeCandidates = extractAifNodes(primary, request.settings.nodeSensitivity, Date.now());
  const nearbyProfiles = [0.75, 0.9].filter((ratio) => request.settings.multiLookbackStability !== "off" && data.candles.length * ratio >= 100).map((ratio) => {
    const subset = normalizeAifCandles(data.candles.slice(-Math.round(data.candles.length * ratio)), Math.round(data.candles.length * ratio), interval);
    const subsetDomain = createAuctionDomain(subset, request.settings, request.currentPrice, request.settings.primaryProfile);
    const subsetProfile = calculateAifProfile(request.settings.primaryProfile, subset, subsetDomain, request.settings, { ...provenance, ...subset.coverage });
    return subsetProfile;
  });
  const nearbyNodes = nearbyProfiles.map((profile) => extractAifNodes(profile, request.settings.nodeSensitivity, Date.now()));
  const primaryNodes = applyNodeStability(primaryNodeCandidates, nearbyNodes);
  const lvnZones = applyAifLvnLifecycle(applyAifLvnStability(extractAifLvnZones(primary, request.settings, Date.now()), nearbyProfiles.map((profile) => extractAifLvnZones(profile, request.settings, Date.now()))), data.candles, request.settings);
  const projectedLvns = selectProjectedAifLvns(lvnZones, request.currentPrice, request.settings);
  let secondary;
  let secondaryNodes: AifAuctionNode[] = [];
  if (request.settings.secondaryProfile !== "off") {
    const type = request.settings.secondaryProfile as AifImplementedProfileType;
    const domain = request.settings.comparisonMode === "shared-domain" ? { ...primaryDomain, currentProfileType: type } : createAuctionDomain(data, request.settings, request.currentPrice, type);
    secondary = calculateAifProfile(type, data, domain, request.settings, provenance);
    secondaryNodes = extractAifNodes(secondary, request.settings.nodeSensitivity, Date.now());
  }
  const confluence = calculateAifConfluence(primaryNodes, secondaryNodes);
  const nodesAt = performance.now();
  const timeline = buildAifTimeline(data.candles, primaryNodes, request.settings.timelineHorizon, request.settings.minimumConfidence, primary.provenance);
  timeline.events.push(...buildAifLvnZoneEvents(projectedLvns, data.candles.at(-1)?.time ?? Math.floor(Date.now() / 1000)));
  timeline.events.sort((a, b) => a.time - b.time);
  timeline.events.splice(0, Math.max(0, timeline.events.length - request.settings.maximumTimelineEvents));
  const eventsAt = performance.now();
  const model = buildAifRenderModel(primary, primaryNodes, lvnZones, projectedLvns, secondary, secondaryNodes, confluence, timeline.events, timeline.activeState, resolveAifImmContext(), request.currentPrice, eventsAt - started, { normalizationMs: normalizedAt - started, profileMs: profileAt - normalizedAt, nodeAndStabilityMs: nodesAt - profileAt, eventMs: eventsAt - nodesAt, renderModelMs: 0 });
  model.timings.renderModelMs = performance.now() - eventsAt;
  model.calculationMs = performance.now() - started;
  return model;
}

function baseProvenance(request: AifCalculationRequest, coverage: ReturnType<typeof normalizeAifCandles>["coverage"]): AifProvenance {
  return { ...coverage, venue: request.marketSymbol.exchange, symbol: request.marketSymbol.rawSymbol, marketType: request.marketSymbol.marketKind, timeframe: request.timeframe, sourceType: "chart-candles", sourceResolution: request.timeframe, profileType: request.settings.primaryProfile, profileVersion: "1.1.0", bucketMethod: request.settings.bucketMode, allocationMethod: "pending", quality: "estimated", engineVersion: "aif-engine/1.1.0", calculatedAt: Date.now() };
}

function timeframeSeconds(timeframe: string) {
  const units: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  const match = /^(\d+)([smhdw])$/.exec(timeframe);
  return match ? Number(match[1]) * units[match[2]] : 60;
}
