import { useMemo, useRef, useState } from "react";
import type { ChartPriceTransformSnapshot } from "../../../chart-engine/priceTransform";
import { priceToScreenY } from "../../../chart-engine/priceTransform";
import {
  bclifEvidenceComposition,
  classifyBclifEvidence,
  extractBclifOperationalClusters,
  selectBclifOperationalLabels
} from "../core/operationalClusters";
import type { BclifModelAuthority, LiquidationFieldRuntimeStatus, LiquidationFieldSettings, LiquidationFieldSnapshot } from "../core/types";
import {
  bclifDisplayRasterIdentity,
  bclifExposureHash,
  bclifModelHash,
  bclifRenderSettingsHash,
  bclifScalarFieldHash,
  resolveBclifDisplayDimensions,
  resolveBclifDisplayDomain
} from "../rendering/displayProjection";
import { bclifThermalLutHash } from "../rendering/thermalPalette";

import type { BclifRendererMetrics } from "../rendering/BlackCoreLiquidationFieldRenderer";
interface Props {
  visible: boolean;
  snapshot: LiquidationFieldSnapshot | null;
  settings: LiquidationFieldSettings;
  status: LiquidationFieldRuntimeStatus;
  currentPrice: number;
  rendererMetrics: BclifRendererMetrics | null;
  onOpenSettings?: () => void;
  onShowContext?: () => void;
  priceTransform: ChartPriceTransformSnapshot | null;
}

