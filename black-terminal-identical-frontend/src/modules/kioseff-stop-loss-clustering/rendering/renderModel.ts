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
  const activeZones = active.map((cluster) => ({
    ...cluster,
    color: absorbtion
      ? settings.absorbtion.clusterColor
      : cluster.strength === "strong"
        ? settings.volatilityAtEntry.strongClusterColor
        : settings.volatilityAtEntry.weakClusterColor,
    showLabel:
      absorbtion || settings.volatilityAtEntry.showActiveClusterSize
  }));
  const violatedZones = violated.map((cluster) => ({
    ...cluster,
    color: absorbtion
      ? settings.absorbtion.oldClusterColor
      : cluster.strength === "strong"
        ? settings.volatilityAtEntry.strongClusterColor
        : settings.volatilityAtEntry.weakClusterColor,
    showLabel: absorbtion
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
    xRay
  };
}
