import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from "react";
import { ExternalLink, Maximize2, Minus, Settings, X } from "lucide-react";
import type { Candle } from "../../../chart-engine/types";
import { blackCoreConnectionManager } from "../../../connectivity/connectionManager";
import { readActiveExecutionVenueId } from "../../../connectivity/activeExecutionVenue";
import type { ConnectionDiagnostics } from "../../../connectivity/types";
import type { BlackCoreModuleMode } from "../../../core/modules/moduleRegistry";
import { submitOrder } from "../../../execution/executionEngine";
import type { MarginMode, OrderSide, OrderType, TimeInForce } from "../../../execution/types";
import { blackCoreMarketDataEngine } from "../../../market-data/engine/marketDataEngine";
import type { MarketSymbol } from "../../../market-data/types";
import type { PortfolioAccount } from "../../../portfolio/types";
import { defaultRiskControls } from "../../../risk/types";
import { DomAggregationEngine } from "../domAggregationEngine";
import { readDomSettings, updateModeSettings, writeDomSettings } from "../domSettingsStore";
import { useDomFeed } from "../useDomFeed";
import type {
  AggregatedDomSnapshot,
  DomCvdHorizon,
  DomHeatmapHorizon,
  DomMode,
  DomSettings,
  DomVisibleRange,
  MacroLiquidityBand,
  MacroLiquidityRange,
  VolumeProfileNode
} from "../types";

type DomProWindowProps = {
  marketSymbol: MarketSymbol;
  lastPrice: number;
  exchangeLabel: string;
  workspaceId: string;
  windowMode: BlackCoreModuleMode;
  settingsOpenSignal?: number;
  onClose: () => void;
};

type HeatmapViewportState = {
  zoom: number;
  offset: number;
};

type DomHoverInfo = {
  x: number;
  y: number;
  title: string;
  lines: string[];
};

type FlowPoint = {
  time: number;
  bidAdded: number;
  askAdded: number;
  bidRemoved: number;
  askRemoved: number;
  net: number;
};

const orderTypes: OrderType[] = ["limit", "market", "twap", "iceberg"];
const visibleRanges: Array<{ value: DomVisibleRange; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "0.25", label: "+/-0.25%" },
  { value: "0.5", label: "+/-0.5%" },
  { value: "1", label: "+/-1%" },
  { value: "2", label: "+/-2%" },
  { value: "5", label: "+/-5%" },
  { value: "custom", label: "Custom" }
];
const modes: DomMode[] = ["scalper", "intraday", "standard", "institutional", "macro", "custom"];
const heatmapHorizons: Array<{ value: DomHeatmapHorizon; label: string }> = [
  { value: "15m", label: "15M" },
  { value: "2h", label: "2H" },
  { value: "6h", label: "6H" },
  { value: "12h", label: "12H" },
  { value: "24h", label: "24H" },
  { value: "3d", label: "3D" },
  { value: "1w", label: "1W" }
];
const cvdHorizons: Array<{ value: DomCvdHorizon; label: string }> = [
  { value: "15m", label: "15M" },
  { value: "1h", label: "1H" },
  { value: "4h", label: "4H" },
  { value: "12h", label: "12H" },
  { value: "24h", label: "24H" }
];