export function LiquidationFieldOverlays({ visible, snapshot, settings, status, currentPrice, priceTransform, rendererMetrics, onOpenSettings, onShowContext }: Props) {
  const [hudOpen, setHudOpen] = useState(false);
  const [summaryOffset, setSummaryOffset] = useState({ x: 0, y: 0 });
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [hoveredClusterId, setHoveredClusterId] = useState<string | null>(null);
  const summaryDrag = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null);
  const clusters = useMemo(
    () => snapshot ? extractBclifOperationalClusters(snapshot, currentPrice, settings) : [],
    [snapshot, currentPrice, settings.clusterLabelFloor, settings.sideFilter]
  );
  const labels = useMemo(
    () => selectBclifOperationalLabels(clusters, currentPrice, settings.maximumClusterLabels),
    [clusters, currentPrice, settings.maximumClusterLabels]
  );
  if (!visible) return null;
  const coverage = snapshot?.coverage;
  const persistentCoverage = snapshot?.persistentCoverage;
  const authority = snapshot?.authority ?? status.authority ?? authorityForSource(status.source);
  const provenance = provenanceFor(authority, snapshot?.collectorNodeId ?? status.collectorNodeId ?? null, status.state, Boolean(snapshot));
  const eventCoverage = persistentCoverage?.liquidationCoveragePercent ?? coverage?.liquidationEventCoveragePercent;
  const horizonTruth = horizonTruthLabel(settings.horizon, eventCoverage, authority);
  const context = snapshot ? {
    chartPriceMinimum: priceTransform?.priceMin ?? snapshot.header.minPrice,
    chartPriceMaximum: priceTransform?.priceMax ?? snapshot.header.maxPrice,
    currentPrice,
    plotWidth: priceTransform ? priceTransform.plotRight - priceTransform.plotLeft : 1280,
    plotHeight: priceTransform ? priceTransform.plotBottom - priceTransform.plotTop : 720,
    constrainedTouchRenderer: (priceTransform?.width ?? 1280) < 900
  } : null;
  const displayDomain = snapshot && context ? resolveBclifDisplayDomain(snapshot, settings, context) : null;
  const displayDimensions = snapshot && context ? resolveBclifDisplayDimensions(snapshot, settings, context) : null;
  const modelHash = snapshot ? bclifModelHash(snapshot) : "NONE";
  const exposureHash = snapshot ? bclifExposureHash(snapshot) : "NONE";
  const scalarFieldHash = snapshot ? bclifScalarFieldHash(snapshot) : "NONE";
  const lutHash = bclifThermalLutHash(settings.palette);
  const renderSettingsHash = bclifRenderSettingsHash(settings);
  const displayRasterHash = snapshot && context ? bclifDisplayRasterIdentity(snapshot, settings, context) : "NONE";
  const displayPriceStep = displayDomain && displayDimensions
    ? (displayDomain.maximum - displayDomain.minimum) / Math.max(1, displayDimensions.rows - 1)
    : null;
  const globalEvidence = snapshot ? bclifEvidenceComposition(snapshot) : null;
  const nearestShort = clusters.filter((cluster) => cluster.peakPrice > currentPrice).sort((a, b) => a.peakPrice - b.peakPrice)[0];
  const nearestLong = clusters.filter((cluster) => cluster.peakPrice < currentPrice).sort((a, b) => b.peakPrice - a.peakPrice)[0];
  const shortPressure = clusters.filter((cluster) => cluster.side === "SHORT_LIQUIDATION").reduce((sum, cluster) => sum + cluster.estimatedExposureHigh * cluster.rankScore, 0);
  const longPressure = clusters.filter((cluster) => cluster.side === "LONG_LIQUIDATION").reduce((sum, cluster) => sum + cluster.estimatedExposureHigh * cluster.rankScore, 0);
  const focusedCluster = clusters.find((cluster) => cluster.id === (hoveredClusterId ?? selectedClusterId)) ?? labels[0];
  const focusedCohorts = focusedCluster && snapshot
    ? snapshot.cohorts.filter((cohort) => focusedCluster.cohortIds.includes(cohort.id))
    : [];
  const hudState = resolveHudState(status, rendererMetrics, snapshot, displayDomain !== null);
  return <>
    <details
      className={`liquidation-field-hud authority-${authority.toLowerCase()}`}
      data-bclif-authority={authority}
      data-bclif-persistence={provenance.persistence}
      data-bclif-state={status.state}
      data-bclif-checksum={snapshot?.header.checksum ?? "NONE"}
      data-bclif-grid={snapshot ? `${snapshot.header.columns}x${snapshot.header.rows}` : "NONE"}
      data-bclif-display-grid={displayDimensions ? `${displayDimensions.columns}x${displayDimensions.rows}` : "NONE"}
      data-bclif-bounds={snapshot ? `${snapshot.header.startTime}:${snapshot.header.endTime}:${snapshot.header.minPrice}:${snapshot.header.maxPrice}` : "NONE"}
      data-bclif-display-bounds={displayDomain ? `${displayDomain.minimum}:${displayDomain.maximum}` : "NONE"}
      data-bclif-chart-range={priceTransform ? `${priceTransform.priceMin}:${priceTransform.priceMax}` : "NONE"}
      data-bclif-intensity={snapshot ? intensityAudit(snapshot.normalizedIntensity) : "NONE"}
      data-bclif-render={`${settings.viewMode}:${settings.palette}:${settings.sharpness}:${settings.gamma}`}
      data-bclif-model-hash={modelHash}
      data-bclif-exposure-hash={exposureHash}
      data-bclif-scalar-field-hash={scalarFieldHash}
      data-bclif-lut-hash={lutHash}
      data-bclif-render-settings-hash={renderSettingsHash}
      data-bclif-display-raster-hash={displayRasterHash}
      data-bclif-price-display={settings.priceDisplay}
      data-bclif-cluster-labels={labels.length}
      data-bclif-horizon-truth={horizonTruth}
      data-bclif-candle-contrast={settings.candleContrast}
      data-bclif-provenance-coverage={clusters.length ? Math.min(...clusters.map((cluster) => cluster.provenanceCoverage)) : 0}
      data-bclif-cohort-count={snapshot?.cohorts.length ?? 0}
      data-bclif-birth-count={snapshot?.lifecycleEvents.filter((event) => event.kind === "BIRTH").length ?? 0}
      data-bclif-contraction-count={snapshot?.lifecycleEvents.filter((event) => event.kind === "OI_CONTRACTION").length ?? 0}
      data-bclif-confirmed-assimilation-count={snapshot?.lifecycleEvents.filter((event) => event.kind === "CONFIRMED_LIQUIDATION").length ?? 0}
      data-bclif-mass-error={snapshot?.massLedger.conservationError ?? 0}
      aria-label={`BCLIF authority ${authority}`}
      open={hudOpen}
      onToggle={(event) => setHudOpen(event.currentTarget.open)}
    >
      <summary>
        <b>{hudState.title}</b>
        <span>{authority.replaceAll("_", " ")}</span>
        <i>OI {formatCoverage(persistentCoverage?.openInterestCoveragePercent, coverage?.openInterestCoveragePercent, 0)} · EVENTS {formatCoverage(persistentCoverage?.liquidationCoveragePercent, coverage?.liquidationEventCoveragePercent, 0)}</i>
        <em>CONF {snapshot ? `${snapshot.confidenceBreakdown.total}%` : "—"}</em>
      </summary>
      {hudOpen && <div className="liquidation-field-hud-details">
        <p>{hudState.detail}</p>
        <span>RAW {rendererMetrics?.rawNonZeroCells.toLocaleString() ?? "—"} · VISIBLE {rendererMetrics?.visibleCells.toLocaleString() ?? "—"} · UPLOADS {rendererMetrics?.textureUploadCount ?? 0}</span>
        <span>MODEL GEN {rendererMetrics?.latestModelGeneration ?? snapshot?.generations?.modelGeneration ?? 0} · RENDER GEN {rendererMetrics?.latestRenderedGeneration ?? 0} · LAG {rendererMetrics?.generationLag ?? "—"}</span>
        <div>
          {hudState.filtered && <button type="button" onClick={onShowContext}>SHOW OI CONTEXT</button>}
          <button type="button" onClick={onOpenSettings}>OPEN SETTINGS</button>
        </div>
      </div>}
    </details>


    {settings.operationalSummaryVisible && snapshot && <details
      className="liquidation-field-operational-summary"
      open={summaryOpen}
      onToggle={(event) => setSummaryOpen(event.currentTarget.open)}
      style={{ transform: `translate(${summaryOffset.x}px, ${summaryOffset.y}px)` }}
    >
      <summary>BCLIF — {settings.preset.replaceAll("_", " ")}<span
        className="liquidation-field-summary-drag"
        title="Drag dashboard"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          summaryDrag.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            originX: summaryOffset.x,
            originY: summaryOffset.y
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = summaryDrag.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          setSummaryOffset({
            x: Math.max(-600, Math.min(200, drag.originX + event.clientX - drag.x)),
            y: Math.max(-80, Math.min(600, drag.originY + event.clientY - drag.y))
          });
        }}
        onPointerUp={(event) => {
          if (summaryDrag.current?.pointerId === event.pointerId) summaryDrag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
      >⋮⋮</span></summary>
      <ClusterSummary label="Nearest short-liq shelf" cluster={nearestShort} currentPrice={currentPrice} />
      <ClusterSummary label="Nearest long-liq shelf" cluster={nearestLong} currentPrice={currentPrice} />
      <div><span>PRESSURE BALANCE</span><b>{shortPressure > longPressure * 1.1 ? "SHORT-LIQ HEAVY" : longPressure > shortPressure * 1.1 ? "LONG-LIQ HEAVY" : "BALANCED"}</b></div>
      <div><span>AUTHORITY</span><b>{authority.replaceAll("_", " ")}</b></div>
      <div><span>EVENT HISTORY</span><b>{formatCoverage(persistentCoverage?.liquidationCoveragePercent, coverage?.liquidationEventCoveragePercent, 1)}</b></div>
    </details>}

    {priceTransform && labels.map((cluster) => {
      const y = priceToScreenY(cluster.peakPrice, priceTransform);
      if (y === null || y < priceTransform.plotTop || y > priceTransform.plotBottom) return null;
      const evidence = classifyBclifEvidence(cluster.evidenceComposition).replaceAll("_", " ");
      return <div
        key={cluster.id}
        className={`liquidation-field-cluster-label ${cluster.side.toLowerCase()} ${settings.cohortProvenanceVisible ? "provenance-enabled" : ""}`}
        style={{ top: y }}
        title={`${evidence} · ${settings.visualChannel.replaceAll("_", " ")} · ${cluster.state}`}
        onPointerEnter={() => settings.cohortProvenanceVisible && setHoveredClusterId(cluster.id)}
        onPointerLeave={() => setHoveredClusterId(null)}
        onClick={() => settings.cohortProvenanceVisible && setSelectedClusterId((current) => current === cluster.id ? null : cluster.id)}
      >
        <b>{cluster.side === "SHORT_LIQUIDATION" ? "SHORT LIQ" : "LONG LIQ"}</b>
        <span>{formatPriceRange(cluster.priceLow, cluster.priceHigh)} · {formatCompactUsd(cluster.estimatedExposureLow)}–{formatCompactUsd(cluster.estimatedExposureHigh)} · {cluster.confidence.toFixed(0)}%</span>
      </div>;
    })}

    {settings.cohortProvenanceVisible && focusedCluster && <div className="liquidation-field-cohort-provenance" data-bclif-shelf-id={focusedCluster.id}>
      <header><b>BCLIF — COHORT PROVENANCE</b><span>{focusedCluster.state}</span></header>
      <ProvenanceRow label="Shelf ID" value={focusedCluster.id} />
      <ProvenanceRow label="Price Range" value={formatPriceRange(focusedCluster.priceLow, focusedCluster.priceHigh)} />
      <ProvenanceRow label="Creation" value={focusedCohorts.length ? new Date(Math.min(...focusedCohorts.map((cohort) => cohort.createdAt))).toISOString() : "UNAVAILABLE"} />
      <ProvenanceRow label="Cohorts" value={`${focusedCluster.cohortOverlapCount} · ${(focusedCluster.provenanceCoverage * 100).toFixed(0)}% ATTRIBUTED`} />
      <ProvenanceRow label="Cohort IDs" value={focusedCluster.cohortIds.join(", ") || "NO COHORT SIDECAR"} />
      <ProvenanceRow label="OI Intervals" value={focusedCohorts.map((cohort) => `${cohort.sourceIntervalStart}-${cohort.sourceIntervalEnd}`).join(", ") || "UNAVAILABLE"} />
      <ProvenanceRow label="Entry Ranges" value={focusedCohorts.map((cohort) => `${Math.round(cohort.entryLower)}-${Math.round(cohort.entryUpper)} ${cohort.entryDistribution.source}`).join(", ") || "UNAVAILABLE"} />
      <ProvenanceRow label="Leverage" value={focusedCohorts.map((cohort) => `${cohort.leverageMean.toFixed(1)}x [${cohort.leverageLower}-${cohort.leverageUpper}]`).join(", ") || "UNAVAILABLE"} />
      <ProvenanceRow label="Risk Tiers" value={[...new Set(focusedCohorts.flatMap((cohort) => cohort.riskTierDistribution.map((tier) => tier.tierId)))].join(", ") || "UNAVAILABLE"} />
      <ProvenanceRow label="Margin" value={focusedCohorts.map((cohort) => cohort.marginMode).join(", ") || "UNAVAILABLE"} />
      <ProvenanceRow label="Remaining" value={formatCompactUsd(focusedCohorts.reduce((sum, cohort) => sum + cohort.estimatedRemainingNotional, 0))} />
      <ProvenanceRow label="Survival" value={focusedCohorts.length ? `${(focusedCohorts.reduce((sum, cohort) => sum + cohort.survivalProbability, 0) / focusedCohorts.length * 100).toFixed(1)}%` : "UNAVAILABLE"} />
      <ProvenanceRow label="Confidence" value={`${focusedCluster.confidence.toFixed(1)}%`} />
      <ProvenanceRow label="Evidence" value={focusedCohorts.flatMap((cohort) => cohort.evidenceChannels).filter((value, index, all) => all.indexOf(value) === index).join(", ") || "UNAVAILABLE"} />
      <ProvenanceRow label="Last Event" value={focusedCohorts.map((cohort) => cohort.lastLifecycleEvent.kind).join(", ") || "UNAVAILABLE"} />
      <ProvenanceRow label="Why It Exists" value={focusedCohorts.map((cohort) => cohort.creationReason).join(" · ") || "PERSISTENT TILE PROVENANCE SIDECAR UNAVAILABLE"} />
      <footer>CONCENTRATION {(focusedCluster.exposureConcentration * 100).toFixed(2)}% · ENTROPY {(focusedCluster.priceEntropy * 100).toFixed(1)}% · WIDTH ${focusedCluster.shelfWidth.toFixed(2)}</footer>
    </div>}

    {settings.legendVisible && <div className="liquidation-field-legend">
      <header><b>LIQUIDATION INTELLIGENCE</b><span>{horizonTruth}</span></header>
      <div className={`thermal-ramp ${settings.palette.toLowerCase()}`} />
      <footer><span>VALID LOW · PURPLE</span><span>RARE VERIFIED EXTREME</span></footer>
    </div>}
    {settings.diagnosticsVisible && <div className="liquidation-field-diagnostics">
      <header><b>BLACK CORE · BCLIF</b><span>{snapshot?.certainty.replaceAll("_", " ") ?? status.source.replaceAll("_", " ")}</span></header>
      <div><span>MODEL</span><b>{snapshot?.header.modelVersion ?? "WAITING"}</b></div>
      <div><span>MODEL HASH</span><b>{modelHash}</b></div>
      <div><span>EXPOSURE HASH</span><b>{exposureHash}</b></div>
      <div><span>SCALAR FIELD HASH</span><b>{scalarFieldHash}</b></div>
      <div><span>LUT HASH</span><b>{lutHash}</b></div>
      <div><span>RENDER SETTINGS HASH</span><b>{renderSettingsHash}</b></div>
      <div><span>FINAL FRAME HASH</span><b>{displayRasterHash}</b></div>
      <div><span>OI COVERAGE</span><b>{formatCoverage(persistentCoverage?.openInterestCoveragePercent, coverage?.openInterestCoveragePercent, 0)}</b></div>
      <div><span>EVENT HISTORY</span><b>{formatCoverage(persistentCoverage?.liquidationCoveragePercent, coverage?.liquidationEventCoveragePercent, 2)}</b></div>
      <div><span>CONTINUITY</span><b>{formatCoverage(persistentCoverage?.continuityPercent, coverage?.modelContinuityPercent, 2)}</b></div>
      <div><span>EVIDENCE</span><b>{globalEvidence ? classifyBclifEvidence(globalEvidence).replaceAll("_", " ") : "—"}</b></div>
      <div><span>CONFIDENCE</span><b>{snapshot?.certainty === "SYNTHETIC_TEST" ? "SYNTHETIC · UNSCORED" : snapshot ? `${snapshot.confidenceBreakdown.total}%` : "—"}</b></div>
      <div><span>MODEL GRID</span><b>{snapshot ? `${snapshot.header.columns}×${snapshot.header.rows} · ${snapshot.header.priceStep.toFixed(2)}` : "—"}</b></div>
      <div><span>DISPLAY GRID</span><b>{displayDimensions ? `${displayDimensions.columns}×${displayDimensions.rows}` : "—"}</b></div>
      <div><span>DISPLAY PRICE STEP</span><b>{displayPriceStep === null ? "—" : `$${displayPriceStep.toFixed(2)}`}</b></div>
      <div><span>DISPLAY TIME STEP</span><b>{snapshot && displayDimensions ? formatDuration((snapshot.header.endTime - snapshot.header.startTime) / Math.max(1, displayDimensions.columns - 1)) : "—"}</b></div>
      <div><span>GRID ORIGIN / VERSION</span><b>{snapshot ? `${snapshot.header.gridOrigin ?? snapshot.header.minPrice} · ${snapshot.header.gridVersion ?? "LEGACY"}` : "—"}</b></div>
      <div><span>COHORTS / PROVENANCE</span><b>{snapshot ? `${snapshot.cohorts.length} · ${clusters.length ? (Math.min(...clusters.map((cluster) => cluster.provenanceCoverage)) * 100).toFixed(0) : "100"}%` : "—"}</b></div>
      <div><span>MASS CONSERVATION</span><b>{snapshot ? `${snapshot.massLedger.conservationError.toExponential(2)} / ${snapshot.massLedger.tolerance.toExponential(2)}` : "—"}</b></div>
      <footer>{status.error ?? status.message}</footer>
    </div>}
  </>;
}

