import type { KioseffSnapshot } from "../core/canonical";
import type { KioseffSettingsV1 } from "../core/settings";
import type { KioseffUnavailableDiagnostic } from "../data/unavailability";
import type {
  KioseffLoadState,
  KioseffRuntimeDiagnostics
} from "../data/loadState";

type Props = {
  visible: boolean;
  snapshot: KioseffSnapshot | null;
  unavailable: KioseffUnavailableDiagnostic | null;
  settings: KioseffSettingsV1;
  loadState: KioseffLoadState;
  diagnostics: KioseffRuntimeDiagnostics;
};

function formatPrice(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function formatVolume(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function loadLabel(state: KioseffLoadState) {
  switch (state.stage) {
    case "idle":
      return "Waiting to start…";
    case "requesting-symbol-metadata":
      return "Requesting authoritative symbol metadata…";
    case "fetching-chart-history":
      return `Fetching chart history — ${state.loaded.toLocaleString()} of ${state.target.toLocaleString()} bars`;
    case "fetching-intrabar-history":
      return `Fetching ordered intrabars — ${state.loaded.toLocaleString()}${state.target === undefined ? "" : ` of ${state.target.toLocaleString()}`}`;
    case "grouping-intrabars":
      return `Grouping ${state.intrabars.toLocaleString()} intrabars into ${state.bars.toLocaleString()} chart bars…`;
    case "validating":
      return `Validating ${state.intrabars.toLocaleString()} ordered intrabars across ${state.bars.toLocaleString()} chart bars…`;
    case "starting-worker":
      return "Starting versioned calculation worker…";
    case "rebuilding":
      return `Rebuilding clean Pine state from ${state.bars.toLocaleString()} chronological bars and ${state.intrabars.toLocaleString()} intrabars…`;
    case "calculating":
      return `Calculating ${state.bars.toLocaleString()} bars from ${state.intrabars.toLocaleString()} intrabars…`;
    case "rendering":
      return `Building visible render geometry for ${state.clusters.toLocaleString()} clusters…`;
    case "warming":
      return `Warming up — calculated from ${state.completedBars.toLocaleString()} of ${state.targetBars.toLocaleString()} chart bars`;
    case "ready":
      return "Ready";
    case "degraded":
      return `Degraded — ${state.message}`;
    case "unavailable":
      return `Unavailable — ${state.reason}`;
    case "error":
      return `Error — ${state.message}`;
  }
}

export function KioseffOverlays({
  visible,
  snapshot,
  unavailable,
  settings,
  loadState,
  diagnostics
}: Props) {
  if (!visible) return null;
  const inspector = import.meta.env.DEV ? (
    <details className="kioseff-data-inspector" data-testid="kioseff-data-inspector">
      <summary>Kioseff data inspector</summary>
      {Object.entries(diagnostics).map(([key, value]) => (
        <small key={key}><span>{key}</span><b>{value === null ? "—" : String(value)}</b></small>
      ))}
    </details>
  ) : null;
  const parityPanel = (
    <details className="kioseff-parity-diagnostics" data-testid="kioseff-parity-diagnostics">
      <summary>KIOSEFF PARITY DIAGNOSTICS · {diagnostics.parityState}</summary>
      <div><span>Engine Mode</span><b>{diagnostics.engineMode}</b></div>
      <div><span>Engine Version</span><b>{diagnostics.engineVersion}</b></div>
      <div><span>Data State</span><b>{diagnostics.parityState}</b></div>
      <div><span>Venue</span><b>{diagnostics.exchange || "—"}</b></div>
      <div><span>Symbol</span><b>{diagnostics.rawSymbol || "—"} · {diagnostics.marketCategory || "—"}</b></div>
      <div><span>Chart TF / LTF</span><b>{diagnostics.chartTimeframe || "—"} / {diagnostics.requestedLowerTimeframe || "—"}</b></div>
      <div><span>Chart Bars</span><b>{diagnostics.groupedChartBarCount.toLocaleString()} / {diagnostics.chartHistoryCount.toLocaleString()}</b></div>
      <div><span>LTF Coverage</span><b>{diagnostics.coveragePercent.toFixed(2)}%</b></div>
      <div><span>LTF Missing</span><b>{diagnostics.missingIntervals.toLocaleString()}</b></div>
      <div><span>LTF Duplicates</span><b>{diagnostics.duplicateIntervals.toLocaleString()}</b></div>
      <div><span>LTF Out Of Order</span><b>{diagnostics.outOfOrderIntervals.toLocaleString()}</b></div>
      <div><span>Active Buy Clusters</span><b>{diagnostics.activeBuyClusterCount.toLocaleString()}</b></div>
      <div><span>Active Sell Clusters</span><b>{diagnostics.activeSellClusterCount.toLocaleString()}</b></div>
      <div><span>Historical Clusters</span><b>{diagnostics.violatedClusterCount.toLocaleString()}</b></div>
      <div><span>Cluster Cap</span><b>{diagnostics.clusterCap}</b></div>
      <div><span>Percentile Mode</span><b>{diagnostics.percentileMode}</b></div>
      <div><span>Gradient Mode</span><b>{diagnostics.gradientMode}</b></div>
      <div><span>Settings Hash</span><b>{diagnostics.settingsHash ?? "—"}</b></div>
      <div><span>Data Hash</span><b>{diagnostics.dataHash ?? "—"}</b></div>
      <div><span>Cluster Hash</span><b>{diagnostics.clusterHash ?? "—"}</b></div>
      <div><span>Last Closed Candle</span><b>{diagnostics.lastClosedCandle === null ? "—" : new Date(diagnostics.lastClosedCandle * 1000).toISOString()}</b></div>
      <div><span>Last Rebuild</span><b>{diagnostics.lastRebuild === null ? "—" : new Date(diagnostics.lastRebuild * 1000).toISOString()}</b></div>
      <div><span>Viewport Affects Calculation</span><b>{diagnostics.viewportAffectsCalculation ? "YES" : "NO"}</b></div>
    </details>
  );
  if (unavailable) {
    return (
      <>
        <aside className="kioseff-unavailable" role="status">
          <b>Stop Loss Clustering unavailable</b>
          <span>{unavailable.capability}</span>
          <small>{unavailable.venue} · {unavailable.symbol} · {unavailable.chartTimeframe}</small>
          <small>Requested LTF: {unavailable.requestedLowerTimeframe}</small>
          <small>Coverage: {unavailable.historyCoverage.actual}/{unavailable.historyCoverage.expected}</small>
          <small>Chart bars: {unavailable.historyCoverage.completeChartBars} complete · {unavailable.historyCoverage.partialChartBars} provisional · {unavailable.historyCoverage.missingChartBars} empty</small>
          <small>Missing intervals: {unavailable.historyCoverage.missingIntervals}</small>
          <small>Realtime source: {unavailable.realtimeSource}</small>
          <small>{unavailable.message}</small>
          <em>{unavailable.retryable ? "Retry is possible." : "This market configuration is unsupported."}</em>
        </aside>
        {parityPanel}
        {inspector}
      </>
    );
  }
  if (!snapshot) {
    return (
      <>
        <aside className="kioseff-unavailable" data-testid="kioseff-load-state"><b>Stop Loss Clustering</b><span>{loadLabel(loadState)}</span></aside>
        {parityPanel}
        {inspector}
      </>
    );
  }
  const buy = snapshot.summary.nearestBuy;
  const sell = snapshot.summary.nearestSell;
  return (
    <>
      {loadState.stage !== "ready" && (
        <aside className="kioseff-warming" role="status">
          <b>PARITY STATE NOT FINAL · PREVIEW ONLY</b>
          {loadState.stage === "warming"
            ? loadLabel(loadState)
            : `Warming up — calculated from ${diagnostics.groupedChartBarCount.toLocaleString()} of ${diagnostics.chartHistoryCount.toLocaleString()} chart bars · ${loadLabel(loadState)}`}
        </aside>
      )}
      {loadState.stage === "ready" &&
        snapshot.activeClusters.length + snapshot.violatedClusters.length === 0 && (
          <aside className="kioseff-warming" role="status">
            Ready — this canonical market window produced no clusters.
          </aside>
        )}
      <aside className="kioseff-summary">
        <b>Stop-Loss Clustering</b>
        <div><span>Nearest Buy-Stop Cluster</span><strong>{formatPrice(buy?.price)}</strong><small>{formatVolume(buy?.signedVolume)}</small><em>{snapshot.model === "absorbtion-extremes" ? buy?.typicalMove === null || buy?.typicalMove === undefined ? "None Similar" : `${(buy.typicalMove * 100).toFixed(2)}%` : buy?.activeSidePercent === null || buy?.activeSidePercent === undefined ? "—" : `${buy.activeSidePercent.toFixed(2)}%`}</em></div>
        <div><span>Nearest Sell-Stop Cluster</span><strong>{formatPrice(sell?.price)}</strong><small>{formatVolume(sell?.signedVolume)}</small><em>{snapshot.model === "absorbtion-extremes" ? sell?.typicalMove === null || sell?.typicalMove === undefined ? "None Similar" : `${(sell.typicalMove * 100).toFixed(2)}%` : sell?.activeSidePercent === null || sell?.activeSidePercent === undefined ? "—" : `${sell.activeSidePercent.toFixed(2)}%`}</em></div>
      </aside>
      {settings.showClusterRatioMeter && (
        <aside className="kioseff-ratio">
          <div><span>Active Buy-Stop Clusters</span><b>{formatVolume(snapshot.ratioMeter.activeBuyStops)}</b><span>Active Sell-Stop Clusters</span><b>{formatVolume(snapshot.ratioMeter.activeSellStops)}</b></div>
          <meter min={0} max={20} value={snapshot.ratioMeter.activeBuyBlocks ?? 10} />
          <div><span>Violated Buy-Stop Clusters</span><b>{formatVolume(snapshot.ratioMeter.violatedBuyStops)}</b><span>Violated Sell-Stop Clusters</span><b>{formatVolume(snapshot.ratioMeter.violatedSellStops)}</b></div>
          <meter min={0} max={20} value={snapshot.ratioMeter.violatedBuyBlocks ?? 10} />
        </aside>
      )}
      {import.meta.env.DEV && snapshot.diagnostics.length > 0 && (
        <aside className="kioseff-diagnostics">
          <b>Parity inspector</b>
          {snapshot.diagnostics.map((diagnostic, index) => <small key={`${diagnostic.code}:${index}`}>{diagnostic.code}: {diagnostic.message}</small>)}
        </aside>
      )}
      {parityPanel}
      {inspector}
    </>
  );
}
