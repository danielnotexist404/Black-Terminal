import type { AuctionProfileSettings, AuctionProfileSnapshot } from "../core/types.ts";
import { RADAP_SHORT_NAME } from "../core/identity.ts";

export function AuctionProfileLegend({ snapshot, settings, chartType }: { snapshot: AuctionProfileSnapshot | null; settings: AuctionProfileSettings; chartType: string }) {
  if (!snapshot) return null;
  const price = (value: number | null) => value === null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const forcedFootprint = chartType === "volumeFootprint";
  const title = forcedFootprint
    ? "CVD FOOTPRINT"
    : settings.rendering.visualizationType === "AUCTION_PROFILE"
      ? RADAP_SHORT_NAME
      : settings.rendering.visualizationType === "COMBINED" ? "RADAP + CVD FOOTPRINT" : "CVD FOOTPRINT";
  return <div className="auction-profile-legend" aria-label="RADAP legend">
    <b>{title}</b><span>{snapshot.engine.replaceAll("_", " ")}</span>
    <em>Scope · {snapshot.scope.replaceAll("_", " ")}</em>
    <em>Block · {Math.round(snapshot.matrix.blockDurationSeconds / 60).toLocaleString()}m</em>
    {forcedFootprint || settings.rendering.visualizationType !== "AUCTION_PROFILE"
      ? <><em>Matrix · {snapshot.matrix.blocks.length.toLocaleString()} × {snapshot.matrix.rows.length.toLocaleString()}</em><em>Cells · {snapshot.matrix.cells.length.toLocaleString()}</em></>
      : <>
        <em>Rows · {snapshot.rows.length.toLocaleString()}</em>
        <em>Body · {settings.rendering.profileBodyStyle === "HDLX_CVD_BLOCKS" ? "HDLX CVD BLOCKS" : "SOLID HISTOGRAM"}</em>
        {settings.rendering.profileBodyStyle === "HDLX_CVD_BLOCKS" && <em>Values · {settings.rendering.profileBlockValueMode === "CUMULATIVE_CVD" ? "DEVELOPING CVD" : "BLOCK DELTA"}</em>}
      </>}
    <em>Data · {snapshot.quality.quality} {snapshot.quality.exactTradeCoveragePercent.toFixed(0)}%</em>
    <em>Scale · {snapshot.matrix.normalizationMode.replaceAll("_", " ")}</em>
    <em>POC · {price(snapshot.keyLevels.poc)}</em>
    <em>VAH · {price(snapshot.keyLevels.vah)}</em>
    <em>VAL · {price(snapshot.keyLevels.val)}</em>
    <em>{snapshot.matrix.blocks.at(-1)?.isDeveloping ? "LIVE COLUMN" : "FINALIZED"}</em>
  </div>;
}