function resolveHudState(
  status: LiquidationFieldRuntimeStatus,
  renderer: BclifRendererMetrics | null,
  snapshot: LiquidationFieldSnapshot | null,
  displayIntersects: boolean
) {
  if (status.state === "UNAVAILABLE" || status.lifecycle === "VENUE_UNSUPPORTED") {
    return { title: "BCLIF UNAVAILABLE", detail: status.error ?? status.message, filtered: false };
  }
  if (renderer?.readiness === "TEXTURE_ERROR" || status.lifecycle === "TEXTURE_ERROR") {
    return { title: "BCLIF — TEXTURE ERROR", detail: renderer?.error ?? status.error ?? status.message, filtered: false };
  }
  if (renderer?.readiness === "FILTERED_EMPTY") {
    return { title: "BCLIF — FILTERED, 0 CELLS VISIBLE", detail: "Model has exposure. Current confidence or channel filters intentionally hide every cell.", filtered: true };
  }
  if (renderer?.readiness === "INVISIBLE_TEXTURE" && renderer.rawNonZeroCells === 0) {
    return { title: "BCLIF — NO MODEL EXPOSURE", detail: "The verified model is ready, but this requested domain contains no non-zero exposure cells.", filtered: false };
  }
  if (renderer?.readiness === "INVISIBLE_TEXTURE") {
    return { title: "BCLIF — INVISIBLE TEXTURE", detail: "Exposure exists, but the current raster has no visible alpha. Review the renderer state before trusting the display.", filtered: false };
  }
  if (snapshot && !displayIntersects) {
    return { title: "BCLIF — OUTSIDE PRICE DISPLAY", detail: "The verified model exists outside the current chart price domain.", filtered: false };
  }
  if (!snapshot) {
    return { title: "BCLIF — INITIALIZING OI CONTEXT", detail: status.error ?? status.message, filtered: false };
  }
  return { title: "BCLIF V6", detail: status.message, filtered: false };
}

