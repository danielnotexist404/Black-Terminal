import type { KioseffSnapshot } from "../core/canonical";
import type { KioseffSettingsV1 } from "../core/settings";
import type { KioseffUnavailableDiagnostic } from "../data/unavailability";
import type {
  KioseffLoadState,
  KioseffRuntimeDiagnostics
} from "../data/loadState";
import { buildMarketMakerActivityDashboard } from "./marketMakerDashboardModel";

type Props = {
  visible: boolean;
  snapshot: KioseffSnapshot | null;
  unavailable: KioseffUnavailableDiagnostic | null;
  settings: KioseffSettingsV1;
  loadState: KioseffLoadState;
  diagnostics: KioseffRuntimeDiagnostics;
  currentPrice: number;
};

function formatPrice(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function formatVolume(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatDistance(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatEventTime(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return new Date(value * 1000).toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function KioseffOverlays({
  visible,
  snapshot,
  unavailable,
  settings,
  loadState,
  diagnostics,
  currentPrice
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
  const parityPanel = import.meta.env.DEV ? (
    <details className="kioseff-parity-diagnostics" data-testid="kioseff-parity-diagnostics">
      <summary>Parity Diagnostics</summary>
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
  ) : null;
  if (unavailable) {
    return (
      <>
        <aside className="kioseff-unavailable" role="status">
          <b>Market Maker Heatmap unavailable</b>
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
        {parityPanel}
        {inspector}
      </>
    );
  }
  const dashboard = buildMarketMakerActivityDashboard(snapshot, currentPrice);
  const buy = dashboard.nearestBuyWall;
  const sell = dashboard.nearestSellWall;
  const latestLiquidation = dashboard.latestLiquidationEvent;
  const pressureBias =
    dashboard.dominantPressure === "none"
      ? "No events"
      : dashboard.dominantPressure === "balanced"
        ? "Balanced"
        : `${dashboard.dominantPressure === "buy-wall" ? "Buy wall" : "Sell wall"} ${dashboard.dominantPressurePercent?.toFixed(0) ?? "—"}%`;
  return (
    <>
      {loadState.stage === "degraded" && (
        <aside className="kioseff-warming" role="status">
          {loadState.message}
        </aside>
      )}
      {loadState.stage === "ready" &&
        snapshot.activeClusters.length + snapshot.violatedClusters.length === 0 && (
          <aside className="kioseff-warming" role="status">
            Ready — this market window produced no active maker zones.
          </aside>
        )}
      {settings.style.showSummaryTable && (
        <aside
          className="kioseff-summary kioseff-activity-dashboard"
          style={{ width: `min(${settings.style.activityDashboardWidth}px, calc(100% - 140px))` }}
        >
          <header>
            <b>Market Maker Activity Dashboard</b>
            <small>LIVE MODEL</small>
          </header>
          <div className="kioseff-wall-row buy-wall">
            <span>Nearest Buy Wall</span>
            <strong>{formatPrice(buy?.price)}</strong>
            <small>{formatVolume(buy?.signedVolume)} vol</small>
            <em>{formatDistance(buy?.distancePercent)}</em>
          </div>
          <div className="kioseff-wall-row sell-wall">
            <span>Nearest Sell Wall</span>
            <strong>{formatPrice(sell?.price)}</strong>
            <small>{formatVolume(sell?.signedVolume)} vol</small>
            <em>{formatDistance(sell?.distancePercent)}</em>
          </div>
          <section className="kioseff-activity-stats">
            <div><span>Active Walls</span><b>{dashboard.activeBuyWallCount} buy · {dashboard.activeSellWallCount} sell</b></div>
            <div><span>Wall Liquidity</span><b>{formatVolume(dashboard.activeBuyLiquidity)} / {formatVolume(dashboard.activeSellLiquidity)}</b></div>
            <div><span>Liquidation Pressure</span><b>{formatVolume(dashboard.totalLiquidationPressure)}</b></div>
            <div><span>Pressure Bias</span><b>{pressureBias}</b></div>
          </section>
          <footer>
            <span>Liquidation Events</span>
            <b>{dashboard.violatedEventCount.toLocaleString()}</b>
            <small>{latestLiquidation ? `${latestLiquidation.side === "buy-stop" ? "Buy wall cleared" : "Sell wall cleared"} · ${formatPrice(latestLiquidation.price)} · ${formatVolume(latestLiquidation.volume)} · ${formatEventTime(latestLiquidation.time)}` : "No violated-wall events in this window"}</small>
            <em>Estimated from violated walls · Black Core tick confirmation pending</em>
          </footer>
        </aside>
      )}
      {settings.showClusterRatioMeter && (
        <aside className="kioseff-ratio">
          <div><span>Active Buy Walls</span><b>{formatVolume(snapshot.ratioMeter.activeBuyStops)}</b><span>Active Sell Walls</span><b>{formatVolume(snapshot.ratioMeter.activeSellStops)}</b></div>
          <meter min={0} max={20} value={snapshot.ratioMeter.activeBuyBlocks ?? 10} />
          <div><span>Violated Buy Walls</span><b>{formatVolume(snapshot.ratioMeter.violatedBuyStops)}</b><span>Violated Sell Walls</span><b>{formatVolume(snapshot.ratioMeter.violatedSellStops)}</b></div>
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
