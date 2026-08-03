import type { AuctionBlockCell } from "../core/types.ts";

function qualityRank(value: AuctionBlockCell["dataQuality"]) {
  return value === "EXACT_TRADES" ? 2 : value === "LOWER_TF_APPROXIMATION" ? 1 : 0;
}

export function downsampleAuctionCells(cells: readonly AuctionBlockCell[], columnStride: number, rowStride: number) {
  const columns = Math.max(1, Math.round(columnStride));
  const rows = Math.max(1, Math.round(rowStride));
  if (columns === 1 && rows === 1) return [...cells];
  const groups = new Map<string, AuctionBlockCell>();
  for (const cell of cells) {
    const blockIndex = Math.floor(cell.blockIndex / columns) * columns;
    const rowIndex = Math.floor(cell.rowIndex / rows) * rows;
    const key = `${blockIndex}:${rowIndex}`;
    const current = groups.get(key);
    if (!current) {
      groups.set(key, { ...cell, id: `render-cell:${key}`, blockIndex, rowIndex });
      continue;
    }
    current.priceLow = Math.min(current.priceLow, cell.priceLow);
    current.priceHigh = Math.max(current.priceHigh, cell.priceHigh);
    current.startTime = Math.min(current.startTime, cell.startTime);
    current.endTime = Math.max(current.endTime, cell.endTime);
    current.rawValue += cell.rawValue;
    current.buyValue += cell.buyValue;
    current.sellValue += cell.sellValue;
    current.unknownValue += cell.unknownValue;
    current.totalValue += cell.totalValue;
    current.notional += cell.notional;
    current.tradeCount += cell.tradeCount;
    current.tpoCount += cell.tpoCount;
    current.garmanKlassVariance += cell.garmanKlassVariance;
    current.realizedVariance += cell.realizedVariance;
    current.parkinsonVariance += cell.parkinsonVariance;
    current.rangeExpansion += cell.rangeExpansion;
    current.isDeveloping = current.isDeveloping || cell.isDeveloping;
    current.isFinalized = current.isFinalized && cell.isFinalized;
    if (qualityRank(cell.dataQuality) < qualityRank(current.dataQuality)) current.dataQuality = cell.dataQuality;
  }
  const result = [...groups.values()];
  const maximum = Math.max(...result.map(cell => Math.abs(cell.rawValue)), Number.EPSILON);
  result.forEach(cell => {
    cell.sign = Math.sign(cell.rawValue) as -1 | 0 | 1;
    cell.normalizedValue = cell.rawValue / maximum;
  });
  return result.sort((left, right) => left.blockIndex - right.blockIndex || left.rowIndex - right.rowIndex);
}

export function auctionCellRenderStrides(
  visibleColumns: number,
  visibleRows: number,
  maximumColumns: number,
  maximumRows: number
) {
  return {
    columnStride: Math.max(1, Math.ceil(visibleColumns / Math.max(1, maximumColumns))),
    rowStride: Math.max(1, Math.ceil(visibleRows / Math.max(1, maximumRows)))
  };
}
