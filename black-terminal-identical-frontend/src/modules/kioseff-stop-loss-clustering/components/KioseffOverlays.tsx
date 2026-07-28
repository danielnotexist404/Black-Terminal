import type { KioseffSnapshot } from "../core/canonical";
import type { KioseffSettingsV1 } from "../core/settings";
import type { KioseffUnavailableDiagnostic } from "../data/unavailability";

type Props = {
  visible: boolean;
  snapshot: KioseffSnapshot | null;
  unavailable: KioseffUnavailableDiagnostic | null;
  settings: KioseffSettingsV1;
};

function formatPrice(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function formatVolume(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function KioseffOverlays({ visible, snapshot, unavailable, settings }: Props) {
  if (!visible) return null;
  if (unavailable) {
    return (
      <aside className="kioseff-unavailable" role="status">
        <b>Stop Loss Clustering unavailable</b>
        <span>{unavailable.capability}</span>
        <small>{unavailable.venue} · {unavailable.symbol} · {unavailable.chartTimeframe}</small>
        <small>Requested LTF: {unavailable.requestedLowerTimeframe}</small>
        <small>Coverage: {unavailable.historyCoverage.actual}/{unavailable.historyCoverage.expected}</small>
        <small>Realtime source: {unavailable.realtimeSource}</small>
        <em>{unavailable.retryable ? "Retry is possible." : "This market configuration is unsupported."}</em>
      </aside>
    );
  }
  if (!snapshot) {
    return <aside className="kioseff-unavailable"><b>Stop Loss Clustering</b><span>Loading certified intrabars…</span></aside>;
  }
  const buy = snapshot.summary.nearestBuy;
  const sell = snapshot.summary.nearestSell;
  return (
    <>
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
    </>
  );
}
