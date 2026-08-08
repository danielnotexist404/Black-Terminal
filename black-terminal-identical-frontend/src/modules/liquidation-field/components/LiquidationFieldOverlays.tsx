import type { BclifModelAuthority, LiquidationFieldRuntimeStatus, LiquidationFieldSettings, LiquidationFieldSnapshot } from "../core/types";

interface Props {
  visible: boolean;
  snapshot: LiquidationFieldSnapshot | null;
  settings: LiquidationFieldSettings;
  status: LiquidationFieldRuntimeStatus;
}

export function LiquidationFieldOverlays({ visible, snapshot, settings, status }: Props) {
  if (!visible) return null;
  const coverage = snapshot?.coverage;
  const persistentCoverage = snapshot?.persistentCoverage;
  const authority = snapshot?.authority ?? status.authority ?? authorityForSource(status.source);
  const provenance = provenanceFor(authority, snapshot?.collectorNodeId ?? status.collectorNodeId ?? null, status.state, Boolean(snapshot));
  return <>
    <div
      className={`liquidation-field-provenance authority-${authority.toLowerCase()}`}
      data-bclif-authority={authority}
      data-bclif-persistence={provenance.persistence}
      data-bclif-state={status.state}
      data-bclif-checksum={snapshot?.header.checksum ?? "NONE"}
      data-bclif-grid={snapshot ? `${snapshot.header.columns}x${snapshot.header.rows}` : "NONE"}
      data-bclif-bounds={snapshot ? `${snapshot.header.startTime}:${snapshot.header.endTime}:${snapshot.header.minPrice}:${snapshot.header.maxPrice}` : "NONE"}
      data-bclif-intensity={snapshot ? intensityAudit(snapshot.normalizedIntensity) : "NONE"}
      data-bclif-render={`${settings.viewMode}:${settings.palette}:${settings.sharpness}:${settings.gamma}`}
      aria-label={`BCLIF authority ${authority}`}
    >
      <header><b>MODEL AUTHORITY</b><span>{authority.replaceAll("_", " ")}</span></header>
      <div><span>COLLECTOR</span><b>{provenance.collector}</b></div>
      <div><span>PERSISTENCE</span><b>{provenance.persistence}</b></div>
      <div><span>HISTORY</span><b>{provenance.history}</b></div>
    </div>
    {settings.legendVisible && <div className="liquidation-field-legend">
      <header><b>LIQUIDATION INTELLIGENCE</b><span>{settings.horizon} · {status.state}</span></header>
      <div className={`thermal-ramp ${settings.palette.toLowerCase()}`} />
      <footer><span>LOW EXPOSURE</span><span>EXTREME</span></footer>
    </div>}
    {settings.diagnosticsVisible && <div className="liquidation-field-diagnostics">
      <header><b>BLACK CORE · BCLIF</b><span>{snapshot?.certainty.replaceAll("_", " ") ?? status.source.replaceAll("_", " ")}</span></header>
      <div><span>MODEL</span><b>{snapshot?.header.modelVersion ?? "WAITING"}</b></div>
      <div><span>OI COVERAGE</span><b>{formatCoverage(persistentCoverage?.openInterestCoveragePercent, coverage?.openInterestCoveragePercent, 0)}</b></div>
      <div><span>EVENT HISTORY</span><b>{formatCoverage(persistentCoverage?.liquidationCoveragePercent, coverage?.liquidationEventCoveragePercent, 2)}</b></div>
      <div><span>CONTINUITY</span><b>{formatCoverage(persistentCoverage?.continuityPercent, coverage?.modelContinuityPercent, 2)}</b></div>
      <div><span>AUTHORITY</span><b>{authority.replaceAll("_", " ")}</b></div>
      <div><span>CONFIDENCE</span><b>{snapshot?.certainty === "SYNTHETIC_TEST" ? "SYNTHETIC · UNSCORED" : snapshot ? `${snapshot.confidenceBreakdown.total}%` : "—"}</b></div>
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

function formatCoverage(persistent: number | null | undefined, legacy: number | undefined, digits: number) {
  if (persistent === null) return "MISSING";
  const value = persistent ?? legacy;
  return value === undefined ? "—" : `${value.toFixed(digits)}%`;
}

function intensityAudit(values: Uint8Array) {
  let maximum = 0;
  let green = 0;
  let yellow = 0;
  for (const value of values) {
    maximum = Math.max(maximum, value);
    if (value >= 254) green += 1;
    if (value === 255) yellow += 1;
  }
  return `max=${maximum};green=${green};yellow=${yellow};cells=${values.length}`;
}

type DisplayAuthority = BclifModelAuthority | "UNRESOLVED";

function authorityForSource(source: LiquidationFieldRuntimeStatus["source"]): DisplayAuthority {
  if (source === "PERSISTENT_COLLECTOR") return "PERSISTENT_NODE";
  if (source === "BYBIT_PUBLIC") return "BROWSER_FALLBACK";
  if (source === "SYNTHETIC_TEST") return "TEST_FIXTURE";
  return "UNRESOLVED";
}

function provenanceFor(
  authority: DisplayAuthority,
  collectorNodeId: string | null,
  state: LiquidationFieldRuntimeStatus["state"],
  hasVerifiedSnapshot: boolean
) {
  if (authority === "PERSISTENT_NODE") {
    if (state === "ERROR" || state === "UNAVAILABLE") return {
      collector: collectorNodeId || "PERSISTENT NODE UNAVAILABLE",
      persistence: "UNAVAILABLE",
      history: "UNKNOWN · NO VERIFIED FIELD"
    };
    if (state === "LOADING" || state === "IDLE") return {
      collector: collectorNodeId || "RESOLVING PERSISTENT NODE",
      persistence: "CHECKING",
      history: "VERIFYING"
    };
    if (state === "COLLECTING" && !hasVerifiedSnapshot) return {
      collector: collectorNodeId || "VERIFIED PERSISTENT NODE",
      persistence: "ON",
      history: "NO VERIFIED TILES YET"
    };
    if (state === "STALE") return {
      collector: collectorNodeId || "VERIFIED PERSISTENT NODE",
      persistence: hasVerifiedSnapshot ? "ON" : "UNAVAILABLE",
      history: hasVerifiedSnapshot ? "LAST VERIFIED SNAPSHOT · STALE" : "UNKNOWN · NO VERIFIED FIELD"
    };
    return {
      collector: collectorNodeId || "VERIFIED PERSISTENT NODE",
      persistence: "ON",
      history: hasVerifiedSnapshot ? "VERIFIED CONTINUOUS" : "NO VERIFIED TILES YET"
    };
  }
  if (authority === "TEST_FIXTURE") return {
    collector: "LOCALHOST VISUAL FIXTURE",
    persistence: "OFF" as const,
    history: "SYNTHETIC TEST ONLY"
  };
  if (authority === "REPLAY") return {
    collector: "VERIFIED REPLAY",
    persistence: "OFF" as const,
    history: "IMMUTABLE REPLAY WINDOW"
  };
  if (authority === "UNRESOLVED") return {
    collector: "AUTHORITY NOT SELECTED",
    persistence: "UNKNOWN",
    history: "UNKNOWN"
  };
  return {
    collector: "BROWSER SESSION",
    persistence: "OFF" as const,
    history: "BUILDS ONLY WHILE THIS CHART IS OPEN"
  };
}
