import type { AuctionProfileSnapshot } from "../core/types.ts";

export function AuctionProfileLegend({ snapshot }: { snapshot: AuctionProfileSnapshot | null }) {
  if (!snapshot) return null;
  return <div className="auction-profile-legend" aria-label="Auction Profile legend">
    <b>AUCTION PROFILE</b><span>{snapshot.engine.replaceAll("_", " ")}</span>
    <em>{snapshot.scope.replaceAll("_", " ")} · {snapshot.quality.quality}</em>
  </div>;
}
