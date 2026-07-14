import type { Candle } from "../../../chart-engine/types";
import { extractStructuralLowActivityZones } from "../../../profile-core/structuralZones.ts";
import type { AifLvnZone, AifProfileResult, AifSettings, AifTimelineEvent } from "../core/aifTypes";

export function extractAifLvnZones(profile: AifProfileResult, settings: AifSettings, now: number): AifLvnZone[] {
  const structural = extractStructuralLowActivityZones(profile.rows.map((row) => ({
    index: row.index, low: row.low, high: row.high, center: row.center, activity: Math.abs(row.value)
  })), {
    method: settings.nodeMethod,
    percentileThreshold: settings.lvnPercentileThreshold,
    relativePocThreshold: settings.lvnRelativePocThreshold,
    robustZThreshold: settings.lvnRobustZThreshold,
    neighborWindow: settings.lvnNeighborWindow,
    minimumNeighborContrast: settings.lvnMinimumContrast,
    minimumContiguousRows: settings.lvnMinimumContiguousRows,
    maximumInternalGapRows: settings.lvnInternalGapRows,
    minimumWidthRows: settings.lvnMinimumWidthRows,
    maximumWidthRows: settings.lvnMaximumWidthRows,
    mergeDistanceRows: settings.lvnMergeDistanceRows,
    edgeExclusionRows: settings.lvnEdgeExclusionRows,
    minimumScore: settings.lvnMinimumStrength
  });
  const tick = profile.rows[0] ? profile.rows[0].high - profile.rows[0].low : 1;
  return structural.map((zone) => {
    const confidence = Math.round(Math.min(99, zone.structuralScore * 0.72 + Math.min(100, zone.neighborContrast * 20) * 0.28));
    return {
      id: stableZoneId(profile, zone.low, zone.high, tick), venue: profile.provenance.venue,
      symbol: profile.provenance.symbol, timeframe: profile.provenance.timeframe, profileType: profile.profileType,
      low: zone.low, high: zone.high, center: zone.center, weightedCenter: zone.weightedCenter,
      minimumActivityPrice: zone.minimumActivityPrice, widthAbsolute: zone.widthAbsolute,
      widthPercent: zone.widthPercent, widthTicks: zone.widthAbsolute / Math.max(tick, 1e-12), rawActivity: zone.rawActivity,
      normalizedActivity: zone.normalizedActivity, activityPercentile: zone.activityPercentile,
      neighborContrast: zone.neighborContrast, valleyDepth: zone.valleyDepth, strength: zone.structuralScore,
      stability: 0, confidence, score: 0, requestedLookback: profile.provenance.requestedLookbackBars,
      effectiveLookback: profile.provenance.effectiveLookbackBars, sourceResolution: profile.provenance.sourceResolution,
      dataQuality: profile.provenance.quality, detectionMethod: zone.method, algorithmVersion: zone.algorithmVersion,
      firstObserved: now, lastObserved: now, touchCount: 0, rejectionCount: 0, acceptanceCount: 0,
      state: "qualified", projected: false, invalidated: false, provenance: { ...profile.provenance, profileVersion: "lvn-zone/1.0.0" }
    };
  });
}

export function applyAifLvnStability(zones: AifLvnZone[], nearby: AifLvnZone[][]) {
  for (const zone of zones) {
    let matches = 1;
    for (const comparison of nearby) if (comparison.some((candidate) => zoneOverlap(zone, candidate) >= 0.35 || centerDistanceRows(zone, candidate) <= 1.5)) matches += 1;
    zone.stability = Math.round(matches / (nearby.length + 1) * 100);
    zone.confidence = Math.round(Math.min(99, zone.confidence * 0.68 + zone.stability * 0.32));
  }
  return zones;
}

export function applyAifLvnLifecycle(zones: AifLvnZone[], candles: Candle[], settings: AifSettings) {
  const source = candles.slice(-Math.max(80, settings.timelineHorizon));
  for (const zone of zones) {
    let inSession = false;
    let separation = 3;
    let closesInside = 0;
    let sessionPenetration = 0;
    for (const candle of source) {
      const intersects = candle.high >= zone.low && candle.low <= zone.high;
      if (!intersects) {
        separation += 1;
        if (inSession && separation >= 2) {
          if (closesInside >= 3 || sessionPenetration >= 0.9) { zone.acceptanceCount += 1; zone.state = "accepted"; }
          else { zone.rejectionCount += 1; zone.state = "rejected"; }
          inSession = false; closesInside = 0; sessionPenetration = 0;
        }
        continue;
      }
      if (!inSession && separation >= 2) {
        zone.touchCount += 1;
        zone.state = zone.touchCount === 1 ? "first-test" : "retest";
        inSession = true;
      }
      separation = 0;
      if (candle.close >= zone.low && candle.close <= zone.high) closesInside += 1;
      const overlap = Math.max(0, Math.min(candle.high, zone.high) - Math.max(candle.low, zone.low));
      sessionPenetration = Math.max(sessionPenetration, overlap / Math.max(zone.widthAbsolute, 1e-12));
    }
    if (zone.acceptanceCount >= 2 || (zone.touchCount >= 4 && zone.rejectionCount === 0)) {
      zone.state = "invalidated"; zone.invalidated = true;
    }
  }
  return zones;
}

