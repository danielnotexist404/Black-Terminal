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
import { mergeAifLvnZoneMemory, mergeAifResearchMemory } from "../nodes/aifNodeMemory";
import { projectAifPriceLine, projectAifProfileRows, projectAifPriceZone } from "../rendering/aifPriceGeometry";

type Props = { active: boolean; settingsOpen: boolean; onCloseSettings: () => void; workspaceId: string; marketSymbol: MarketSymbol; timeframe: Timeframe; currentPrice: number; latestCandle: Candle | null; chartEngine: BlackChartEngine | null; priceTransform: ChartPriceTransformSnapshot | null };

export function AifIndicatorOverlay({ active, settingsOpen, onCloseSettings, workspaceId, marketSymbol, timeframe, currentPrice, latestCandle, chartEngine, priceTransform }: Props) {
  const symbolKey = `${marketSymbol.exchange}:${marketSymbol.rawSymbol}:${timeframe}`;
  const [settings, setSettings] = useState<AifSettings>(() => readAifSettings(workspaceId, symbolKey));
  const [model, setModel] = useState<AifRenderModel | null>(null);
  const [stage, setStage] = useState<AifProgressStage>("LOADING HISTORY");
  const [loaded, setLoaded] = useState(0);
  const [error, setError] = useState("");
  const [historyRevision, setHistoryRevision] = useState(0);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
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
        const zoneMemory = mergeAifLvnZoneMemory(`${workspaceId}:${symbolKey}`, result.lvnZones);
        const reconciledZones = zoneMemory.zones.filter((zone) => result.lvnZones.some((current) => lvnOverlap(zone.low, zone.high, current.low, current.high) >= 0.35));
        const reconciledEvents = result.timelineEvents.map((event) => {
          const sourceZone = event.nodeId ? result.lvnZones.find((zone) => zone.id === event.nodeId) : undefined;
          if (!sourceZone) return event;
          const reconciled = reconciledZones.find((zone) => lvnOverlap(zone.low, zone.high, sourceZone.low, sourceZone.high) >= 0.35);
          return reconciled ? { ...event, id: event.id.replace(`:${sourceZone.id}:`, `:${reconciled.id}:`), nodeId: reconciled.id } : event;
        });
        const memory = mergeAifResearchMemory(`${workspaceId}:${symbolKey}`, result.primaryNodes, reconciledEvents);
        setStage("READY");
        setModel({ ...result, primaryNodes: memory.nodes.filter((node) => node.profileType === result.profileHistogram.profileType), lvnZones: reconciledZones, projectedLvns: reconciledZones.filter((zone) => result.projectedLvns.some((projected) => lvnOverlap(zone.low, zone.high, projected.low, projected.high) >= 0.35)), timelineEvents: memory.events });
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
      primaryRows: projectAifProfileRows(model.profileHistogram.rows, priceTransform, priceToY, 100, settings.profileNormalization),
      secondaryRows: model.secondaryProfile ? projectAifProfileRows(model.secondaryProfile.rows, priceTransform, priceToY, 55, settings.profileNormalization) : [],
      zones: model.projectedLvns.map((zone) => ({ zone, screen: projectAifPriceZone(zone.low, zone.high, zone.center, zone.minimumActivityPrice, priceTransform, priceToY) })).filter((entry) => entry.screen != null),
      lineY: (price: number) => projectAifPriceLine(price, priceTransform, priceToY)
    };
  }, [chartEngine, model, priceTransform, settings.profileNormalization]);
  const overlayStyle = priceTransform ? {
    "--aif-plot-right": `${priceTransform.plotRight}px`,
    "--aif-axis-width": `${Math.max(0, priceTransform.width - priceTransform.plotRight)}px`
    ,"--aif-profile-width": `${settings.profileWidth}%`
    ,"--aif-profile-offset": `${settings.profileHorizontalOffset}px`
    ,"--aif-zone-fill": `${settings.futureLvnZoneOpacity / 100}`
    ,"--aif-zone-border": `${settings.futureLvnBoundaryOpacity / 100}`
    ,"--aif-value-area-color": settings.valueAreaColor
  } as CSSProperties : undefined;
  const labeledNodeLimit = settings.labelDensity === "high" ? 24 : settings.labelDensity === "medium" ? 12 : 6;
  const specializedNodeIds = new Set([...(model?.supportResistanceZones ?? []), ...(model?.projectedLvns ?? [])].map((node) => node.id));
  const standaloneNodes = model?.primaryNodes
    .filter((node) => !specializedNodeIds.has(node.id) && node.confidence >= settings.minimumConfidence && (node.nodeType !== "lvn" || settings.showMinorNodes) && (node.nodeType !== "hvn" || settings.showHvns))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, Math.min(labeledNodeLimit, settings.maximumVisibleNodes)) ?? [];
  const chobEvents = model?.timelineEvents.filter((event) => event.price != null && (event.type === "chob-candidate" || event.type === "chob-confirmed")).slice(-6) ?? [];
  if (!active && !settingsOpen) return null;
  return <>
    {active && <div className="aif-overlay" data-testid="aif-overlay" data-transform-revision={priceTransform?.revision ?? 0} data-calculated-at={model?.provenance.calculatedAt ?? 0} style={overlayStyle}>
      {!model && <div className="aif-progress"><b>{error ? "A.I.F. UNAVAILABLE" : stage === "LOADING HISTORY" ? "LOADING LONG HORIZON AUCTION..." : stage}</b><span>{error || `${loaded.toLocaleString()} / ${settings.lookbackBars.toLocaleString()} BARS`}</span></div>}
      {model && geometry && priceTransform && <>
        {(settings.profilePlacement === "right" || settings.profilePlacement === "overlay" || settings.profilePlacement === "both") && <div className="aif-profile aif-profile-right" aria-label="A.I.F. primary profile">{geometry.primaryRows.map((row) => <div key={row.index} data-row-index={row.index} className={row.valueArea && settings.showValueArea ? "value-area" : ""} style={{ top: row.top, height: row.height, width: `${row.width}%`, opacity: settings.opacity / 100 * (row.valueArea && settings.showValueArea ? settings.valueAreaOpacity / 100 : 1) }} />)}</div>}
        {(settings.profilePlacement === "left" || settings.profilePlacement === "both") && <div className="aif-profile aif-profile-left" aria-label="A.I.F. primary profile left">{geometry.primaryRows.map((row) => <div key={row.index} data-row-index={row.index} className={row.valueArea && settings.showValueArea ? "value-area" : ""} style={{ top: row.top, height: row.height, width: `${row.width}%`, opacity: settings.opacity / 100 * (row.valueArea && settings.showValueArea ? settings.valueAreaOpacity / 100 : 1) }} />)}</div>}
        {model.secondaryProfile && <div className={`aif-profile aif-secondary aif-profile-${settings.profilePlacement === "right" ? "left" : "right"}`} aria-label="A.I.F. secondary profile">{geometry.secondaryRows.map((row) => <div key={row.index} style={{ top: row.top, height: row.height, width: `${row.width}%` }} />)}</div>}
        {settings.showFutureLvns && <div className="aif-lvn-zones">{geometry.zones.map(({ zone, screen }) => screen && <div key={zone.id} className={`aif-lvn-zone ${zone.center >= currentPrice ? "resistance" : "support"} state-${zone.state} ${selectedZoneId === zone.id ? "selected" : ""}`} style={{ top: screen.top, height: screen.height }} data-zone-id={zone.id}>
          {settings.futureLvnShowCenter && <i className="center" style={{ top: screen.centerY - screen.top }} />}
          {settings.futureLvnShowMinimumActivity && <i className="minimum" style={{ top: screen.minimumY - screen.top }} />}
          {settings.showLabels && <button type="button" onClick={() => setSelectedZoneId(zone.id)} title={zoneTooltip(zone)}><b>FUTURE LVN{settings.futureLvnShowLookback ? ` ${Math.round(zone.effectiveLookback / 1000)}K` : ""}</b>{settings.futureLvnShowScore && <span>{zone.score}</span>}{settings.futureLvnShowState && <em>{zone.state.toUpperCase()}</em>}</button>}
        </div>)}</div>}
        <div className="aif-levels">
          {settings.showPoc && model.profileHistogram.poc != null && <AifLevel price={model.profileHistogram.poc} y={geometry.lineY(model.profileHistogram.poc)} className="poc" label="POC" />}
          {settings.showValueArea && settings.showVah && model.profileHistogram.vah != null && <AifLevel price={model.profileHistogram.vah} y={geometry.lineY(model.profileHistogram.vah)} className="value-boundary" label="VAH" />}
          {settings.showValueArea && settings.showVal && model.profileHistogram.val != null && <AifLevel price={model.profileHistogram.val} y={geometry.lineY(model.profileHistogram.val)} className="value-boundary" label="VAL" />}
          {settings.showSupportResistance && model.supportResistanceZones.map((node) => <AifLevel key={node.id} price={node.center} y={geometry.lineY(node.center)} className={node.center >= currentPrice ? "resistance" : "support"} label={node.nodeType.toUpperCase()} detail={`${node.confidence}%`} />)}
          {settings.showNodes && standaloneNodes.map((node) => <AifLevel key={node.id} price={node.center} y={geometry.lineY(node.center)} className={`auction-node ${node.nodeType}`} label={node.nodeType.toUpperCase()} detail={`${node.confidence}%`} />)}
          {chobEvents.map((event) => <AifLevel key={event.id} price={event.price!} y={geometry.lineY(event.price!)} className={`chob-marker ${event.type === "chob-confirmed" ? "confirmed" : ""}`} label={event.type === "chob-confirmed" ? "CHoB" : "CHoB?"} detail={`${event.confidence}%`} />)}
        </div>
        {settings.showDataQuality && <div className="aif-quality">AUCTION PROFILE READY | {model.provenance.effectiveLookbackBars.toLocaleString()} BARS LOADED | {model.provenance.quality.toUpperCase()} | REQUESTED {model.provenance.requestedLookbackBars.toLocaleString()}{model.provenance.wasClamped ? ` | ${model.provenance.clampReason}` : ""}</div>}
        {settings.showStatisticsCard && <AifProfileSummary model={model} />}
        {settings.showTimeline && <AifEventTimeline events={model.timelineEvents} height={settings.timelineHeight} onSelectNode={(id) => setSelectedZoneId(id)} />}
      </>}
    </div>}
    {settingsOpen && <AifIndicatorSettings settings={settings} onChange={setSettings} onClose={onCloseSettings} />}
  </>;
}

