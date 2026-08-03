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
    const first = rows[node.componentRowIndices[0] ?? -1];
    const last = rows[node.componentRowIndices.at(-1) ?? -1];
    if (!first || !last || Math.abs(first.low - node.low) > tolerance || Math.abs(last.high - node.high) > tolerance) errors.push(node.id + ": node boundary is not grid aligned");
  }
  for (const level of [snapshot.keyLevels.poc, snapshot.keyLevels.vah, snapshot.keyLevels.val]) {
    if (level !== null && (level < snapshot.grid.priceLow - tolerance || level > snapshot.grid.priceHigh + tolerance)) errors.push("key level outside grid");
  }
  return errors;
}
