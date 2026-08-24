export type HistoricalCoinPricePoint = {
  time: number;
  close: number;
};

export function oscillatorHoverIndex(clientX: number, left: number, width: number, pointCount: number) {
  if (!Number.isFinite(clientX) || !Number.isFinite(left) || !Number.isFinite(width) || width <= 0 || pointCount <= 0) return null;
  if (pointCount === 1) return 0;
  const ratio = Math.min(1, Math.max(0, (clientX - left) / width));
  return Math.round(ratio * (pointCount - 1));
}

export function nearestHistoricalCoinPrice(
  points: readonly HistoricalCoinPricePoint[],
  oscillatorTimeMs: number,
  maximumDistanceSeconds: number
) {
  if (!points.length || !Number.isFinite(oscillatorTimeMs) || !Number.isFinite(maximumDistanceSeconds)) return null;
  const target = oscillatorTimeMs / 1_000;
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle]!.time < target) low = middle + 1;
    else high = middle;
  }
  const candidates = [points[low - 1], points[low]].filter((point): point is HistoricalCoinPricePoint => Boolean(point));
  const nearest = candidates.reduce<HistoricalCoinPricePoint | null>((best, point) => {
    if (!best) return point;
    return Math.abs(point.time - target) < Math.abs(best.time - target) ? point : best;
  }, null);
  if (!nearest || Math.abs(nearest.time - target) > Math.max(0, maximumDistanceSeconds)) return null;
  return nearest;
}