function zoneTooltip(zone: AifRenderModel["projectedLvns"][number]) {
  return [`FUTURE LVN`, `Range: ${zone.low.toFixed(2)}-${zone.high.toFixed(2)}`, `Center: ${zone.center.toFixed(2)}`, `Minimum Activity: ${zone.minimumActivityPrice.toFixed(2)}`, `Width: ${zone.widthAbsolute.toFixed(2)}`, `Profile: ${zone.profileType}`, `Requested Lookback: ${zone.requestedLookback.toLocaleString()}`, `Effective Lookback: ${zone.effectiveLookback.toLocaleString()}`, `Detection: ${zone.algorithmVersion}`, `Strength: ${zone.strength}/100`, `Stability: ${zone.stability}%`, `Neighbor Contrast: ${zone.neighborContrast.toFixed(2)}x`, `State: ${zone.state}`, `Touches: ${zone.touchCount}`, `Projection: ${zone.projected ? "Active" : "Inactive"}`, `Data Quality: ${zone.dataQuality} from ${zone.sourceResolution}`].join("\n");
}

function AifLevel({ price, y, className, label, detail }: { price: number; y: number | null; className: string; label: string; detail?: string }) {
  if (y == null) return null;
  return <span className={className} style={{ top: y }}><b>{label}</b> {price.toFixed(2)} {detail && <i>{detail}</i>}</span>;
}

function lvnOverlap(leftLow: number, leftHigh: number, rightLow: number, rightHigh: number) {
  const overlap = Math.max(0, Math.min(leftHigh, rightHigh) - Math.max(leftLow, rightLow));
  const union = Math.max(leftHigh, rightHigh) - Math.min(leftLow, rightLow);
  return union > 0 ? overlap / union : 0;
}
