import type {
  CanonicalCluster,
  CanonicalPanePoint,
  CanonicalCurve,
  KioseffSnapshot
} from "../core/canonical.ts";
import type { KioseffSettingsV1 } from "../core/settings.ts";
import { isKioseffVisibleOnTimeframe } from "../core/settings.ts";

export const KIOSEFF_PINE_ACTIVE_OBJECT_CAP = 496;

export type KioseffRenderZone = CanonicalCluster & {
  color: string;
  labelColor: string;
  showLabel: boolean;
  labelText: string | null;
  drawAsLine: boolean;
};

export type KioseffLabelLayout = {
  zone: KioseffRenderZone;
  y: number;
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

function parseHexColor(color: string) {
  const normalized = color.trim().replace(/^#/, "");
  const value = Number.parseInt(normalized.length === 3
    ? normalized.split("").map((part) => `${part}${part}`).join("")
    : normalized, 16);
  if (!Number.isFinite(value)) return { red: 255, green: 255, blue: 255 };
  return {
    red: (value >> 16) & 0xff,
    green: (value >> 8) & 0xff,
    blue: value & 0xff
  };
}

function channelHex(value: number) {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
}

export function interpolateHexColor(from: string, to: string, position: number) {
  const start = parseHexColor(from);
  const end = parseHexColor(to);
  const amount = Math.max(0, Math.min(1, position));
  return `#${channelHex(start.red + (end.red - start.red) * amount)}${channelHex(
    start.green + (end.green - start.green) * amount
  )}${channelHex(start.blue + (end.blue - start.blue) * amount)}`;
}

export function formatPineVolume(value: number) {
  const absolute = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  const compact = (divisor: number, suffix: string) => {
    const amount = absolute / divisor;
    const decimals = amount < 100 ? 2 : amount < 1000 ? 1 : 0;
    return `${sign}${amount.toFixed(decimals).replace(/\.0+$|(?<=\.[0-9])0+$/u, "")}${suffix}`;
  };
  if (absolute >= 1e12) return compact(1e12, "T");
  if (absolute >= 1e9) return compact(1e9, "B");
  if (absolute >= 1e6) return compact(1e6, "M");
  if (absolute >= 1e3) return compact(1e3, "K");
  return `${sign}${absolute.toFixed(2).replace(/\.0+$|(?<=\.[0-9])0+$/u, "")}`;
}

/**
 * Keeps labels on their exact price Y while suppressing rows that cannot fit
 * without collision. Selection is global across the visible price range, so a
 * large ascending grid cannot consume the pool only at its lowest levels.
 */
export function layoutKioseffLabels(
  zones: readonly KioseffRenderZone[],
  yForPrice: (price: number) => number,
  top: number,
  bottom: number,
  fontSize: number,
  maximum = KIOSEFF_PINE_ACTIVE_OBJECT_CAP
): KioseffLabelLayout[] {
  const minimumGap = Math.max(8, fontSize + 1);
  const candidates = zones
    .filter((zone) => zone.showLabel && zone.labelText !== null)
    .map((zone) => ({ zone, y: yForPrice(zone.price) }))
    .filter(({ y }) => Number.isFinite(y) && y >= top && y <= bottom)
    .sort(
      (left, right) =>
        Number(right.zone.hot) - Number(left.zone.hot) ||
        right.zone.absoluteVolume - left.zone.absoluteVolume ||
        left.y - right.y ||
        left.zone.id.localeCompare(right.zone.id)
    );
  const selected: KioseffLabelLayout[] = [];
  for (const candidate of candidates) {
    if (selected.length >= maximum) break;
    if (selected.some((current) => Math.abs(current.y - candidate.y) < minimumGap)) {
      continue;
    }
    selected.push(candidate);
  }
  return selected.sort((left, right) => left.y - right.y);
}

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
  if (!isKioseffVisibleOnTimeframe(settings, snapshot.timeframe)) {
    return {
      model: snapshot.model,
      activeZones: [],
      violatedZones: [],
      curves: [],
      pane: [],
      xRay: null,
      geometryCommandCount: 0
    };
  }
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
        : interpolateHexColor(
            settings.style.chartBackgroundColor,
            settings.volatilityAtEntry.weakClusterColor,
            cluster.strengthNormalized ?? 0
          ),
    labelColor: absorbtion
      ? settings.absorbtion.clusterColor
      : cluster.strength === "strong"
        ? settings.volatilityAtEntry.strongClusterColor
        : settings.volatilityAtEntry.weakClusterColor,
    showLabel:
      absorbtion || settings.volatilityAtEntry.showActiveClusterSize,
    labelText: formatPineVolume(cluster.signedVolume),
    drawAsLine: false,
    opacity: opacityFor(cluster)
  }));
  const violatedZones = violated.map((cluster) => ({
    ...cluster,
    color: absorbtion
      ? settings.absorbtion.oldClusterColor
      : snapshot.granularity === "lower"
        ? interpolateHexColor(
            settings.volatilityAtEntry.weakClusterColor,
            settings.volatilityAtEntry.strongClusterColor,
            0.5
          )
        : cluster.strength === "strong"
          ? settings.volatilityAtEntry.strongClusterColor
          : interpolateHexColor(
              settings.style.chartBackgroundColor,
              settings.volatilityAtEntry.weakClusterColor,
              cluster.strengthNormalized ?? 0
            ),
    labelColor: absorbtion
      ? settings.absorbtion.oldClusterColor
      : settings.volatilityAtEntry.strongClusterColor,
    showLabel: absorbtion,
    labelText: absorbtion ? formatPineVolume(cluster.signedVolume) : null,
    drawAsLine: !absorbtion,
    opacity:
      !absorbtion && snapshot.granularity === "lower"
        ? 0.5
        : opacityFor(cluster)
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

export function kioseffPriceDomain(
  snapshot: KioseffSnapshot | null,
  settings: KioseffSettingsV1,
  candleMinimum: number,
  candleMaximum: number,
  visibleStartTime: number | null,
  visibleEndTime: number | null
) {
  const policy = settings.visibility.priceScalePolicy;
  if (
    !snapshot ||
    policy === "candles-only" ||
    policy === "fixed-manual" ||
    !isKioseffVisibleOnTimeframe(settings, snapshot.timeframe)
  ) {
    return { minimum: candleMinimum, maximum: candleMaximum, includedClusters: 0 };
  }
  const source = policy === "candles-active-clusters"
    ? snapshot.activeClusters
    : [
        ...snapshot.activeClusters,
        ...(snapshot.model === "absorbtion-extremes" ||
        settings.volatilityAtEntry.showHistoricalTriggers
          ? snapshot.violatedClusters
          : [])
      ];
  const candleRange = Math.max(1e-9, candleMaximum - candleMinimum);
  // Include nearby geometry while refusing to compress the chart for extreme,
  // currently irrelevant levels. This affects only projection, never state.
  const guardMinimum = candleMinimum - candleRange * 2.5;
  const guardMaximum = candleMaximum + candleRange * 2.5;
  const visible = source.filter((cluster) => {
    const startsBeforeEnd =
      visibleEndTime === null || (cluster.startTime ?? cluster.creationTime) <= visibleEndTime;
    const endsAfterStart =
      cluster.endTime === null || visibleStartTime === null || cluster.endTime >= visibleStartTime;
    const nearby = cluster.priceHigh >= guardMinimum && cluster.priceLow <= guardMaximum;
    return startsBeforeEnd && endsAfterStart && nearby;
  });
  return {
    minimum: Math.min(candleMinimum, ...visible.map((cluster) => cluster.priceLow)),
    maximum: Math.max(candleMaximum, ...visible.map((cluster) => cluster.priceHigh)),
    includedClusters: visible.length
  };
}
