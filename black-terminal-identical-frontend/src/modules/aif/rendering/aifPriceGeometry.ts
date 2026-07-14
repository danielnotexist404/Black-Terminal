import type { ChartPriceTransformSnapshot } from "../../../chart-engine/priceTransform";
import type { AifProfileRow, AifSettings } from "../core/aifTypes";

export type AifScreenRow = {
  index: number;
  top: number;
  height: number;
  width: number;
  valueArea: boolean;
};

export type AifScreenZone = { top: number; height: number; centerY: number; minimumY: number };

export function projectAifProfileRows(
  rows: AifProfileRow[],
  transform: ChartPriceTransformSnapshot,
  priceToY: (price: number) => number | null,
  widthScale = 100,
  normalization: AifSettings["profileNormalization"] = "percent-max"
): AifScreenRow[] {
  const widths = normalizeWidths(rows.map((row) => Math.max(0, Math.abs(row.value))), normalization);
  const output: AifScreenRow[] = [];
  for (const [rowPosition, row] of rows.entries()) {
    const yHigh = priceToY(row.high);
    const yLow = priceToY(row.low);
    if (yHigh == null || yLow == null) continue;
    const rawTop = Math.min(yHigh, yLow);
    const rawBottom = Math.max(yHigh, yLow);
    if (rawBottom < transform.plotTop || rawTop > transform.plotBottom) continue;
    const top = Math.max(transform.plotTop, rawTop);
    const bottom = Math.min(transform.plotBottom, rawBottom);
    output.push({
      index: row.index,
      top,
      height: Math.max(1, bottom - top),
      width: Math.max(0.5, (widths[rowPosition] ?? 0) * widthScale),
      valueArea: row.valueArea
    });
  }
  return output;
}

export function normalizeWidths(values: number[], normalization: AifSettings["profileNormalization"]): number[] {
  if (!values.length) return [];
  if (normalization === "percentile") {
    const sorted = [...values].sort((a, b) => a - b);
    return values.map((value) => sorted.length === 1 ? 1 : lastLessThanOrEqual(sorted, value) / (sorted.length - 1));
  }
  if (normalization === "z-score") return normalizeCentered(values, average(values), standardDeviation(values));
  if (normalization === "robust-z-score") {
    const center = median(values);
    return normalizeCentered(values, center, median(values.map((value) => Math.abs(value - center))) * 1.4826);
  }
  const transformed = normalization === "log" ? values.map((value) => Math.log1p(value)) : values;
  const maximum = Math.max(...transformed, Number.EPSILON);
  return transformed.map((value) => value / maximum);
}

function normalizeCentered(values: number[], center: number, spread: number) {
  const safeSpread = Math.max(spread, Number.EPSILON);
  const scores = values.map((value) => Math.max(0, 0.5 + (value - center) / (safeSpread * 6)));
  const maximum = Math.max(...scores, Number.EPSILON);
  return scores.map((value) => value / maximum);
}

function average(values: number[]) { return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length); }
function standardDeviation(values: number[]) { const center = average(values); return Math.sqrt(average(values.map((value) => (value - center) ** 2))); }
function median(values: number[]) { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2; }
function lastLessThanOrEqual(values: number[], target: number) { let result = 0; for (let index = 0; index < values.length; index += 1) { if (values[index] > target) break; result = index; } return result; }

export function projectAifPriceLine(
  price: number,
  transform: ChartPriceTransformSnapshot,
  priceToY: (price: number) => number | null
) {
  const y = priceToY(price);
  if (y == null || y < transform.plotTop || y > transform.plotBottom) return null;
  return y;
}

export function projectAifPriceZone(low: number, high: number, center: number, minimum: number, transform: ChartPriceTransformSnapshot, priceToY: (price: number) => number | null): AifScreenZone | null {
  const yHigh = priceToY(high);
  const yLow = priceToY(low);
  const centerY = priceToY(center);
  const minimumY = priceToY(minimum);
  if (yHigh == null || yLow == null || centerY == null || minimumY == null) return null;
  const rawTop = Math.min(yHigh, yLow);
  const rawBottom = Math.max(yHigh, yLow);
  if (rawBottom < transform.plotTop || rawTop > transform.plotBottom) return null;
  const top = Math.max(transform.plotTop, rawTop);
  const bottom = Math.min(transform.plotBottom, rawBottom);
  return { top, height: Math.max(2, bottom - top), centerY, minimumY };
}
