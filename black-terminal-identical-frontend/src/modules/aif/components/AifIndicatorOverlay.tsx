import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { BlackChartEngine } from "../../../chart-engine/BlackChartEngine";
import type { ChartPriceTransformSnapshot } from "../../../chart-engine/priceTransform";
import type { Candle } from "../../../chart-engine/types";
import type { MarketSymbol, Timeframe } from "../../../market-data/types";
import type { AifProgressStage, AifRenderModel, AifSettings } from "../core/aifTypes";
import { loadAifHistory } from "../core/aifHistoryLoader";
import { AifWorkerClient } from "../workers/aifWorkerClient";
import { readAifSettings, writeAifSettings } from "../state/aifStore";
import { AifIndicatorSettings } from "./AifIndicatorSettings";
import { AifEventTimeline } from "./AifEventTimeline";
import { AifProfileSummary } from "./AifProfileSummary";
import { mergeAifResearchMemory } from "../nodes/aifNodeMemory";
import { projectAifPriceLine, projectAifProfileRows } from "../rendering/aifPriceGeometry";

type Props = { active: boolean; settingsOpen: boolean; onCloseSettings: () => void; workspaceId: string; marketSymbol: MarketSymbol; timeframe: Timeframe; currentPrice: number; latestCandle: Candle | null; chartEngine: BlackChartEngine | null; priceTransform: ChartPriceTransformSnapshot | null };

