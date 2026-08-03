import type { AuctionProfileSnapshot } from "../core/types.ts";

export function AuctionProfileLegend({ snapshot }: { snapshot: AuctionProfileSnapshot | null }) {
  if (!snapshot) return null;
  const price = (value: number | null) => value === null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return <div className="auction-profile-legend" aria-label="Auction Profile legend">
    <b>AUCTION PROFILE</b><span>{snapshot.engine.replaceAll("_", " ")}</span>
    <em>Scope · {snapshot.scope.replaceAll("_", " ")}</em>
    <em>Block · {Math.round(snapshot.matrix.blockDurationSeconds / 60).toLocaleString()}m</em>
    <em>Matrix · {snapshot.matrix.blocks.length.toLocaleString()} × {snapshot.matrix.rows.length.toLocaleString()}</em>
    <em>Cells · {snapshot.matrix.cells.length.toLocaleString()}</em>
    <em>Data · {snapshot.quality.quality} {snapshot.quality.exactTradeCoveragePercent.toFixed(0)}%</em>
    <em>Scale · {snapshot.matrix.normalizationMode.replaceAll("_", " ")}</em>
    <em>POC · {price(snapshot.keyLevels.poc)}</em>
    <em>VAH · {price(snapshot.keyLevels.vah)}</em>
    <em>VAL · {price(snapshot.keyLevels.val)}</em>
    <em>{snapshot.matrix.blocks.at(-1)?.isDeveloping ? "LIVE COLUMN" : "FINALIZED"}</em>
  </div>;
}
