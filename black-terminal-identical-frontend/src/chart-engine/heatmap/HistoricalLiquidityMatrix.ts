import type { OrderBookHeatmapCell } from "./OrderBookHeatmapModel.ts";

export type HeatmapMatrix = {
  columns: number;
  rows: number;
  startIndex: number;
  endIndex: number;
  minPrice: number;
  maxPrice: number;
  indexStep: number;
  priceStep: number;
  bidIntensity: Float32Array;
  askIntensity: Float32Array;
  observedColumns: Uint8Array;
  sourceCells: number;
};

export type HeatmapMatrixOptions = {
  maxColumns?: number;
  maxRows?: number;
  minimumNotional?: number;
};

const MAX_COLUMNS = 1024;
const MAX_ROWS = 512;

export function buildHistoricalLiquidityMatrix(
  cells: OrderBookHeatmapCell[],
  firstIndex: number,
  lastIndex: number,
  minPrice: number,
  maxPrice: number,
  options: HeatmapMatrixOptions = {}
): HeatmapMatrix {
  const indexSpan = Math.max(1e-9, lastIndex - firstIndex + 1);
  const priceSpan = Math.max(1e-9, maxPrice - minPrice);
  const columns = Math.max(1, Math.min(MAX_COLUMNS, Math.round(options.maxColumns ?? MAX_COLUMNS)));
  const rows = Math.max(1, Math.min(MAX_ROWS, Math.round(options.maxRows ?? MAX_ROWS)));
  const indexStep = indexSpan / columns;
  const priceStep = priceSpan / rows;
  const bidIntensity = new Float32Array(columns * rows);
  const askIntensity = new Float32Array(columns * rows);
  const observedColumns = new Uint8Array(columns);
  const minimumNotional = Math.max(0, options.minimumNotional ?? 0);
  let sourceCells = 0;

  for (const cell of cells) {
    if (cell.notional < minimumNotional || cell.priceHigh < minPrice || cell.priceLow > maxPrice) continue;
    if (cell.xEndIndex < firstIndex || cell.xStartIndex > lastIndex + 1) continue;
    const startColumn = clamp(Math.floor((Math.max(firstIndex, cell.xStartIndex) - firstIndex) / indexStep), 0, columns - 1);
    const endColumn = clamp(Math.floor((Math.min(lastIndex + 1, Math.max(cell.xStartIndex + indexStep, cell.xEndIndex)) - firstIndex) / indexStep), startColumn, columns - 1);
    const startRow = clamp(Math.floor((Math.max(minPrice, cell.priceLow) - minPrice) / priceStep), 0, rows - 1);
    const endRow = clamp(Math.floor((Math.min(maxPrice, Math.max(cell.priceLow + priceStep, cell.priceHigh)) - minPrice) / priceStep), startRow, rows - 1);
    const target = cell.side === "bid" ? bidIntensity : askIntensity;
    for (let column = startColumn; column <= endColumn; column += 1) {
      observedColumns[column] = 1;
      for (let row = startRow; row <= endRow; row += 1) {
        const offset = row * columns + column;
        target[offset] = Math.max(target[offset], cell.notional);
      }
    }
    sourceCells += 1;
  }

  return {
    columns,
    rows,
    startIndex: firstIndex,
    endIndex: lastIndex,
    minPrice,
    maxPrice,
    indexStep,
    priceStep,
    bidIntensity,
    askIntensity,
    observedColumns,
    sourceCells
  };
}

export function matrixQuantileReference(matrix: HeatmapMatrix, percentile = 0.985) {
  const values: number[] = [];
  for (let index = 0; index < matrix.bidIntensity.length; index += 1) {
    const value = Math.max(matrix.bidIntensity[index] ?? 0, matrix.askIntensity[index] ?? 0);
    if (value > 0 && Number.isFinite(value)) values.push(value);
  }
  if (!values.length) return 1;
  values.sort((left, right) => left - right);
  return values[Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * percentile)))] ?? 1;
}

export function matrixCellCount(matrix: HeatmapMatrix) {
  return matrix.columns * matrix.rows;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}
