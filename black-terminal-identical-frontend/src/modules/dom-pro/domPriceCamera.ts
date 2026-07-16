import type { MacroLiquidityRange } from "./types";

export type DomPriceCameraMode = "follow" | "explore" | "fit" | "manual";

export type DomPriceBucket = {
  index: number;
  key: string;
  low: number;
  high: number;
  center: number;
  topPct: number;
  heightPct: number;
};

export type DomProPriceCamera = {
  visiblePriceMin: number;
  visiblePriceMax: number;
  centerPrice: number;
  zoom: number;
  panOffset: number;
  bucketSize: number;
  bucketMode: "shared-visible-domain";
  rowCount: number;
  version: string;
  mode: DomPriceCameraMode;
  source: MacroLiquidityRange["source"];
  buckets: DomPriceBucket[];
};

export function createDomProPriceCamera(
  range: MacroLiquidityRange,
  currentPrice: number,
  requestedRows: number,
  mode: DomPriceCameraMode
): DomProPriceCamera {
  const visiblePriceMin = Math.max(0.00000001, finite(range.min, currentPrice * 0.99));
  const visiblePriceMax = Math.max(visiblePriceMin + 0.00000001, finite(range.max, currentPrice * 1.01));
  const span = visiblePriceMax - visiblePriceMin;
  const rowCount = Math.max(12, Math.min(120, Math.round(requestedRows)));
  const bucketSize = span / rowCount;
  const centerPrice = (visiblePriceMin + visiblePriceMax) / 2;
  const normalizedCurrent = Math.max(0.00000001, finite(currentPrice, centerPrice));
  const version = [stableNumber(visiblePriceMin), stableNumber(visiblePriceMax), stableNumber(rowCount), mode].join(":");
  const buckets = Array.from({ length: rowCount }, (_, index) => {
    const low = visiblePriceMin + index * bucketSize;
    const high = index === rowCount - 1 ? visiblePriceMax : visiblePriceMin + (index + 1) * bucketSize;
    return {
      index,
      key: `${version}:${index}`,
      low,
      high,
      center: (low + high) / 2,
      topPct: (visiblePriceMax - high) / span * 100,
      heightPct: (high - low) / span * 100
    };
  });
  return {
    visiblePriceMin,
    visiblePriceMax,
    centerPrice,
    zoom: span / Math.max(normalizedCurrent, 0.00000001),
    panOffset: centerPrice - normalizedCurrent,
    bucketSize,
    bucketMode: "shared-visible-domain",
    rowCount,
    version,
    mode,
    source: range.source,
    buckets
  };
}

export function domCameraRange(camera: DomProPriceCamera): MacroLiquidityRange {
  return {
    min: camera.visiblePriceMin,
    max: camera.visiblePriceMax,
    source: camera.source
  };
}

export function domPriceBucketAt(camera: DomProPriceCamera, price: number) {
  if (!Number.isFinite(price) || price < camera.visiblePriceMin || price > camera.visiblePriceMax) return null;
  const rawIndex = Math.floor((price - camera.visiblePriceMin) / camera.bucketSize);
  return camera.buckets[Math.max(0, Math.min(camera.buckets.length - 1, rawIndex))] ?? null;
}

export function domPriceToTopPct(camera: DomProPriceCamera, price: number) {
  const span = camera.visiblePriceMax - camera.visiblePriceMin;
  if (!Number.isFinite(price) || span <= 0) return 50;
  return Math.max(0, Math.min(100, (camera.visiblePriceMax - price) / span * 100));
}

export function sameDomPriceCamera(left: DomProPriceCamera, right: DomProPriceCamera, tolerance = 1e-8) {
  return Math.abs(left.visiblePriceMin - right.visiblePriceMin) <= tolerance
    && Math.abs(left.visiblePriceMax - right.visiblePriceMax) <= tolerance
    && Math.abs(left.bucketSize - right.bucketSize) <= tolerance
    && left.rowCount === right.rowCount;
}

function finite(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function stableNumber(value: number) {
  return Number(value.toFixed(8)).toString();
}