function ProvenanceRow({ label, value }: { label: string; value: string }) {
  return <div><span>{label.toUpperCase()}</span><b title={value}>{value}</b></div>;
}

function ClusterSummary({ label, cluster, currentPrice }: { label: string; cluster: ReturnType<typeof extractBclifOperationalClusters>[number] | undefined; currentPrice: number }) {
  const evidence = cluster ? classifyBclifEvidence(cluster.evidenceComposition).replaceAll("_", " ") : undefined;
  return <div className="cluster-summary-row" title={evidence ? `Evidence: ${evidence}` : undefined}><span>{label.toUpperCase()}</span><b>{cluster ? `${formatPriceRange(cluster.priceLow, cluster.priceHigh)} · ${cluster.distanceFromMarkBps >= 0 ? "+" : ""}${(cluster.distanceFromMarkBps / 100).toFixed(1)}% · ${cluster.confidence.toFixed(0)}%` : "NO QUALIFYING SHELF"}</b><i>{cluster ? `${formatCompactUsd(cluster.estimatedExposureLow)}–${formatCompactUsd(cluster.estimatedExposureHigh)} · ${cluster.state}` : `MARK ${currentPrice.toLocaleString()}`}</i></div>;
}

function formatCoverage(persistent: number | null | undefined, legacy: number | undefined, digits: number) {
  if (persistent === null) return "MISSING";
  const value = persistent ?? legacy;
  return value === undefined ? "—" : `${value.toFixed(digits)}%`;
}

