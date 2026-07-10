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
import { blackDepthHistoryStore, type DepthHistoryPoint, type DepthHistoryRead } from "../depthHistoryStore";
import { readDomSettings, updateModeSettings, writeDomSettings } from "../domSettingsStore";
import { useDomFeed } from "../useDomFeed";
import type {
  AggregatedDomSnapshot,
  DomCvdHorizon,
  DomHeatmapHorizon,
  DomMode,
  DomSettings,
  DomWorkspacePreset,
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
  centerPrice: number | null;
  domainMin: number | null;
  domainMax: number | null;
  zoomFactor: number;
  cameraCenterPrice: number | null;
  cameraZoom: number;
  cameraOffset: number;
  cameraHeight: number | null;
  mode: HeatmapCameraMode;
};

type HeatmapCameraPreset = "current" | "range1" | "range2" | "range5" | "range10" | "range20" | "1h" | "6h" | "12h" | "24h" | "3d" | "full" | "fit";
type HeatmapCameraMode = HeatmapCameraPreset | "manual";
type HeatmapTimeCameraPreset = "1h" | "6h" | "12h" | "24h" | "3d";

type IMMStatusPayload = {
  overallStatus?: string;
  workerStatus?: string;
  currentVenue?: string | null;
  currentSymbol?: string | null;
  lastMessageAt?: string | null;
  lastPersistAt?: string | null;
  activeBuyWalls?: number;
  activeSellWalls?: number;
  staleForMs?: number | null;
  quality?: {
    coverageScore?: number;
    replayConfidence?: string;
    bidAskBalance?: string;
  };
  warnings?: string[];
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

type HeatmapStructureRibbon = {
  id: string;
  price: number;
  intensity: number;
  side: "supply" | "demand" | "poc";
  kind: VolumeProfileNode["kind"];
};

type CoverageGap = {
  id: string;
  low: number;
  high: number;
};

type DomDebugStats = {
  domainMin: number;
  domainMax: number;
  computedDomainMin: number;
  computedDomainMax: number;
  selectedVisibleRange: string;
  currentPrice: number;
  rawBidLevels: number;
  rawAskLevels: number;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  bidBuckets: number;
  askBuckets: number;
  minBidPrice: number | null;
  maxBidPrice: number | null;
  minAskPrice: number | null;
  maxAskPrice: number | null;
  totalBidSize: number;
  totalAskSize: number;
  buyWalls: number;
  sellWalls: number;
  visibleRows: number;
  heatmapRowsRendered: number;
  profileRowsRendered: number;
  depthBidPoints: number;
  depthAskPoints: number;
  depthMemoryPoints: number;
  reason: string;
};

const orderTypes: OrderType[] = ["limit", "market", "twap", "iceberg"];
const visibleRanges: Array<{ value: DomVisibleRange; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "0.25", label: "+/-0.25%" },
  { value: "0.5", label: "+/-0.5%" },
  { value: "1", label: "+/-1%" },
  { value: "2", label: "+/-2%" },
  { value: "5", label: "+/-5%" },
  { value: "10", label: "+/-10%" },
  { value: "20", label: "+/-20%" },
  { value: "full", label: "Full Data" },
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
const cameraPresets: Array<{ value: HeatmapCameraPreset; label: string; title: string }> = [
  { value: "current", label: "Current", title: "Center Market" },
  { value: "range1", label: "+/-1%", title: "Set camera to +/-1% around market" },
  { value: "range2", label: "+/-2%", title: "Set camera to +/-2% around market" },
  { value: "range5", label: "+/-5%", title: "Set camera to +/-5% around market" },
  { value: "range10", label: "+/-10%", title: "Set camera to +/-10% around market" },
  { value: "range20", label: "+/-20%", title: "Set camera to +/-20% around market" },
  { value: "1h", label: "1H", title: "Fit last 1H liquidity" },
  { value: "6h", label: "6H", title: "Fit last 6H liquidity" },
  { value: "12h", label: "12H", title: "Fit last 12H liquidity" },
  { value: "24h", label: "24H", title: "Fit last 24H liquidity" },
  { value: "3d", label: "3D", title: "Fit last 3D liquidity" },
  { value: "full", label: "Full", title: "Show full available liquidity data" },
  { value: "fit", label: "Fit", title: "Fit to Visible Data" }
];
const cvdHorizons: Array<{ value: DomCvdHorizon; label: string }> = [
  { value: "15m", label: "15M" },
  { value: "1h", label: "1H" },
  { value: "4h", label: "4H" },
  { value: "12h", label: "12H" },
  { value: "24h", label: "24H" }
];
const workspacePresets: Array<{ value: DomWorkspacePreset; label: string; title: string }> = [
  { value: "scalper", label: "Scalper", title: "Fast near-price tape, tighter range, higher refresh" },
  { value: "intraday", label: "Intraday", title: "Balanced 6H desk view for active sessions" },
  { value: "institutional", label: "Institutional", title: "24H liquidity map with calmer rendering" },
  { value: "macro", label: "Macro", title: "Wide liquidity memory and longer historical context" }
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
  const heatmapDragRef = useRef<{ startY: number; startCenterPrice: number; cameraHeight: number } | null>(null);
  const heatmapDragRafRef = useRef<number | null>(null);
  const pendingHeatmapDragRef = useRef<{ centerPrice: number; cameraHeight: number } | null>(null);
  const [settings, setSettings] = useState<DomSettings>(() => readDomSettings(workspaceId, symbolKey));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [heatmapViewport, setHeatmapViewport] = useState<HeatmapViewportState>(() => defaultHeatmapCamera());
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
  const [depthHistoryRevision, setDepthHistoryRevision] = useState(0);
  const [immStatus, setImmStatus] = useState<IMMStatusPayload | null>(null);

  useEffect(() => blackCoreConnectionManager.subscribe(setConnections), []);

  useEffect(() => {
    return blackDepthHistoryStore.subscribe(marketSymbol, () => {
      setDepthHistoryRevision((revision) => revision + 1);
    });
  }, [marketSymbol.exchange, marketSymbol.marketKind, marketSymbol.rawSymbol]);

  useEffect(() => {
    const next = readDomSettings(workspaceId, symbolKey);
    setSettings(next);
    engineRef.current = new DomAggregationEngine();
    setHeatmapViewport(defaultHeatmapCamera());
    setDomHover(null);
  }, [workspaceId, symbolKey]);

  useEffect(() => {
    writeDomSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (settingsOpenSignal > 0) setSettingsOpen(true);
  }, [settingsOpenSignal]);

  useEffect(() => {
    let cancelled = false;
    const loadStatus = async () => {
      try {
        const response = await fetch("/api/imm/status", { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`IMM status ${response.status}`);
        const payload = await response.json() as IMMStatusPayload;
        if (!cancelled) setImmStatus(payload);
      } catch {
        if (!cancelled) setImmStatus({ overallStatus: "unavailable", workerStatus: "unavailable", warnings: ["status_endpoint_unavailable"] });
      }
    };
    void loadStatus();
    const interval = window.setInterval(loadStatus, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

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

  useEffect(() => {
    blackDepthHistoryStore.record(marketSymbol, snapshot.sourceBook, snapshot.lastPrice ?? lastPrice);
  }, [lastPrice, marketSymbol, snapshot.generatedAt, snapshot.lastPrice, snapshot.sourceBook]);

  const cvdData = engineRef.current.cvdData();
  const macroBands = useMemo(
    () => settings.showMacroRadar ? buildMacroLiquidityBands(macroCandles, snapshot.lastPrice ?? lastPrice, settings) : [],
    [lastPrice, macroCandles, settings.macroBandCount, settings.macroLookbackDays, settings.showMacroRadar, snapshot.lastPrice]
  );
  const macroRange = useMemo(
    () => resolveMacroLiquidityRange(snapshot, macroCandles, macroBands, snapshot.lastPrice ?? lastPrice, settings),
    [lastPrice, macroBands, macroCandles, settings, snapshot]
  );
  const heatmapFrames = useMemo(() => snapshot.heatmap.slice(-resolveHorizonFrameCount(settings)), [settings, snapshot.heatmap]);
  const liquidityDataRange = useMemo(
    () => resolveLiquidityDataRange(snapshot, macroBands, snapshot.heatmap, macroRange),
    [macroBands, macroRange, snapshot]
  );
  const heatmapRange = useMemo(
    () => applyHeatmapCamera(macroRange, liquidityDataRange, heatmapViewport, snapshot.lastPrice ?? lastPrice),
    [heatmapViewport, lastPrice, liquidityDataRange, macroRange, snapshot.lastPrice]
  );
  const institutionalProfile = useMemo(
    () => buildInstitutionalProfile(snapshot.volumeProfile, macroCandles, heatmapRange),
    [heatmapRange, macroCandles, snapshot.volumeProfile]
  );
  const maxProfileVolume = Math.max(...institutionalProfile.map((node) => node.volume), 1);
  const profileOutline = useMemo(
    () => buildProfileOutline(institutionalProfile, maxProfileVolume, heatmapRange),
    [heatmapRange, institutionalProfile, maxProfileVolume]
  );
  const heatmapStructureRibbons = useMemo(
    () => buildHeatmapStructureRibbons(institutionalProfile, maxProfileVolume, heatmapRange, snapshot.lastPrice ?? lastPrice),
    [heatmapRange, institutionalProfile, lastPrice, maxProfileVolume, snapshot.lastPrice]
  );
  const depthHistory = useMemo(
    () => blackDepthHistoryStore.read(marketSymbol, heatmapRange, settings.heatmapHorizon),
    [depthHistoryRevision, heatmapRange, marketSymbol, settings.heatmapHorizon]
  );
  const depthCoverageGaps = useMemo(
    () => buildDepthCoverageGaps(heatmapRange, heatmapFrames, macroBands, heatmapStructureRibbons, depthHistory.points, snapshot.lastPrice ?? lastPrice),
    [depthHistory.points, heatmapFrames, heatmapRange, heatmapStructureRibbons, lastPrice, macroBands, snapshot.lastPrice]
  );
  const smoothedCvdData = useMemo(() => buildSmoothedCvd(cvdData, settings), [cvdData, settings]);
  const cvdStats = useMemo(() => buildCvdStats(snapshot.trades, smoothedCvdData, settings), [settings, smoothedCvdData, snapshot.trades]);
  const cvdPath = useMemo(() => buildCvdPath(smoothedCvdData), [smoothedCvdData]);
  const depthChart = useMemo(() => buildDepthChart(snapshot, heatmapRange), [heatmapRange, snapshot]);
  const flowBars = useMemo(() => buildFlowBars(flowSeries, settings), [flowSeries, settings]);
  const debugStats = useMemo(
    () => buildDomDebugStats(snapshot, macroRange, heatmapRange, settings, heatmapFrames, institutionalProfile, depthChart, depthHistory, snapshot.lastPrice ?? lastPrice),
    [depthChart, depthHistory, heatmapFrames, heatmapRange, institutionalProfile, lastPrice, macroRange, settings, snapshot]
  );

  const centerMarketCamera = useCallback(() => {
    setHeatmapViewport(createCameraFromRange(macroRange, macroRange, "current", snapshot.lastPrice ?? lastPrice));
    patchSettings({ followMarket: false, freeExplore: false });
    setDomHover(null);
  }, [lastPrice, macroRange, snapshot.lastPrice]);

  const fitVisibleDataCamera = useCallback(() => {
    setHeatmapViewport(createCameraFromRange(liquidityDataRange, macroRange, "fit"));
    patchSettings({ followMarket: false, freeExplore: true });
    setDomHover(null);
  }, [liquidityDataRange, macroRange]);

  const applyWorkspacePreset = useCallback((preset: DomWorkspacePreset) => {
    const patch: Partial<DomSettings> = {
      workspacePreset: preset,
      mode: preset,
      followMarket: false,
      freeExplore: preset !== "scalper"
    };
    if (preset === "scalper") {
      Object.assign(patch, {
        bucketMultiplier: 25,
        visibleRange: "0.5",
        fpsCap: 24,
        heatmapHorizon: "15m",
        cvdHorizon: "15m",
        maxVisibleBuckets: 90,
        maxHeatmapHistory: 140,
        cvdSampleIntervalSec: 5,
        cvdSmoothingLength: 14
      } satisfies Partial<DomSettings>);
      setHeatmapViewport(createCameraFromRange(rangeFromPricePct(snapshot.lastPrice ?? lastPrice ?? midpoint(macroRange), 0.5, macroRange.source), macroRange, "range1", snapshot.lastPrice ?? lastPrice));
    } else if (preset === "intraday") {
      Object.assign(patch, {
        bucketMultiplier: 100,
        visibleRange: "2",
        fpsCap: 15,
        heatmapHorizon: "6h",
        cvdHorizon: "1h",
        maxVisibleBuckets: 150,
        maxHeatmapHistory: 300,
        cvdSampleIntervalSec: 10,
        cvdSmoothingLength: 24
      } satisfies Partial<DomSettings>);
      setHeatmapViewport(createCameraFromRange(resolveCameraPresetRange("6h", snapshot, macroBands, macroRange, snapshot.lastPrice ?? lastPrice), macroRange, "6h"));
    } else if (preset === "macro") {
      Object.assign(patch, {
        bucketMultiplier: 1000,
        visibleRange: "full",
        fpsCap: 7,
        heatmapHorizon: "1w",
        cvdHorizon: "24h",
        maxVisibleBuckets: 220,
        maxHeatmapHistory: 720,
        cvdSampleIntervalSec: 30,
        cvdSmoothingLength: 50,
        macroLookbackDays: 720
      } satisfies Partial<DomSettings>);
      setHeatmapViewport(createCameraFromRange(liquidityDataRange, macroRange, "full"));
    } else {
      Object.assign(patch, {
        bucketMultiplier: 500,
        visibleRange: "5",
        fpsCap: 12,
        heatmapHorizon: "24h",
        cvdHorizon: "4h",
        maxVisibleBuckets: 180,
        maxHeatmapHistory: 520,
        cvdSampleIntervalSec: 10,
        cvdSmoothingLength: 34,
        macroLookbackDays: 365
      } satisfies Partial<DomSettings>);
      setHeatmapViewport(createCameraFromRange(resolveCameraPresetRange("24h", snapshot, macroBands, macroRange, snapshot.lastPrice ?? lastPrice), macroRange, "24h"));
    }
    patchSettings(patch);
    setDomHover(null);
  }, [lastPrice, liquidityDataRange, macroBands, macroRange, snapshot]);

  const handleCameraPreset = useCallback((preset: HeatmapCameraPreset) => {
    if (preset === "current") {
      centerMarketCamera();
      return;
    }
    if (preset === "fit") {
      fitVisibleDataCamera();
      return;
    }
    if (preset === "full") {
      setHeatmapViewport(createCameraFromRange(liquidityDataRange, macroRange, "full"));
      patchSettings({ visibleRange: "full", followMarket: false, freeExplore: true });
      setDomHover(null);
      return;
    }
    const rangePct = cameraPresetToRangePct(preset);
    if (rangePct !== null) {
      const marketPrice = snapshot.lastPrice ?? lastPrice ?? midpoint(macroRange);
      const nextRange = rangeFromPricePct(marketPrice, rangePct, macroRange.source);
      setHeatmapViewport(createCameraFromRange(nextRange, macroRange, preset, marketPrice));
      patchSettings({ visibleRange: String(rangePct) as DomVisibleRange, followMarket: false, freeExplore: true });
      setDomHover(null);
      return;
    }
    const nextRange = resolveCameraPresetRange(preset as HeatmapTimeCameraPreset, snapshot, macroBands, macroRange, snapshot.lastPrice ?? lastPrice);
    setHeatmapViewport(createCameraFromRange(nextRange, macroRange, preset));
    const horizonPatch = cameraPresetToHeatmapHorizon(preset);
    patchSettings({ ...(horizonPatch && horizonPatch !== settings.heatmapHorizon ? { heatmapHorizon: horizonPatch } : {}), followMarket: false, freeExplore: true });
    setDomHover(null);
  }, [centerMarketCamera, fitVisibleDataCamera, lastPrice, macroBands, macroRange, settings.heatmapHorizon, snapshot]);

  useEffect(() => {
    if (!settings.followMarket || settings.freeExplore) return;
    const marketPrice = snapshot.lastPrice ?? lastPrice;
    if (!Number.isFinite(marketPrice)) return;
    setHeatmapViewport((current) => normalizeCamera({
      ...current,
      cameraCenterPrice: Number(marketPrice),
      cameraHeight: resolveCameraHeight(current, macroRange),
      mode: "current"
    }, macroRange));
  }, [lastPrice, macroRange, settings.followMarket, settings.freeExplore, snapshot.lastPrice]);

  const handleHeatmapWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (settings.followMarket || !settings.freeExplore) patchSettings({ followMarket: false, freeExplore: true });
    const rect = event.currentTarget.getBoundingClientRect();
    setHeatmapViewport((current) => {
      const cameraHeight = resolveCameraHeight(current, macroRange);
      const currentCenter = current.cameraCenterPrice ?? snapshot.lastPrice ?? lastPrice ?? midpoint(macroRange);
      if (event.shiftKey) {
        return normalizeCamera({
          ...current,
          cameraCenterPrice: currentCenter + (event.deltaY / Math.max(1, rect.height)) * cameraHeight,
          cameraHeight,
          mode: "manual"
        }, macroRange);
      }
      const cursorY = event.clientY - rect.top;
      const cursorPrice = priceFromY(cursorY, rect, {
        min: currentCenter - cameraHeight / 2,
        max: currentCenter + cameraHeight / 2,
        source: macroRange.source
      });
      const factor = event.deltaY > 0 ? 1.18 : 1 / 1.18;
      const nextHeight = Math.max(macroRange.max * 0.000001, Math.min(cameraHeight * factor, rangeSpan(liquidityDataRange) * 100));
      const yPct = Math.max(0, Math.min(1, cursorY / Math.max(1, rect.height)));
      const nextCenter = cursorPrice - (0.5 - yPct) * nextHeight;
      return normalizeCamera({
        ...current,
        cameraCenterPrice: nextCenter,
        cameraHeight: nextHeight,
        mode: "manual"
      }, macroRange);
    });
  }, [lastPrice, liquidityDataRange, macroRange, settings.followMarket, settings.freeExplore, snapshot.lastPrice]);

  const handleHeatmapMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (settings.followMarket || !settings.freeExplore) patchSettings({ followMarket: false, freeExplore: true });
    heatmapDragRef.current = {
      startY: event.clientY,
      startCenterPrice: heatmapViewport.cameraCenterPrice ?? snapshot.lastPrice ?? lastPrice ?? midpoint(macroRange),
      cameraHeight: resolveCameraHeight(heatmapViewport, macroRange)
    };
  }, [heatmapViewport, lastPrice, macroRange, settings.followMarket, settings.freeExplore, snapshot.lastPrice]);

  const handleHeatmapMouseMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const activeDrag = heatmapDragRef.current;
    if (activeDrag) {
      const delta = (event.clientY - activeDrag.startY) / Math.max(1, rect.height);
      const nextCenter = activeDrag.startCenterPrice + delta * activeDrag.cameraHeight;
      pendingHeatmapDragRef.current = {
        centerPrice: nextCenter,
        cameraHeight: activeDrag.cameraHeight
      };
      if (heatmapDragRafRef.current === null && typeof window !== "undefined") {
        heatmapDragRafRef.current = window.requestAnimationFrame(() => {
          heatmapDragRafRef.current = null;
          const pending = pendingHeatmapDragRef.current;
          pendingHeatmapDragRef.current = null;
          if (!pending) return;
          setHeatmapViewport((current) => normalizeCamera({
            ...current,
            cameraCenterPrice: pending.centerPrice,
            cameraHeight: pending.cameraHeight,
            mode: "manual"
          }, macroRange));
        });
      }
      setDomHover(null);
      return;
    }
    setDomHover(buildHeatmapHover(event, rect, heatmapRange, heatmapFrames, macroBands, snapshot.walls));
  }, [heatmapFrames, heatmapRange, macroBands, macroRange, snapshot.walls]);

  const handleProfileMouseMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setDomHover(buildProfileHover(event, rect, heatmapRange, institutionalProfile));
  }, [heatmapRange, institutionalProfile]);

  useEffect(() => {
    const clearDrag = () => {
      heatmapDragRef.current = null;
      pendingHeatmapDragRef.current = null;
    };
    window.addEventListener("mouseup", clearDrag);
    return () => {
      window.removeEventListener("mouseup", clearDrag);
      if (heatmapDragRafRef.current !== null) window.cancelAnimationFrame(heatmapDragRafRef.current);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (event.code === "Space") {
        event.preventDefault();
        centerMarketCamera();
      } else if (key === "f") {
        event.preventDefault();
        fitVisibleDataCamera();
      } else if (key === "m") {
        event.preventDefault();
        patchSettings({ followMarket: !settings.followMarket, freeExplore: settings.followMarket });
      } else if (key === "r") {
        event.preventDefault();
        setHeatmapViewport(defaultHeatmapCamera());
        patchSettings({ followMarket: false, freeExplore: false });
        setDomHover(null);
      } else if (key === "h") {
        event.preventDefault();
        patchSettings({ showHeatmap: !settings.showHeatmap });
      } else if (key === "p") {
        event.preventDefault();
        patchSettings({ showVolumeProfile: !settings.showVolumeProfile });
      } else if (key === "d") {
        event.preventDefault();
        patchSettings({ showDepthChart: !settings.showDepthChart });
      } else if (event.key === "Escape") {
        setDomHover(null);
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [centerMarketCamera, fitVisibleDataCamera, settings.followMarket, settings.showDepthChart, settings.showHeatmap, settings.showVolumeProfile]);

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
          <div className="dom-pro-title-area">
            <b>DOM PRO+</b>
            <span>Institutional Depth & Order Flow Terminal</span>
            <nav className="dom-pro-preset-strip" aria-label="DOM Pro workspace presets">
              {workspacePresets.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  title={preset.title}
                  className={settings.workspacePreset === preset.value ? "active" : ""}
                  onClick={() => applyWorkspacePreset(preset.value)}
                >
                  {preset.label}
                </button>
              ))}
            </nav>
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
          <div className="dom-pro-camera-switches" aria-label="DOM Pro camera controls">
            <button type="button" title="Space" onClick={centerMarketCamera}>Center</button>
            <button type="button" title="F" onClick={fitVisibleDataCamera}>Fit</button>
            <button
              type="button"
              title="M"
              className={settings.followMarket ? "active" : ""}
              onClick={() => patchSettings({ followMarket: !settings.followMarket, freeExplore: settings.followMarket })}
            >
              Follow
            </button>
            <button
              type="button"
              className={settings.freeExplore ? "active" : ""}
              onClick={() => patchSettings({ freeExplore: !settings.freeExplore, followMarket: false })}
            >
              Explore
            </button>
          </div>
          <button type="button" className="dom-pro-settings-btn" onClick={() => setSettingsOpen((value) => !value)}><Settings size={15} /> Settings</button>
        </section>

        {settingsOpen && (
          <section className="dom-pro-settings-panel">
            <Toggle label="Volume Profile" checked={settings.showVolumeProfile} onChange={(value) => patchSettings({ showVolumeProfile: value })} />
            <Toggle label="Heatmap" checked={settings.showHeatmap} onChange={(value) => patchSettings({ showHeatmap: value })} />
            <Toggle label="Wall Detection" checked={settings.showWallDetection} onChange={(value) => patchSettings({ showWallDetection: value })} />
            <Toggle label="CVD" checked={settings.showCvd} onChange={(value) => patchSettings({ showCvd: value })} />
            <Toggle label="Depth Chart" checked={settings.showDepthChart} onChange={(value) => patchSettings({ showDepthChart: value })} />
            <Toggle label="Execution" checked={settings.showExecutionPanel} onChange={(value) => patchSettings({ showExecutionPanel: value })} />
            <Toggle label="Diagnostics" checked={settings.showDiagnostics} onChange={(value) => patchSettings({ showDiagnostics: value })} />
            <Toggle label="Macro Radar" checked={settings.showMacroRadar} onChange={(value) => patchSettings({ showMacroRadar: value })} />
            <Toggle label="Follow Market" checked={settings.followMarket} onChange={(value) => patchSettings({ followMarket: value, freeExplore: !value })} />
            <Toggle label="Free Explore" checked={settings.freeExplore} onChange={(value) => patchSettings({ freeExplore: value, followMarket: false })} />
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
                  <div className="dom-pro-profile-scale" onMouseMove={handleProfileMouseMove} onMouseLeave={() => setDomHover(null)} onDoubleClick={centerMarketCamera}>
                <div className="dom-pro-profile-axis">
                  {buildPriceScale(heatmapRange).map((price) => <span key={price} style={{ top: priceToTop(price, heatmapRange) }}>{formatPrice(price)}</span>)}
                </div>
                <svg className="dom-pro-profile-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                  {profileOutline.area && <polygon points={profileOutline.area} />}
                  {profileOutline.line && <polyline points={profileOutline.line} />}
                </svg>
                {institutionalProfile.map((node) => (
                  <div className={`dom-pro-profile-node ${node.kind} ${node.volume <= 0 ? "empty" : ""}`} key={`${node.price}-${node.kind}`} style={{ top: priceToTop(node.price, heatmapRange) }}>
                    <i style={{ width: `${node.volume <= 0 ? 0 : Math.max(3, node.volume / maxProfileVolume * 100)}%` }} />
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
              {cameraPresets.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  title={preset.title}
                  className={heatmapViewport.mode === preset.value ? "active" : ""}
                  onClick={() => handleCameraPreset(preset.value)}
                >
                  {preset.label}
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
                onDoubleClick={centerMarketCamera}
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
                {depthCoverageGaps.map((gap) => (
                  <div
                    key={gap.id}
                    className="dom-pro-coverage-gap"
                    style={{
                      top: priceToTop(gap.high, heatmapRange),
                      height: `${Math.max(12, priceToHeight(gap.low, gap.high, heatmapRange))}%`
                    }}
                  >
                    <span>Collecting Depth History</span>
                  </div>
                ))}
                {depthHistory.points.map((point) => (
                  <i
                    key={point.id}
                    className={`dom-pro-depth-memory ${point.side}`}
                    title={`${point.side === "bid" ? "Buy" : "Sell"} depth memory ${formatPrice(point.price)}`}
                    style={{
                      top: priceToTop(point.price, heatmapRange),
                      opacity: Math.max(0.12, Math.min(0.9, point.strength)),
                      height: `${Math.max(3, Math.min(16, point.strength * 16))}px`,
                      width: `${Math.max(18, Math.min(96, 18 + point.strength * 66 + Math.log1p(point.observations) * 4))}%`
                    }}
                  />
                ))}
                {heatmapStructureRibbons.map((ribbon) => (
                  <i
                    key={ribbon.id}
                    className={`dom-pro-structure-ribbon ${ribbon.side} ${ribbon.kind}`}
                    style={{
                      top: priceToTop(ribbon.price, heatmapRange),
                      opacity: Math.max(0.1, Math.min(0.82, ribbon.intensity)),
                      height: `${Math.max(3, Math.min(14, ribbon.intensity * 14))}px`
                    }}
                  />
                ))}
                {heatmapFrames.map((frame, frameIndex) => frame.cells.filter((cell) => cell.price >= heatmapRange.min && cell.price <= heatmapRange.max).slice(0, 260).map((cell, cellIndex) => (
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
                <div className="dom-pro-heatmap-footer"><span>{macroStatus}</span><span>{heatmapRange.source.replace("-", " ").toUpperCase()} / {formatCameraZoom(heatmapViewport, macroRange)} / {formatPrice(heatmapRange.min)}-{formatPrice(heatmapRange.max)}</span></div>
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
            {!settings.showDepthChart ? <EmptyState text="Depth chart hidden in DOM settings." /> : depthChart.empty ? <EmptyState text="Depth chart awaiting bid/ask buckets." /> : (
              <div className="dom-pro-depth-wrap">
                <svg className="dom-pro-depth-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Cumulative market depth">
                  <line className="axis" x1="50" y1="8" x2="50" y2="94" />
                  <line className="axis zero" x1="3" y1="94" x2="97" y2="94" />
                  {depthChart.bidArea && <polygon className="bid-fill" points={depthChart.bidArea} />}
                  {depthChart.askArea && <polygon className="ask-fill" points={depthChart.askArea} />}
                  {depthChart.bidLine && <polyline className="bid-line" points={depthChart.bidLine} />}
                  {depthChart.askLine && <polyline className="ask-line" points={depthChart.askLine} />}
                </svg>
                {depthChart.warning && <span>{depthChart.warning}</span>}
              </div>
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
              <Metric label="Selected Range" value={debugStats.selectedVisibleRange} />
              <Metric label="Computed Domain" value={`${formatPrice(debugStats.computedDomainMin)} / ${formatPrice(debugStats.computedDomainMax)}`} />
              <Metric label="Camera Domain" value={`${formatPrice(debugStats.domainMin)} / ${formatPrice(debugStats.domainMax)}`} />
              <Metric label="Current Price" value={formatPrice(debugStats.currentPrice)} />
              <Metric label="Best Bid / Ask" value={`${formatPrice(debugStats.bestBid)} / ${formatPrice(debugStats.bestAsk)}`} />
              <Metric label="Mid Price" value={formatPrice(debugStats.midPrice)} />
              <Metric label="Raw Bid / Ask" value={`${debugStats.rawBidLevels} / ${debugStats.rawAskLevels}`} />
              <Metric label="Bid / Ask Buckets" value={`${debugStats.bidBuckets} / ${debugStats.askBuckets}`} />
              <Metric label="Bid Price Range" value={`${formatPrice(debugStats.minBidPrice)} / ${formatPrice(debugStats.maxBidPrice)}`} />
              <Metric label="Ask Price Range" value={`${formatPrice(debugStats.minAskPrice)} / ${formatPrice(debugStats.maxAskPrice)}`} />
              <Metric label="Bid / Ask Size" value={`${formatCompact(debugStats.totalBidSize)} / ${formatCompact(debugStats.totalAskSize)}`} />
              <Metric label="Buy / Sell Walls" value={`${debugStats.buyWalls} / ${debugStats.sellWalls}`} />
              <Metric label="Visible Rows" value={String(debugStats.visibleRows)} />
              <Metric label="Heatmap Rows" value={String(debugStats.heatmapRowsRendered)} />
              <Metric label="Profile Rows" value={String(debugStats.profileRowsRendered)} />
              <Metric label="Depth Points" value={`${debugStats.depthBidPoints} / ${debugStats.depthAskPoints}`} />
              <Metric label="Depth Memory" value={`${debugStats.depthMemoryPoints}`} note={`${depthHistory.stats.bidPoints} BID / ${depthHistory.stats.askPoints} ASK / ${depthHistory.stats.source.toUpperCase()}`} />
              <Metric label="Debug Reason" value={debugStats.reason} hot={debugStats.reason !== "OK"} />
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
        <IMMStatusBar
          status={immStatus}
          snapshot={snapshot}
          settings={settings}
          marketSymbol={marketSymbol}
          exchangeLabel={exchangeLabel}
          heatmapRange={heatmapRange}
          depthHistory={depthHistory}
        />
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

function IMMStatusBar({
  status,
  snapshot,
  settings,
  marketSymbol,
  exchangeLabel,
  heatmapRange,
  depthHistory
}: {
  status: IMMStatusPayload | null;
  snapshot: AggregatedDomSnapshot;
  settings: DomSettings;
  marketSymbol: MarketSymbol;
  exchangeLabel: string;
  heatmapRange: MacroLiquidityRange;
  depthHistory: DepthHistoryRead;
}) {
  const overall = String(status?.overallStatus || snapshot.status || "unavailable").toUpperCase();
  const worker = String(status?.workerStatus || "browser-feed").toUpperCase();
  const coverage = Number(status?.quality?.coverageScore ?? 0);
  const staleFor = Number(status?.staleForMs ?? 0);
  const persistAge = status?.lastPersistAt ? formatDuration(Date.now() - Date.parse(status.lastPersistAt)) : "NO PERSIST";
  const lastMessageAge = status?.lastMessageAt ? formatDuration(Date.now() - Date.parse(status.lastMessageAt)) : "NO HEARTBEAT";
  const cameraMode = settings.followMarket ? "FOLLOW" : settings.freeExplore ? "FREE EXPLORE" : "CENTERED";
  const statusClass = ["HEALTHY", "LIVE"].includes(overall) ? "healthy" : ["DEGRADED", "STALE", "RECONNECTING"].includes(overall) ? "degraded" : "offline";
  return (
    <footer className="dom-pro-statusbar" aria-label="IMM operational status">
      <span className={`dom-pro-status-pill ${statusClass}`}>IMM {overall}</span>
      <span>{exchangeLabel.toUpperCase()} / {marketSymbol.rawSymbol}</span>
      <span>{settings.heatmapHorizon.toUpperCase()} HORIZON</span>
      <span>{cameraMode}</span>
      <span>{settings.bucketMultiplier}x BUCKET</span>
      <span>{snapshot.renderStats.renderFps.toFixed(1)} FPS</span>
      <span>{worker}</span>
      <span>{coverage ? `${coverage.toFixed(0)}% QUALITY` : depthHistory.stats.source.toUpperCase()}</span>
      <span>{status?.quality?.replayConfidence ? `${status.quality.replayConfidence.toUpperCase()} REPLAY` : `${depthHistory.stats.totalPoints} MEMORY POINTS`}</span>
      <span>{formatPrice(heatmapRange.min)} - {formatPrice(heatmapRange.max)}</span>
      <span>{status?.activeBuyWalls ?? snapshot.walls.filter((wall) => wall.side === "buy").length} BUY / {status?.activeSellWalls ?? snapshot.walls.filter((wall) => wall.side === "sell").length} SELL WALLS</span>
      <span>{staleFor > 0 ? `${formatDuration(staleFor)} STALE` : `${lastMessageAge} MSG`}</span>
      <span>{persistAge} PERSIST</span>
    </footer>
  );
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

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select";
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
  const zoneCount = 10;
  for (let index = 0; index < zoneCount; index += 1) {
    const zoneLow = min + (span / zoneCount) * index;
    const zoneHigh = min + (span / zoneCount) * (index + 1);
    const candidate = ranked
      .filter((bin) => bin.price >= zoneLow && bin.price <= zoneHigh && bin.strength >= 0.1)
      .sort((a, b) => b.strength - a.strength)[0];
    if (candidate) pushCandidate(candidate);
  }
  for (const candidate of ranked) {
    pushCandidate(candidate);
    if (selected.length >= Math.max(18, settings.macroBandCount)) break;
  }

  const pocPrice = ranked[0]?.price ?? selected[0]?.price ?? price;
  return selected.map((bin) => {
    const isPoc = Math.abs(bin.price - pocPrice) <= step * 0.5;
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
  if (settings.visibleRange === "full") {
    const fullPrices = [
      price,
      snapshot.lastPrice,
      snapshot.midPrice,
      snapshot.bestBid,
      snapshot.bestAsk,
      ...snapshot.buckets.map((bucket) => bucket.price),
      ...(snapshot.sourceBook?.bids.map((level) => level.price) ?? []),
      ...(snapshot.sourceBook?.asks.map((level) => level.price) ?? []),
      ...bands.flatMap((band) => [band.low, band.high, band.price]),
      ...candles.slice(-settings.macroLookbackDays).flatMap((candle) => [candle.low, candle.high, candle.close])
    ].map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
    return pricesToRange(fullPrices, rangeFromPricePct(price, 20, snapshot.buckets.length ? "live-depth" : "fallback"), candles.length || bands.length ? "historical-ohlcv" : snapshot.buckets.length ? "live-depth" : "fallback");
  }
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

function rangeFromPricePct(price: number, rangePct: number, source: MacroLiquidityRange["source"]): MacroLiquidityRange {
  const normalizedPrice = Math.max(0.00000001, Number(price) || 1);
  return {
    min: Math.max(0.00000001, normalizedPrice * (1 - rangePct / 100)),
    max: Math.max(normalizedPrice * (1 + rangePct / 100), normalizedPrice + 0.00000001),
    source
  };
}

function buildInstitutionalProfile(liveProfile: VolumeProfileNode[], candles: Candle[], range: MacroLiquidityRange): VolumeProfileNode[] {
  const historicalSource = candles.slice(-365);
  const overlappingSource = historicalSource.filter((candle) => candle.high >= range.min && candle.low <= range.max);
  const source = overlappingSource.length >= 8 ? overlappingSource : historicalSource.filter((candle) => candle.close >= range.min && candle.close <= range.max);
  const binCount = 128;
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

  for (const node of liveProfile) {
    if (node.price < range.min || node.price > range.max || node.volume <= 0) continue;
    const index = Math.max(0, Math.min(bins.length - 1, Math.round((node.price - range.min) / step)));
    bins[index].volume += node.volume * Math.max(8, source.length ? 1 : 18);
  }

  const volumes = bins.map((bin) => bin.volume);
  const max = Math.max(...volumes, 1);
  const positiveVolumes = volumes.filter((volume) => volume > 0);
  const avg = positiveVolumes.reduce((sum, value) => sum + value, 0) / Math.max(1, positiveVolumes.length);
  return bins
    .map((bin) => ({
      price: bin.price,
      volume: bin.volume,
      kind: (bin.volume <= 0 ? "lvn" : bin.volume === max ? "poc" : bin.volume > avg * 1.55 ? "hvn" : bin.volume < avg * 0.42 ? "lvn" : "normal") as VolumeProfileNode["kind"]
    }))
    .sort((a, b) => b.price - a.price);
}

function buildProfileOutline(profile: VolumeProfileNode[], maxVolume: number, range: MacroLiquidityRange) {
  const rows = profile
    .slice()
    .sort((a, b) => b.price - a.price)
    .map((node) => ({
      x: 4 + Math.sqrt(Math.max(0, node.volume) / Math.max(1, maxVolume)) * 72,
      y: priceToY(node.price, range)
    }));
  if (rows.length < 2) return { line: "", area: "" };
  const line = rows.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
  const area = `4,${rows[0].y.toFixed(2)} ${line} 4,${rows[rows.length - 1].y.toFixed(2)}`;
  return { line, area };
}

function buildHeatmapStructureRibbons(
  profile: VolumeProfileNode[],
  maxVolume: number,
  range: MacroLiquidityRange,
  currentPrice: number | null | undefined
): HeatmapStructureRibbon[] {
  const price = Number(currentPrice ?? midpoint(range));
  const visible = profile
    .filter((node) => node.price >= range.min && node.price <= range.max && node.volume > 0)
    .map((node) => ({
      node,
      intensity: Math.sqrt(node.volume / Math.max(1, maxVolume))
    }))
    .filter(({ intensity, node }) => intensity >= 0.16 || node.kind === "poc" || node.kind === "hvn")
    .sort((a, b) => b.intensity - a.intensity);
  const below = visible.filter(({ node }) => node.price < price).slice(0, 34);
  const above = visible.filter(({ node }) => node.price >= price).slice(0, 34);
  return [...below, ...above]
    .sort((a, b) => b.node.price - a.node.price)
    .map(({ node, intensity }) => ({
      id: `profile-ribbon:${Math.round(node.price * 100)}`,
      price: node.price,
      intensity,
      side: node.kind === "poc" ? "poc" : node.price >= price ? "supply" : "demand",
      kind: node.kind
    }));
}

function buildDepthCoverageGaps(
  range: MacroLiquidityRange,
  frames: AggregatedDomSnapshot["heatmap"],
  bands: MacroLiquidityBand[],
  ribbons: HeatmapStructureRibbon[],
  memoryPoints: DepthHistoryPoint[],
  currentPrice: number | null | undefined
): CoverageGap[] {
  const segmentCount = 14;
  const span = rangeSpan(range);
  const signalPrices = [
    Number(currentPrice),
    ...frames.flatMap((frame) => frame.cells.map((cell) => cell.price)),
    ...bands.flatMap((band) => [band.low, band.high, band.price]),
    ...ribbons.map((ribbon) => ribbon.price),
    ...memoryPoints.map((point) => point.price)
  ].filter((price) => Number.isFinite(price) && price >= range.min && price <= range.max);
  const minGapHeight = span / segmentCount;
  const gaps: CoverageGap[] = [];
  let active: CoverageGap | null = null;

  for (let index = 0; index < segmentCount; index += 1) {
    const low = range.min + (span / segmentCount) * index;
    const high = range.min + (span / segmentCount) * (index + 1);
    const hasSignal = signalPrices.some((price) => price >= low && price <= high);
    if (hasSignal) {
      if (active && active.high - active.low >= minGapHeight) gaps.push(active);
      active = null;
      continue;
    }
    if (!active) active = { id: `gap:${index}`, low, high };
    else active.high = high;
  }

  if (active && active.high - active.low >= minGapHeight) gaps.push(active);
  return gaps.slice(0, 4);
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
  return `${priceToY(Number(price), range)}%`;
}

function priceToY(price: number, range: MacroLiquidityRange) {
  if (!Number.isFinite(price) || range.max <= range.min) return 50;
  const pct = 100 - ((price - range.min) / (range.max - range.min)) * 100;
  return Math.max(1, Math.min(99, pct));
}

function priceToX(price: number, range: MacroLiquidityRange) {
  if (!Number.isFinite(price) || range.max <= range.min) return 50;
  const pct = ((price - range.min) / (range.max - range.min)) * 94 + 3;
  return Math.max(3, Math.min(97, pct));
}

function priceToHeight(low: number, high: number, range: MacroLiquidityRange) {
  if (range.max <= range.min || high <= low) return 0;
  return Math.max(0, Math.min(100, ((high - low) / (range.max - range.min)) * 100));
}

function buildPriceScale(range: MacroLiquidityRange) {
  const step = (range.max - range.min) / 5;
  return Array.from({ length: 6 }, (_, index) => range.max - step * index);
}

function defaultHeatmapCamera(): HeatmapViewportState {
  return {
    centerPrice: null,
    domainMin: null,
    domainMax: null,
    zoomFactor: 1,
    cameraCenterPrice: null,
    cameraZoom: 1,
    cameraOffset: 0,
    cameraHeight: null,
    mode: "current"
  };
}

function resolveVisibleRangePct(settings: DomSettings) {
  if (settings.visibleRange === "custom") return Math.max(0.05, settings.customVisibleRangePct);
  if (settings.visibleRange === "full") return 20;
  if (settings.visibleRange !== "auto") return Number(settings.visibleRange);
  if (settings.mode === "macro") return 5;
  if (settings.mode === "institutional" || settings.mode === "standard" || settings.mode === "swing") return 2;
  if (settings.mode === "intraday") return 1;
  return 0.25;
}

function midpoint(range: MacroLiquidityRange) {
  return (range.min + range.max) / 2;
}

function rangeSpan(range: MacroLiquidityRange) {
  return Math.max(range.max - range.min, 0.00000001);
}

function normalizeCamera(camera: HeatmapViewportState, baseRange: MacroLiquidityRange): HeatmapViewportState {
  const baseHeight = rangeSpan(baseRange);
  const cameraHeight = Number.isFinite(camera.cameraHeight ?? NaN) ? Math.max(baseHeight / 100, Number(camera.cameraHeight)) : null;
  const cameraZoom = cameraHeight ? cameraHeight / baseHeight : Math.max(0.01, camera.cameraZoom || 1);
  const center = Number.isFinite(camera.cameraCenterPrice ?? camera.centerPrice ?? NaN) ? Number(camera.cameraCenterPrice ?? camera.centerPrice) : null;
  const domainMin = center !== null && cameraHeight ? Math.max(0.00000001, center - cameraHeight / 2) : (Number.isFinite(camera.domainMin ?? NaN) ? Number(camera.domainMin) : null);
  const domainMax = center !== null && cameraHeight ? Math.max(center + cameraHeight / 2, center - cameraHeight / 2 + 0.00000001) : (Number.isFinite(camera.domainMax ?? NaN) ? Number(camera.domainMax) : null);
  return {
    ...camera,
    centerPrice: center,
    domainMin,
    domainMax,
    zoomFactor: Math.max(0.01, Math.min(100, cameraZoom)),
    cameraCenterPrice: center,
    cameraZoom: Math.max(0.01, Math.min(100, cameraZoom)),
    cameraOffset: Number.isFinite(camera.cameraOffset) ? camera.cameraOffset : 0,
    cameraHeight
  };
}

function resolveCameraHeight(camera: HeatmapViewportState, baseRange: MacroLiquidityRange) {
  const baseHeight = rangeSpan(baseRange);
  return Number.isFinite(camera.cameraHeight ?? NaN) ? Math.max(baseHeight / 100, Number(camera.cameraHeight)) : baseHeight * Math.max(0.01, camera.cameraZoom || 1);
}

function createCameraFromRange(range: MacroLiquidityRange, baseRange: MacroLiquidityRange, mode: HeatmapCameraMode, centerOverride?: number | null): HeatmapViewportState {
  const baseHeight = rangeSpan(baseRange);
  const sourceHeight = rangeSpan(range);
  const height = Math.max(baseHeight / 100, sourceHeight * 1.08);
  const center = Number.isFinite(centerOverride ?? NaN) ? Number(centerOverride) : midpoint(range);
  const min = Math.max(0.00000001, center - height / 2);
  const max = Math.max(center + height / 2, min + 0.00000001);
  return {
    centerPrice: center,
    domainMin: min,
    domainMax: max,
    zoomFactor: Math.max(0.01, Math.min(100, height / baseHeight)),
    cameraCenterPrice: center,
    cameraZoom: Math.max(0.01, Math.min(100, height / baseHeight)),
    cameraOffset: (center - midpoint(baseRange)) / baseHeight,
    cameraHeight: height,
    mode
  };
}

function applyHeatmapCamera(baseRange: MacroLiquidityRange, dataRange: MacroLiquidityRange, camera: HeatmapViewportState, currentPrice: number | null | undefined): MacroLiquidityRange {
  const normalized = normalizeCamera(camera, baseRange);
  const height = resolveCameraHeight(normalized, baseRange);
  const center = normalized.cameraCenterPrice ?? Number(currentPrice ?? midpoint(baseRange));
  const min = normalized.domainMin ?? Math.max(0.00000001, center - height / 2);
  const max = normalized.domainMax ?? Math.max(center + height / 2, center - height / 2 + 0.00000001);
  return {
    min,
    max,
    source: dataRange.source
  };
}

function formatCameraZoom(camera: HeatmapViewportState, baseRange: MacroLiquidityRange) {
  const zoom = resolveCameraHeight(camera, baseRange) / rangeSpan(baseRange);
  if (zoom >= 10) return `${zoom.toFixed(0)}x`;
  return `${zoom.toFixed(1)}x`;
}

function resolveLiquidityDataRange(
  snapshot: AggregatedDomSnapshot,
  bands: MacroLiquidityBand[],
  frames: AggregatedDomSnapshot["heatmap"],
  fallbackRange: MacroLiquidityRange
): MacroLiquidityRange {
  const prices = [
    fallbackRange.min,
    fallbackRange.max,
    snapshot.lastPrice,
    snapshot.midPrice,
    snapshot.bestBid,
    snapshot.bestAsk,
    ...bands.flatMap((band) => [band.low, band.high, band.price]),
    ...frames.flatMap((frame) => frame.cells.map((cell) => cell.price)),
    ...snapshot.walls.map((wall) => wall.price),
    ...snapshot.volumeProfile.map((node) => node.price),
    ...snapshot.buckets.map((bucket) => bucket.price)
  ].map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
  return pricesToRange(prices, fallbackRange, bands.length || frames.length ? "historical-ohlcv" : snapshot.buckets.length ? "live-depth" : fallbackRange.source);
}

function resolveCameraPresetRange(
  preset: HeatmapTimeCameraPreset,
  snapshot: AggregatedDomSnapshot,
  bands: MacroLiquidityBand[],
  fallbackRange: MacroLiquidityRange,
  currentPrice: number | null | undefined
): MacroLiquidityRange {
  const now = Date.now();
  const cutoff = now - horizonSeconds(preset) * 1000;
  const cells = snapshot.heatmap
    .filter((frame) => frame.time >= cutoff)
    .flatMap((frame) => frame.cells.map((cell) => cell.price));
  const prices = [
    fallbackRange.min,
    fallbackRange.max,
    currentPrice,
    snapshot.midPrice,
    snapshot.bestBid,
    snapshot.bestAsk,
    ...cells,
    ...snapshot.walls.map((wall) => wall.price),
    ...snapshot.buckets.map((bucket) => bucket.price),
    ...(preset === "12h" || preset === "24h" || preset === "3d" ? bands.flatMap((band) => [band.low, band.high, band.price]) : [])
  ].map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
  const fallback = Number.isFinite(currentPrice ?? NaN)
    ? { min: Number(currentPrice) - rangeSpan(fallbackRange) / 2, max: Number(currentPrice) + rangeSpan(fallbackRange) / 2, source: fallbackRange.source }
    : fallbackRange;
  return pricesToRange(prices, fallback, prices.length ? "historical-ohlcv" : fallbackRange.source);
}

function pricesToRange(prices: number[], fallbackRange: MacroLiquidityRange, source: MacroLiquidityRange["source"]): MacroLiquidityRange {
  if (prices.length === 0) return fallbackRange;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = Math.max(max - min, rangeSpan(fallbackRange) * 0.25);
  const pad = Math.max(span * 0.045, rangeSpan(fallbackRange) * 0.025);
  return {
    min: Math.max(0.00000001, min - pad),
    max: Math.max(min + pad + 0.00000001, max + pad),
    source
  };
}

function cameraPresetToHeatmapHorizon(preset: HeatmapCameraPreset): DomHeatmapHorizon | null {
  if (preset === "6h" || preset === "12h" || preset === "24h" || preset === "3d") return preset;
  if (preset === "1h") return "2h";
  return null;
}

function cameraPresetToRangePct(preset: HeatmapCameraPreset): 1 | 2 | 5 | 10 | 20 | null {
  if (preset === "range1") return 1;
  if (preset === "range2") return 2;
  if (preset === "range5") return 5;
  if (preset === "range10") return 10;
  if (preset === "range20") return 20;
  return null;
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

function buildDepthChart(snapshot: AggregatedDomSnapshot, range: MacroLiquidityRange) {
  const currentPrice = snapshot.midPrice ?? snapshot.lastPrice ?? midpoint(range);
  const rawBidSource = (snapshot.sourceBook?.bids ?? [])
    .map((level) => ({ price: level.price, bidSize: level.quantity, askSize: 0 }))
    .filter((level) => level.price > 0 && level.bidSize > 0);
  const rawAskSource = (snapshot.sourceBook?.asks ?? [])
    .map((level) => ({ price: level.price, askSize: level.quantity, bidSize: 0 }))
    .filter((level) => level.price > 0 && level.askSize > 0);
  const bidSource = rawBidSource.length >= 2 ? rawBidSource : snapshot.bids;
  const askSource = rawAskSource.length >= 2 ? rawAskSource : snapshot.asks;
  const bidLevels = bidSource
    .filter((level) => level.price >= range.min && level.price <= Math.min(currentPrice, range.max) && level.bidSize > 0)
    .sort((a, b) => b.price - a.price)
    .slice(0, 420);
  const askLevels = askSource
    .filter((level) => level.price <= range.max && level.price >= Math.max(currentPrice, range.min) && level.askSize > 0)
    .sort((a, b) => a.price - b.price)
    .slice(0, 420);
  if (bidLevels.length === 0 && askLevels.length === 0) {
    return { empty: true, bidLine: "", askLine: "", bidArea: "", askArea: "", bidPoints: 0, askPoints: 0, warning: "Depth chart awaiting bid/ask buckets." };
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
  const startX = priceToX(currentPrice, range);
  bidLevels.forEach((level, index) => {
    const x = priceToX(level.price, range);
    const y = 94 - Math.sqrt(bidTotals[index] / maxTotal) * 82;
    bidCumulative.push({ x, y });
  });
  askLevels.forEach((level, index) => {
    const x = priceToX(level.price, range);
    const y = 94 - Math.sqrt(askTotals[index] / maxTotal) * 82;
    askCumulative.push({ x, y });
  });
  const bidLinePoints = bidCumulative.length
    ? extendDepthSide([{ x: startX, y: 94 }, ...bidCumulative].sort((a, b) => a.x - b.x), "bid")
    : [];
  const askLinePoints = askCumulative.length
    ? extendDepthSide([{ x: startX, y: 94 }, ...askCumulative].sort((a, b) => a.x - b.x), "ask")
    : [];
  const pointString = (points: Array<{ x: number; y: number }>) => points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
  return {
    empty: false,
    bidLine: pointString(bidLinePoints),
    askLine: pointString(askLinePoints),
    bidArea: bidLinePoints.length ? `${pointString(bidLinePoints)} ${startX.toFixed(2)},94 ${bidLinePoints[0].x.toFixed(2)},94` : "",
    askArea: askLinePoints.length ? `${pointString(askLinePoints)} ${askLinePoints[askLinePoints.length - 1].x.toFixed(2)},94 ${startX.toFixed(2)},94` : "",
    bidPoints: bidLinePoints.length,
    askPoints: askLinePoints.length,
    warning: bidLinePoints.length === 0 ? "Only ask side available from source." : askLinePoints.length === 0 ? "Only bid side available from source." : rawBidSource.length < 2 || rawAskSource.length < 2 ? "Raw depth sparse; using aggregated fallback." : ""
  };
}

function extendDepthSide(points: Array<{ x: number; y: number }>, side: "bid" | "ask") {
  if (points.length === 0) return points;
  const next = points.slice();
  if (side === "bid" && next[0].x > 3.5) next.unshift({ x: 3, y: next[0].y });
  if (side === "ask" && next[next.length - 1].x < 96.5) next.push({ x: 97, y: next[next.length - 1].y });
  return next;
}

function buildDomDebugStats(
  snapshot: AggregatedDomSnapshot,
  computedDomain: MacroLiquidityRange,
  domain: MacroLiquidityRange,
  settings: DomSettings,
  heatmapFrames: AggregatedDomSnapshot["heatmap"],
  profile: VolumeProfileNode[],
  depthChart: ReturnType<typeof buildDepthChart>,
  depthHistory: DepthHistoryRead,
  currentPrice: number | null | undefined
): DomDebugStats {
  const visibleHeatmapRows = heatmapFrames.reduce(
    (sum, frame) => sum + frame.cells.filter((cell) => cell.price >= domain.min && cell.price <= domain.max).length,
    0
  );
  const minPrice = (values: number[]) => values.length ? Math.min(...values) : null;
  const maxPrice = (values: number[]) => values.length ? Math.max(...values) : null;
  const bidPrices = snapshot.bids.map((bucket) => bucket.price);
  const askPrices = snapshot.asks.map((bucket) => bucket.price);
  const totalBidSize = snapshot.bids.reduce((sum, bucket) => sum + bucket.bidSize, 0);
  const totalAskSize = snapshot.asks.reduce((sum, bucket) => sum + bucket.askSize, 0);
  const reasons = [
    (snapshot.sourceBook?.bids.length ?? 0) === 0 ? "raw bids missing" : "",
    (snapshot.sourceBook?.asks.length ?? 0) === 0 ? "raw asks missing" : "",
    snapshot.bids.length === 0 ? "bid buckets missing" : "",
    snapshot.asks.length === 0 ? "ask buckets missing" : "",
    snapshot.walls.filter((wall) => wall.side === "buy").length === 0 && snapshot.bids.length > 0 ? "buy walls zero with bid buckets" : "",
    depthChart.bidPoints === 0 && snapshot.bids.length > 0 ? "depth bid points zero" : "",
    depthChart.askPoints === 0 && snapshot.asks.length > 0 ? "depth ask points zero" : ""
  ].filter(Boolean);
  return {
    domainMin: domain.min,
    domainMax: domain.max,
    computedDomainMin: computedDomain.min,
    computedDomainMax: computedDomain.max,
    selectedVisibleRange: settings.visibleRange === "full" ? "FULL DATA" : settings.visibleRange === "custom" ? `+/-${settings.customVisibleRangePct}%` : settings.visibleRange === "auto" ? "AUTO" : `+/-${settings.visibleRange}%`,
    currentPrice: Number(currentPrice ?? snapshot.midPrice ?? midpoint(domain)),
    rawBidLevels: snapshot.sourceBook?.bids.length ?? 0,
    rawAskLevels: snapshot.sourceBook?.asks.length ?? 0,
    bestBid: snapshot.bestBid,
    bestAsk: snapshot.bestAsk,
    midPrice: snapshot.midPrice,
    bidBuckets: snapshot.bids.length,
    askBuckets: snapshot.asks.length,
    minBidPrice: minPrice(bidPrices),
    maxBidPrice: maxPrice(bidPrices),
    minAskPrice: minPrice(askPrices),
    maxAskPrice: maxPrice(askPrices),
    totalBidSize,
    totalAskSize,
    buyWalls: snapshot.walls.filter((wall) => wall.side === "buy").length,
    sellWalls: snapshot.walls.filter((wall) => wall.side === "sell").length,
    visibleRows: snapshot.buckets.length,
    heatmapRowsRendered: visibleHeatmapRows,
    profileRowsRendered: profile.length,
    depthBidPoints: depthChart.bidPoints ?? 0,
    depthAskPoints: depthChart.askPoints ?? 0,
    depthMemoryPoints: depthHistory.stats.totalPoints,
    reason: reasons.length ? reasons.join("; ").toUpperCase() : "OK"
  };
}

function buildFlowBars(series: FlowPoint[], settings: DomSettings) {
  if (series.length === 0) return [];
  const now = Math.max(...series.map((point) => point.time));
  const cutoff = now - horizonSeconds(settings.cvdHorizon);
  const points = series.filter((point) => point.time >= cutoff).sort((a, b) => a.time - b.time).slice(-220);
  if (points.length === 0) return [];
  const scale = Math.max(1, percentile(points.map((point) => Math.abs(point.net)), 0.95) * 1.18);
  const width = Math.max(0.25, 96 / Math.max(16, points.length));
  return points.map((point, index) => ({
    time: point.time,
    net: point.net,
    left: index / Math.max(1, points.length) * 100,
    width,
    height: Math.max(1, Math.min(42, Math.sqrt(Math.min(1, Math.abs(point.net) / scale)) * 42))
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