export function AifIndicatorOverlay({ active, settingsOpen, onCloseSettings, workspaceId, marketSymbol, timeframe, currentPrice, latestCandle, chartEngine, priceTransform }: Props) {
  const symbolKey = `${marketSymbol.exchange}:${marketSymbol.rawSymbol}:${timeframe}`;
  const [settings, setSettings] = useState<AifSettings>(() => readAifSettings(workspaceId, symbolKey));
  const [model, setModel] = useState<AifRenderModel | null>(null);
  const [stage, setStage] = useState<AifProgressStage>("LOADING HISTORY");
  const [loaded, setLoaded] = useState(0);
  const [error, setError] = useState("");
  const [historyRevision, setHistoryRevision] = useState(0);
  const clientRef = useRef<AifWorkerClient | null>(null);
  const historyRef = useRef<Candle[]>([]);
  const currentPriceRef = useRef(currentPrice);
  const currentBarTimerRef = useRef<number | null>(null);
  currentPriceRef.current = currentPrice;
  useEffect(() => { setSettings(readAifSettings(workspaceId, symbolKey)); }, [workspaceId, symbolKey]);
  useEffect(() => { writeAifSettings(workspaceId, symbolKey, settings); }, [workspaceId, symbolKey, settings]);
  useEffect(() => {
    if (!active) { historyRef.current = []; return; }
    let cancelled = false;
    setError(""); setStage("LOADING HISTORY"); setLoaded(0);
    loadAifHistory(marketSymbol, timeframe, settings.lookbackBars, (count) => !cancelled && setLoaded(count))
      .then((candles) => { if (!cancelled) { historyRef.current = candles; setHistoryRevision((value) => value + 1); } })
      .catch((cause) => { if (!cancelled) { setError(cause instanceof Error ? cause.message : String(cause)); setModel(null); } });
    return () => { cancelled = true; };
  }, [active, marketSymbol.exchange, marketSymbol.rawSymbol, marketSymbol.marketKind, timeframe, settings.lookbackBars]);
  useEffect(() => {
    if (!active || !historyRef.current.length) return;
    let cancelled = false;
    const candles = historyRef.current.slice(-settings.lookbackBars);
    const client = clientRef.current ?? new AifWorkerClient();
    clientRef.current = client;
    setStage("NORMALIZING");
    const calculationTimer = window.setTimeout(() => !cancelled && setStage("CALCULATING PROFILE"), 0);
    const extractTimer = window.setTimeout(() => !cancelled && setStage("EXTRACTING NODES"), 80);
    const timelineTimer = window.setTimeout(() => !cancelled && setStage("BUILDING TIMELINE"), 180);
    const last = candles.at(-1);
    void client.calculate({ marketSymbol, timeframe, candles, currentPrice: currentPriceRef.current || last?.close || 0, settings, sourceVersion: `${candles[0]?.time}:${last?.time}:${last?.open}:${last?.high}:${last?.low}:${last?.close}:${last?.volume}:${candles.length}` })
      .then((result) => {
        if (cancelled || !result) return;
        const memory = mergeAifResearchMemory(`${workspaceId}:${symbolKey}`, result.primaryNodes, result.timelineEvents);
        setStage("READY");
        setModel({ ...result, primaryNodes: memory.nodes.filter((node) => node.profileType === result.profileHistogram.profileType), timelineEvents: memory.events });
      })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { window.clearTimeout(calculationTimer); window.clearTimeout(extractTimer); window.clearTimeout(timelineTimer); });
    return () => { cancelled = true; window.clearTimeout(calculationTimer); window.clearTimeout(extractTimer); window.clearTimeout(timelineTimer); };
  }, [active, historyRevision, marketSymbol.exchange, marketSymbol.rawSymbol, marketSymbol.marketKind, settings, symbolKey, timeframe, workspaceId]);
  useEffect(() => {
    if (!active || !latestCandle || !historyRef.current.length) return;
    const history = historyRef.current;
    const last = history.at(-1);
    if (!last || latestCandle.time > last.time) {
      historyRef.current = [...history, latestCandle].slice(-settings.lookbackBars);
      setHistoryRevision((value) => value + 1);
      return;
    }
    const index = history.findIndex((candle) => candle.time === latestCandle.time);
    if (index < 0) return;
    history[index] = latestCandle;
    if (currentBarTimerRef.current != null) window.clearTimeout(currentBarTimerRef.current);
    currentBarTimerRef.current = window.setTimeout(() => setHistoryRevision((value) => value + 1), 5000);
  }, [active, latestCandle, settings.lookbackBars]);
  useEffect(() => {
    if (active) return;
    if (currentBarTimerRef.current != null) window.clearTimeout(currentBarTimerRef.current);
    clientRef.current?.dispose(); clientRef.current = null; setModel(null);
  }, [active]);
  useEffect(() => () => { if (currentBarTimerRef.current != null) window.clearTimeout(currentBarTimerRef.current); clientRef.current?.dispose(); }, []);
  const geometry = useMemo(() => {
    if (!model || !chartEngine || !priceTransform) return null;
    const priceToY = (price: number) => chartEngine.priceToScreenY(price);
    return {
      primaryRows: projectAifProfileRows(model.profileHistogram.rows, priceTransform, priceToY),
      secondaryRows: model.secondaryProfile ? projectAifProfileRows(model.secondaryProfile.rows, priceTransform, priceToY, 55) : [],
      lineY: (price: number) => projectAifPriceLine(price, priceTransform, priceToY)
    };
  }, [chartEngine, model, priceTransform]);
  const overlayStyle = priceTransform ? {
    "--aif-plot-right": `${priceTransform.plotRight}px`,
    "--aif-axis-width": `${Math.max(0, priceTransform.width - priceTransform.plotRight)}px`
  } as CSSProperties : undefined;
  const labeledNodeLimit = settings.labelDensity === "high" ? 24 : settings.labelDensity === "medium" ? 12 : 6;
  const specializedNodeIds = new Set([...(model?.supportResistanceZones ?? []), ...(model?.projectedLvns ?? [])].map((node) => node.id));
  const standaloneNodes = model?.primaryNodes
    .filter((node) => !specializedNodeIds.has(node.id) && node.confidence >= settings.minimumConfidence)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, labeledNodeLimit) ?? [];
  const chobEvents = model?.timelineEvents.filter((event) => event.price != null && (event.type === "chob-candidate" || event.type === "chob-confirmed")).slice(-6) ?? [];
  if (!active && !settingsOpen) return null;
  return <>
    {active && <div className="aif-overlay" data-testid="aif-overlay" data-transform-revision={priceTransform?.revision ?? 0} data-calculated-at={model?.provenance.calculatedAt ?? 0} style={overlayStyle}>
      {!model && <div className="aif-progress"><b>{error ? "A.I.F. UNAVAILABLE" : stage === "LOADING HISTORY" ? "LOADING LONG HORIZON AUCTION..." : stage}</b><span>{error || `${loaded.toLocaleString()} / ${settings.lookbackBars.toLocaleString()} BARS`}</span></div>}
      {model && geometry && priceTransform && <>
        <div className={`aif-profile aif-profile-${settings.profilePlacement}`} aria-label="A.I.F. primary profile">{geometry.primaryRows.map((row) => <div key={row.index} data-row-index={row.index} className={row.valueArea ? "value-area" : ""} style={{ top: row.top, height: row.height, width: `${row.width}%`, opacity: settings.opacity / 100 }} />)}</div>
        {model.secondaryProfile && <div className={`aif-profile aif-secondary aif-profile-${settings.profilePlacement === "right" ? "left" : "right"}`} aria-label="A.I.F. secondary profile">{geometry.secondaryRows.map((row) => <div key={row.index} style={{ top: row.top, height: row.height, width: `${row.width}%` }} />)}</div>}
        <div className="aif-levels">
          {settings.showPoc && model.profileHistogram.poc != null && <AifLevel price={model.profileHistogram.poc} y={geometry.lineY(model.profileHistogram.poc)} className="poc" label="POC" />}
          {settings.showValueArea && model.profileHistogram.vah != null && <AifLevel price={model.profileHistogram.vah} y={geometry.lineY(model.profileHistogram.vah)} className="value-boundary" label="VAH" />}
          {settings.showValueArea && model.profileHistogram.val != null && <AifLevel price={model.profileHistogram.val} y={geometry.lineY(model.profileHistogram.val)} className="value-boundary" label="VAL" />}
          {settings.showSupportResistance && model.supportResistanceZones.map((node) => <AifLevel key={node.id} price={node.center} y={geometry.lineY(node.center)} className={node.center >= currentPrice ? "resistance" : "support"} label={node.nodeType.toUpperCase()} detail={`${node.confidence}%`} />)}
          {settings.showFutureLvns && model.projectedLvns.map((node) => <AifLevel key={node.id} price={node.center} y={geometry.lineY(node.center)} className="future-lvn" label="FUTURE LVN" />)}
          {settings.showNodes && standaloneNodes.map((node) => <AifLevel key={node.id} price={node.center} y={geometry.lineY(node.center)} className={`auction-node ${node.nodeType}`} label={node.nodeType.toUpperCase()} detail={`${node.confidence}%`} />)}
          {chobEvents.map((event) => <AifLevel key={event.id} price={event.price!} y={geometry.lineY(event.price!)} className={`chob-marker ${event.type === "chob-confirmed" ? "confirmed" : ""}`} label={event.type === "chob-confirmed" ? "CHoB" : "CHoB?"} detail={`${event.confidence}%`} />)}
        </div>
        {settings.showDataQuality && <div className="aif-quality">AUCTION PROFILE READY | {model.provenance.effectiveLookbackBars.toLocaleString()} BARS LOADED | {model.provenance.quality.toUpperCase()} | REQUESTED {model.provenance.requestedLookbackBars.toLocaleString()}{model.provenance.wasClamped ? ` | ${model.provenance.clampReason}` : ""}</div>}
        <AifProfileSummary model={model} />
        {settings.showTimeline && <AifEventTimeline events={model.timelineEvents} />}
      </>}
    </div>}
    {settingsOpen && <AifIndicatorSettings settings={settings} onChange={setSettings} onClose={onCloseSettings} />}
  </>;
}

function AifLevel({ price, y, className, label, detail }: { price: number; y: number | null; className: string; label: string; detail?: string }) {
  if (y == null) return null;
  return <span className={className} style={{ top: y }}><b>{label}</b> {price.toFixed(2)} {detail && <i>{detail}</i>}</span>;
}
