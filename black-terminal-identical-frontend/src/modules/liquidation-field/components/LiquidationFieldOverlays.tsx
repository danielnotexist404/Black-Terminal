import type { LiquidationFieldRuntimeStatus, LiquidationFieldSettings, LiquidationFieldSnapshot } from "../core/types";

interface Props {
  visible: boolean;
  snapshot: LiquidationFieldSnapshot | null;
  settings: LiquidationFieldSettings;
  status: LiquidationFieldRuntimeStatus;
}

export function LiquidationFieldOverlays({ visible, snapshot, settings, status }: Props) {
  if (!visible) return null;
  const coverage = snapshot?.coverage;
  return <>
    {settings.legendVisible && <div className="liquidation-field-legend">
      <header><b>LIQUIDATION INTELLIGENCE</b><span>{settings.horizon} · {status.state}</span></header>
      <div className={`thermal-ramp ${settings.palette.toLowerCase()}`} />
      <footer><span>LOW EXPOSURE</span><span>EXTREME</span></footer>
    </div>}
    {settings.diagnosticsVisible && <div className="liquidation-field-diagnostics">
      <header><b>BLACK CORE · BCLIF</b><span>{snapshot?.certainty.replaceAll("_", " ") ?? status.source.replaceAll("_", " ")}</span></header>
      <div><span>MODEL</span><b>{snapshot?.header.modelVersion ?? "WAITING"}</b></div>
      <div><span>OI COVERAGE</span><b>{coverage ? `${coverage.openInterestCoveragePercent.toFixed(0)}%` : "—"}</b></div>
      <div><span>EVENT HISTORY</span><b>{coverage ? `${coverage.liquidationEventCoveragePercent.toFixed(2)}%` : "—"}</b></div>
      <div><span>CONFIDENCE</span><b>{snapshot ? `${snapshot.confidenceBreakdown.total}%` : "—"}</b></div>
      <div><span>GRID / BUILD</span><b>{snapshot ? `${snapshot.header.columns}×${snapshot.header.rows} · ${snapshot.buildTimeMs.toFixed(0)}ms` : "—"}</b></div>
      <footer>{status.error ?? status.message}</footer>
    </div>}
    {(status.state === "LOADING" || status.state === "ERROR" || status.state === "UNAVAILABLE") && <div className={`liquidation-field-status ${status.state.toLowerCase()}`}>
      <b>{status.state === "LOADING" ? "EVENT HORIZON INITIALIZING" : "LIQUIDATION INTELLIGENCE UNAVAILABLE"}</b>
      <span>{status.error ?? status.message}</span>
      {status.state === "LOADING" && <i />}
    </div>}
  </>;
}