export function DomProWindow({ marketSymbol, lastPrice, exchangeLabel, workspaceId, windowMode, settingsOpenSignal = 0, onClose }: DomProWindowProps) {
  const symbolKey = `${marketSymbol.exchange}:${marketSymbol.marketKind}:${marketSymbol.rawSymbol}`;
  const channelName = `bt-dom-pro:${workspaceId}:${symbolKey}`;
  const feed = useDomFeed(marketSymbol);
  const engineRef = useRef(new DomAggregationEngine());
  const frameRef = useRef<number | null>(null);
  const popoutRef = useRef<Window | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const submitQuickOrderRef = useRef<(targetSide: OrderSide, override?: Partial<{ quantity: string; price: string; orderType: OrderType; reduceOnly: boolean; postOnly: boolean }>) => Promise<void>>();
  const lastRenderAtRef = useRef(0);
  const droppedFramesRef = useRef(0);
  const renderCooldownUntilRef = useRef(0);
  const heatmapDragRef = useRef<{ startY: number; startOffset: number } | null>(null);
  const [settings, setSettings] = useState<DomSettings>(() => readDomSettings(workspaceId, symbolKey));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [heatmapViewport, setHeatmapViewport] = useState<HeatmapViewportState>({ zoom: 1, offset: 0 });
  const [domHover, setDomHover] = useState<DomHoverInfo | null>(null);
  const [flowSeries, setFlowSeries] = useState<FlowPoint[]>([]);
  const [snapshot, setSnapshot] = useState<AggregatedDomSnapshot>(() =>
    engineRef.current.aggregate({
      marketSymbol,
      book: feed.book,
      ticker: feed.ticker,
      trades: feed.trades,
      settings,
      subscriptionCount: feed.subscriptionCount
    })
  );
  const [connections, setConnections] = useState<ConnectionDiagnostics[]>(() => blackCoreConnectionManager.listDiagnostics());
  const activeConnections = useMemo(() => connections.filter((connection) => !["disconnected", "offline", "unsupported"].includes(connection.status)), [connections]);
  const selectedConnection = useMemo(() => {
    const activeVenueId = readActiveExecutionVenueId();
    return activeConnections.find((connection) => connection.id === activeVenueId) ?? activeConnections[0] ?? null;
  }, [activeConnections]);
  const [side, setSide] = useState<OrderSide>("buy");
  const [orderType, setOrderType] = useState<OrderType>("limit");
  const [quantity, setQuantity] = useState("0.001");
  const [price, setPrice] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [postOnly, setPostOnly] = useState(false);
  const [marginMode, setMarginMode] = useState<MarginMode>("cross");
  const [timeInForce, setTimeInForce] = useState<TimeInForce>("gtc");
  const [executionStatus, setExecutionStatus] = useState("");
  const [macroCandles, setMacroCandles] = useState<Candle[]>(() => blackCoreMarketDataEngine.cache.getCandles(marketSymbol, "1d"));
  const [macroStatus, setMacroStatus] = useState("HISTORICAL DEPTH");

  useEffect(() => blackCoreConnectionManager.subscribe(setConnections), []);

  useEffect(() => {
    const next = readDomSettings(workspaceId, symbolKey);
    setSettings(next);
    engineRef.current = new DomAggregationEngine();
    setHeatmapViewport({ zoom: 1, offset: 0 });
    setDomHover(null);
  }, [workspaceId, symbolKey]);

  useEffect(() => {
    writeDomSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (settingsOpenSignal > 0) setSettingsOpen(true);
  }, [settingsOpenSignal]);

  useEffect(() => {
    setHeatmapViewport({ zoom: 1, offset: 0 });
  }, [settings.mode, settings.visibleRange, settings.heatmapHorizon]);

  useEffect(() => {
    let cancelled = false;
    const cached = blackCoreMarketDataEngine.cache.getCandles(marketSymbol, "1d");
    if (cached.length) {
      setMacroCandles(cached);
      setMacroStatus(`HISTORICAL ${cached.length}D`);
    } else {
      setMacroCandles([]);
      setMacroStatus("LOADING HISTORICAL DEPTH");
    }

    const adapter = blackCoreMarketDataEngine.getAdapter(marketSymbol.exchange);
    adapter.getHistoricalCandles({
      exchange: marketSymbol.exchange,
      symbol: marketSymbol.rawSymbol,
      marketKind: marketSymbol.marketKind,
      timeframe: "1d",
      limit: Math.min(1000, Math.max(90, settings.macroLookbackDays))
    }).then((candles) => {
      if (cancelled) return;
      setMacroCandles(candles);
      setMacroStatus(candles.length ? `HISTORICAL ${candles.length}D` : "NO HISTORICAL DEPTH");
    }).catch(() => {
      if (cancelled) return;
      const fallback = blackCoreMarketDataEngine.cache.getCandles(marketSymbol, "1d");
      setMacroCandles(fallback);
      setMacroStatus(fallback.length ? `CACHE ${fallback.length}D` : "HISTORICAL DEPTH UNAVAILABLE");
    });

    return () => {
      cancelled = true;
    };
  }, [marketSymbol.exchange, marketSymbol.marketKind, marketSymbol.rawSymbol, settings.macroLookbackDays]);

  useEffect(() => {
    if (frameRef.current !== null) return;
    const now = performance.now();
    const minFrameMs = 1000 / Math.max(1, settings.fpsCap);
    const elapsed = now - lastRenderAtRef.current;
    if (now < renderCooldownUntilRef.current) {
      droppedFramesRef.current += 1;
      frameRef.current = window.setTimeout(() => {
        frameRef.current = null;
        renderSnapshot();
      }, Math.max(minFrameMs, renderCooldownUntilRef.current - now)) as unknown as number;
      return;
    }
    if (elapsed < minFrameMs) {
      droppedFramesRef.current += 1;
      frameRef.current = window.setTimeout(() => {
        frameRef.current = null;
        renderSnapshot();
      }, minFrameMs - elapsed) as unknown as number;
      return;
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      renderSnapshot();
    });
  }, [feed.updatedAt, settings]);

  useEffect(() => () => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      window.clearTimeout(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!price && snapshot.lastPrice) setPrice(String(Number(snapshot.lastPrice.toFixed(2))));
  }, [snapshot.lastPrice, price]);

  useEffect(() => {
    if (!snapshot.liquidityDelta.length) return;
    const bucketTime = Math.floor((snapshot.generatedAt / 1000) / settings.cvdSampleIntervalSec) * settings.cvdSampleIntervalSec;
    const nextPoint: FlowPoint = {
      time: bucketTime,
      bidAdded: snapshot.liquidityDelta.reduce((sum, delta) => sum + delta.bidAdded, 0),
      askAdded: snapshot.liquidityDelta.reduce((sum, delta) => sum + delta.askAdded, 0),
      bidRemoved: snapshot.liquidityDelta.reduce((sum, delta) => sum + delta.bidRemoved, 0),
      askRemoved: snapshot.liquidityDelta.reduce((sum, delta) => sum + delta.askRemoved, 0),
      net: snapshot.liquidityDelta.reduce((sum, delta) => sum + delta.bidAdded + delta.askRemoved - delta.askAdded - delta.bidRemoved, 0)
    };
    const cutoff = bucketTime - horizonSeconds(settings.cvdHorizon);
    setFlowSeries((current) => {
      const withoutCurrent = current.filter((point) => point.time !== bucketTime && point.time >= cutoff);
      return [...withoutCurrent, nextPoint].slice(-420);
    });
  }, [settings.cvdHorizon, settings.cvdSampleIntervalSec, snapshot.generatedAt, snapshot.liquidityDelta]);

  function renderSnapshot() {
    const started = performance.now();
    const next = engineRef.current.aggregate({
      marketSymbol,
      book: feed.book,
      ticker: feed.ticker,
      trades: feed.trades,
      settings,
      renderStats: {
        renderFps: lastRenderAtRef.current ? 1000 / Math.max(1, performance.now() - lastRenderAtRef.current) : 0,
        droppedFrames: droppedFramesRef.current,
        lastRenderMs: 0
      },
      subscriptionCount: feed.subscriptionCount
    });
    next.renderStats.lastRenderMs = performance.now() - started;
    if (next.renderStats.lastRenderMs > 18) {
      renderCooldownUntilRef.current = performance.now() + 1000 / Math.max(1, settings.fpsCap);
      droppedFramesRef.current += 1;
    }
    lastRenderAtRef.current = performance.now();
    setSnapshot(next);
  }

  function patchSettings(patch: Partial<DomSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
  }

  const submitQuickOrder = useCallback(async (targetSide: OrderSide, override: Partial<{ quantity: string; price: string; orderType: OrderType; reduceOnly: boolean; postOnly: boolean }> = {}) => {
    setExecutionStatus("");
    const nextQuantity = override.quantity ?? quantity;
    const nextPrice = override.price ?? price;
    const nextOrderType = override.orderType ?? orderType;
    const nextReduceOnly = override.reduceOnly ?? reduceOnly;
    const nextPostOnly = override.postOnly ?? postOnly;
    const parsedQuantity = Number(nextQuantity);
    const parsedPrice = Number(nextPrice || snapshot.lastPrice || lastPrice || 0);
    if (!selectedConnection) {
      setExecutionStatus("CONNECT ACCOUNT IN POSITIONS");
      return;
    }
    if (selectedConnection.category === "wallet") {
      setExecutionStatus("WALLET SIGNER NEEDS A PROTOCOL ROUTER");
      return;
    }
    if (!selectedConnection.accountId) {
      setExecutionStatus("CONNECTED VENUE HAS NO ACCOUNT ID");
      return;
    }
    if (selectedConnection.category === "protocol" && selectedConnection.metadata.executionReady !== true) {
      setExecutionStatus(String(selectedConnection.metadata.readinessReason || "PROTOCOL RELAY IS NOT READY").toUpperCase());
      return;
    }
    if (!parsedQuantity || parsedQuantity <= 0) {
      setExecutionStatus("ENTER VALID SIZE");
      return;
    }

    try {
      const update = await submitOrder({
        accountId: selectedConnection.accountId,
        exchange: selectedConnection.provider as MarketSymbol["exchange"],
        symbol: marketSymbol.rawSymbol.toUpperCase(),
        marketKind: marketSymbol.marketKind,
        side: targetSide,
        type: nextOrderType,
        quantity: parsedQuantity,
        sizingMethod: "quantity",
        limitPrice: nextOrderType === "limit" || nextOrderType === "iceberg" || nextOrderType === "twap" ? parsedPrice : undefined,
        referencePrice: parsedPrice,
        reduceOnly: nextReduceOnly,
        postOnly: nextPostOnly,
        marginMode,
        timeInForce,
        source: "order-ticket",
        destinations: ["personal-portfolio"]
      }, buildExecutionAccount(selectedConnection), parsedPrice || 1);
      setExecutionStatus(`${update.status.toUpperCase()}: ${update.reason || update.orderId}`);
    } catch (error) {
      setExecutionStatus(error instanceof Error ? error.message.toUpperCase() : String(error));
    }
  }, [lastPrice, marginMode, marketSymbol.marketKind, marketSymbol.rawSymbol, orderType, postOnly, price, quantity, reduceOnly, selectedConnection, snapshot.lastPrice, timeInForce]);

  useEffect(() => {
    submitQuickOrderRef.current = submitQuickOrder;
  }, [submitQuickOrder]);

  const cvdData = engineRef.current.cvdData();
  const macroBands = useMemo(
    () => settings.showMacroRadar ? buildMacroLiquidityBands(macroCandles, snapshot.lastPrice ?? lastPrice, settings) : [],
    [lastPrice, macroCandles, settings.macroBandCount, settings.macroLookbackDays, settings.showMacroRadar, snapshot.lastPrice]
  );
  const macroRange = useMemo(
    () => resolveMacroLiquidityRange(snapshot, macroCandles, macroBands, snapshot.lastPrice ?? lastPrice, settings),
    [lastPrice, macroBands, macroCandles, settings, snapshot]
  );
  const heatmapRange = useMemo(
    () => applyHeatmapViewport(macroRange, heatmapViewport),
    [heatmapViewport, macroRange]
  );
  const institutionalProfile = useMemo(
    () => buildInstitutionalProfile(snapshot.volumeProfile, macroCandles, heatmapRange),
    [heatmapRange, macroCandles, snapshot.volumeProfile]
  );
  const maxProfileVolume = Math.max(...institutionalProfile.map((node) => node.volume), 1);
  const heatmapFrames = useMemo(() => snapshot.heatmap.slice(-resolveHorizonFrameCount(settings)), [settings, snapshot.heatmap]);
  const smoothedCvdData = useMemo(() => buildSmoothedCvd(cvdData, settings), [cvdData, settings]);
  const cvdStats = useMemo(() => buildCvdStats(snapshot.trades, smoothedCvdData, settings), [settings, smoothedCvdData, snapshot.trades]);
  const cvdPath = useMemo(() => buildCvdPath(smoothedCvdData), [smoothedCvdData]);
  const depthChart = useMemo(() => buildDepthChart(snapshot), [snapshot]);
  const flowBars = useMemo(() => buildFlowBars(flowSeries, settings), [flowSeries, settings]);

  const resetHeatmapView = useCallback(() => {
    setHeatmapViewport({ zoom: 1, offset: 0 });
    setDomHover(null);
  }, []);

  const handleHeatmapWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    setHeatmapViewport((current) => {
      if (event.shiftKey) {
        return clampViewport({ ...current, offset: current.offset + event.deltaY * 0.0012 / current.zoom });
      }
      const factor = event.deltaY > 0 ? 0.9 : 1.12;
      return clampViewport({ zoom: Math.max(1, Math.min(8, current.zoom * factor)), offset: current.offset });
    });
  }, []);

  const handleHeatmapMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    heatmapDragRef.current = { startY: event.clientY, startOffset: heatmapViewport.offset };
  }, [heatmapViewport.offset]);

  const handleHeatmapMouseMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (heatmapDragRef.current) {
      const delta = (event.clientY - heatmapDragRef.current.startY) / Math.max(1, rect.height);
      setHeatmapViewport((current) => clampViewport({ ...current, offset: heatmapDragRef.current!.startOffset + delta / current.zoom }));
      return;
    }
    setDomHover(buildHeatmapHover(event, rect, heatmapRange, heatmapFrames, macroBands, snapshot.walls));
  }, [heatmapFrames, heatmapRange, macroBands, snapshot.walls]);

  const handleProfileMouseMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setDomHover(buildProfileHover(event, rect, heatmapRange, institutionalProfile));
  }, [heatmapRange, institutionalProfile]);

  useEffect(() => {
    const clearDrag = () => {
      heatmapDragRef.current = null;
    };
    window.addEventListener("mouseup", clearDrag);
    return () => window.removeEventListener("mouseup", clearDrag);
  }, []);

  useEffect(() => {
    if (windowMode !== "detached-browser") return;
    if (typeof BroadcastChannel !== "undefined" && !channelRef.current) {
      const channel = new BroadcastChannel(channelName);
      channel.onmessage = (event) => {
        if (event.data?.type !== "quick-order") return;
        const payload = event.data.payload ?? {};
        void submitQuickOrderRef.current?.(payload.side === "sell" ? "sell" : "buy", {
          quantity: payload.quantity,
          price: payload.price,
          orderType: payload.orderType,
          reduceOnly: Boolean(payload.reduceOnly),
          postOnly: Boolean(payload.postOnly)
        });
      };
      channelRef.current = channel;
    }

    if (!popoutRef.current || popoutRef.current.closed) {
      const popout = window.open("", "black-terminal-dom-pro", "popup=yes,width=1480,height=920,left=80,top=60");
      if (popout) {
        popout.document.open();
        popout.document.write(buildDomProPopoutDocument(channelName));
        popout.document.close();
        popoutRef.current = popout;
      }
    }

    return () => {
      channelRef.current?.close();
      channelRef.current = null;
      if (popoutRef.current && !popoutRef.current.closed) popoutRef.current.close();
      popoutRef.current = null;
    };
  }, [channelName, windowMode]);

  useEffect(() => {
    if (windowMode !== "detached-browser") return;
    channelRef.current?.postMessage({
      type: "snapshot",
      snapshot,
      settings,
      cvdData,
      macroBands,
      macroRange: heatmapRange,
      executionStatus,
      marketSymbol,
      lastPrice,
      exchangeLabel
    });
  }, [cvdData, exchangeLabel, executionStatus, heatmapRange, lastPrice, macroBands, marketSymbol, settings, snapshot, windowMode]);

  const priceRows = snapshot.buckets;
  const maxTotal = Math.max(...priceRows.map((row) => row.totalSize), 1);

  if (windowMode === "detached-browser") {
    return (
      <div className="dom-pro-shell dom-pro-detached-controller" role="dialog" aria-label="DOM Pro plus detached browser controller">
        <div className="dom-pro-detached-card">
          <b>DOM PRO+ DETACHED</b>
          <span>{popoutRef.current && !popoutRef.current.closed ? "Streaming through parent Black Core feed." : "Popout blocked or closed. Use Open DOM Pro+ to return in-workspace."}</span>
          <button type="button" onClick={onClose}>Close Detached DOM</button>
        </div>
      </div>
    );
  }

  return (
    <div className="dom-pro-shell" role="dialog" aria-label="DOM Pro plus institutional order flow terminal">
      <div className={`dom-pro-window ${settingsOpen ? "settings-open" : ""}`}>
        <header className="dom-pro-header">
          <div>
            <b>DOM PRO+</b>
            <span>Institutional Depth & Order Flow Terminal</span>
          </div>
          <div className="dom-pro-window-controls">
            <button type="button" title="Detach DOM"><ExternalLink size={15} /></button>
            <button type="button" title="Minimize"><Minus size={15} /></button>
            <button type="button" title="Maximize"><Maximize2 size={15} /></button>
            <button type="button" title="Close DOM Pro+" onClick={onClose}><X size={16} /></button>
          </div>
        </header>

        <section className="dom-pro-stats">
          <Stat label="Symbol" value={`${marketSymbol.rawSymbol} ${marketSymbol.marketKind.toUpperCase()}`} />
          <Stat label="Last Price" value={formatPrice(snapshot.lastPrice ?? lastPrice)} />
          <Stat label="24H Change" value={signed(snapshot.ticker?.priceChangePercent, "%")} />
          <Stat label="24H High" value={formatPrice(snapshot.ticker?.highPrice)} />
          <Stat label="24H Low" value={formatPrice(snapshot.ticker?.lowPrice)} />
          <Stat label="24H Volume" value={formatCompact(snapshot.ticker?.quoteVolume ?? snapshot.ticker?.volume)} />
          <label>
            <span>DOM Mode</span>
            <select value={settings.mode} onChange={(event) => setSettings(updateModeSettings(settings, event.target.value as DomMode))}>
              {modes.map((mode) => <option key={mode} value={mode}>{labelDomMode(mode)}</option>)}
            </select>
          </label>
          <label>
            <span>Bucket</span>
            <select value={String(settings.bucketMultiplier)} onChange={(event) => patchSettings({ bucketMultiplier: event.target.value === "custom" ? "custom" : Number(event.target.value) as DomSettings["bucketMultiplier"] })}>
              {[1, 5, 10, 25, 50, 100, 250, 500, 1000].map((item) => <option key={item} value={item}>{item}x</option>)}
              <option value="custom">Custom</option>
            </select>
          </label>
          <label>
            <span>Visible Range</span>
            <select value={settings.visibleRange} onChange={(event) => patchSettings({ visibleRange: event.target.value as DomVisibleRange })}>
              {visibleRanges.map((range) => <option key={range.value} value={range.value}>{range.label}</option>)}
            </select>
          </label>
          <label>
            <span>Heatmap</span>
            <select value={settings.heatmapHorizon} onChange={(event) => patchSettings({ heatmapHorizon: event.target.value as DomHeatmapHorizon })}>
              {heatmapHorizons.map((horizon) => <option key={horizon.value} value={horizon.value}>{horizon.label}</option>)}
            </select>
          </label>
          <Stat label="FPS Cap" value={`${settings.fpsCap} FPS`} />
          <button type="button" className="dom-pro-settings-btn" onClick={() => setSettingsOpen((value) => !value)}><Settings size={15} /> Settings</button>
        </section>

        {settingsOpen && (
          <section className="dom-pro-settings-panel">
            <Toggle label="Volume Profile" checked={settings.showVolumeProfile} onChange={(value) => patchSettings({ showVolumeProfile: value })} />
            <Toggle label="Heatmap" checked={settings.showHeatmap} onChange={(value) => patchSettings({ showHeatmap: value })} />
            <Toggle label="Wall Detection" checked={settings.showWallDetection} onChange={(value) => patchSettings({ showWallDetection: value })} />
            <Toggle label="CVD" checked={settings.showCvd} onChange={(value) => patchSettings({ showCvd: value })} />
            <Toggle label="Execution" checked={settings.showExecutionPanel} onChange={(value) => patchSettings({ showExecutionPanel: value })} />
            <Toggle label="Diagnostics" checked={settings.showDiagnostics} onChange={(value) => patchSettings({ showDiagnostics: value })} />
            <Toggle label="Macro Radar" checked={settings.showMacroRadar} onChange={(value) => patchSettings({ showMacroRadar: value })} />
            <Field label="FPS" value={settings.fpsCap} min={5} max={30} onChange={(value) => patchSettings({ fpsCap: value })} />
            <Field label="Max Buckets" value={settings.maxVisibleBuckets} min={20} max={180} onChange={(value) => patchSettings({ maxVisibleBuckets: value })} />
            <Field label="Heatmap Frames" value={settings.maxHeatmapHistory} min={60} max={720} onChange={(value) => patchSettings({ maxHeatmapHistory: value })} />
            <Field label="Liquidity Threshold" value={settings.liquidityThreshold} min={1} max={8} step={0.1} onChange={(value) => patchSettings({ liquidityThreshold: value })} />
            <Field label="Macro Lookback" value={settings.macroLookbackDays} min={90} max={1000} onChange={(value) => patchSettings({ macroLookbackDays: value })} />
            <Field label="Macro Bands" value={settings.macroBandCount} min={4} max={18} onChange={(value) => patchSettings({ macroBandCount: value })} />
            <Field label="Smoothing" value={settings.persistenceSmoothing} min={40} max={97} onChange={(value) => patchSettings({ persistenceSmoothing: value })} />
            <Field label="CVD Sample" value={settings.cvdSampleIntervalSec} min={5} max={60} onChange={(value) => patchSettings({ cvdSampleIntervalSec: value })} />
            <Field label="CVD Smooth" value={settings.cvdSmoothingLength} min={8} max={80} onChange={(value) => patchSettings({ cvdSmoothingLength: value })} />
            {settings.bucketMultiplier === "custom" && <Field label="Custom Bucket" value={settings.customBucketSize} min={0.01} max={10000} step={0.01} onChange={(value) => patchSettings({ customBucketSize: value })} />}
          </section>
        )}

        <main className="dom-pro-grid">
          <section className="dom-pro-panel dom-pro-ladder">
            <PanelTitle title="Aggregated DOM Ladder" status={snapshot.statusMessage} />
            {snapshot.status === "awaiting-book" ? <EmptyState text="Awaiting live orderbook stream." /> : (
              <>
                <div className="dom-pro-ladder-head"><span>Price ({marketSymbol.quoteAsset})</span><span>Bid Size ({marketSymbol.baseAsset})</span><span>Ask Size ({marketSymbol.baseAsset})</span></div>
                <div className="dom-pro-ladder-rows">
                  {priceRows.map((row) => (
                    <div className={`dom-pro-ladder-row ${row.isCurrentPrice ? "current" : ""}`} key={row.price}>
                      <span>{formatPrice(row.price)}</span>
                      <span>{formatSize(row.bidSize)}</span>
                      <span className="red">{formatSize(row.askSize)}</span>
                      <i className="bid-depth" style={{ transform: `scaleX(${row.bidSize / maxTotal})` }} />
                      <i className="ask-depth" style={{ transform: `scaleX(${row.askSize / maxTotal})` }} />
                    </div>
                  ))}
                </div>
                <div className="dom-pro-mid">
                  <b>{formatPrice(snapshot.lastPrice)}</b>
                  <span>Spread {formatPrice(snapshot.spread ?? 0)}</span>
                  <em>Mid {formatPrice(snapshot.midPrice)}</em>
                </div>
              </>
            )}
          </section>

          <section className="dom-pro-panel dom-pro-profile">
            <PanelTitle title="Volume Profile" status="VISIBLE RANGE" />
            {!settings.showVolumeProfile ? <EmptyState text="Volume profile hidden in DOM settings." /> : institutionalProfile.length === 0 ? <EmptyState text="Awaiting live orderbook or historical candles." /> : (
              <div className="dom-pro-profile-scale" onMouseMove={handleProfileMouseMove} onMouseLeave={() => setDomHover(null)} onDoubleClick={resetHeatmapView}>
                {institutionalProfile.map((node) => (
                  <div className={`dom-pro-profile-node ${node.kind}`} key={`${node.price}-${node.kind}`} style={{ top: priceToTop(node.price, heatmapRange) }}>
                    <i style={{ width: `${Math.max(3, node.volume / maxProfileVolume * 100)}%` }} />
                    <span>{formatPrice(node.price)}</span>
                    <b>{node.kind.toUpperCase()}</b>
                  </div>
                ))}
                <div className="dom-pro-profile-legend"><span>POC</span><span>VALUE AREA</span><span>HVN</span><span>LVN</span></div>
              </div>
            )}
          </section>

          <section className="dom-pro-panel dom-pro-heatmap">
            <PanelTitle title="Liquidity Heatmap" status={`${settings.heatmapHorizon.toUpperCase()} HISTORICAL DEPTH`} />
            <div className="dom-pro-horizon-controls">
              <button type="button" className="reset" onClick={resetHeatmapView}>RESET VIEW</button>
              {heatmapHorizons.map((horizon) => (
                <button
                  key={horizon.value}
                  type="button"
                  className={settings.heatmapHorizon === horizon.value ? "active" : ""}
                  onClick={() => patchSettings({ heatmapHorizon: horizon.value })}
                >
                  {horizon.label}
                </button>
              ))}
            </div>
            {!settings.showHeatmap ? <EmptyState text="Liquidity heatmap hidden in DOM settings." /> : heatmapFrames.length === 0 && macroBands.length === 0 ? <EmptyState text="Liquidity heatmap requires depth history or historical candles." /> : (
              <div
                className="dom-pro-heatmap-canvas"
                onWheel={handleHeatmapWheel}
                onMouseDown={handleHeatmapMouseDown}
                onMouseMove={handleHeatmapMouseMove}
                onMouseLeave={() => setDomHover(null)}
                onDoubleClick={resetHeatmapView}
              >
                <div className="dom-pro-heatmap-scale">
                  {buildPriceScale(heatmapRange).map((price) => <span key={price} style={{ top: priceToTop(price, heatmapRange) }}>{formatPrice(price)}</span>)}
                </div>
                {macroBands.filter((band) => band.high >= heatmapRange.min && band.low <= heatmapRange.max).map((band) => (
                  <div
                    key={band.id}
                    className={`dom-pro-macro-band ${band.side}`}
                    style={{
                      top: priceToTop(band.price, heatmapRange),
                      height: `${Math.max(5, Math.min(24, (band.strength * 18) + 5))}px`,
                      opacity: Math.max(0.28, band.strength)
                    }}
                  >
                    <span>{band.label}</span>
                    <b>{formatPrice(band.price)}</b>
                    <em>{band.touches} touches / {Math.round(band.strength * 100)}%</em>
                  </div>
                ))}
                {heatmapFrames.map((frame, frameIndex) => frame.cells.filter((cell) => cell.price >= heatmapRange.min && cell.price <= heatmapRange.max).slice(0, 130).map((cell, cellIndex) => (
                  <i
                    key={`${frame.time}-${cell.price}-${cellIndex}`}
                    className={`dom-pro-heatmap-cell ${cell.side}`}
                    style={{
                      left: `${(frameIndex / Math.max(1, heatmapFrames.length - 1)) * 92}%`,
                      top: priceToTop(cell.price, heatmapRange),
                      opacity: Math.max(0.08, cell.intensity),
                      width: `${Math.max(1.4, 92 / Math.max(18, heatmapFrames.length))}%`,
                      height: `${Math.max(2, Math.min(10, cell.intensity * 9))}px`
                    }}
                  />
                )))}
                <b className="dom-pro-current-price" style={{ top: priceToTop(snapshot.lastPrice ?? lastPrice, heatmapRange) }} />
                {domHover && <HoverTooltip hover={domHover} />}
                <div className="dom-pro-heatmap-footer"><span>{macroStatus}</span><span>{heatmapRange.source.replace("-", " ").toUpperCase()} / {heatmapViewport.zoom.toFixed(1)}x</span></div>
              </div>
            )}
          </section>

          <section className="dom-pro-panel dom-pro-walls">
            <PanelTitle title="Wall Detection" status="PERSISTENCE" />
            {!settings.showWallDetection ? <EmptyState text="Wall detection hidden in DOM settings." /> : snapshot.walls.length === 0 ? <EmptyState text="No persistent liquidity wall detected." /> : (
              <>
                <div className="dom-pro-wall-head"><span>Type</span><span>Price</span><span>Size</span><span>Age</span></div>
                {snapshot.walls.map((wall) => (
                  <div className={`dom-pro-wall ${wall.side}`} key={wall.id}>
                    <b>{wall.side === "sell" ? "SELL WALL" : "BUY WALL"}</b>
                    <span>{formatPrice(wall.price)}</span>
                    <em>{formatSize(wall.size)} {marketSymbol.baseAsset}</em>
                    <small>{formatDuration(wall.persistenceMs)} / {wall.persistencePct.toFixed(0)}% / {wall.distancePct.toFixed(2)}%</small>
                  </div>
                ))}
                {snapshot.liquidityMigration.length > 0 && (
                  <div className="dom-pro-migration">
                    <b>Liquidity Migration</b>
                    {snapshot.liquidityMigration.map((migration) => (
                      <span key={migration.id}>
                        {migration.side === "sell" ? "Sell" : "Buy"} wall moved {migration.direction} {formatPrice(migration.distance)} {marketSymbol.quoteAsset} over {formatDuration(migration.elapsedMs)}.
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>

          <section className="dom-pro-panel dom-pro-tape">
            <PanelTitle title="Trade Tape" status={feed.tradeStatus} />
            {snapshot.trades.length === 0 ? <EmptyState text="Trade stream unavailable for this venue." /> : (
              <>
                <div className="dom-pro-tape-head"><span>Time</span><span>Price</span><span>Size</span><span>Side</span></div>
                {snapshot.trades.slice(0, 22).map((trade) => (
                  <div className={`dom-pro-tape-row ${trade.side}`} key={trade.tradeId}>
                    <span>{formatTime(trade.time)}</span>
                    <span>{formatPrice(trade.price)}</span>
                    <span>{formatSize(trade.quantity)}</span>
                    <span>{trade.side === "buy" ? "B" : trade.side === "sell" ? "S" : "-"}</span>
                  </div>
                ))}
              </>
            )}
          </section>

          <section className="dom-pro-panel dom-pro-metrics">
            <PanelTitle title="DOM Metrics" status={exchangeLabel.toUpperCase()} />
            <Metric label="Orderbook Imbalance" value={`${snapshot.metrics.orderBookImbalance.toFixed(2)}%`} note={snapshot.metrics.orderBookImbalance >= 0 ? "BID HEAVY" : "ASK HEAVY"} />
            <Metric label="Depth Imbalance" value={`${snapshot.metrics.depthImbalance.toFixed(1)}%`} note="VISIBLE" />
            <Metric label="Liquidity Score" value={`${snapshot.metrics.liquidityScore.toFixed(0)} / 100`} note="STRUCTURE" />
            <Metric label="Absorption" value={snapshot.absorption.detected ? "DETECTED" : "NONE"} note={snapshot.absorption.label} hot={snapshot.absorption.detected} />
            <Metric label="Pulling / Stacking" value={snapshot.metrics.bidStacked + snapshot.metrics.askStacked >= snapshot.metrics.bidPulled + snapshot.metrics.askPulled ? "STACKING" : "PULLING"} note="NET LIQUIDITY" hot />
            <Metric label="Large Trades (1m)" value={String(snapshot.metrics.largeTradesLastMinute)} note="LAST 60S" />
            <Metric label="Est. Icebergs" value={`${snapshot.iceberg.estimatedCount}`} note={`${snapshot.iceberg.probability.toUpperCase()} PROBABILITY`} hot={snapshot.iceberg.probability !== "low"} />
            <Metric label="Latency" value={`${snapshot.metrics.latencyMs.toFixed(0)} ms`} note={feed.bookStatus} />
          </section>

          <section className="dom-pro-panel dom-pro-depth-chart">
            <PanelTitle title="Depth Chart" status="AGGREGATED" />
            {depthChart.empty ? <EmptyState text="Depth chart requires bid and ask depth." /> : (
              <svg className="dom-pro-depth-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Cumulative market depth">
                <line className="axis" x1="50" y1="8" x2="50" y2="94" />
                <line className="axis zero" x1="3" y1="94" x2="97" y2="94" />
                <polygon className="bid-fill" points={depthChart.bidArea} />
                <polygon className="ask-fill" points={depthChart.askArea} />
                <polyline className="bid-line" points={depthChart.bidLine} />
                <polyline className="ask-line" points={depthChart.askLine} />
              </svg>
            )}
          </section>

          <section className="dom-pro-panel dom-pro-flow">
            <PanelTitle title="Liquidity Flow Delta" status="PULL / STACK" />
            {flowBars.length === 0 ? <EmptyState text="Awaiting rolling liquidity delta." /> : (
              <div className="dom-pro-flow-histogram">
                <b />
                {flowBars.map((bar, index) => (
                  <i
                    key={`${bar.time}-${index}`}
                    className={bar.net >= 0 ? "positive" : "negative"}
                    style={{
                      left: `${bar.left}%`,
                      width: `${bar.width}%`,
                      height: `${bar.height}%`,
                      bottom: bar.net >= 0 ? "50%" : `${50 - bar.height}%`
                    }}
                  />
                ))}
              </div>
            )}
          </section>

          {settings.showCvd && (
            <section className="dom-pro-panel dom-pro-cvd">
              <PanelTitle title="Heuristic CVD" status={`${settings.cvdHorizon.toUpperCase()} / ${cvdStats.trend.toUpperCase()}`} />
              <div className="dom-pro-cvd-controls">
                {cvdHorizons.map((horizon) => (
                  <button key={horizon.value} type="button" className={settings.cvdHorizon === horizon.value ? "active" : ""} onClick={() => patchSettings({ cvdHorizon: horizon.value })}>{horizon.label}</button>
                ))}
              </div>
              <div className="dom-pro-cvd-card">
                {smoothedCvdData.length === 0 ? <EmptyState text="Trade stream unavailable for this venue." /> : (
                  <>
                    <div className="dom-pro-cvd-stats">
                      <span>Current <b>{formatSize(cvdStats.current)}</b></span>
                      <span>Session <b>{formatSize(cvdStats.sessionDelta)}</b></span>
                      <span>Buy <b>{cvdStats.buyPct.toFixed(0)}%</b></span>
                      <span>Sell <b>{cvdStats.sellPct.toFixed(0)}%</b></span>
                      <span>Divergence <b>WATCH</b></span>
                    </div>
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Heuristic cumulative volume delta">
                      <polyline points={cvdPath} />
                    </svg>
                  </>
                )}
              </div>
            </section>
          )}

          {settings.showDiagnostics && (
            <section className="dom-pro-panel dom-pro-performance">
              <PanelTitle title="Performance" status={snapshot.renderStats.lastRenderMs > 12 ? "LOAD HIGH" : "OK"} />
              <Metric label="DOM Updates / Sec" value={snapshot.renderStats.updateRate.toFixed(1)} />
              <Metric label="DOM Render FPS" value={snapshot.renderStats.renderFps.toFixed(1)} />
              <Metric label="Visible Buckets" value={String(snapshot.renderStats.visibleBuckets)} />
              <Metric label="Bucket Size" value={`${formatPrice(snapshot.renderStats.bucketSize)} ${marketSymbol.quoteAsset}`} />
              <Metric label="Dropped Frames" value={String(snapshot.renderStats.droppedFrames)} />
              <Metric label="Last Render" value={`${snapshot.renderStats.lastRenderMs.toFixed(2)} ms`} />
              <Metric label="Memory Estimate" value={`${snapshot.renderStats.memoryEstimateKb} KB`} />
              <Metric label="Subscriptions" value={String(snapshot.renderStats.subscriptionCount)} />
              {snapshot.renderStats.lastRenderMs > 12 && <div className="dom-pro-warning">DOM Pro+ render load high. Increase bucket size or reduce FPS.</div>}
            </section>
          )}

          {settings.showExecutionPanel && (
            <section className="dom-pro-panel dom-pro-execution">
              <PanelTitle title="Execution" status={selectedConnection ? selectedConnection.label.toUpperCase() : "NO ACCOUNT"} />
              <div className="dom-pro-order-types">
                {orderTypes.map((type) => <button key={type} type="button" className={orderType === type ? "active" : ""} onClick={() => setOrderType(type)}>{type.toUpperCase()}</button>)}
              </div>
              <div className="dom-pro-side-buttons">
                <button type="button" className={side === "buy" ? "active" : ""} onClick={() => setSide("buy")}>BUY</button>
                <button type="button" className={side === "sell" ? "active sell" : "sell"} onClick={() => setSide("sell")}>SELL</button>
              </div>
              <label><span>Qty ({marketSymbol.baseAsset})</span><input value={quantity} onChange={(event) => setQuantity(event.target.value)} inputMode="decimal" /></label>
              <label><span>Price ({marketSymbol.quoteAsset})</span><input value={price} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" /></label>
              <label><span>Margin</span><select value={marginMode} onChange={(event) => setMarginMode(event.target.value as MarginMode)}><option value="cross">Cross</option><option value="isolated">Isolated</option></select></label>
              <label><span>TIF</span><select value={timeInForce} onChange={(event) => setTimeInForce(event.target.value as TimeInForce)}><option value="gtc">GTC</option><option value="ioc">IOC</option><option value="fok">FOK</option></select></label>
              <div className="dom-pro-checks">
                <label><input type="checkbox" checked={postOnly} onChange={(event) => setPostOnly(event.target.checked)} /> Post Only</label>
                <label><input type="checkbox" checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} /> Reduce Only</label>
              </div>
              <div className="dom-pro-submit-row">
                <button type="button" onClick={() => submitQuickOrder("buy")}>Place Buy</button>
                <button type="button" className="sell" onClick={() => submitQuickOrder("sell")}>Place Sell</button>
              </div>
              <p>{executionStatus || "Orders route through OMS / EMS / Risk."}</p>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

function PanelTitle({ title, status }: { title: string; status?: string }) {
  return <div className="dom-pro-panel-title"><span>{title}</span>{status && <b>{status}</b>}</div>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="dom-pro-stat"><span>{label}</span><b>{value}</b></div>;
}

function Metric({ label, value, note, hot }: { label: string; value: string; note?: string; hot?: boolean }) {
  return <div className="dom-pro-metric"><span>{label}</span><b className={hot ? "hot" : ""}>{value}</b>{note && <em>{note}</em>}</div>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="dom-pro-toggle"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /> {label}</label>;
}

function Field({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
  return <label className="dom-pro-field"><span>{label}</span><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="dom-pro-empty">{text}</div>;
}

function HoverTooltip({ hover }: { hover: DomHoverInfo }) {
  return (
    <div className="dom-pro-hover-tooltip" style={{ left: hover.x, top: hover.y }}>
      <b>{hover.title}</b>
      {hover.lines.map((line) => <span key={line}>{line}</span>)}
    </div>
  );
}

function labelDomMode(mode: DomMode) {
  if (mode === "intraday") return "INTRADAY";
  if (mode === "institutional") return "INSTITUTIONAL";
  if (mode === "macro") return "MACRO";
  if (mode === "scalper") return "SCALPER";
  return mode.toUpperCase();
}

function buildMacroLiquidityBands(candles: Candle[], currentPrice: number | null | undefined, settings: DomSettings): MacroLiquidityBand[] {
  const source = candles.filter((candle) => Number.isFinite(candle.high) && Number.isFinite(candle.low) && candle.high > candle.low).slice(-settings.macroLookbackDays);
  if (source.length < 20) return [];

  const min = Math.min(...source.map((candle) => candle.low));
  const max = Math.max(...source.map((candle) => candle.high));
  const span = Math.max(max - min, currentPrice ? currentPrice * 0.02 : 1);
  const binCount = 120;
  const step = span / binCount;
  const bins = Array.from({ length: binCount + 1 }, (_, index) => ({
    price: min + index * step,
    volume: 0,
    touches: 0,
    lastTouch: 0
  }));

  for (const candle of source) {
    const typical = (candle.high + candle.low + candle.close) / 3;
    const width = Math.max(candle.high - candle.low, step);
    const candleVolume = Math.max(1, candle.volume || 1);
    for (const bin of bins) {
      if (bin.price < candle.low - step || bin.price > candle.high + step) continue;
      const proximity = 1 / (1 + Math.abs(bin.price - typical) / width);
      bin.volume += candleVolume * proximity;
      bin.touches += bin.price >= candle.low && bin.price <= candle.high ? 1 : 0;
      if (bin.price >= candle.low && bin.price <= candle.high) bin.lastTouch = Math.max(bin.lastTouch, candle.time);
    }
  }

  const maxVolume = Math.max(...bins.map((bin) => bin.volume), 1);
  const ranked = bins
    .map((bin, index) => ({
      ...bin,
      index,
      strength: Math.min(1, (bin.volume / maxVolume) * 0.78 + Math.min(0.22, bin.touches / Math.max(1, source.length) * 1.8))
    }))
    .filter((bin, index, all) => {
      const left = all[index - 1]?.volume ?? 0;
      const right = all[index + 1]?.volume ?? 0;
      return bin.volume >= left && bin.volume >= right && bin.strength >= 0.18;
    })
    .sort((a, b) => b.strength - a.strength);

  const selected: typeof ranked = [];
  const minGap = step * 4;
  const price = Number(currentPrice ?? source[source.length - 1]?.close ?? 0);
  const proximityRank = (candidate: typeof ranked[number]) => {
    const distancePct = price > 0 ? Math.abs(candidate.price - price) / price * 100 : 0;
    return candidate.strength * 0.78 + Math.max(0, 1 - distancePct / 8) * 0.22;
  };
  const pushCandidate = (candidate: typeof ranked[number]) => {
    if (selected.some((node) => Math.abs(node.price - candidate.price) < minGap)) return false;
    selected.push(candidate);
    return true;
  };
  const below = ranked.filter((candidate) => price <= 0 || candidate.price < price).sort((a, b) => proximityRank(b) - proximityRank(a));
  const above = ranked.filter((candidate) => price <= 0 || candidate.price > price).sort((a, b) => proximityRank(b) - proximityRank(a));
  const perSideTarget = Math.max(2, Math.floor(settings.macroBandCount / 2));
  for (const candidate of below) {
    pushCandidate(candidate);
    if (selected.filter((node) => node.price < price).length >= perSideTarget) break;
  }
  for (const candidate of above) {
    pushCandidate(candidate);
    if (selected.filter((node) => node.price > price).length >= perSideTarget) break;
  }
  for (const candidate of ranked) {
    pushCandidate(candidate);
    if (selected.length >= Math.max(4, settings.macroBandCount)) break;
  }

  return selected.map((bin, index) => {
    const isPoc = index === 0;
    const side: MacroLiquidityBand["side"] = isPoc ? "poc" : bin.price > price ? "supply" : "demand";
    return {
      id: `macro:${side}:${Math.round(bin.price / Math.max(step, 0.0001))}`,
      price: bin.price,
      low: bin.price - step * 0.65,
      high: bin.price + step * 0.65,
      strength: bin.strength,
      side,
      label: isPoc ? "POC" : side === "supply" ? "SELL WALL" : "BUY WALL",
      touches: bin.touches,
      ageDays: bin.lastTouch ? Math.max(0, (Date.now() / 1000 - bin.lastTouch) / 86400) : 0,
      source: "historical-ohlcv" as const
    };
  }).sort((a, b) => b.price - a.price);
}

function resolveMacroLiquidityRange(snapshot: AggregatedDomSnapshot, candles: Candle[], bands: MacroLiquidityBand[], currentPrice: number | null | undefined, settings: DomSettings): MacroLiquidityRange {
  const priceCandidates = [
    currentPrice,
    snapshot.lastPrice,
    snapshot.midPrice,
    snapshot.bestBid,
    snapshot.bestAsk,
    snapshot.buckets[0]?.price,
    candles[candles.length - 1]?.close
  ].filter((value) => Number.isFinite(value ?? NaN) && Number(value) > 0);
  const price = Number(priceCandidates[0] ?? 1);
  const rangePct = resolveVisibleRangePct(settings);
  const min = price * (1 - rangePct / 100);
  const max = price * (1 + rangePct / 100);
  const minimumSpan = Math.max(price * 0.0025, snapshot.renderStats.bucketSize * 18, 1);
  const currentSpan = max - min;
  const paddedMin = currentSpan < minimumSpan ? price - minimumSpan / 2 : min;
  const paddedMax = currentSpan < minimumSpan ? price + minimumSpan / 2 : max;
  return {
    min: Math.max(0.00000001, paddedMin),
    max: Math.max(paddedMin + 0.00000001, paddedMax),
    source: candles.length || bands.length ? "historical-ohlcv" : snapshot.buckets.length ? "live-depth" : "fallback"
  };
}

function buildInstitutionalProfile(liveProfile: VolumeProfileNode[], candles: Candle[], range: MacroLiquidityRange): VolumeProfileNode[] {
  const source = candles.filter((candle) => candle.high >= range.min && candle.low <= range.max).slice(-365);
  if (source.length < 20) return liveProfile;
  const binCount = 96;
  const step = Math.max((range.max - range.min) / binCount, 0.0001);
  const bins = Array.from({ length: binCount + 1 }, (_, index) => ({ price: range.min + index * step, volume: 0 }));

  for (const candle of source) {
    const width = Math.max(candle.high - candle.low, step);
    const volume = Math.max(1, candle.volume || 1);
    for (const bin of bins) {
      if (bin.price < candle.low || bin.price > candle.high) continue;
      bin.volume += volume / Math.max(1, width / step);
    }
  }

  const volumes = bins.map((bin) => bin.volume);
  const max = Math.max(...volumes, 1);
  const avg = volumes.reduce((sum, value) => sum + value, 0) / Math.max(1, volumes.length);
  return bins
    .filter((bin) => bin.volume > 0)
    .map((bin) => ({
      price: bin.price,
      volume: bin.volume,
      kind: (bin.volume === max ? "poc" : bin.volume > avg * 1.55 ? "hvn" : bin.volume < avg * 0.42 ? "lvn" : "normal") as VolumeProfileNode["kind"]
    }))
    .sort((a, b) => b.price - a.price);
}

function resolveHorizonFrameCount(settings: DomSettings) {
  const fallback = settings.maxHeatmapHistory;
  switch (settings.heatmapHorizon) {
    case "15m": return Math.min(fallback, 45);
    case "2h": return Math.min(fallback, 90);
    case "6h": return Math.min(fallback, 150);
    case "12h": return Math.min(fallback, 240);
    case "24h": return Math.min(fallback, 360);
    case "3d": return Math.min(fallback, 520);
    case "1w": return Math.min(fallback, 720);
    default: return fallback;
  }
}

function priceToTop(price: number | null | undefined, range: MacroLiquidityRange) {
  if (!Number.isFinite(price ?? NaN) || range.max <= range.min) return "50%";
  const pct = 100 - ((Number(price) - range.min) / (range.max - range.min)) * 100;
  return `${Math.max(1, Math.min(99, pct))}%`;
}

function buildPriceScale(range: MacroLiquidityRange) {
  const step = (range.max - range.min) / 5;
  return Array.from({ length: 6 }, (_, index) => range.max - step * index);
}

function resolveVisibleRangePct(settings: DomSettings) {
  if (settings.visibleRange === "custom") return Math.max(0.05, settings.customVisibleRangePct);
  if (settings.visibleRange !== "auto") return Number(settings.visibleRange);
  if (settings.mode === "macro") return 5;
  if (settings.mode === "institutional" || settings.mode === "standard" || settings.mode === "swing") return 2;
  if (settings.mode === "intraday") return 1;
  return 0.25;
}

function clampViewport(viewport: HeatmapViewportState): HeatmapViewportState {
  const zoom = Math.max(1, Math.min(8, viewport.zoom));
  const maxOffset = (1 - 1 / zoom) / 2;
  return {
    zoom,
    offset: Math.max(-maxOffset, Math.min(maxOffset, viewport.offset))
  };
}

function applyHeatmapViewport(range: MacroLiquidityRange, viewport: HeatmapViewportState): MacroLiquidityRange {
  const normalized = clampViewport(viewport);
  const span = Math.max(range.max - range.min, 0.00000001);
  const visibleSpan = span / normalized.zoom;
  const center = (range.min + range.max) / 2 + normalized.offset * span;
  let min = center - visibleSpan / 2;
  let max = center + visibleSpan / 2;
  if (min < range.min) {
    max += range.min - min;
    min = range.min;
  }
  if (max > range.max) {
    min -= max - range.max;
    max = range.max;
  }
  return {
    min: Math.max(0.00000001, min),
    max: Math.max(min + 0.00000001, max),
    source: range.source
  };
}

function priceFromY(y: number, rect: DOMRect, range: MacroLiquidityRange) {
  const pct = Math.max(0, Math.min(1, y / Math.max(1, rect.height)));
  return range.max - pct * (range.max - range.min);
}

function buildHeatmapHover(
  event: ReactMouseEvent<HTMLDivElement>,
  rect: DOMRect,
  range: MacroLiquidityRange,
  frames: AggregatedDomSnapshot["heatmap"],
  bands: MacroLiquidityBand[],
  walls: AggregatedDomSnapshot["walls"]
): DomHoverInfo {
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const price = priceFromY(y, rect, range);
  const xPct = Math.max(0, Math.min(1, x / Math.max(1, rect.width)));
  const frame = frames[Math.round(xPct * Math.max(0, frames.length - 1))];
  const priceWindow = Math.max((range.max - range.min) * 0.008, 0.00000001);
  const nearestCell = frame?.cells
    .filter((cell) => Math.abs(cell.price - price) <= priceWindow)
    .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))[0];
  const nearestBand = bands
    .filter((band) => band.high >= price - priceWindow && band.low <= price + priceWindow)
    .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))[0];
  const nearestWall = walls
    .filter((wall) => Math.abs(wall.price - price) <= priceWindow)
    .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))[0];
  const lines = [
    `Price ${formatPrice(price)}`,
    `Time ${frame ? formatHeatmapTime(frame.time) : "Historical band"}`,
    `Liquidity ${nearestCell ? `${nearestCell.side === "ask" ? "sell" : "buy"} / ${(nearestCell.intensity * 100).toFixed(0)}% intensity` : "No live cell at cursor"}`
  ];
  if (nearestBand) lines.push(`${nearestBand.label} ${formatPrice(nearestBand.price)} / ${nearestBand.touches} touches / ${Math.round(nearestBand.strength * 100)}%`);
  if (nearestWall) lines.push(`${nearestWall.side === "sell" ? "Sell wall" : "Buy wall"} ${formatSize(nearestWall.size)} / ${formatDuration(nearestWall.persistenceMs)}`);
  return {
    x,
    y,
    title: nearestBand?.label ?? (nearestWall ? `${nearestWall.side.toUpperCase()} WALL` : "LIQUIDITY POINT"),
    lines
  };
}

function buildProfileHover(event: ReactMouseEvent<HTMLDivElement>, rect: DOMRect, range: MacroLiquidityRange, profile: VolumeProfileNode[]): DomHoverInfo {
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const price = priceFromY(y, rect, range);
  const nearest = profile
    .slice()
    .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))[0];
  return {
    x,
    y,
    title: nearest ? nearest.kind.toUpperCase() : "PROFILE",
    lines: [
      `Price ${formatPrice(nearest?.price ?? price)}`,
      `Volume ${formatCompact(nearest?.volume ?? 0)}`,
      `Node ${nearest?.kind.toUpperCase() ?? "NONE"}`
    ]
  };
}

function horizonSeconds(horizon: DomHeatmapHorizon | DomCvdHorizon) {
  switch (horizon) {
    case "15m": return 15 * 60;
    case "1h": return 60 * 60;
    case "2h": return 2 * 60 * 60;
    case "4h": return 4 * 60 * 60;
    case "6h": return 6 * 60 * 60;
    case "12h": return 12 * 60 * 60;
    case "24h": return 24 * 60 * 60;
    case "3d": return 3 * 24 * 60 * 60;
    case "1w": return 7 * 24 * 60 * 60;
    default: return 24 * 60 * 60;
  }
}

function buildSmoothedCvd(points: Array<{ time: number; value: number }>, settings: DomSettings) {
  if (points.length === 0) return [];
  const now = Math.max(Date.now() / 1000, ...points.map((point) => normalizeEpochSeconds(point.time)));
  const cutoff = now - horizonSeconds(settings.cvdHorizon);
  const ordered = points
    .map((point) => ({ time: normalizeEpochSeconds(point.time), value: point.value }))
    .filter((point) => point.time >= cutoff)
    .sort((a, b) => a.time - b.time);
  const source = ordered.length ? ordered : points.slice(-180).map((point) => ({ time: normalizeEpochSeconds(point.time), value: point.value }));
  const interval = Math.max(1, settings.cvdSampleIntervalSec);
  const bucketed = new Map<number, number>();
  for (const point of source) {
    bucketed.set(Math.floor(point.time / interval) * interval, point.value);
  }
  const samples = Array.from(bucketed.entries()).map(([time, value]) => ({ time, value })).sort((a, b) => a.time - b.time);
  if (samples.length <= 1) return samples;
  const alpha = 2 / (Math.max(2, settings.cvdSmoothingLength) + 1);
  let ema = samples[0].value;
  return samples.map((point) => {
    ema = ema + alpha * (point.value - ema);
    return { time: point.time, value: ema };
  });
}

function buildCvdStats(trades: AggregatedDomSnapshot["trades"], cvdData: Array<{ time?: number; value: number }>, settings: DomSettings) {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - horizonSeconds(settings.cvdHorizon);
  const horizonTrades = trades.filter((trade) => normalizeEpochSeconds(trade.time) >= cutoff);
  const buyVolume = horizonTrades.filter((trade) => trade.side === "buy").reduce((sum, trade) => sum + trade.quantity, 0);
  const sellVolume = horizonTrades.filter((trade) => trade.side === "sell").reduce((sum, trade) => sum + trade.quantity, 0);
  const total = Math.max(1, buyVolume + sellVolume);
  const current = cvdData[cvdData.length - 1]?.value ?? 0;
  const first = cvdData[0]?.value ?? 0;
  const sessionDelta = current - first;
  const lookback = cvdData[Math.max(0, cvdData.length - Math.max(4, Math.floor(cvdData.length * 0.25)))]?.value ?? first;
  const slope = current - lookback;
  const noise = Math.max(1, Math.abs(sessionDelta) * 0.08);
  return {
    current,
    sessionDelta,
    buyPct: buyVolume / total * 100,
    sellPct: sellVolume / total * 100,
    trend: slope > noise ? "rising" : slope < -noise ? "falling" : "flat"
  };
}

function buildCvdPath(points: Array<{ value: number }>) {
  if (points.length < 2) return "0,50 100,50";
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  return points.map((point, index) => {
    const x = index / Math.max(1, points.length - 1) * 100;
    const y = 92 - ((point.value - min) / span) * 82;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

function buildDepthChart(snapshot: AggregatedDomSnapshot) {
  const bidLevels = snapshot.bids.slice(0, 90).sort((a, b) => b.price - a.price);
  const askLevels = snapshot.asks.slice(0, 90).sort((a, b) => a.price - b.price);
  if (bidLevels.length === 0 || askLevels.length === 0) {
    return { empty: true, bidLine: "", askLine: "", bidArea: "", askArea: "" };
  }
  const bidCumulative: Array<{ x: number; y: number }> = [];
  const askCumulative: Array<{ x: number; y: number }> = [];
  let bidTotal = 0;
  let askTotal = 0;
  const bidTotals = bidLevels.map((level) => {
    bidTotal += level.bidSize;
    return bidTotal;
  });
  const askTotals = askLevels.map((level) => {
    askTotal += level.askSize;
    return askTotal;
  });
  const maxTotal = Math.max(1, bidTotal, askTotal);
  bidLevels.forEach((_level, index) => {
    const x = 50 - ((index + 1) / Math.max(1, bidLevels.length)) * 47;
    const y = 94 - (bidTotals[index] / maxTotal) * 82;
    bidCumulative.push({ x, y });
  });
  askLevels.forEach((_level, index) => {
    const x = 50 + ((index + 1) / Math.max(1, askLevels.length)) * 47;
    const y = 94 - (askTotals[index] / maxTotal) * 82;
    askCumulative.push({ x, y });
  });
  const bidLinePoints = [{ x: 50, y: 94 }, ...bidCumulative];
  const askLinePoints = [{ x: 50, y: 94 }, ...askCumulative];
  const pointString = (points: Array<{ x: number; y: number }>) => points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
  return {
    empty: false,
    bidLine: pointString(bidLinePoints),
    askLine: pointString(askLinePoints),
    bidArea: `${pointString(bidLinePoints)} ${bidCumulative[bidCumulative.length - 1]?.x.toFixed(2) ?? "3"},94 50,94`,
    askArea: `${pointString(askLinePoints)} ${askCumulative[askCumulative.length - 1]?.x.toFixed(2) ?? "97"},94 50,94`
  };
}

function buildFlowBars(series: FlowPoint[], settings: DomSettings) {
  if (series.length === 0) return [];
  const now = Math.max(...series.map((point) => point.time));
  const cutoff = now - horizonSeconds(settings.cvdHorizon);
  const points = series.filter((point) => point.time >= cutoff).sort((a, b) => a.time - b.time).slice(-220);
  if (points.length === 0) return [];
  const scale = Math.max(1, percentile(points.map((point) => Math.abs(point.net)), 0.92));
  const width = Math.max(0.25, 96 / Math.max(16, points.length));
  return points.map((point, index) => ({
    time: point.time,
    net: point.net,
    left: index / Math.max(1, points.length) * 100,
    width,
    height: Math.max(1, Math.min(46, Math.abs(point.net) / scale * 46))
  }));
}

function percentile(values: number[], pct: number) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * pct)));
  return sorted[index];
}

function normalizeEpochSeconds(time: number) {
  return time > 100000000000 ? Math.floor(time / 1000) : time;
}

function formatHeatmapTime(time: number) {
  return new Date(time > 100000000000 ? time : time * 1000).toLocaleString(undefined, {
    hour12: false,
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function buildDomProPopoutDocument(channelName: string) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>DOM Pro+ - Black Terminal</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #030405; color: #d9dde4; font-family: "IBM Plex Mono", Consolas, monospace; overflow: hidden; }
    .shell { height: 100vh; display: grid; grid-template-rows: 46px 72px minmax(0, 1fr); border: 1px solid rgba(255,0,0,.32); background: radial-gradient(circle at 50% 20%, rgba(120,0,0,.12), transparent 34%), #050607; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 0 15px; border-bottom: 1px solid rgba(255,0,0,.24); background: linear-gradient(180deg, #101316, #050607); }
    header b { color: #fff; font-size: 13px; letter-spacing: .06em; }
    header span, .stat span, .panel-title b, .metric span { color: #858b95; font-size: 9px; font-weight: 800; text-transform: uppercase; }
    .stats { display: grid; grid-template-columns: repeat(8, minmax(110px, 1fr)); border-bottom: 1px solid rgba(255,255,255,.08); }
    .stat { display: grid; align-content: center; gap: 6px; padding: 8px 11px; border-right: 1px solid rgba(255,255,255,.075); min-width: 0; }
    .stat b { color: #f2f4f7; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .grid { min-height: 0; display: grid; grid-template-columns: 1.05fr .9fr 1.45fr .75fr .95fr .9fr; grid-template-rows: minmax(0, 1fr) 178px minmax(284px, .42fr); align-content: stretch; gap: 8px; padding: 8px; }
    .panel { min-width: 0; min-height: 0; overflow: hidden; background: rgba(5,6,7,.97); border: 1px solid rgba(255,255,255,.09); }
    .panel-title { height: 34px; display: flex; align-items: center; justify-content: space-between; padding: 0 10px; border-bottom: 1px solid rgba(255,255,255,.08); }
    .panel-title span { color: #eef1f5; font-size: 10px; font-weight: 900; text-transform: uppercase; }
    .ladder { grid-column: 1; grid-row: 1 / 3; }
    .profile { grid-column: 2; grid-row: 1 / 3; }
    .heatmap { grid-column: 3; grid-row: 1 / 3; }
    .walls { grid-column: 4; grid-row: 1 / 3; }
    .tape { grid-column: 5; grid-row: 1; }
    .metrics { grid-column: 6; grid-row: 1; }
    .depth { grid-column: 1 / 3; grid-row: 3; }
    .flow { grid-column: 3 / 5; grid-row: 3; }
    .cvd { grid-column: 5; grid-row: 2; }
    .perf { grid-column: 6; grid-row: 2; }
    .exec { grid-column: 5 / 7; grid-row: 3; }
    .empty { height: calc(100% - 34px); display: grid; place-items: center; padding: 20px; color: #7e858f; font-size: 10px; font-weight: 800; text-align: center; text-transform: uppercase; }
    .row, .head, .tape-row, .tape-head { display: grid; align-items: center; font-size: 10px; }
    .head, .row { grid-template-columns: 1fr .95fr .95fr; padding: 0 8px 0 10px; }
    .head, .tape-head { height: 28px; color: #7d838c; font-size: 9px; text-transform: uppercase; }
    .row { position: relative; height: 18px; color: #d4d7dc; }
    .row span { position: relative; z-index: 1; }
    .row span:nth-child(2), .row span:nth-child(3), .head span:nth-child(2), .head span:nth-child(3) { text-align: right; }
    .row i { position: absolute; top: 2px; bottom: 2px; width: 44%; opacity: .38; transform-origin: right center; }
    .row .bid { left: 24%; background: linear-gradient(90deg, rgba(180,185,194,.06), rgba(205,209,216,.44)); }
    .row .ask { right: 8px; background: linear-gradient(270deg, rgba(255,0,0,.66), rgba(255,0,0,.02)); }
    .row.current { box-shadow: inset 0 0 0 1px rgba(255,255,255,.48); background: rgba(255,255,255,.05); }
    .ladder-body, .profile-body { height: calc(100% - 34px); overflow: auto; }
    .profile-row { display: grid; grid-template-columns: 76px 1fr 38px; align-items: center; gap: 7px; height: 14px; color: #a9aeb6; font-size: 9px; font-weight: 700; padding: 0 8px; }
    .profile-row i { height: 8px; background: linear-gradient(90deg, rgba(145,150,158,.28), rgba(226,229,235,.82)); }
    .profile-row.poc i { background: linear-gradient(90deg, rgba(255,0,0,.3), rgba(255,255,255,.94)); box-shadow: 0 0 10px rgba(255,0,0,.34); }
    .heatmap-canvas, .bars { position: relative; height: calc(100% - 34px); overflow: hidden; background: linear-gradient(rgba(255,255,255,.028) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.028) 1px, transparent 1px); background-size: 48px 28px; }
    .heatmap-canvas .cell { position: absolute; display: block; min-width: 2px; height: 5px; transform: translateY(-50%); background: rgba(205,210,218,.62); box-shadow: 0 0 8px rgba(255,255,255,.1); }
    .heatmap-canvas .cell.ask { background: rgba(255,0,0,.82); box-shadow: 0 0 13px rgba(255,0,0,.42); }
    .macro-band { position: absolute; left: 5px; right: 70px; min-height: 7px; display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 8px; padding: 0 8px; transform: translateY(-50%); color: #fff; font-size: 9px; font-weight: 900; pointer-events: none; }
    .macro-band.supply { background: linear-gradient(90deg, rgba(255,0,0,.08), rgba(255,0,0,.88), rgba(255,0,0,.06)); box-shadow: 0 0 16px rgba(255,0,0,.45); }
    .macro-band.demand { background: linear-gradient(90deg, rgba(190,196,206,.05), rgba(230,234,240,.78), rgba(190,196,206,.06)); box-shadow: 0 0 14px rgba(255,255,255,.22); }
    .macro-band.poc { color: #111; background: linear-gradient(90deg, rgba(255,255,255,.06), rgba(255,255,255,.92), rgba(255,0,0,.18)); box-shadow: 0 0 18px rgba(255,255,255,.34); }
    .heatmap-scale { position:absolute; top:0; right:7px; bottom:0; width:58px; pointer-events:none; }
    .heatmap-scale span { position:absolute; right:0; transform:translateY(-50%); color:#8f959e; font-size:9px; font-weight:800; }
    .current-price { position:absolute; left:0; right:0; height:1px; background:rgba(255,255,255,.78); box-shadow:0 0 8px rgba(255,255,255,.42); }
    .heatmap-footer { position:absolute; left:8px; right:70px; bottom:6px; display:flex; justify-content:space-between; color:#858b94; font-size:8px; font-weight:800; text-transform:uppercase; }
    .wall, .metric { display: grid; gap: 3px; padding: 9px 10px; border-bottom: 1px solid rgba(255,255,255,.06); }
    .wall b, .metric b.hot { color: #ff1d1d; }
    .wall span, .metric b { color: #fff; font-size: 12px; }
    .wall em, .metric em { color: #969ca5; font-size: 9px; font-style: normal; text-align: right; }
    .tape-head, .tape-row { grid-template-columns: .9fr 1fr .8fr .42fr; padding: 0 10px; }
    .tape-row { height: 20px; color: #d1d4da; }
    .tape-row.sell { color: #ff1d1d; }
    .metric { grid-template-columns: 1fr auto; min-height: 38px; }
    .metric em { grid-column: 1 / -1; }
    .bars { display: flex; align-items: end; gap: 1px; padding: 12px 14px; }
    .bars i { flex: 1; min-width: 2px; background: linear-gradient(180deg, rgba(230,233,238,.78), rgba(230,233,238,.08)); }
    .bars i.ask, .bars i.neg { background: linear-gradient(180deg, rgba(255,0,0,.88), rgba(255,0,0,.12)); }
    .cvd-line { position: relative; height: calc(100% - 34px); overflow: hidden; background: linear-gradient(rgba(255,255,255,.028) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.028) 1px, transparent 1px); background-size: 42px 26px; }
    .cvd-line span { position: absolute; width: 4px; height: 4px; border-radius: 50%; background: #cfd3da; box-shadow: 0 0 8px rgba(255,255,255,.28); }
    .cvd-line span.neg { background: #ff1d1d; box-shadow: 0 0 9px rgba(255,0,0,.38); }
    .exec { display: flex; flex-direction: column; }
    .exec-inner { min-height: 0; flex: 1; padding: 9px 10px; display: grid; grid-auto-rows: min-content; gap: 8px; }
    .exec-inner select, .exec-inner input { height: 30px; background: #050607; color: #fff; border: 1px solid rgba(255,255,255,.14); padding: 0 8px; }
    .exec-buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    button { height: 30px; color: #fff; border: 1px solid rgba(255,255,255,.14); background: rgba(190,190,194,.16); font: 900 10px "IBM Plex Mono", Consolas, monospace; text-transform: uppercase; cursor: pointer; }
    button.sell { background: rgba(175,0,0,.76); border-color: rgba(255,0,0,.62); }
  </style>
</head>
<body>
  <div class="shell">
    <header><div><b>DOM PRO+</b> <span>Detached Institutional Depth & Order Flow Terminal</span></div><span id="status">Awaiting parent feed</span></header>
    <section class="stats" id="stats"></section>
    <main class="grid">
      <section class="panel ladder"><div class="panel-title"><span>Aggregated DOM Ladder</span><b id="bookStatus">--</b></div><div id="ladder" class="ladder-body empty">Awaiting live orderbook stream.</div></section>
      <section class="panel profile"><div class="panel-title"><span>Volume Profile</span><b>DOM</b></div><div id="profile" class="profile-body empty">Awaiting live orderbook stream.</div></section>
      <section class="panel heatmap"><div class="panel-title"><span>Liquidity Heatmap</span><b>LOW -> HIGH</b></div><div id="heatmap" class="heatmap-canvas"></div></section>
      <section class="panel walls"><div class="panel-title"><span>Wall Detection</span><b>HEURISTIC</b></div><div id="walls" class="empty">No persistent liquidity wall detected.</div></section>
      <section class="panel tape"><div class="panel-title"><span>Trade Tape</span><b id="tapeStatus">--</b></div><div id="tape"></div></section>
      <section class="panel metrics"><div class="panel-title"><span>DOM Metrics</span><b>LIVE</b></div><div id="metrics"></div></section>
      <section class="panel depth"><div class="panel-title"><span>Depth Chart</span><b>AGGREGATED</b></div><div id="depth" class="bars"></div></section>
      <section class="panel flow"><div class="panel-title"><span>Liquidity Flow Delta</span><b>PULL / STACK</b></div><div id="flow" class="bars"></div></section>
      <section class="panel cvd"><div class="panel-title"><span>CVD</span><b>CUMULATIVE</b></div><div id="cvd" class="cvd-line empty">Trade stream unavailable for this venue.</div></section>
      <section class="panel perf"><div class="panel-title"><span>Performance</span><b id="perfStatus">OK</b></div><div id="perf"></div></section>
      <section class="panel exec"><div class="panel-title"><span>Execution</span><b>OMS / EMS</b></div><div class="exec-inner"><select id="orderType"><option value="limit">LIMIT</option><option value="market">MARKET</option><option value="twap">TWAP</option><option value="iceberg">ICEBERG</option></select><input id="qty" value="0.001" placeholder="Quantity" /><input id="px" placeholder="Price" /><label><input id="postOnly" type="checkbox" /> Post Only</label><label><input id="reduceOnly" type="checkbox" /> Reduce Only</label><div class="exec-buttons"><button id="buy">Place Buy</button><button id="sell" class="sell">Place Sell</button></div><small id="execStatus">Orders route through parent OMS / EMS / Risk.</small></div></section>
    </main>
  </div>
  <script>
    const channel = new BroadcastChannel(${JSON.stringify(channelName)});
    const fmt = (n, d = 1) => Number.isFinite(Number(n)) ? Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '--';
    const compact = (n) => Number.isFinite(Number(n)) ? Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 }).format(Number(n)) : '--';
    const metric = (label, value, note, hot) => '<div class="metric"><span>' + label + '</span><b class="' + (hot ? 'hot' : '') + '">' + value + '</b>' + (note ? '<em>' + note + '</em>' : '') + '</div>';
    const deriveRange = (s, bands) => {
      const prices = [...(s.buckets || []).map(b => b.price), ...(bands || []).flatMap(b => [b.low, b.high])].filter(v => Number.isFinite(Number(v)) && Number(v) > 0);
      const last = Number(s.lastPrice || 1);
      if (!prices.length) return { min: last * .98, max: last * 1.02, source: 'fallback' };
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const pad = Math.max((max - min) * .035, last * .002);
      return { min: min - pad, max: max + pad, source: bands && bands.length ? 'historical-ohlcv' : 'live-depth' };
    };
    function render(data) {
      const s = data.snapshot;
      const ticker = s.ticker || {};
      document.getElementById('status').textContent = s.statusMessage || 'Live parent feed';
      document.getElementById('bookStatus').textContent = s.statusMessage || '--';
      document.getElementById('tapeStatus').textContent = s.trades && s.trades.length ? 'LIVE / REST' : 'UNAVAILABLE';
      document.getElementById('execStatus').textContent = data.executionStatus || 'Orders route through parent OMS / EMS / Risk.';
      document.getElementById('px').value = document.getElementById('px').value || fmt(s.lastPrice, 2).replace(/,/g, '');
      document.getElementById('stats').innerHTML = [
        ['Symbol', s.marketSymbol.rawSymbol + ' ' + s.marketSymbol.marketKind.toUpperCase()],
        ['Last Price', fmt(s.lastPrice)],
        ['24H Change', ticker.priceChangePercent ? Number(ticker.priceChangePercent).toFixed(2) + '%' : '--'],
        ['24H High', fmt(ticker.highPrice)],
        ['24H Low', fmt(ticker.lowPrice)],
        ['24H Volume', compact(ticker.quoteVolume || ticker.volume)],
        ['DOM Mode', data.settings.mode.toUpperCase()],
        ['Bucket', fmt(s.renderStats.bucketSize) + ' ' + s.marketSymbol.quoteAsset]
      ].map(x => '<div class="stat"><span>' + x[0] + '</span><b>' + x[1] + '</b></div>').join('');
      const rows = s.buckets || [];
      const max = Math.max(1, ...rows.map(r => r.totalSize));
      document.getElementById('ladder').className = rows.length ? 'ladder-body' : 'ladder-body empty';
      document.getElementById('ladder').innerHTML = rows.length ? '<div class="head"><span>Price</span><span>Bid</span><span>Ask</span></div>' + rows.map(r => '<div class="row ' + (r.isCurrentPrice ? 'current' : '') + '"><span>' + fmt(r.price) + '</span><span>' + fmt(r.bidSize, 3) + '</span><span style="color:#ff1d1d">' + fmt(r.askSize, 3) + '</span><i class="bid" style="transform:scaleX(' + (r.bidSize / max) + ')"></i><i class="ask" style="transform:scaleX(' + (r.askSize / max) + ')"></i></div>').join('') : 'Awaiting live orderbook stream.';
      const prof = s.volumeProfile || [];
      const pmax = Math.max(1, ...prof.map(p => p.volume));
      document.getElementById('profile').className = prof.length ? 'profile-body' : 'profile-body empty';
      document.getElementById('profile').innerHTML = prof.length ? prof.map(p => '<div class="profile-row ' + p.kind + '"><span>' + fmt(p.price) + '</span><i style="width:' + Math.max(2, p.volume / pmax * 100) + '%"></i><b>' + p.kind.toUpperCase() + '</b></div>').join('') : 'Awaiting live orderbook stream.';
      const bands = data.macroBands || [];
      const range = data.macroRange || deriveRange(s, bands);
      const top = (price) => Math.max(1, Math.min(99, 100 - ((Number(price) - range.min) / Math.max(1, range.max - range.min)) * 100));
      const frameLimit = data.settings.heatmapHorizon === '1w' ? 720 : data.settings.heatmapHorizon === '3d' ? 520 : data.settings.heatmapHorizon === '24h' ? 360 : data.settings.heatmapHorizon === '12h' ? 240 : data.settings.heatmapHorizon === '6h' ? 150 : 90;
      const frames = (s.heatmap || []).slice(-Math.min(frameLimit, data.settings.maxHeatmapHistory || frameLimit));
      const scale = Array.from({ length: 6 }, (_, i) => range.max - ((range.max - range.min) / 5) * i).map(p => '<span style="top:' + top(p) + '%">' + fmt(p) + '</span>').join('');
      const bandHtml = bands.map(b => '<div class="macro-band ' + b.side + '" style="top:' + top(b.price) + '%;height:' + Math.max(7, Math.min(24, b.strength * 18 + 5)) + 'px;opacity:' + Math.max(.28, b.strength) + '"><span>' + b.label + '</span><b>' + fmt(b.price) + '</b><em>' + b.touches + ' touches</em></div>').join('');
      const cellHtml = frames.flatMap((f, fi) => f.cells.slice(0, 130).map(c => '<i class="cell ' + c.side + '" style="left:' + (fi / Math.max(1, frames.length - 1) * 92) + '%;top:' + top(c.price) + '%;width:' + Math.max(1.4, 92 / Math.max(18, frames.length)) + '%;opacity:' + Math.max(.08, c.intensity) + '"></i>')).join('');
      document.getElementById('heatmap').innerHTML = '<div class="heatmap-scale">' + scale + '</div>' + bandHtml + cellHtml + '<b class="current-price" style="top:' + top(s.lastPrice) + '%"></b><div class="heatmap-footer"><span>' + String(data.settings.heatmapHorizon || '24h').toUpperCase() + ' RADAR</span><span>' + String(range.source || 'live-depth').toUpperCase() + '</span></div>';
      const walls = s.walls || [];
      document.getElementById('walls').className = walls.length ? '' : 'empty';
      document.getElementById('walls').innerHTML = walls.length ? walls.map(w => '<div class="wall"><b>' + (w.side === 'sell' ? 'SELL WALL' : 'BUY WALL') + '</b><span>' + fmt(w.price) + '</span><em>' + fmt(w.size, 3) + ' / score ' + Math.round(w.score) + '</em></div>').join('') : 'No persistent liquidity wall detected.';
      document.getElementById('tape').innerHTML = s.trades && s.trades.length ? '<div class="tape-head"><span>Time</span><span>Price</span><span>Size</span><span>Side</span></div>' + s.trades.slice(0, 24).map(t => '<div class="tape-row ' + t.side + '"><span>' + new Date(t.time * 1000).toLocaleTimeString() + '</span><span>' + fmt(t.price) + '</span><span>' + fmt(t.quantity, 3) + '</span><span>' + (t.side === 'sell' ? 'S' : 'B') + '</span></div>').join('') : '<div class="empty">Trade stream unavailable for this venue.</div>';
      document.getElementById('metrics').innerHTML = metric('Orderbook Imbalance', s.metrics.orderBookImbalance.toFixed(2) + '%', s.metrics.orderBookImbalance >= 0 ? 'BID HEAVY' : 'ASK HEAVY') + metric('Liquidity Score', s.metrics.liquidityScore.toFixed(0) + ' / 100', 'STRUCTURE') + metric('Absorption', s.absorption.detected ? 'DETECTED' : 'NONE', s.absorption.label, s.absorption.detected) + metric('Pulling / Stacking', s.metrics.bidStacked + s.metrics.askStacked >= s.metrics.bidPulled + s.metrics.askPulled ? 'STACKING' : 'PULLING', 'NET', true) + metric('Est. Icebergs', String(s.iceberg.estimatedCount), s.iceberg.probability.toUpperCase(), s.iceberg.probability !== 'low') + metric('Latency', s.metrics.latencyMs.toFixed(0) + ' ms', 'PARENT FEED');
      document.getElementById('depth').innerHTML = (s.bids || []).slice(0, 35).reverse().map(b => '<i style="height:' + Math.max(2, b.bidSize / max * 100) + '%"></i>').join('') + (s.asks || []).slice(0, 35).map(a => '<i class="ask" style="height:' + Math.max(2, a.askSize / max * 100) + '%"></i>').join('');
      document.getElementById('flow').innerHTML = (s.liquidityDelta || []).slice(0, 80).map(d => '<i class="' + (d.net >= 0 ? '' : 'neg') + '" style="height:' + Math.min(100, Math.abs(d.net) / max * 160) + '%"></i>').join('');
      const cvd = data.cvdData || [];
      const cmin = Math.min(...cvd.map(p => p.value), 0);
      const cmax = Math.max(...cvd.map(p => p.value), 1);
      const cspan = Math.max(1, cmax - cmin);
      document.getElementById('cvd').className = cvd.length ? 'cvd-line' : 'cvd-line empty';
      document.getElementById('cvd').innerHTML = cvd.length ? cvd.map((p, i) => '<span class="' + (p.value < 0 ? 'neg' : '') + '" style="left:' + (i / Math.max(1, cvd.length - 1) * 100) + '%;bottom:' + ((p.value - cmin) / cspan * 86 + 7) + '%"></span>').join('') : 'Trade stream unavailable for this venue.';
      document.getElementById('perf').innerHTML = metric('Updates / Sec', s.renderStats.updateRate.toFixed(1)) + metric('Render FPS', s.renderStats.renderFps.toFixed(1)) + metric('Visible Buckets', String(s.renderStats.visibleBuckets)) + metric('Bucket Size', fmt(s.renderStats.bucketSize)) + metric('Dropped Frames', String(s.renderStats.droppedFrames)) + metric('Last Render', s.renderStats.lastRenderMs.toFixed(2) + ' ms') + metric('Subscriptions', String(s.renderStats.subscriptionCount));
    }
    function send(side) {
      channel.postMessage({ type: 'quick-order', payload: { side, quantity: document.getElementById('qty').value, price: document.getElementById('px').value, orderType: document.getElementById('orderType').value, postOnly: document.getElementById('postOnly').checked, reduceOnly: document.getElementById('reduceOnly').checked } });
    }
    document.getElementById('buy').onclick = () => send('buy');
    document.getElementById('sell').onclick = () => send('sell');
    channel.onmessage = (event) => { if (event.data && event.data.type === 'snapshot') render(event.data); };
  </script>
</body>
</html>`;
}

function buildExecutionAccount(connection: ConnectionDiagnostics): PortfolioAccount {
  return {
    id: connection.accountId || connection.id,
    exchange: connection.provider as MarketSymbol["exchange"],
    label: connection.label,
    accountName: connection.label,
    permissions: ["read-account", "read-orders", "read-positions", "place-orders", "cancel-orders", "modify-orders", "withdraw-disabled"],
    isPaper: false,
    connectedAt: connection.createdAt,
    lastValidatedAt: connection.updatedAt,
    status: connection.status === "connected" ? "connected" : "degraded",
    apiHealth: connection.metadata.executionReady === true ? "healthy" : "warning",
    latencyMs: connection.health.latencyMs,
    balanceUsd: 0,
    equityUsd: 0,
    marginUsed: 0,
    availableMargin: 0,
    buyingPower: 0,
    leverage: 1,
    dailyPnl: 0,
    monthlyPnl: 0,
    openPositions: 0,
    openOrders: 0,
    riskControls: defaultRiskControls
  };
}

function formatPrice(value?: number | null) {
  if (!Number.isFinite(value ?? NaN)) return "--";
  return Number(value).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function formatSize(value?: number | null) {
  if (!Number.isFinite(value ?? NaN)) return "--";
  return Number(value).toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

function formatCompact(value?: number | null) {
  if (!Number.isFinite(value ?? NaN)) return "--";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(Number(value));
}

function signed(value?: number, suffix = "") {
  if (!Number.isFinite(value ?? NaN)) return "--";
  const sign = Number(value) > 0 ? "+" : "";
  return `${sign}${Number(value).toFixed(2)}${suffix}`;
}

function formatTime(time: number) {
  return new Date(time * 1000).toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function normalizeCvd(value: number, points: Array<{ value: number }>) {
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return 0;
  return ((value - min) / (max - min) - 0.5) * 2;
}
