import { useEffect, useMemo, useRef, useState } from "react";
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

type Props = { active: boolean; settingsOpen: boolean; onCloseSettings: () => void; workspaceId: string; marketSymbol: MarketSymbol; timeframe: Timeframe; currentPrice: number; latestCandle: Candle | null };

export function AifIndicatorOverlay({ active, settingsOpen, onCloseSettings, workspaceId, marketSymbol, timeframe, currentPrice, latestCandle }: Props) {
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
  const domain = model?.profileHistogram;
  const max = useMemo(() => domain?.rows.reduce((value, row) => Math.max(value, row.normalized), 0) || 1, [domain]);
  if (!active && !settingsOpen) return null;
  return <>
    {active && <div className="aif-overlay" data-testid="aif-overlay">
      {!model && <div className="aif-progress"><b>{error ? "A.I.F. UNAVAILABLE" : stage}</b><span>{error || `${loaded.toLocaleString()} / ${settings.lookbackBars.toLocaleString()} BARS`}</span></div>}
      {model && <>
        <div className={`aif-profile aif-profile-${settings.profilePlacement}`} aria-label="A.I.F. primary profile">{model.profileHistogram.rows.map((row) => <div key={row.index} className={row.valueArea ? "value-area" : ""} style={{ bottom: `${row.index / model.profileHistogram.rows.length * 100}%`, height: `${100 / model.profileHistogram.rows.length + 0.08}%`, width: `${Math.max(0.5, row.normalized / max * 100)}%`, opacity: settings.opacity / 100 }} />)}</div>
        {model.secondaryProfile && <div className={`aif-profile aif-secondary aif-profile-${settings.profilePlacement === "right" ? "left" : "right"}`} aria-label="A.I.F. secondary profile">{model.secondaryProfile.rows.map((row) => <div key={row.index} style={{ bottom: `${row.index / model.secondaryProfile!.rows.length * 100}%`, height: `${100 / model.secondaryProfile!.rows.length + 0.08}%`, width: `${Math.max(0.4, row.normalized * 55)}%` }} />)}</div>}
        <div className="aif-levels">
          {settings.showPoc && model.profileHistogram.poc != null && <span className="poc" style={{ bottom: `${pricePercent(model, model.profileHistogram.poc)}%` }}><b>POC</b> {model.profileHistogram.poc.toFixed(2)}</span>}
          {settings.showValueArea && model.profileHistogram.vah != null && <span className="value-boundary" style={{ bottom: `${pricePercent(model, model.profileHistogram.vah)}%` }}><b>VAH</b> {model.profileHistogram.vah.toFixed(2)}</span>}
          {settings.showValueArea && model.profileHistogram.val != null && <span className="value-boundary" style={{ bottom: `${pricePercent(model, model.profileHistogram.val)}%` }}><b>VAL</b> {model.profileHistogram.val.toFixed(2)}</span>}
          {settings.showSupportResistance && model.supportResistanceZones.map((node) => <span key={node.id} className={node.center >= currentPrice ? "resistance" : "support"} style={{ bottom: `${pricePercent(model, node.center)}%` }}><b>{node.nodeType.toUpperCase()}</b> {node.center.toFixed(2)} <i>{node.confidence}%</i></span>)}
          {settings.showFutureLvns && model.projectedLvns.map((node) => <span key={node.id} className="future-lvn" style={{ bottom: `${pricePercent(model, node.center)}%` }}><b>FUTURE LVN</b> {node.center.toFixed(2)}</span>)}
        </div>
        {settings.showDataQuality && <div className="aif-quality">{model.provenance.quality.toUpperCase()} | REQUESTED {model.provenance.requestedLookbackBars.toLocaleString()} | USED {model.provenance.effectiveLookbackBars.toLocaleString()}{model.provenance.wasClamped ? ` | ${model.provenance.clampReason}` : ""}</div>}
        <AifProfileSummary model={model} />
        {settings.showTimeline && <AifEventTimeline events={model.timelineEvents} />}
      </>}
    </div>}
    {settingsOpen && <AifIndicatorSettings settings={settings} onChange={setSettings} onClose={onCloseSettings} />}
  </>;
}

function pricePercent(model: AifRenderModel, price: number) {
  const rows = model.profileHistogram.rows;
  const min = rows[0]?.low ?? price;
  const max = rows.at(-1)?.high ?? price + 1;
  return Math.max(0, Math.min(100, (price - min) / Math.max(1e-12, max - min) * 100));
}
