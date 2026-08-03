import type { AuctionProfileRow } from "../core/types.ts";

export function usdVolumeMetricValue(row: AuctionProfileRow) {
  return row.buyNotional + row.sellNotional + row.unknownNotional;
}
