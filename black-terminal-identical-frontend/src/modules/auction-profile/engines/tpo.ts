import type { AuctionProfileRow } from "../core/types.ts";

export function tpoMetricValue(row: AuctionProfileRow) {
  return row.tpoCount;
}
