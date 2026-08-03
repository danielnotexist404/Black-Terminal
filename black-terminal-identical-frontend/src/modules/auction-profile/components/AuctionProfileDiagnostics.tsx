import type { AuctionProfileSnapshot } from "../core/types.ts";

export function AuctionProfileDiagnostics({ snapshot }: { snapshot: AuctionProfileSnapshot | null }) {
  if (!snapshot) return null;
  const q = snapshot.quality;
  return <div className="auction-profile-diagnostics" data-testid="auction-profile-diagnostics">
    <div><b>PROFILE DATA</b><span>{q.quality}</span></div>
    <div><span>Requested / loaded</span><strong>{snapshot.range.requestedBars.toLocaleString()} / {snapshot.range.loadedBars.toLocaleString()} bars</strong></div>
    <div><span>Exact trades</span><strong>{q.exactTradeCoveragePercent.toFixed(1)}%</strong></div>
    <div><span>Lower-TF estimate</span><strong>{q.lowerTimeframeCoveragePercent.toFixed(1)}%</strong></div>
    <div><span>Chart-bar estimate</span><strong>{q.chartBarCoveragePercent.toFixed(1)}%</strong></div>
    <div><span>Rows / nodes</span><strong>{snapshot.rows.length} / {snapshot.nodes.length}</strong></div>
    <div><span>Blocks / cells</span><strong>{snapshot.matrix.blocks.length.toLocaleString()} / {snapshot.matrix.cells.length.toLocaleString()}</strong></div>
    <div><span>Block / scale</span><strong>{Math.round(snapshot.matrix.blockDurationSeconds / 60)}m / {snapshot.matrix.normalizationMode.replaceAll("_", " ")}</strong></div>
    <div><span>Build</span><strong>{snapshot.diagnostics.buildDurationMs.toFixed(1)} ms</strong></div>
    <small>{snapshot.implementationMode.replaceAll("_", " ")} · {snapshot.diagnostics.viewportAffectsCalculation ? "viewport dependent" : "camera independent"} · {snapshot.profileVersion}</small>
  </div>;
}
