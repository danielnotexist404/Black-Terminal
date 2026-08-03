import type { AuctionProfileSnapshot } from "../core/types.ts";

export function validateAuctionProfileInvariants(snapshot: AuctionProfileSnapshot, tolerance = 1e-7) {
  const errors: string[] = [];
  const rows = snapshot.rows;
  rows.forEach(row => {
    if (!(row.low < row.high)) errors.push("row-" + row.index + ": invalid bounds");
    for (const [field, value] of Object.entries(row)) {
      if (typeof value === "number" && !Number.isFinite(value)) errors.push("row-" + row.index + ": " + field + " is not finite");
    }
    const components = row.buyQuantity + row.sellQuantity + row.unknownQuantity;
    if (Math.abs(row.totalQuantity - components) > tolerance * Math.max(1, components)) errors.push("row-" + row.index + ": volume conservation failed");
  });
  for (const node of snapshot.nodes) {
  const cellKeys = new Set<string>();
  for (const block of snapshot.matrix.blocks) {
    if (block.endTime < block.startTime) errors.push(block.id + ": invalid time bounds");
    if (block.isDeveloping === block.isFinalized) errors.push(block.id + ": invalid lifecycle state");
  }
  for (const cell of snapshot.matrix.cells) {
    const key = cell.blockIndex + ":" + cell.rowIndex;
    if (cellKeys.has(key)) errors.push(key + ": duplicate matrix cell");
    cellKeys.add(key);
    if (!snapshot.matrix.blocks[cell.blockIndex]) errors.push(cell.id + ": missing block");
    if (!snapshot.matrix.rows[cell.rowIndex]) errors.push(cell.id + ": missing row");
    if (!(cell.priceLow < cell.priceHigh) || cell.endTime < cell.startTime) errors.push(cell.id + ": invalid bounds");
    for (const [field, value] of Object.entries(cell)) {
      if (typeof value === "number" && !Number.isFinite(value)) errors.push(cell.id + ": " + field + " is not finite");
    }
    const components = cell.buyValue + cell.sellValue + cell.unknownValue;
    if (Math.abs(cell.totalValue - components) > tolerance * Math.max(1, components)) errors.push(cell.id + ": volume conservation failed");
    if (cell.sign !== Math.sign(cell.rawValue)) errors.push(cell.id + ": sign does not match raw value");
  }
  if (snapshot.implementationMode === "BLACK_CORE_NATIVE") {
    const rowTotal = rows.reduce((sum, row) => sum + row.totalQuantity, 0);
    const cellTotal = snapshot.matrix.cells.reduce((sum, cell) => sum + cell.totalValue, 0);
    if (Math.abs(rowTotal - cellTotal) > tolerance * Math.max(1, rowTotal)) errors.push("matrix/profile volume conservation failed");
  }
    const first = rows[node.componentRowIndices[0] ?? -1];
    const last = rows[node.componentRowIndices.at(-1) ?? -1];
    if (!first || !last || Math.abs(first.low - node.low) > tolerance || Math.abs(last.high - node.high) > tolerance) errors.push(node.id + ": node boundary is not grid aligned");
  }
  for (const level of [snapshot.keyLevels.poc, snapshot.keyLevels.vah, snapshot.keyLevels.val]) {
    if (level !== null && (level < snapshot.grid.priceLow - tolerance || level > snapshot.grid.priceHigh + tolerance)) errors.push("key level outside grid");
  }
  return errors;
}