function horizonTruthLabel(horizon: LiquidationFieldSettings["horizon"], eventCoverage: number | null | undefined, authority: string) {
  if (horizon !== "3W") return `${horizon} MODEL CONTEXT`;
  if (authority === "PERSISTENT_NODE" && eventCoverage !== null && eventCoverage !== undefined && eventCoverage >= 99.5) return "3W FULL EVENT HISTORY";
  return "3W OI CONTEXT · LIVE EVENTS COLLECTING";
}

function formatPriceRange(low: number, high: number) {
  return `$${Math.round(low).toLocaleString()}–$${Math.round(high).toLocaleString()}`;
}

function formatCompactUsd(value: number) {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(0)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function formatDuration(value: number) {
  if (value < 60_000) return `${Math.max(1, Math.round(value / 1_000))}s`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)}m`;
  return `${(value / 3_600_000).toFixed(1)}h`;
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

function provenanceFor(authority: DisplayAuthority, collectorNodeId: string | null, state: LiquidationFieldRuntimeStatus["state"], hasSnapshot: boolean) {
  if (authority === "PERSISTENT_NODE") return {
    collector: collectorNodeId || "PERSISTENT NODE",
    persistence: state === "ERROR" || state === "UNAVAILABLE" ? "UNAVAILABLE" : "ON",
    history: hasSnapshot ? (state === "STALE" ? "LAST VERIFIED SNAPSHOT · STALE" : "VERIFIED CONTINUOUS") : "NO VERIFIED TILES YET"
  };
  if (authority === "TEST_FIXTURE") return { collector: "LOCALHOST VISUAL FIXTURE", persistence: "OFF", history: "SYNTHETIC TEST ONLY" };
  if (authority === "REPLAY") return { collector: "VERIFIED REPLAY", persistence: "OFF", history: "IMMUTABLE REPLAY WINDOW" };
  if (authority === "UNRESOLVED") return { collector: "AUTHORITY NOT SELECTED", persistence: "UNKNOWN", history: "UNKNOWN" };
  return { collector: "BROWSER SESSION", persistence: "OFF", history: "BUILDS ONLY WHILE THIS CHART IS OPEN" };
}
