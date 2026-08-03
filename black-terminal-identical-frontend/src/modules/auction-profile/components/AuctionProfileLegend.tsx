import type { AuctionProfileSettings, AuctionProfileSnapshot } from "../core/types.ts";

export function AuctionProfileLegend({ snapshot, settings, chartType }: { snapshot: AuctionProfileSnapshot | null; settings: AuctionProfileSettings; chartType: string }) {
  if (!snapshot) return null;
  const price = (value: number | null) => value === null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const forcedFootprint = chartType === "volumeFootprint";
  const title = forcedFootprint ? "CVD FOOTPRINT" : settings.rendering.visualizationType.replaceAll("_", " ");
  return <div className="auction-profile-legend" aria-label="Auction Profile legend">
    <b>{title}</b><span>{snapshot.engine.replaceAll("_", " ")}</span>
    <em>Scope · {snapshot.scope.replaceAll("_", " ")}</em>
    <em>Block · {Math.round(snapshot.matrix.blockDurationSeconds / 60).toLocaleString()}m</em>
    {forcedFootprint || settings.rendering.visualizationType !== "AUCTION_PROFILE"
      ? <><em>Matrix · {snapshot.matrix.blocks.length.toLocaleString()} × {snapshot.matrix.rows.length.toLocaleString()}</em><em>Cells · {snapshot.matrix.cells.length.toLocaleString()}</em></>
      : <><em>Rows · {snapshot.rows.length.toLocaleString()}</em><em>Geometry · {settings.rendering.profileGeometry.replaceAll("_", " ")}</em></>}
    <em>Data · {snapshot.quality.quality} {snapshot.quality.exactTradeCoveragePercent.toFixed(0)}%</em>
    <em>Scale · {snapshot.matrix.normalizationMode.replaceAll("_", " ")}</em>
    <em>POC · {price(snapshot.keyLevels.poc)}</em>
    <em>VAH · {price(snapshot.keyLevels.vah)}</em>
    <em>VAL · {price(snapshot.keyLevels.val)}</em>
    <em>{snapshot.matrix.blocks.at(-1)?.isDeveloping ? "LIVE COLUMN" : "FINALIZED"}</em>
  </div>;
}