export function selectProjectedAifLvns(zones: AifLvnZone[], currentPrice: number, settings: AifSettings) {
  const eligible = zones.filter((zone) => {
    if (zone.invalidated && settings.futureLvnKeepInvalidated !== "faded") return false;
    if (zone.state === "accepted" && !settings.futureLvnKeepTested) return false;
    if (zone.strength < settings.lvnMinimumStrength || zone.stability < settings.futureLvnMinimumStability || zone.neighborContrast < settings.futureLvnMinimumContrast || zone.confidence < settings.futureLvnMinimumConfidence) return false;
    if (settings.futureLvnPolicy === "major-untested" && zone.state !== "qualified") return false;
    if (settings.futureLvnPolicy === "untested-first-test" && !["qualified", "first-test", "rejected"].includes(zone.state)) return false;
    if (settings.futureLvnPolicy === "active-lifecycle" && ["invalidated", "expired", "broken", "accepted"].includes(zone.state)) return false;
    return true;
  });
  for (const zone of eligible) {
    const freshness = Math.max(0.55, 1 - zone.touchCount * 0.1);
    const lifecycle = zone.state === "qualified" ? 1 : zone.state === "rejected" ? 0.94 : 0.82;
    const quality = zone.dataQuality === "exact" ? 1 : zone.dataQuality === "estimated" ? 0.88 : 0.7;
    const contrastScore = Math.min(100, Math.max(0, (zone.neighborContrast - 1) * 45));
    zone.score = Math.round(Math.min(100, (zone.strength * 0.32 + zone.stability * 0.24 + contrastScore * 0.2 + zone.confidence * 0.14 + freshness * 100 * 0.1) * lifecycle * quality));
  }
  const ranked = eligible.filter((zone) => zone.score >= settings.futureLvnMinimumScore).sort((a, b) => b.score - a.score);
  const above = ranked.filter((zone) => zone.center >= currentPrice).slice(0, settings.futureLvnMaxAbove);
  const below = ranked.filter((zone) => zone.center < currentPrice).slice(0, settings.futureLvnMaxBelow);
  return [...above, ...below].sort((a, b) => b.score - a.score).slice(0, settings.futureLvnMaxTotal).map((zone) => ({ ...zone, projected: true, state: zone.state === "qualified" ? "projected" as const : zone.state }));
}

export function buildAifLvnZoneEvents(zones: AifLvnZone[], time: number): AifTimelineEvent[] {
  return zones.flatMap((zone) => {
    const base: AifTimelineEvent = {
      id: `lvn-zone-created:${zone.id}:${time}`, time, type: "lvn-zone-created", price: zone.center,
      confidence: zone.confidence, source: zone.profileType, nodeId: zone.id,
      details: { low: zone.low, high: zone.high, score: zone.score, state: zone.state, algorithm: zone.algorithmVersion },
      provenance: zone.provenance
    };
    const events = [base];
    if (zone.projected) events.push({ ...base, id: `lvn-zone-projected:${zone.id}:${time}`, type: "lvn-zone-projected" });
    const lifecycleType = zone.state === "first-test" ? "lvn-zone-first-test" : zone.state === "rejected" ? "lvn-zone-rejected" : zone.state === "accepted" ? "lvn-zone-accepted" : zone.state === "invalidated" ? "lvn-zone-invalidated" : null;
    if (lifecycleType) events.push({ ...base, id: `${lifecycleType}:${zone.id}:${time}`, type: lifecycleType });
    return events;
  });
}

function stableZoneId(profile: AifProfileResult, low: number, high: number, tick: number) {
  const quantizedLow = Math.round(low / Math.max(tick, 1e-12));
  const quantizedHigh = Math.round(high / Math.max(tick, 1e-12));
  return `${profile.profileType}:lvn-zone:${quantizedLow}-${quantizedHigh}`;
}
function zoneOverlap(left: AifLvnZone, right: AifLvnZone) { const overlap = Math.max(0, Math.min(left.high, right.high) - Math.max(left.low, right.low)); const union = Math.max(left.high, right.high) - Math.min(left.low, right.low); return union > 0 ? overlap / union : 0; }
function centerDistanceRows(left: AifLvnZone, right: AifLvnZone) { return Math.abs(left.center - right.center) / Math.max(left.widthAbsolute, right.widthAbsolute, 1e-12); }
