export const KIOSEFF_SCHEMA_VERSION = 1;
export const KIOSEFF_ENGINE_VERSION = "1.1.0-pine-compatibility-parity-pending";

export type KioseffModel = "absorbtion-extremes" | "volatility-at-entry";
export type KioseffGranularity = "higher" | "lower";
export type KioseffEngineMode = "pine-compatibility" | "black-core-enhanced";
export type ClusterSide = "buy-stop" | "sell-stop";
export type ClusterState = "active" | "violated";

export type CanonicalCluster = {
  id: string;
  side: ClusterSide;
  state: ClusterState;
  signedVolume: number;
  absoluteVolume: number;
  price: number;
  priceLow: number;
  priceHigh: number;
  tickIndex: number | null;
  creationTime: number;
  startTime: number | null;
  violationTime: number | null;
  endTime: number | null;
  strength: "strong" | "weak" | null;
  percentileValue: number | null;
  strengthNormalized: number | null;
  hot: boolean;
  sourceCount: number;
  opacity: number | null;
  granularity: KioseffGranularity | null;
  historicalTrigger: boolean;
  createdAtBarIndex: number;
  violatedAtBarIndex: number | null;
  sourceEngineVersion: string;
};

export type CanonicalCurve = {
  id: string;
  side: ClusterSide;
  startTime: number;
  endTime: number;
  dashed: boolean;
  points: Array<{ time: number; price: number }>;
};

export type CanonicalNearest = {
  clusterId: string;
  price: number;
  signedVolume: number;
  typicalMove: number | null;
  activeSidePercent: number | null;
};

export type CanonicalPanePoint = {
  time: number;
  buyStopsHit: number | null;
  sellStopsHit: number | null;
  buyAverage: number | null;
  sellAverage: number | null;
  radiateBuy: boolean;
  radiateSell: boolean;
};

export type CanonicalAlertEvent = {
  id: string;
  time: number;
  side: ClusterSide;
  title: "Large Buy-Stop Cluster Triggered" | "Large Sell-Stop Cluster Triggered";
  message: "Large Buy-Stop Cluster Triggered" | "Large Sell-Stop Cluster Triggered";
};

export type CanonicalSummaryModel = {
  nearestBuy: CanonicalNearest | null;
  nearestSell: CanonicalNearest | null;
};

export type CanonicalRatioModel = {
  activeBuyStops: number;
  activeSellStops: number;
  violatedBuyStops: number;
  violatedSellStops: number;
  activeBuyBlocks: number | null;
  activeSellBlocks: number | null;
  violatedBuyBlocks: number | null;
  violatedSellBlocks: number | null;
  blocks: 20;
};

export type CanonicalDiagnostic = {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  barTime?: number;
  intrabarTime?: number;
  data?: Record<string, string | number | boolean | null>;
};

export type KioseffSnapshot = {
  schemaVersion: number;
  engineVersion: string;
  model: KioseffModel;
  granularity?: KioseffGranularity;
  symbol: {
    exchange: string;
    rawSymbol: string;
    assetClass: string;
    tickSize: string;
  };
  timeframe: string;
  sourceVersion: string;
  committedThrough: number | null;
  provisionalBarTime: number | null;
  activeClusters: CanonicalCluster[];
  violatedClusters: CanonicalCluster[];
  qCurves: CanonicalCurve[];
  outputs: {
    buyStopsHit: number | null;
    sellStopsHit: number | null;
    buyStopsAverage: number | null;
    sellStopsAverage: number | null;
    nearestBuy: CanonicalNearest | null;
    nearestSell: CanonicalNearest | null;
    activeBuyTotal: number;
    activeSellTotal: number;
    violatedBuyTotal: number;
    violatedSellTotal: number;
    typicalBuyMove: number | null;
    typicalSellMove: number | null;
    radiateBuy: boolean;
    radiateSell: boolean;
  };
  pane: CanonicalPanePoint[];
  alerts: CanonicalAlertEvent[];
  summary: CanonicalSummaryModel;
  ratioMeter: CanonicalRatioModel;
  diagnostics: CanonicalDiagnostic[];
};

function escapeIdPart(value: string | number) {
  return encodeURIComponent(String(value));
}

export function canonicalClusterId(input: {
  model: KioseffModel;
  side: ClusterSide;
  priceKey: string | number;
  creationTime: number;
  creationSequence: number;
}) {
  return [
    input.model,
    input.side,
    escapeIdPart(input.priceKey),
    input.creationTime,
    input.creationSequence
  ].join(":");
}

export function compareCanonicalClusters(left: CanonicalCluster, right: CanonicalCluster) {
  return (
    left.price - right.price ||
    left.creationTime - right.creationTime ||
    left.id.localeCompare(right.id)
  );
}

export function canonicalizeSnapshot(snapshot: KioseffSnapshot): KioseffSnapshot {
  return {
    ...snapshot,
    activeClusters: [...snapshot.activeClusters].sort(compareCanonicalClusters),
    violatedClusters: [...snapshot.violatedClusters].sort(compareCanonicalClusters),
    qCurves: [...snapshot.qCurves]
      .map((curve) => ({ ...curve, points: [...curve.points].sort((a, b) => a.time - b.time) }))
      .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id)),
    pane: [...snapshot.pane].sort((a, b) => a.time - b.time),
    alerts: [...snapshot.alerts].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id)),
    diagnostics: [...snapshot.diagnostics].sort(
      (a, b) =>
        (a.barTime ?? -1) - (b.barTime ?? -1) ||
        (a.intrabarTime ?? -1) - (b.intrabarTime ?? -1) ||
        a.code.localeCompare(b.code)
    )
  };
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableJsonValue(child)])
    );
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical snapshots cannot contain non-finite numbers.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new Error(`Canonical snapshots cannot contain ${typeof value} values.`);
  }
  return value;
}

export function stableCanonicalJson(snapshot: KioseffSnapshot) {
  return JSON.stringify(stableJsonValue(canonicalizeSnapshot(snapshot)));
}

export function canonicalSnapshotHash(snapshot: KioseffSnapshot) {
  const source = stableCanonicalJson(snapshot);
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(source)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function fnv1a64(source: string) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(source)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Hashes calculation output only. Camera, viewport, pane sizing and draw order
 * are intentionally excluded so zoom/pan can never alter this diagnostic.
 */
export function canonicalClusterHash(snapshot: KioseffSnapshot) {
  const clusters = [...snapshot.activeClusters, ...snapshot.violatedClusters]
    .sort(compareCanonicalClusters)
    .map((cluster) => stableJsonValue(cluster));
  return fnv1a64(JSON.stringify(clusters));
}

export function stableValueHash(value: unknown) {
  return fnv1a64(JSON.stringify(stableJsonValue(value)));
}

export function emptyRatioModel(): CanonicalRatioModel {
  return {
    activeBuyStops: 0,
    activeSellStops: 0,
    violatedBuyStops: 0,
    violatedSellStops: 0,
    activeBuyBlocks: null,
    activeSellBlocks: null,
    violatedBuyBlocks: null,
    violatedSellBlocks: null,
    blocks: 20
  };
}
