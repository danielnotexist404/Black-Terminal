import type { AuctionNodeZone } from "../core/types.ts";

export function auctionNodeAlpha(node: AuctionNodeZone) {
  return node.type === "LVN"
    ? Math.max(0.08, Math.min(0.42, 0.08 + node.prominence * 0.32))
    : Math.max(0.12, Math.min(0.48, 0.12 + node.normalizedScore * 0.34));
}
