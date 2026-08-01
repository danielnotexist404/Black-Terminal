import type {
  CanonicalCluster,
  CanonicalPanePoint,
  CanonicalCurve,
  KioseffSnapshot
} from "../core/canonical.ts";
import type { KioseffSettingsV1 } from "../core/settings.ts";

export type KioseffRenderZone = CanonicalCluster & {
  color: string;
  showLabel: boolean;
};

export type KioseffRenderModel = {
  model: KioseffSnapshot["model"];
  activeZones: KioseffRenderZone[];
  violatedZones: KioseffRenderZone[];
  curves: CanonicalCurve[];
  pane: CanonicalPanePoint[];
  xRay: { enabled: boolean; priceLow: number; priceHigh: number } | null;
  geometryCommandCount: number;
};

function newestBySide(
  clusters: readonly CanonicalCluster[],
  buyLimit: number,
  sellLimit: number
) {
  const newest = (side: CanonicalCluster["side"], limit: number) =>
    clusters
      .filter((cluster) => cluster.side === side)
      .sort(
        (left, right) =>
          right.creationTime - left.creationTime || right.id.localeCompare(left.id)
      )
      .slice(0, limit);
  return [...newest("buy-stop", buyLimit), ...newest("sell-stop", sellLimit)];
}

export function buildKioseffRenderModel(
  snapshot: KioseffSnapshot,
  settings: KioseffSettingsV1
): KioseffRenderModel {
  const absorbtion = snapshot.model === "absorbtion-extremes";
  const active = absorbtion
    ? newestBySide(
        snapshot.activeClusters,
        settings.absorbtion.stopClusterBuys,
        settings.absorbtion.stopClusterSells
      )
    : snapshot.activeClusters;
  const violated = absorbtion
    ? newestBySide(
        snapshot.violatedClusters,
        settings.absorbtion.oldStopClusterBuys,
        settings.absorbtion.oldStopClusterSells
      )
    : settings.volatilityAtEntry.showHistoricalTriggers
      ? snapshot.violatedClusters
      : [];
  const absorbtionMaximumVolume = absorbtion
    ? Math.max(
        1,
        ...[...active, ...violated].map((cluster) =>
          Math.abs(cluster.signedVolume)
        )
      )
    : 1;
  const opacityFor = (cluster: CanonicalCluster) =>
    absorbtion && settings.absorbtion.intensityBySize
      ? 0.07 +
        0.25 *
          Math.min(1, Math.abs(cluster.signedVolume) / absorbtionMaximumVolume)
      : cluster.opacity;
  const activeZones = active.map((cluster) => ({
    ...cluster,
    color: absorbtion
      ? settings.absorbtion.clusterColor
      : cluster.strength === "strong"
        ? settings.volatilityAtEntry.strongClusterColor
        : settings.volatilityAtEntry.weakClusterColor,
    showLabel:
      absorbtion || settings.volatilityAtEntry.showActiveClusterSize,
    opacity: opacityFor(cluster)
  }));
  const violatedZones = violated.map((cluster) => ({
    ...cluster,
    color: absorbtion
      ? settings.absorbtion.oldClusterColor
      : cluster.strength === "strong"
        ? settings.volatilityAtEntry.strongClusterColor
        : settings.volatilityAtEntry.weakClusterColor,
    showLabel: absorbtion,
    opacity: opacityFor(cluster)
  }));
  const all = [...activeZones, ...violatedZones];
  const xRay =
    absorbtion && settings.absorbtion.showXRay && all.length
      ? {
          enabled: true,
          priceLow: Math.min(...all.map((cluster) => cluster.priceLow)),
          priceHigh: Math.max(...all.map((cluster) => cluster.priceHigh))
        }
      : null;
  return {
    model: snapshot.model,
    activeZones,
    violatedZones,
    curves: absorbtion ? snapshot.qCurves.slice(-50) : [],
    pane: snapshot.pane,
    xRay,
    geometryCommandCount:
      activeZones.length * 2 +
      violatedZones.length * 2 +
      snapshot.qCurves.reduce(
        (sum, curve) => sum + Math.max(0, curve.points.length - 1),
        0
      ) +
      snapshot.pane.reduce(
        (sum, point) =>
          sum +
          Number(point.buyStopsHit !== null) +
          Number(point.sellStopsHit !== null) +
          Number(point.buyAverage !== null) +
          Number(point.sellAverage !== null),
        0
      ) +
      Number(Boolean(xRay))
  };
}
