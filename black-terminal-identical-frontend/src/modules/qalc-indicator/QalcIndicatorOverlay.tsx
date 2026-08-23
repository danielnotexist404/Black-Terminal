import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { BlackChartEngine } from "../../chart-engine/BlackChartEngine";
import type { ChartPriceTransformSnapshot } from "../../chart-engine/priceTransform";
import type { QalcIndicatorSettings } from "../../chart-engine/types";
import { qalcApi, type QalcChartEvent, type QalcRuntimeStatus, type QalcTimelineResponse } from "../strategy-lab/qalc/qalcApi";

type Props = {
  active: boolean;
  symbol: string;
  exchange: string;
  settings: QalcIndicatorSettings;
  chartEngine: BlackChartEngine | null;
  priceTransform: ChartPriceTransformSnapshot | null;
  onOpenSettings: () => void;
};

const emptyTimeline: QalcTimelineResponse = {
  available: false,
  source: "NO_FALLBACK",
  updatedAt: 0,
  coverage: { complete: false, source: "RECORDED_QALC_EVENT_TIME" },
  events: [],
};

export function QalcIndicatorOverlay({ active, symbol, exchange, settings, chartEngine, priceTransform, onOpenSettings }: Props) {
  const [timeline, setTimeline] = useState<QalcTimelineResponse>(emptyTimeline);
  const [status, setStatus] = useState<QalcRuntimeStatus>();
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const canonicalSymbol = symbol.replace(/[^a-z0-9]/gi, "").toUpperCase();
  const supported = exchange.toLowerCase() === "bybit" && (canonicalSymbol === "BTCUSDT" || canonicalSymbol === "ETHUSDT");

  useEffect(() => {
    if (!active || !supported) return;
    const controller = new AbortController();
    let disposed = false;
    const refresh = async () => {
      if (inFlight.current || document.visibilityState !== "visible") return;
      inFlight.current = true;
      try {
        const visibleRange = chartEngine?.getVisibleTimeRange();
        const [timelineResult, statusResult] = await Promise.allSettled([
          qalcApi.timeline({
            symbol: canonicalSymbol,
            from: visibleRange ? visibleRange.from * 1_000 : undefined,
            to: visibleRange ? visibleRange.to * 1_000 : undefined,
            runId: settings.selectedRunId || undefined,
            limit: 2_000,
          }, controller.signal),
          qalcApi.status(controller.signal),
        ]);
        if (disposed) return;
        if (timelineResult.status === "fulfilled") setTimeline(timelineResult.value);
        else throw timelineResult.reason;
        if (statusResult.status === "fulfilled") setStatus(statusResult.value);
        setError("");
      } catch (cause) {
        if (!disposed && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "BC-QALC timeline unavailable.");
      } finally {
        inFlight.current = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => { disposed = true; controller.abort(); window.clearInterval(timer); inFlight.current = false; };
  }, [active, canonicalSymbol, chartEngine, settings.selectedRunId, supported]);

  const markers = useMemo(() => {
    if (!active || !chartEngine || !priceTransform) return [];
    return timeline.events.flatMap((event) => {
      if (!isVisibleEvent(event, settings)) return [];
      const x = chartEngine.getScreenXForTimestamp(event.eventTime / 1_000);
      const y = chartEngine.getScreenYForPrice(event.price);
      if (!Number.isFinite(x) || y == null || !Number.isFinite(y) || x < priceTransform.plotLeft || x > priceTransform.plotRight || y < priceTransform.plotTop || y > priceTransform.plotBottom) return [];
      return [{ event, x, y }];
    });
  }, [active, chartEngine, priceTransform, settings, timeline.events]);

  if (!active) return null;
  const variables = {
    "--qalc-long": settings.longColor,
    "--qalc-short": settings.shortColor,
    "--qalc-neutral": settings.neutralColor,
    "--qalc-marker-size": `${settings.markerSize}px`,
    "--qalc-pane-height": `${settings.paneHeight}px`,
  } as CSSProperties;
  const stateLabel = !supported ? "BYBIT BTC/ETH ONLY" : error ? "TIMELINE UNAVAILABLE" : timeline.available ? `${status?.certificationState || "RESEARCH"} · ${status?.runtimeState || "SYNCING"}` : "NO RECORDED EVENTS";

  return <div className="qalc-chart-overlay" style={variables} data-source={timeline.source} data-testid="qalc-chart-overlay">
    <button type="button" className="qalc-chart-badge" onClick={onOpenSettings} title={error || "Open BC-QALC indicator settings"}>
      <strong>BC-QALC</strong><span>{stateLabel}</span>
    </button>
    <div className="qalc-marker-layer" aria-label="Canonical BC-QALC event markers">
      {markers.map(({ event, x, y }) => <button
        type="button"
        key={event.id}
        className={`qalc-marker qalc-marker-${event.kind.toLowerCase().replaceAll("_", "-")}`}
        style={{ left: x, top: y }}
        title={eventTooltip(event, settings.tooltipDetail)}
        aria-label={`${humanize(event.kind)} at ${event.price}`}
      ><i /></button>)}
    </div>
    {settings.showMicrostructurePane && <MicrostructurePane status={status} settings={settings} />}
    {!timeline.available && <div className="qalc-coverage-note">RECORDED EVENT-TIME DATA ONLY · NO CANDLE FALLBACK</div>}
  </div>;
}

function MicrostructurePane({ status, settings }: { status?: QalcRuntimeStatus; settings: QalcIndicatorSettings }) {
  const features = status?.features;
  const horizon = String(settings.predictionHorizonMs) as "250" | "1000" | "3000" | "5000" | "10000";
  const values = [
    ["QI5", features?.queueImbalance?.["5"]],
    ["OFI", features?.combinedOfi?.[horizon] ?? features?.combinedOfi?.["1000"]],
    ["CVD", features?.notionalCvd?.[horizon] ?? features?.notionalCvd?.["1000"]],
    ["FLOW", features?.flowEfficiency?.[horizon] ?? features?.flowEfficiency?.["1000"]],
    ["TOX", features?.toxicity?.score],
    ["P(FILL)", status?.decision?.fill?.beforeInvalidation],
  ] as Array<[string, number | undefined]>;
  return <div className="qalc-micro-pane" style={{ transform: `translateY(${settings.paneOffset}px) scaleY(${settings.paneScale})` }}>
    <header><strong>QUEUE MICROSTRUCTURE</strong><span>{features?.initiativeState || status?.runtimeState || "AWAITING CANONICAL STREAM"}</span></header>
    <div>{values.map(([label, value]) => <span key={label}><em>{label}</em><b>{formatMetric(value)}</b><i style={{ width: `${metricWidth(value, label)}%` }} /></span>)}</div>
  </div>;
}

function isVisibleEvent(event: QalcChartEvent, settings: QalcIndicatorSettings) {
  if (settings.displayMode === "REPLAY" && event.origin !== "REPLAY") return false;
  if (settings.displayMode === "LIVE" && event.origin === "REPLAY") return false;
  if (event.kind.startsWith("CANDIDATE")) return settings.showCandidates;
  if (event.kind === "REJECTED") return settings.showRejected;
  if (event.kind === "QUOTE_BID" || event.kind === "QUOTE_ASK") return settings.showQuotes;
  if (event.kind === "QUOTE_CANCELLED" || event.kind === "QUOTE_EXPIRED") return settings.showCancellations;
  if (event.kind === "PARTIAL_FILL") return settings.showPartialFills;
  if (event.kind.startsWith("ENTRY")) return settings.showEntries;
  if (event.kind.startsWith("EXIT")) return settings.showExits;
  return false;
}

function eventTooltip(event: QalcChartEvent, detail: QalcIndicatorSettings["tooltipDetail"]) {
  const base = `${humanize(event.kind)} · ${event.symbol}\n${new Date(event.eventTime).toISOString()} · ${event.price}\n${event.reason}`;
  if (detail === "COMPACT") return base;
  const metrics = event.metrics;
  return `${base}\nOrigin ${event.origin} · Run ${event.runId}\nP(up) ${formatMetric(metrics.probabilityUp)} · P(down) ${formatMetric(metrics.probabilityDown)} · P(fill) ${formatMetric(metrics.fillProbability)}\nNet edge ${formatMetric(metrics.expectedNetEdgeUsdt)} USDT · Cost ${formatMetric(metrics.allInCostUsdt)} USDT · Toxicity ${formatMetric(metrics.toxicity)}`;
}

function humanize(value: string) { return value.replaceAll("_", " "); }
function formatMetric(value?: number) { return Number.isFinite(value) ? Number(value).toFixed(Math.abs(Number(value)) >= 100 ? 1 : 3) : "—"; }
function metricWidth(value: number | undefined, label: string) {
  if (!Number.isFinite(value)) return 0;
  const scale = label === "TOX" ? Number(value) : Math.abs(Number(value)) <= 1 ? Math.abs(Number(value)) * 100 : Math.min(100, Math.log10(Math.abs(Number(value)) + 1) * 32);
  return Math.max(2, Math.min(100, scale));
}
