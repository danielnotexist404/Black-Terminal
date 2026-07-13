import type { ChartPriceTransformSnapshot } from "../../../chart-engine/priceTransform";
import type { AifProfileRow } from "../core/aifTypes";

export type AifScreenRow = {
  index: number;
  top: number;
  height: number;
  width: number;
  valueArea: boolean;
};

export function projectAifProfileRows(
  rows: AifProfileRow[],
  transform: ChartPriceTransformSnapshot,
  priceToY: (price: number) => number | null,
  widthScale = 100
): AifScreenRow[] {
  const maximum = rows.reduce((value, row) => Math.max(value, row.normalized), 0) || 1;
  const output: AifScreenRow[] = [];
  for (const row of rows) {
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
      width: Math.max(0.5, row.normalized / maximum * widthScale),
      valueArea: row.valueArea
    });
  }
  return output;
}

export function projectAifPriceLine(
  price: number,
  transform: ChartPriceTransformSnapshot,
  priceToY: (price: number) => number | null
) {
  const y = priceToY(price);
  if (y == null || y < transform.plotTop || y > transform.plotBottom) return null;
  return y;
}
