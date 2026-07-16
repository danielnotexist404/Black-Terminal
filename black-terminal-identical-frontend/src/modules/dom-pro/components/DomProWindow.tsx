import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, ExternalLink, Maximize2, Minimize2, Minus, Settings, X } from "lucide-react";
import type { Candle } from "../../../chart-engine/types";
import { blackCoreConnectionManager } from "../../../connectivity/connectionManager";
import { validateMainnetOrderReadiness } from "../../../execution/mainnetValidationMode";
import { readActiveExecutionVenueId } from "../../../connectivity/activeExecutionVenue";
import type { ConnectionDiagnostics } from "../../../connectivity/types";
import type { BlackCoreModuleMode } from "../../../core/modules/moduleRegistry";
import { submitOrder } from "../../../execution/executionEngine";
import type { MarginMode, OrderSide, OrderType, TimeInForce, TriggerSource, VenueStrategyParameters } from "../../../execution/types";
import { blackCoreMarketDataEngine } from "../../../market-data/engine/marketDataEngine";
import type { MarketKind, MarketSymbol, Timeframe } from "../../../market-data/types";
import { blackCorePerformanceMonitor } from "../../../performance/performanceMonitor";
import type { PortfolioAccount } from "../../../portfolio/types";
import { syncExchangeAccountViaApi, type ExchangeAccountSyncPayload } from "../../../portfolio/portfolioApiClient";
import { defaultRiskControls } from "../../../risk/types";
import { buildVenueExecutionSchema, calculateVenueOrderPreview, sizeFromEquityPercent, validateVenueOrderDraft } from "../../../execution/venueExecutionSchema";
import { DomAggregationEngine } from "../domAggregationEngine";
import { aggregateDomSnapshot } from "../domAggregationClient";
import { DomAdaptiveQualityController, type DomVisualQuality } from "../domAdaptiveQuality";
import { domInteractionCoordinator } from "../domInteractionCoordinator";
import { domPerformanceTrace } from "../domPerformanceTrace";
import { domFreezeWatchdog } from "../domFreezeWatchdog";
import { domVisualScheduler } from "../domVisualScheduler";
import { blackDepthHistoryStore, type DepthHistoryPoint, type DepthHistoryRead } from "../depthHistoryStore";
import { buildDomLadderModel, formatDomLadderQuantity, type DomLadderDisplayUnit } from "../domLadderModel";
import { createDomProPriceCamera, domCameraRange, domPriceBucketAt, domPriceToTopPct, type DomProPriceCamera } from "../domPriceCamera";
import {
  applyDomPanelPreset,
  applyDomWorkspacePreset,
  domPanelFields,
  domPanelPresets,
  exportDomPanelSettings,
  importDomPanelSettings,
  patchDomPanel,
  readDomPanelRegistry,
  resetAllDomPanels,
  resetDomPanel,
  writeDomPanelRegistry,
  type DomPanelId,
  type DomPanelSettingsRegistry,
  type DomPanelValues
} from "../domPanelSettingsStore";
import { DomPanelUpdateScheduler } from "../domPanelUpdateScheduler";
import {
  applyDomProLayoutPreset,
  createDomProLayout,
  domWorkspaceTracks,
  findDomSplit,
  listDomProLayoutPresets,
  maximizeDomPanel,
  patchDomPanelLayout,
  readDomProLayout,
  readDomProLayoutPreset,
  resizeDomSplit,
  saveDomProLayoutPreset,
  splitSpanRatio,
  writeDomProLayout,
  type DomProLayoutPreset,
  type DomProLayoutState,
  type DomWorkspacePanelId
} from "../domWorkspaceLayout";
import { availableDomOrderTypes, availableDomTimeInForce, DOM_EQUITY_ALLOCATION_MARKERS, nearestLeverageOptions } from "../domExecutionPresentation";
import { placePanelPopover } from "../domPanelPopover";
import {
  buildStructuralCvdFromCandles,
  buildStructuralCvdFromTrades,
  structuralCvdRange,
  structuralCvdStats,
  type StructuralCvdCumulation,
  type StructuralCvdPoint
} from "../domStructuralCvd";
import {
  aggregateTradeTape,
  clipAndSmoothSeries,
  MetricsStabilizer,
  PersistentDepthProcessor,
  StableWallProcessor,
  type StabilizedMetrics
} from "../domSignalStabilizers";
import { readDomSettings, updateModeSettings, writeDomSettings } from "../domSettingsStore";
import { useDomFeed } from "../useDomFeed";
import type {
  AggregatedDomSnapshot,
  DomCvdHorizon,
  DomHeatmapHorizon,
  DomMode,
  DomPerformanceMode,
  DomSettings,
  DomWorkspacePreset,
  DomVisibleRange,
  MacroLiquidityBand,
  MacroLiquidityRange,
  VolumeProfileNode
} from "../types";
import { DomHeatmapCanvas } from "./DomHeatmapCanvas";

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

type CvdViewportState = {
  startIndex: number | null;
  visibleCount: number | null;
  followLatest: boolean;
};

type CvdResolvedCamera = {
  start: number;
  end: number;
  visibleCount: number;
  total: number;
  followLatest: boolean;
};

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
  price?: number;
  priceBucketKey?: string;
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

type DomVolumeProfileNode = VolumeProfileNode & {
  key: string;
  low: number;
  high: number;
  topPct: number;
  heightPct: number;
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
  { value: "24h", label: "24H" },
  { value: "3d", label: "3D" },
  { value: "1w", label: "1W" }
];
const workspacePresets: Array<{ value: DomWorkspacePreset; label: string; title: string }> = [
  { value: "scalper", label: "Scalper", title: "Fast near-price tape, tighter range, higher refresh" },
  { value: "intraday", label: "Intraday", title: "Balanced 6H desk view for active sessions" },
  { value: "institutional", label: "Institutional", title: "24H liquidity map with calmer rendering" },
  { value: "macro", label: "Macro", title: "Wide liquidity memory and longer historical context" }
];
const configurablePanelIds: DomPanelId[] = ["ladder", "volume-profile", "liquidity-heatmap", "wall-detection", "trade-tape", "dom-metrics", "heuristic-cvd", "depth-chart", "liquidity-flow-delta", "execution"];
const panelVisibilitySelectors: Array<[DomPanelId, string]> = [
  ["ladder", ".dom-pro-ladder"], ["volume-profile", ".dom-pro-profile"], ["liquidity-heatmap", ".dom-pro-heatmap"],
  ["wall-detection", ".dom-pro-walls"], ["trade-tape", ".dom-pro-tape"], ["dom-metrics", ".dom-pro-metrics"],
  ["heuristic-cvd", ".dom-pro-cvd"], ["depth-chart", ".dom-pro-depth-chart"], ["liquidity-flow-delta", ".dom-pro-flow"],
  ["execution", ".dom-pro-execution"]
];

export function DomProWindow({ marketSymbol, lastPrice, exchangeLabel, workspaceId, windowMode, settingsOpenSignal = 0, onClose }: DomProWindowProps) {
  const componentRenderStartedAt = performance.now();
  const symbolKey = `${marketSymbol.exchange}:${marketSymbol.marketKind}:${marketSymbol.rawSymbol}`;
  const channelName = `bt-dom-pro:${workspaceId}:${symbolKey}`;
  const feed = useDomFeed(marketSymbol);
  const engineRef = useRef(new DomAggregationEngine());
  const frameRef = useRef<number | null>(null);
  const renderGenerationRef = useRef(0);
  const popoutRef = useRef<Window | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const submitQuickOrderRef = useRef<(targetSide: OrderSide, override?: Partial<{ quantity: string; price: string; orderType: OrderType; reduceOnly: boolean; postOnly: boolean }>) => Promise<void>>();
  const lastRenderAtRef = useRef(0);
  const droppedFramesRef = useRef(0);
  const renderCooldownUntilRef = useRef(0);
  const heatmapDragRef = useRef<{ startY: number; startCenterPrice: number; cameraHeight: number } | null>(null);
  const pendingHeatmapDragRef = useRef<{ centerPrice: number; cameraHeight: number } | null>(null);
  const pendingHeatmapWheelRef = useRef<{ deltaY: number; shiftKey: boolean; cursorY: number; height: number } | null>(null);
  const pendingHoverRef = useRef<{ x: number; y: number; rect: DOMRect } | null>(null);
  const cvdDragStartRef = useRef<{ x: number; startIndex: number; visibleCount: number; total: number; width: number } | null>(null);
  const gridRef = useRef<HTMLElement | null>(null);
  const upperWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const bottomWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const layoutResizeFrameRef = useRef<number | null>(null);
  const [settings, setSettings] = useState<DomSettings>(() => readDomSettings(workspaceId, symbolKey));
  const [panelRegistry, setPanelRegistry] = useState<DomPanelSettingsRegistry>(() => readDomPanelRegistry(workspaceId, symbolKey));
  const [layout, setLayout] = useState<DomProLayoutState>(() => readDomProLayout(workspaceId, windowMode));
  const [customLayoutPresets, setCustomLayoutPresets] = useState<string[]>(() => listDomProLayoutPresets(workspaceId));
  const [resizeActive, setResizeActive] = useState(false);
  const panelSchedulerRef = useRef(new DomPanelUpdateScheduler());
  const depthProcessorRef = useRef(new PersistentDepthProcessor());
  const wallProcessorRef = useRef(new StableWallProcessor());
  const metricsProcessorRef = useRef(new MetricsStabilizer());
  const qualityControllerRef = useRef(new DomAdaptiveQualityController());
  const [stableWalls, setStableWalls] = useState<Array<AggregatedDomSnapshot["walls"][number] & { reliability?: number; lifecycle?: string; observations?: number }>>([]);
  const [stableTrades, setStableTrades] = useState<AggregatedDomSnapshot["trades"]>([]);
  const [stableMetrics, setStableMetrics] = useState<StabilizedMetrics | null>(null);
  const [depthModelRevision, setDepthModelRevision] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTransferStatus, setSettingsTransferStatus] = useState("");
  const [heatmapViewport, setHeatmapViewport] = useState<HeatmapViewportState>(() => defaultHeatmapCamera());
  const [cvdViewport, setCvdViewport] = useState<CvdViewportState>(() => defaultCvdCamera());
  const [domHover, setDomHover] = useState<DomHoverInfo | null>(null);
  const [flowSeries, setFlowSeries] = useState<FlowPoint[]>([]);
  const lastFlowUiUpdateAtRef = useRef(0);
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
  const [panelSnapshots, setPanelSnapshots] = useState<Record<DomPanelId, AggregatedDomSnapshot>>(() => createPanelSnapshotMap(snapshot));
  const [connections, setConnections] = useState<ConnectionDiagnostics[]>(() => blackCoreConnectionManager.listDiagnostics());
  const activeConnections = useMemo(() => connections.filter((connection) => !["disconnected", "offline", "unsupported"].includes(connection.status)), [connections]);
  const selectedConnection = useMemo(() => {
    const activeVenueId = readActiveExecutionVenueId();
    return activeConnections.find((connection) => connection.id === activeVenueId) ?? activeConnections[0] ?? null;
  }, [activeConnections]);
  const [side, setSide] = useState<OrderSide>("buy");
  const [executionMarketKind, setExecutionMarketKind] = useState<MarketKind>(() => marketSymbol.marketKind === "spot" ? "spot" : "perpetual");
  const [orderType, setOrderType] = useState<OrderType>("limit");
  const [quantity, setQuantity] = useState("0.001");
  const [price, setPrice] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [postOnly, setPostOnly] = useState(false);
  const [marginMode, setMarginMode] = useState<MarginMode>("cross");
  const [timeInForce, setTimeInForce] = useState<TimeInForce>("gtc");
  const [leverage, setLeverage] = useState(1);
  const [equityAllocation, setEquityAllocation] = useState(0);
  const [tpSlEnabled, setTpSlEnabled] = useState(false);
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [triggerBy, setTriggerBy] = useState<TriggerSource>("last");
  const [strategyDurationSeconds, setStrategyDurationSeconds] = useState(1800);
  const [strategyIntervalSeconds, setStrategyIntervalSeconds] = useState(30);
  const [strategyRandomize, setStrategyRandomize] = useState(false);
  const [strategyTriggerPrice, setStrategyTriggerPrice] = useState("");
  const [strategyMaxChasePrice, setStrategyMaxChasePrice] = useState("");
  const [strategyChaseUnit, setStrategyChaseUnit] = useState<"distance" | "percent">("distance");
  const [strategyChaseValue, setStrategyChaseValue] = useState("0.5");
  const [strategySubSize, setStrategySubSize] = useState("");
  const [strategyOrderCount, setStrategyOrderCount] = useState(10);
  const [icebergPreference, setIcebergPreference] = useState<"maker" | "taker" | "offset" | "fixed">("maker");
  const [povMode, setPovMode] = useState<"TradedVolume" | "OppositeSideLiquidity" | "SameSideLiquidity">("TradedVolume");
  const [povParticipationRate, setPovParticipationRate] = useState(10);
  const [povReferenceWindow, setPovReferenceWindow] = useState(300);
  const [povDepthReference, setPovDepthReference] = useState(5);
  const [accountSync, setAccountSync] = useState<ExchangeAccountSyncPayload | null>(null);
  const [accountSyncError, setAccountSyncError] = useState("");
  const [executionStatus, setExecutionStatus] = useState("");
  const [macroCandles, setMacroCandles] = useState<Candle[]>(() => blackCoreMarketDataEngine.cache.getCandles(marketSymbol, "1d"));
  const [macroStatus, setMacroStatus] = useState("HISTORICAL DEPTH");
  const [cvdHistoryCandles, setCvdHistoryCandles] = useState<Candle[]>(() => blackCoreMarketDataEngine.cache.getCandles(marketSymbol, "4h"));
  const [cvdHistoryStatus, setCvdHistoryStatus] = useState("LOADING STRUCTURAL FLOW");
  const [depthHistoryRevision, setDepthHistoryRevision] = useState(0);
  const [immStatus, setImmStatus] = useState<IMMStatusPayload | null>(null);
  const [interactionActive, setInteractionActive] = useState(false);
  const [visualQuality, setVisualQuality] = useState<DomVisualQuality>("full");
  const [documentVisible, setDocumentVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const effectiveVisualQuality = resolveVisualQuality(settings.performanceMode, visualQuality);
  const venueSchema = useMemo(() => selectedConnection
    ? buildVenueExecutionSchema({ connection: selectedConnection, product: executionMarketKind, symbol: marketSymbol.rawSymbol, sync: accountSync })
    : null,
  [accountSync, executionMarketKind, marketSymbol.rawSymbol, selectedConnection]);
  const venueOrderTypes = useMemo(() => availableDomOrderTypes(venueSchema), [venueSchema]);
  const selectedOrderMode = useMemo(() => venueSchema?.supportedOrderModes.find((mode) => mode.orderTypes.includes(orderType)) ?? null, [orderType, venueSchema]);
  const supportsPostOnly = venueSchema?.featureFlags.showPostOnly !== false && selectedOrderMode?.fields.includes("postOnly") === true;
  const supportsReduceOnly = executionMarketKind !== "spot" && venueSchema?.featureFlags.showReduceOnly !== false && selectedOrderMode?.fields.includes("reduceOnly") === true;
  const supportsTpSl = venueSchema?.featureFlags.showTpSl !== false && selectedOrderMode?.fields.includes("tpSl") === true;
  const venueTimeInForce = useMemo(() => availableDomTimeInForce(venueSchema, orderType, postOnly), [orderType, postOnly, venueSchema]);
  const leverageOptions = useMemo(() => nearestLeverageOptions(
    venueSchema?.instrumentRules.minLeverage ?? 1,
    venueSchema?.instrumentRules.maxLeverage ?? 1,
    venueSchema?.instrumentRules.leverageStep ?? 1,
    leverage
  ), [leverage, venueSchema]);
  const executionPrice = Number(price || snapshot.lastPrice || lastPrice || 0);
  const executionQuantity = Number(quantity || 0);
  const strategyOrder = ["chase-limit", "twap", "iceberg", "pov"].includes(orderType);
  const strategyParameters: VenueStrategyParameters | undefined = strategyOrder ? {
    durationSeconds: ["twap", "pov"].includes(orderType) ? strategyDurationSeconds : undefined,
    intervalSeconds: ["twap", "pov"].includes(orderType) ? strategyIntervalSeconds : undefined,
    randomize: orderType === "twap" ? strategyRandomize : undefined,
    triggerPrice: Number(strategyTriggerPrice || 0) || undefined,
    maxChasePrice: Number(strategyMaxChasePrice || 0) || undefined,
    chaseDistance: (orderType === "chase-limit" || orderType === "iceberg" && icebergPreference === "offset") && strategyChaseUnit === "distance" ? Number(strategyChaseValue || 0) : undefined,
    chasePercent: (orderType === "chase-limit" || orderType === "iceberg" && icebergPreference === "offset") && strategyChaseUnit === "percent" ? Number(strategyChaseValue || 0) : undefined,
    subSize: orderType === "iceberg" ? Number(strategySubSize || 0) || undefined : undefined,
    orderCount: orderType === "iceberg" && !Number(strategySubSize || 0) ? strategyOrderCount : undefined,
    icebergPreference: orderType === "iceberg" ? icebergPreference : undefined,
    povMode: orderType === "pov" ? povMode : undefined,
    participationRate: orderType === "pov" ? povParticipationRate : undefined,
    referenceWindowSeconds: orderType === "pov" && povMode === "TradedVolume" ? povReferenceWindow : undefined,
    depthReference: orderType === "pov" && povMode !== "TradedVolume" ? povDepthReference : undefined
  } : undefined;
  const requiresLimitPrice = ["limit", "stop-limit"].includes(orderType) || orderType === "iceberg" && icebergPreference === "fixed";
  const executionPreview = venueSchema ? calculateVenueOrderPreview({
    schema: venueSchema,
    sizingMethod: "quantity",
    size: executionQuantity,
    referencePrice: executionPrice,
    leverage,
    side,
    takeProfit: Number(takeProfit || 0) || undefined,
    stopLoss: Number(stopLoss || 0) || undefined
  }) : null;
  const executionValidation = venueSchema ? validateVenueOrderDraft({
    schema: venueSchema,
    orderType,
    sizingMethod: "quantity",
    size: executionQuantity,
    referencePrice: executionPrice,
    limitPrice: requiresLimitPrice ? executionPrice : undefined,
    triggerPrice: ["stop-market", "stop-limit"].includes(orderType) ? Number(stopPrice || 0) || undefined : undefined,
    leverage,
    side,
    reduceOnly,
    tpSlEnabled,
    strategyParameters
  }) : { valid: false, reasons: ["Connect a supported execution account."] };
  const upperTracks = useMemo(() => domWorkspaceTracks(layout.upperSplit, layout.panelStates), [layout.panelStates, layout.upperSplit]);
  const bottomTracks = useMemo(() => domWorkspaceTracks(layout.bottomSplit, layout.panelStates), [layout.bottomSplit, layout.panelStates]);
  const upperColumns = upperTracks.columns;
  const bottomColumns = bottomTracks.columns;
  const upperSeparators = upperTracks.separators;
  const bottomSeparators = bottomTracks.separators;

  useEffect(() => blackCoreConnectionManager.subscribe(setConnections), []);

  useEffect(() => {
    domPerformanceTrace.record("react.dom_pro_commit", performance.now() - componentRenderStartedAt, document.getElementsByClassName("dom-pro-panel").length, 1);
    domPerformanceTrace.increment("react.dom_pro_renders");
  });

  useEffect(() => domInteractionCoordinator.subscribe(setInteractionActive), []);

  useEffect(() => domFreezeWatchdog.start(() => ({
    symbol: symbolKey,
    preset: settings.workspacePreset,
    quality: qualityLabel(effectiveVisualQuality)
  })), [effectiveVisualQuality, settings.workspacePreset, symbolKey]);

  useEffect(() => {
    const handleVisibility = () => setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  useEffect(() => {
    return blackDepthHistoryStore.subscribe(marketSymbol, () => {
      setDepthHistoryRevision((revision) => revision + 1);
    });
  }, [marketSymbol.exchange, marketSymbol.marketKind, marketSymbol.rawSymbol]);

  useEffect(() => {
    const next = readDomSettings(workspaceId, symbolKey);
    setSettings(next);
    setPanelRegistry(readDomPanelRegistry(workspaceId, symbolKey));
    engineRef.current = new DomAggregationEngine();
    depthProcessorRef.current = new PersistentDepthProcessor();
    wallProcessorRef.current = new StableWallProcessor();
    metricsProcessorRef.current = new MetricsStabilizer();
    setPanelSnapshots(createPanelSnapshotMap(snapshot));
    renderGenerationRef.current += 1;
    setHeatmapViewport(defaultHeatmapCamera());
    setDomHover(null);
  }, [workspaceId, symbolKey]);

  useEffect(() => {
    writeDomSettings(settings);
  }, [settings]);

  useEffect(() => {
    setLayout(readDomProLayout(workspaceId, windowMode));
    setCustomLayoutPresets(listDomProLayoutPresets(workspaceId));
  }, [windowMode, workspaceId]);

  useEffect(() => {
    if (!layout.autoSave || resizeActive) return;
    const timer = window.setTimeout(() => writeDomProLayout(layout, windowMode), 500);
    return () => window.clearTimeout(timer);
  }, [layout, resizeActive, windowMode]);

  useEffect(() => {
    const restoreMaximized = (event: KeyboardEvent) => {
      if (event.key === "Escape" && layout.maximizedPanel) setLayout((current) => maximizeDomPanel(current, null));
    };
    document.addEventListener("keydown", restoreMaximized);
    return () => document.removeEventListener("keydown", restoreMaximized);
  }, [layout.maximizedPanel]);

  useEffect(() => {
    if (!selectedConnection?.accountId || selectedConnection.provider !== "bybit") {
      setAccountSync(null);
      setAccountSyncError("");
      return;
    }
    let active = true;
    const load = async () => {
      try {
        const next = await syncExchangeAccountViaApi(selectedConnection.accountId!, marketSymbol.rawSymbol, executionMarketKind);
        if (active) { setAccountSync(next); setAccountSyncError(""); }
      } catch (error) {
        if (active) setAccountSyncError(error instanceof Error ? error.message : String(error));
      }
    };
    void load();
    const timer = window.setInterval(load, 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, [executionMarketKind, marketSymbol.rawSymbol, selectedConnection?.accountId, selectedConnection?.provider]);

  useEffect(() => {
    if (!venueSchema) return;
    setLeverage((current) => {
      if (venueSchema.product === "spot") return 1;
      const preferred = current === 1 ? venueSchema.currentLeverage || venueSchema.instrumentRules.minLeverage || 1 : current;
      return Math.min(venueSchema.instrumentRules.maxLeverage, Math.max(venueSchema.instrumentRules.minLeverage, preferred));
    });
    setMarginMode(venueSchema.currentMarginMode);
    if (venueSchema.product === "spot") setReduceOnly(false);
  }, [selectedConnection?.accountId, venueSchema]);

  useEffect(() => {
    if (!venueOrderTypes.includes(orderType)) setOrderType(venueOrderTypes[0] ?? "market");
  }, [orderType, venueOrderTypes]);

  useEffect(() => {
    if (!supportsPostOnly) setPostOnly(false);
    if (!supportsReduceOnly) setReduceOnly(false);
    if (!supportsTpSl) setTpSlEnabled(false);
  }, [supportsPostOnly, supportsReduceOnly, supportsTpSl]);

  useEffect(() => {
    if (venueTimeInForce.length > 0 && !venueTimeInForce.includes(timeInForce)) setTimeInForce(venueTimeInForce[0]);
    if (venueTimeInForce.length === 0 && timeInForce !== "gtc") setTimeInForce("gtc");
  }, [timeInForce, venueTimeInForce]);

  useEffect(() => {
    if (!venueSchema || equityAllocation <= 0 || executionPrice <= 0) return;
    const nextQuantity = sizeFromEquityPercent({ schema: venueSchema, percent: equityAllocation / 100, referencePrice: executionPrice, leverage, sizingMethod: "quantity" });
    setQuantity(String(nextQuantity));
  }, [equityAllocation, executionPrice, leverage, venueSchema]);

  useEffect(() => {
    const persistTimer = window.setTimeout(() => writeDomPanelRegistry(panelRegistry), 250);
    for (const panelId of Object.keys(panelRegistry.panels) as DomPanelId[]) {
      const values = panelRegistry.panels[panelId].settings;
      panelSchedulerRef.current.setCadence(panelId, numberSetting(values, "updateIntervalMs", 1000), 1000 / numberSetting(values, "renderFps", 4));
      if (booleanSetting(values, "visible", true)) panelSchedulerRef.current.resumePanel(panelId);
      else panelSchedulerRef.current.suspendPanel(panelId);
    }
    return () => window.clearTimeout(persistTimer);
  }, [panelRegistry]);

  useEffect(() => {
    if (settingsOpenSignal > 0) setSettingsOpen(true);
  }, [settingsOpenSignal]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const panelId = (entry.target as HTMLElement).dataset.domPanelId as DomPanelId | undefined;
        if (!panelId) continue;
        if (entry.isIntersecting && document.visibilityState !== "hidden") panelSchedulerRef.current.resumePanel(panelId);
        else panelSchedulerRef.current.suspendPanel(panelId);
      }
    }, { threshold: 0.01 });
    for (const [panelId, selector] of panelVisibilitySelectors) {
      const panel = document.querySelector<HTMLElement>(`.dom-pro-window ${selector}`);
      if (!panel) continue;
      panel.dataset.domPanelId = panelId;
      observer.observe(panel);
    }
    return () => observer.disconnect();
  }, [settings.showCvd, settings.showExecutionPanel, settings.showDepthChart, settings.showHeatmap, settings.showVolumeProfile]);

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
    if (!documentVisible) return;
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
  }, [documentVisible, feed.updatedAt, settings]);

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
    const flowValues = panelRegistry.panels["liquidity-flow-delta"].settings;
    const flowCadence = numberSetting(flowValues, "updateIntervalMs", 2000);
    if (snapshot.generatedAt - lastFlowUiUpdateAtRef.current < flowCadence) return;
    lastFlowUiUpdateAtRef.current = snapshot.generatedAt;
    const bucketSeconds = numberSetting(flowValues, "timeBucketSec", 10);
    const bucketTime = Math.floor((snapshot.generatedAt / 1000) / bucketSeconds) * bucketSeconds;
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
  }, [panelRegistry, settings.cvdHorizon, snapshot.generatedAt, snapshot.liquidityDelta]);

  function renderSnapshot() {
    const started = performance.now();
    const generation = ++renderGenerationRef.current;
    const input = {
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
    };
    void aggregateDomSnapshot(input, engineRef.current).then((next) => {
      if (!next || generation !== renderGenerationRef.current) return;
      next.renderStats.lastRenderMs = performance.now() - started;
      blackCorePerformanceMonitor.recordFrame(next.renderStats.lastRenderMs, { surface: "dom-pro" });
      blackCorePerformanceMonitor.recordMetric("dom_pro.render_ms", next.renderStats.lastRenderMs, "ms", { surface: "dom-pro" });
      blackCorePerformanceMonitor.recordMetric("dom_pro.visible_buckets", next.renderStats.visibleBuckets, "count", { surface: "dom-pro" });
      const nextQuality = qualityControllerRef.current.update(next.renderStats.lastRenderMs, 0, domInteractionCoordinator.isActive());
      setVisualQuality((current) => current === nextQuality ? current : nextQuality);
      if (next.renderStats.lastRenderMs > 18) {
        renderCooldownUntilRef.current = performance.now() + 1000 / Math.max(1, settings.fpsCap);
        droppedFramesRef.current += 1;
      }
      lastRenderAtRef.current = performance.now();
      setSnapshot(next);
    });
  }

  function patchSettings(patch: Partial<DomSettings>) {
    const startedAt = performance.now();
    setSettings((current) => ({ ...current, ...patch }));
    domPerformanceTrace.record("settings.update", performance.now() - startedAt, Object.keys(patch).length, 1);
  }

  function patchPanelSettings(panelId: DomPanelId, patch: Partial<DomPanelValues>) {
    const startedAt = performance.now();
    setPanelRegistry((current) => patchDomPanel(current, panelId, patch));
    panelSchedulerRef.current.requestImmediateUpdate(panelId);
    domPerformanceTrace.record("settings.panel_update", performance.now() - startedAt, Object.keys(patch).length, 1);
  }

  function setPanelHoverFreeze(panelId: DomPanelId, hovering: boolean) {
    if (!booleanSetting(panelRegistry.panels[panelId].settings, "freezeOnHover", false)) return;
    if (hovering) panelSchedulerRef.current.suspendPanel(panelId);
    else panelSchedulerRef.current.resumePanel(panelId);
  }

  async function exportPanelSettings() {
    await navigator.clipboard.writeText(exportDomPanelSettings(panelRegistry));
    setSettingsTransferStatus("Panel settings copied");
  }

  function importPanelSettings() {
    const raw = window.prompt("Paste DOM Pro panel settings JSON");
    if (!raw) return;
    try {
      setPanelRegistry(importDomPanelSettings(raw, workspaceId, symbolKey));
      setSettingsTransferStatus("Panel settings imported");
    } catch {
      setSettingsTransferStatus("Invalid settings JSON");
    }
  }

  function applyEquityAllocation(percent: number) {
    setEquityAllocation(percent);
    if (!venueSchema || executionPrice <= 0) return;
    const nextQuantity = sizeFromEquityPercent({
      schema: venueSchema,
      percent: percent / 100,
      referencePrice: executionPrice,
      leverage,
      sizingMethod: "quantity"
    });
    setQuantity(String(nextQuantity));
  }

  function panelLayoutClass(panelId: DomWorkspacePanelId, base: string) {
    const state = layout.panelStates[panelId];
    return ["dom-pro-panel", base, state?.collapsed ? "is-collapsed" : "", layout.maximizedPanel === panelId ? "is-maximized" : ""].filter(Boolean).join(" ");
  }

  function beginLayoutResize(region: "root" | "upper" | "bottom", splitId: string, event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const element = region === "root" ? gridRef.current : region === "upper" ? upperWorkspaceRef.current : bottomWorkspaceRef.current;
    if (!element) return;
    const tree = region === "root" ? layout.rootSplit : region === "upper" ? layout.upperSplit : layout.bottomSplit;
    const split = findDomSplit(tree, splitId);
    if (!split) return;
    const rect = element.getBoundingClientRect();
    const vertical = split.direction === "vertical";
    const startPointer = vertical ? event.clientX : event.clientY;
    const totalSize = Math.max(1, (vertical ? rect.width : rect.height) * splitSpanRatio(tree, splitId));
    const startLayout = layout;
    const pointerId = event.pointerId;
    let latestDelta = 0;
    event.currentTarget.setPointerCapture?.(pointerId);
    setResizeActive(true);
    domInteractionCoordinator.begin();
    document.body.classList.add("dom-pro-resize-active");

    const move = (moveEvent: PointerEvent) => {
      const delta = (vertical ? moveEvent.clientX : moveEvent.clientY) - startPointer;
      latestDelta = delta;
      if (layoutResizeFrameRef.current !== null) window.cancelAnimationFrame(layoutResizeFrameRef.current);
      layoutResizeFrameRef.current = window.requestAnimationFrame(() => {
        layoutResizeFrameRef.current = null;
        setLayout(resizeDomSplit(startLayout, region, splitId, delta / totalSize));
      });
    };
    const end = () => {
      if (layoutResizeFrameRef.current !== null) window.cancelAnimationFrame(layoutResizeFrameRef.current);
      layoutResizeFrameRef.current = null;
      setLayout(resizeDomSplit(startLayout, region, splitId, latestDelta / totalSize));
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      document.body.classList.remove("dom-pro-resize-active");
      setResizeActive(false);
      domInteractionCoordinator.endAfter(80);
      domVisualScheduler.markAllDirty();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  }

  function keyboardResize(region: "root" | "upper" | "bottom", splitId: string, event: ReactKeyboardEvent<HTMLDivElement>) {
    const negative = event.key === "ArrowLeft" || event.key === "ArrowUp";
    const positive = event.key === "ArrowRight" || event.key === "ArrowDown";
    if (!negative && !positive) return;
    event.preventDefault();
    setLayout((current) => resizeDomSplit(current, region, splitId, (negative ? -1 : 1) * (event.shiftKey ? 0.05 : 0.015)));
  }

  function resetLayoutSplit(region: "root" | "upper" | "bottom", splitId: string) {
    const factory = createDomProLayout(workspaceId, layout.preset);
    const currentTree = region === "root" ? layout.rootSplit : region === "upper" ? layout.upperSplit : layout.bottomSplit;
    const factoryTree = region === "root" ? factory.rootSplit : region === "upper" ? factory.upperSplit : factory.bottomSplit;
    const current = findDomSplit(currentTree, splitId);
    const target = findDomSplit(factoryTree, splitId);
    if (current && target) setLayout((state) => resizeDomSplit(state, region, splitId, target.ratio - current.ratio));
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
    const liveReadiness = validateMainnetOrderReadiness(selectedConnection);
    if (!liveReadiness.allowed) {
      setExecutionStatus((liveReadiness.reason || "MAINNET VALIDATION BLOCKED").toUpperCase());
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
            marketKind: executionMarketKind,
            side: targetSide,
            type: nextOrderType,
            quantity: parsedQuantity,
            sizingMethod: "quantity",
            limitPrice: ["limit", "stop-limit"].includes(nextOrderType) || nextOrderType === "iceberg" && icebergPreference === "fixed" ? parsedPrice : undefined,
            stopPrice: ["stop-market", "stop-limit"].includes(nextOrderType) ? Number(stopPrice || 0) || undefined : undefined,
            referencePrice: parsedPrice,
            reduceOnly: nextReduceOnly,
            postOnly: nextPostOnly,
            marginMode,
            timeInForce: venueTimeInForce.length > 0 ? timeInForce : undefined,
            triggerBy,
            leverage,
            takeProfit: tpSlEnabled ? Number(takeProfit || 0) || undefined : undefined,
            stopLoss: tpSlEnabled ? Number(stopLoss || 0) || undefined : undefined,
            strategyParameters,
            source: "order-ticket",
            destinations: ["personal-portfolio"]
          }, buildExecutionAccount(selectedConnection, accountSync), parsedPrice || 1);
      setExecutionStatus(`${update.status.toUpperCase()}: ${update.reason || update.orderId}`);
    } catch (error) {
      setExecutionStatus(error instanceof Error ? error.message.toUpperCase() : String(error));
    }
  }, [accountSync, executionMarketKind, icebergPreference, lastPrice, leverage, marginMode, marketSymbol.rawSymbol, orderType, postOnly, price, quantity, reduceOnly, selectedConnection, snapshot.lastPrice, stopLoss, stopPrice, strategyParameters, takeProfit, timeInForce, tpSlEnabled, triggerBy, venueTimeInForce.length]);

  useEffect(() => {
    submitQuickOrderRef.current = submitQuickOrder;
  }, [submitQuickOrder]);

  useEffect(() => {
    blackDepthHistoryStore.record(marketSymbol, snapshot.sourceBook, snapshot.lastPrice ?? lastPrice);
  }, [lastPrice, marketSymbol, snapshot.generatedAt, snapshot.lastPrice, snapshot.sourceBook]);

  const ladderPanelValues = panelRegistry.panels.ladder.settings;
  const ladderDisplayUnits = stringSetting(ladderPanelValues, "displayUnits", "base") as DomLadderDisplayUnit;
  const ladderShowNetDepth = booleanSetting(ladderPanelValues, "showNetDepth", false);
  const profilePanelValues = panelRegistry.panels["volume-profile"].settings;
  const profileShowLabels = booleanSetting(profilePanelValues, "showLabels", true);
  const heatmapPanelValues = panelRegistry.panels["liquidity-heatmap"].settings;
  const cvdPanelValues = panelRegistry.panels["heuristic-cvd"].settings;
  const depthPanelValues = panelRegistry.panels["depth-chart"].settings;
  const wallPanelValues = panelRegistry.panels["wall-detection"].settings;
  const tapePanelValues = panelRegistry.panels["trade-tape"].settings;
  const metricsPanelValues = panelRegistry.panels["dom-metrics"].settings;
  const flowPanelValues = panelRegistry.panels["liquidity-flow-delta"].settings;
  const analyticalSettings = useMemo<DomSettings>(() => ({
    ...settings,
    cvdHorizon: stringSetting(cvdPanelValues, "horizon", settings.cvdHorizon) as DomCvdHorizon,
    cvdSampleIntervalSec: numberSetting(cvdPanelValues, "sourceBucketSec", settings.cvdSampleIntervalSec),
    cvdSmoothingLength: numberSetting(cvdPanelValues, "smoothingLength", settings.cvdSmoothingLength),
    cvdCandleSeconds: numberSetting(cvdPanelValues, "candleSeconds", settings.cvdCandleSeconds),
    cvdVisibleCandles: numberSetting(cvdPanelValues, "visibleCandles", settings.cvdVisibleCandles),
    depthDisplayLevels: numberSetting(depthPanelValues, "levels", settings.depthDisplayLevels),
    depthSmoothingLevels: numberSetting(depthPanelValues, "bucketAggregation", settings.depthSmoothingLevels),
    depthCurvePower: numberSetting(depthPanelValues, "curvePower", settings.depthCurvePower)
  }), [cvdPanelValues, depthPanelValues, settings]);
  const cvdSourceTimeframe = stringSetting(cvdPanelValues, "sourceTimeframe", "4h") as Timeframe;
  const cvdLookbackBars = numberSetting(cvdPanelValues, "lookbackBars", 240);
  const cvdCumulationType = stringSetting(cvdPanelValues, "cumulationType", "sum") as StructuralCvdCumulation;
  const cvdCumulationLength = numberSetting(cvdPanelValues, "cumulationLength", 14);
  const cvdNormalizeMovingAverages = booleanSetting(cvdPanelValues, "normalizeMovingAverages", true);
  const cvdScaleFactor = numberSetting(cvdPanelValues, "scaleFactor", 1);
  const cvdOutlierPercentile = numberSetting(cvdPanelValues, "outlierPercentile", 99);

  useEffect(() => {
    let cancelled = false;
    const cached = blackCoreMarketDataEngine.cache.getCandles(marketSymbol, cvdSourceTimeframe).slice(-cvdLookbackBars);
    if (cached.length) {
      setCvdHistoryCandles(cached);
      setCvdHistoryStatus(`ESTIMATED OHLCV / ${cached.length} BARS`);
    } else {
      setCvdHistoryCandles([]);
      setCvdHistoryStatus("LOADING STRUCTURAL FLOW");
    }
    const adapter = blackCoreMarketDataEngine.getAdapter(marketSymbol.exchange);
    const load = async () => {
      try {
        const candles = await adapter.getHistoricalCandles({
          exchange: marketSymbol.exchange,
          symbol: marketSymbol.rawSymbol,
          marketKind: marketSymbol.marketKind,
          timeframe: cvdSourceTimeframe,
          limit: Math.min(1000, Math.max(48, cvdLookbackBars))
        });
        if (cancelled) return;
        const bounded = candles.slice(-cvdLookbackBars);
        setCvdHistoryCandles((current) => sameCandleSeries(current, bounded) ? current : bounded);
        setCvdHistoryStatus(bounded.length ? `ESTIMATED OHLCV / ${bounded.length} BARS` : "CLASSIFIED TAPE FALLBACK");
      } catch {
        if (cancelled) return;
        const fallback = blackCoreMarketDataEngine.cache.getCandles(marketSymbol, cvdSourceTimeframe).slice(-cvdLookbackBars);
        setCvdHistoryCandles((current) => sameCandleSeries(current, fallback) ? current : fallback);
        setCvdHistoryStatus(fallback.length ? `CACHED OHLCV / ${fallback.length} BARS` : "CLASSIFIED TAPE FALLBACK");
      }
    };
    void load();
    const refreshMs = Math.max(60_000, numberSetting(cvdPanelValues, "updateIntervalMs", 5000) * 12);
    const timer = window.setInterval(load, refreshMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [cvdLookbackBars, cvdPanelValues, cvdSourceTimeframe, marketSymbol]);

  useEffect(() => {
    const panelUpdateStartedAt = performance.now();
    const rawBids = snapshot.sourceBook?.bids ?? [];
    const rawAsks = snapshot.sourceBook?.asks ?? [];
    if (rawBids.length || rawAsks.length) {
      depthProcessorRef.current.ingest(rawBids, rawAsks, numberSetting(depthPanelValues, "smoothingWindow", 12));
    }
    const scheduler = panelSchedulerRef.current;
    const due = new Set(configurablePanelIds.filter((panelId) => scheduler.coalesceUpdates(panelId, snapshot.generatedAt)));
    if (due.size) {
      setPanelSnapshots((current) => {
        const next = { ...current };
        for (const panelId of due) next[panelId] = snapshot;
        return next;
      });
    }
    if (due.has("depth-chart")) setDepthModelRevision((value) => value + 1);
    if (due.has("wall-detection")) {
      const minimumWallSize = numberSetting(wallPanelValues, "minimumWallSize", 0);
      setStableWalls(wallProcessorRef.current.update(snapshot.walls.filter((wall) => wall.size >= minimumWallSize), {
        activationScore: numberSetting(wallPanelValues, "activationScore", 62),
        deactivationScore: numberSetting(wallPanelValues, "deactivationScore", 44),
        minimumPersistenceMs: numberSetting(wallPanelValues, "minimumPersistenceMs", 8000),
        minimumObservations: numberSetting(wallPanelValues, "minimumObservations", 3),
        maximumRows: numberSetting(wallPanelValues, "maximumRows", 8),
        sortMode: stringSetting(wallPanelValues, "sortMode", "reliability"),
        majorOnly: booleanSetting(wallPanelValues, "majorOnly", false)
      }, snapshot.generatedAt));
    }
    if (due.has("trade-tape")) {
      const tapeStartedAt = performance.now();
      setStableTrades(aggregateTradeTape(snapshot.trades, {
        minimumTradeSize: numberSetting(tapePanelValues, "minimumTradeSize", 0),
        groupingIntervalMs: numberSetting(tapePanelValues, "groupingIntervalMs", 1000),
        aggregateSamePrice: booleanSetting(tapePanelValues, "aggregateSamePrice", true),
        displayRows: numberSetting(tapePanelValues, "displayRows", 22)
      }));
      domPerformanceTrace.record("panel.trade_tape", performance.now() - tapeStartedAt, snapshot.trades.length, numberSetting(tapePanelValues, "displayRows", 22));
    }
    if (due.has("dom-metrics")) {
      const metricsStartedAt = performance.now();
      setStableMetrics(metricsProcessorRef.current.update(
        snapshot.metrics,
        numberSetting(metricsPanelValues, "smoothingLength", 12),
        numberSetting(metricsPanelValues, "hysteresisPct", 5),
        numberSetting(metricsPanelValues, "stateChangeDelayMs", 5000),
        snapshot.generatedAt
      ));
      domPerformanceTrace.record("panel.metric_stabilization", performance.now() - metricsStartedAt, 1, 1);
    }
    domPerformanceTrace.record("panel.snapshot_commit", performance.now() - panelUpdateStartedAt, due.size, due.size);
  }, [depthPanelValues, metricsPanelValues, snapshot.generatedAt, snapshot.metrics, snapshot.sourceBook, snapshot.trades, snapshot.walls, tapePanelValues, wallPanelValues]);

  const cvdSnapshot = panelSnapshots["heuristic-cvd"];
  const depthSnapshot = panelSnapshots["depth-chart"];
  const profileSnapshot = panelSnapshots["volume-profile"];
  const heatmapSnapshot = panelSnapshots["liquidity-heatmap"];
  const ladderSnapshot = panelSnapshots.ladder;
  const macroBands = useMemo(
    () => settings.showMacroRadar ? buildMacroLiquidityBands(macroCandles, snapshot.lastPrice ?? lastPrice, settings) : [],
    [lastPrice, macroCandles, settings.macroBandCount, settings.macroLookbackDays, settings.showMacroRadar, snapshot.lastPrice]
  );
  const macroRange = useMemo(
    () => resolveMacroLiquidityRange(snapshot, macroCandles, macroBands, snapshot.lastPrice ?? lastPrice, settings),
    [lastPrice, macroBands, macroCandles, settings, snapshot]
  );
  const heatmapFrames = useMemo(() => heatmapSnapshot.heatmap.slice(-resolveHorizonFrameCount(settings)), [heatmapSnapshot.heatmap, settings]);
  const liquidityDataRange = useMemo(
    () => resolveLiquidityDataRange(heatmapSnapshot, macroBands, heatmapSnapshot.heatmap, macroRange),
    [heatmapSnapshot, macroBands, macroRange]
  );
  const heatmapRange = useMemo(
    () => applyHeatmapCamera(macroRange, liquidityDataRange, heatmapViewport, snapshot.lastPrice ?? lastPrice),
    [heatmapViewport, lastPrice, liquidityDataRange, macroRange, snapshot.lastPrice]
  );
  const sharedPriceCameraMode = settings.followMarket && !settings.freeExplore
    ? "follow"
    : heatmapViewport.mode === "fit" || heatmapViewport.mode === "full"
      ? "fit"
      : heatmapViewport.mode === "manual"
        ? "manual"
        : "explore";
  const sharedPriceRowCount = numberSetting(ladderPanelValues, "levels", settings.mode === "macro" ? 48 : 42);
  const sharedPriceCamera = useMemo(
    () => createDomProPriceCamera(heatmapRange, snapshot.lastPrice ?? lastPrice ?? midpoint(heatmapRange), sharedPriceRowCount, sharedPriceCameraMode),
    [heatmapRange, lastPrice, sharedPriceCameraMode, sharedPriceRowCount, snapshot.lastPrice]
  );
  const sharedPriceRange = useMemo(() => domCameraRange(sharedPriceCamera), [sharedPriceCamera]);
  const ladderCameraMode = stringSetting(ladderPanelValues, "cameraMode", "shared");
  const ladderPriceCamera = useMemo(() => {
    if (ladderCameraMode === "shared") return sharedPriceCamera;
    const marketPrice = ladderSnapshot.lastPrice ?? ladderSnapshot.midPrice ?? lastPrice ?? sharedPriceCamera.centerPrice;
    if (ladderCameraMode === "follow-current") {
      const halfSpan = (sharedPriceCamera.visiblePriceMax - sharedPriceCamera.visiblePriceMin) / 2;
      return createDomProPriceCamera({ min: Math.max(0.00000001, marketPrice - halfSpan), max: marketPrice + halfSpan, source: sharedPriceCamera.source }, marketPrice, sharedPriceRowCount, "follow");
    }
    const bookPrices = [...(ladderSnapshot.sourceBook?.bids ?? []), ...(ladderSnapshot.sourceBook?.asks ?? [])].map((level) => level.price).filter((value) => Number.isFinite(value) && value > 0);
    const localRange = bookPrices.length
      ? { min: Math.min(...bookPrices), max: Math.max(...bookPrices), source: "live-depth" as const }
      : sharedPriceRange;
    return createDomProPriceCamera(localRange, marketPrice, sharedPriceRowCount, "manual");
  }, [ladderCameraMode, ladderSnapshot.lastPrice, ladderSnapshot.midPrice, ladderSnapshot.sourceBook, lastPrice, sharedPriceCamera, sharedPriceRange, sharedPriceRowCount]);
  const ladderCoverageMode = stringSetting(ladderPanelValues, "coverageMode", "dim");
  const ladderModel = useMemo(() => buildDomLadderModel({
    snapshot: ladderSnapshot,
    camera: ladderPriceCamera,
    walls: stableWalls,
    bookStatus: feed.bookStatus,
    minimumSize: numberSetting(ladderPanelValues, "minimumSize", 0),
    hideUncovered: ladderCoverageMode === "hide"
  }), [feed.bookStatus, ladderCoverageMode, ladderPanelValues, ladderPriceCamera, ladderSnapshot, stableWalls]);
  const institutionalProfile = useMemo(
    () => traceCalculation("panel.volume_profile", profileSnapshot.volumeProfile.length + macroCandles.length, () => buildInstitutionalProfile(
      profileSnapshot.volumeProfile,
      macroCandles,
      sharedPriceCamera,
      numberSetting(profilePanelValues, "rowCount", 128)
    )),
    [macroCandles, profilePanelValues, profileSnapshot.volumeProfile, sharedPriceCamera]
  );
  const maxProfileVolume = Math.max(...institutionalProfile.map((node) => node.volume), 1);
  const profileOutline = useMemo(
    () => buildProfileOutline(institutionalProfile, maxProfileVolume, sharedPriceRange),
    [institutionalProfile, maxProfileVolume, sharedPriceRange]
  );
  const heatmapStructureRibbons = useMemo(
    () => buildHeatmapStructureRibbons(institutionalProfile, maxProfileVolume, sharedPriceRange, snapshot.lastPrice ?? lastPrice),
    [institutionalProfile, lastPrice, maxProfileVolume, sharedPriceRange, snapshot.lastPrice]
  );
  const depthHistory = useMemo(
    () => blackDepthHistoryStore.read(marketSymbol, sharedPriceRange, settings.heatmapHorizon),
    [depthHistoryRevision, marketSymbol, settings.heatmapHorizon, sharedPriceRange]
  );
  const depthCoverageGaps = useMemo(
    () => buildDepthCoverageGaps(sharedPriceRange, heatmapFrames, macroBands, heatmapStructureRibbons, depthHistory.points, snapshot.lastPrice ?? lastPrice),
    [depthHistory.points, heatmapFrames, heatmapStructureRibbons, lastPrice, macroBands, sharedPriceRange, snapshot.lastPrice]
  );
  const cvdStructure = useMemo(() => traceCalculation("panel.cvd_structure", cvdHistoryCandles.length + cvdSnapshot.trades.length, () => {
    const options = {
      cumulationType: cvdCumulationType,
      cumulationLength: cvdCumulationLength,
      normalizeMovingAverages: cvdNormalizeMovingAverages,
      scaleFactor: cvdScaleFactor,
      outlierPercentile: cvdOutlierPercentile
    };
    if (cvdHistoryCandles.length >= Math.min(12, cvdCumulationLength)) return buildStructuralCvdFromCandles(cvdHistoryCandles, options);
    return buildStructuralCvdFromTrades(cvdSnapshot.trades, timeframeSeconds(cvdSourceTimeframe), options);
  }), [cvdCumulationLength, cvdCumulationType, cvdHistoryCandles, cvdNormalizeMovingAverages, cvdOutlierPercentile, cvdScaleFactor, cvdSnapshot.trades, cvdSourceTimeframe]);
  const cvdData = useMemo(() => cvdStructure.map((point) => ({ time: point.time, value: point.cumulativeDelta })), [cvdStructure]);
  const cvdStats = useMemo(() => structuralCvdStats(cvdStructure, numberSetting(cvdPanelValues, "trendThreshold", 0.08)), [cvdPanelValues, cvdStructure]);
  const cvdCamera = useMemo(() => resolveCvdCamera(cvdViewport, cvdStructure.length, analyticalSettings), [analyticalSettings, cvdStructure.length, cvdViewport]);
  const cvdVisibleStructure = useMemo(() => cvdStructure.slice(cvdCamera.start, cvdCamera.end), [cvdCamera.end, cvdCamera.start, cvdStructure]);
  const cvdValueDomain = useMemo(() => structuralCvdRange(cvdVisibleStructure, cvdOutlierPercentile), [cvdOutlierPercentile, cvdVisibleStructure]);
  const cvdCameraLabel = cvdCamera.total > 0 ? `${cvdCamera.start + 1}-${cvdCamera.end} / ${cvdCamera.total}` : "No tape";
  const depthChartRange = useMemo(() => resolveDepthChartRange(depthSnapshot), [depthSnapshot]);
  const structuralDepth = useMemo(() => ({
    bids: depthProcessorRef.current.structural("bid", numberSetting(depthPanelValues, "persistenceThreshold", 55), numberSetting(depthPanelValues, "minimumVisibleSize", 0)),
    asks: depthProcessorRef.current.structural("ask", numberSetting(depthPanelValues, "persistenceThreshold", 55), numberSetting(depthPanelValues, "minimumVisibleSize", 0))
  }), [depthModelRevision, depthPanelValues]);
  const depthChart = useMemo(() => traceCalculation("panel.depth_chart", structuralDepth.bids.length + structuralDepth.asks.length, () => buildDepthChart(depthSnapshot, depthChartRange, analyticalSettings, stringSetting(depthPanelValues, "mode", "structural"), structuralDepth)), [analyticalSettings, depthChartRange, depthPanelValues, depthSnapshot, structuralDepth]);
  const stabilizedFlowSeries = useMemo(() => clipAndSmoothSeries(flowSeries, numberSetting(flowPanelValues, "outlierPercentile", 95), numberSetting(flowPanelValues, "smoothingLength", 10)), [flowPanelValues, flowSeries]);
  const flowBars = useMemo(() => traceCalculation("panel.flow_delta", stabilizedFlowSeries.length, () => buildFlowBars(stabilizedFlowSeries, analyticalSettings)), [analyticalSettings, stabilizedFlowSeries]);
  const debugStats = useMemo(
    () => buildDomDebugStats(snapshot, macroRange, sharedPriceRange, settings, heatmapFrames, institutionalProfile, depthChart, depthHistory, snapshot.lastPrice ?? lastPrice),
    [depthChart, depthHistory, heatmapFrames, institutionalProfile, lastPrice, macroRange, settings, sharedPriceRange, snapshot]
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
        cvdSmoothingLength: 14,
        cvdCandleSeconds: 30,
        cvdVisibleCandles: 36,
        depthDisplayLevels: 80,
        depthSmoothingLevels: 2,
        depthCurvePower: 0.82
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
        cvdSmoothingLength: 24,
        cvdCandleSeconds: 120,
        cvdVisibleCandles: 42,
        depthDisplayLevels: 140,
        depthSmoothingLevels: 3,
        depthCurvePower: 0.76
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
        cvdCandleSeconds: 900,
        cvdVisibleCandles: 72,
        depthDisplayLevels: 240,
        depthSmoothingLevels: 8,
        depthCurvePower: 0.62,
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
        cvdCandleSeconds: 300,
        cvdVisibleCandles: 48,
        depthDisplayLevels: 180,
        depthSmoothingLevels: 4,
        depthCurvePower: 0.72,
        macroLookbackDays: 365
      } satisfies Partial<DomSettings>);
      setHeatmapViewport(createCameraFromRange(resolveCameraPresetRange("24h", snapshot, macroBands, macroRange, snapshot.lastPrice ?? lastPrice), macroRange, "24h"));
    }
    setCvdViewport(defaultCvdCamera());
    setPanelRegistry((current) => applyDomWorkspacePreset(current, preset));
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
    domInteractionCoordinator.begin();
    domInteractionCoordinator.endAfter();
    if (settings.followMarket || !settings.freeExplore) patchSettings({ followMarket: false, freeExplore: true });
    const rect = event.currentTarget.getBoundingClientRect();
    const queued = pendingHeatmapWheelRef.current;
    pendingHeatmapWheelRef.current = {
      deltaY: (queued?.deltaY ?? 0) + event.deltaY,
      shiftKey: event.shiftKey,
      cursorY: event.clientY - rect.top,
      height: rect.height
    };
    domVisualScheduler.scheduleOnce(`dom-heatmap-wheel:${symbolKey}`, () => {
      const wheel = pendingHeatmapWheelRef.current;
      pendingHeatmapWheelRef.current = null;
      if (!wheel) return;
      setHeatmapViewport((current) => {
      const cameraHeight = resolveCameraHeight(current, macroRange);
      const currentCenter = current.cameraCenterPrice ?? snapshot.lastPrice ?? lastPrice ?? midpoint(macroRange);
      if (wheel.shiftKey) {
        return normalizeCamera({
          ...current,
          cameraCenterPrice: currentCenter + (wheel.deltaY / Math.max(1, wheel.height)) * cameraHeight,
          cameraHeight,
          mode: "manual"
        }, macroRange);
      }
      const cursorY = wheel.cursorY;
      const cursorPrice = priceFromY(cursorY, rect, {
        min: currentCenter - cameraHeight / 2,
        max: currentCenter + cameraHeight / 2,
        source: macroRange.source
      });
      const factor = wheel.deltaY > 0 ? Math.pow(1.18, Math.max(1, Math.abs(wheel.deltaY) / 120)) : Math.pow(1 / 1.18, Math.max(1, Math.abs(wheel.deltaY) / 120));
      const nextHeight = Math.max(macroRange.max * 0.000001, Math.min(cameraHeight * factor, rangeSpan(liquidityDataRange) * 100));
      const yPct = Math.max(0, Math.min(1, cursorY / Math.max(1, wheel.height)));
      const nextCenter = cursorPrice - (0.5 - yPct) * nextHeight;
      return normalizeCamera({
        ...current,
        cameraCenterPrice: nextCenter,
        cameraHeight: nextHeight,
        mode: "manual"
      }, macroRange);
      });
    }, 2);
  }, [lastPrice, liquidityDataRange, macroRange, settings.followMarket, settings.freeExplore, snapshot.lastPrice, symbolKey]);

  const handleHeatmapMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    domInteractionCoordinator.begin();
    if (settings.followMarket || !settings.freeExplore) patchSettings({ followMarket: false, freeExplore: true });
    heatmapDragRef.current = {
      startY: event.clientY,
      startCenterPrice: heatmapViewport.cameraCenterPrice ?? snapshot.lastPrice ?? lastPrice ?? midpoint(macroRange),
      cameraHeight: resolveCameraHeight(heatmapViewport, macroRange)
    };
  }, [heatmapViewport, lastPrice, macroRange, settings.followMarket, settings.freeExplore, snapshot.lastPrice]);

  const moveSharedPriceCamera = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const activeDrag = heatmapDragRef.current;
    if (!activeDrag) return false;
    const delta = (event.clientY - activeDrag.startY) / Math.max(1, rect.height);
    const nextCenter = activeDrag.startCenterPrice + delta * activeDrag.cameraHeight;
    pendingHeatmapDragRef.current = {
      centerPrice: nextCenter,
      cameraHeight: activeDrag.cameraHeight
    };
    domVisualScheduler.scheduleOnce(`dom-shared-price-drag:${symbolKey}`, () => {
        const pending = pendingHeatmapDragRef.current;
        pendingHeatmapDragRef.current = null;
        if (!pending) return;
        setHeatmapViewport((current) => normalizeCamera({
          ...current,
          cameraCenterPrice: pending.centerPrice,
          cameraHeight: pending.cameraHeight,
          mode: "manual"
        }, macroRange));
    }, 2);
    setDomHover(null);
    return true;
  }, [macroRange, symbolKey]);

  const handleHeatmapMouseMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (moveSharedPriceCamera(event)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    pendingHoverRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top, rect };
    domVisualScheduler.scheduleOnce(`dom-heatmap-hover:${symbolKey}`, () => {
      const hover = pendingHoverRef.current;
      pendingHoverRef.current = null;
      if (!hover || domInteractionCoordinator.isActive()) return;
      const startedAt = performance.now();
      setDomHover(buildHeatmapHoverAt(hover.x, hover.y, hover.rect, sharedPriceCamera, heatmapFrames, macroBands, snapshot.walls));
      domPerformanceTrace.record("tooltip.calculation", performance.now() - startedAt, heatmapFrames.length, 1);
    }, 4);
  }, [heatmapFrames, macroBands, moveSharedPriceCamera, sharedPriceCamera, snapshot.walls, symbolKey]);

  const handleCvdWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (cvdStructure.length <= 2) return;
    event.preventDefault();
    domInteractionCoordinator.begin();
    domInteractionCoordinator.endAfter();
    const rect = event.currentTarget.getBoundingClientRect();
    const anchor = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    const current = resolveCvdCamera(cvdViewport, cvdStructure.length, analyticalSettings);
    const factor = event.deltaY > 0 ? 1.24 : 1 / 1.24;
    const nextVisible = clampCvdVisibleCount(Math.round(current.visibleCount * factor), current.total);
    const anchorIndex = current.start + anchor * current.visibleCount;
    const nextStart = clampCvdStart(Math.round(anchorIndex - anchor * nextVisible), current.total, nextVisible);
    setCvdViewport({ startIndex: nextStart, visibleCount: nextVisible, followLatest: false });
  }, [analyticalSettings, cvdStructure.length, cvdViewport]);

  const handleCvdMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || cvdStructure.length <= 2) return;
    domInteractionCoordinator.begin();
    const rect = event.currentTarget.getBoundingClientRect();
    const current = resolveCvdCamera(cvdViewport, cvdStructure.length, analyticalSettings);
    cvdDragStartRef.current = {
      x: event.clientX,
      startIndex: current.start,
      visibleCount: current.visibleCount,
      total: current.total,
      width: Math.max(1, rect.width)
    };
  }, [analyticalSettings, cvdStructure.length, cvdViewport]);

  const handleCvdMouseMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const activeDrag = cvdDragStartRef.current;
    if (!activeDrag) return;
    const deltaCandles = Math.round(((event.clientX - activeDrag.x) / activeDrag.width) * activeDrag.visibleCount);
    const nextStart = clampCvdStart(activeDrag.startIndex - deltaCandles, activeDrag.total, activeDrag.visibleCount);
    domVisualScheduler.scheduleOnce(`dom-cvd-drag:${symbolKey}`, () => setCvdViewport({ startIndex: nextStart, visibleCount: activeDrag.visibleCount, followLatest: false }), 2);
  }, [symbolKey]);

  const handleCvdMouseUp = useCallback(() => {
    cvdDragStartRef.current = null;
    domInteractionCoordinator.endAfter();
  }, []);

  const handleCvdDoubleClick = useCallback(() => {
    setCvdViewport(defaultCvdCamera());
  }, []);

  const handleProfileMouseMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (moveSharedPriceCamera(event)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setDomHover(buildProfileHover(event, rect, sharedPriceCamera, institutionalProfile));
  }, [institutionalProfile, moveSharedPriceCamera, sharedPriceCamera]);

  const handleLadderMouseMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (ladderCameraMode === "shared" && moveSharedPriceCamera(event)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const price = ladderPriceCamera.visiblePriceMax - y / Math.max(1, rect.height) * (ladderPriceCamera.visiblePriceMax - ladderPriceCamera.visiblePriceMin);
    const bucket = domPriceBucketAt(ladderPriceCamera, price);
    const row = bucket ? ladderModel.rows.find((candidate) => candidate.key === bucket.key) : null;
    if (!bucket || !row) return setDomHover(null);
    const coverageLabel = row.coverage === "live" ? "Live venue book" : row.coverage === "unavailable" ? "Outside live book coverage" : row.coverage.toUpperCase();
    setDomHover({
      x,
      y,
      price: bucket.center,
      priceBucketKey: bucket.key,
      title: "PRICE BUCKET",
      lines: [
        `${formatPrice(bucket.low)} - ${formatPrice(bucket.high)}`,
        `Live bid ${row.coverage === "live" ? formatDomLadderQuantity(row, "bid", ladderDisplayUnits === "notional" ? 0 : 3, ladderDisplayUnits) : "unavailable"} ${ladderUnitLabel(ladderDisplayUnits, marketSymbol)}`,
        `Live ask ${row.coverage === "live" ? formatDomLadderQuantity(row, "ask", ladderDisplayUnits === "notional" ? 0 : 3, ladderDisplayUnits) : "unavailable"} ${ladderUnitLabel(ladderDisplayUnits, marketSymbol)}`,
        ...(ladderShowNetDepth ? [`Net depth ${formatLadderNetDepth(row.netDepth, row.centerPrice, ladderDisplayUnits)} ${ladderUnitLabel(ladderDisplayUnits, marketSymbol)}`] : []),
        row.wall ? `IMM ${row.wall.side} wall / ${row.wall.persistencePct.toFixed(0)}% persistence` : "IMM wall none",
        coverageLabel
      ]
    });
  }, [ladderCameraMode, ladderDisplayUnits, ladderModel.rows, ladderPriceCamera, ladderShowNetDepth, marketSymbol, moveSharedPriceCamera]);

  useEffect(() => {
    const clearDrag = () => {
      heatmapDragRef.current = null;
      pendingHeatmapDragRef.current = null;
      cvdDragStartRef.current = null;
      domInteractionCoordinator.endAfter();
    };
    window.addEventListener("mouseup", clearDrag);
    return () => {
      window.removeEventListener("mouseup", clearDrag);
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

  const panelHeaderProps = (panelId: DomPanelId) => ({
    panelId,
    panel: panelRegistry.panels[panelId],
    scheduler: panelSchedulerRef.current.reportMetrics(panelId)[0],
    dataQuality: snapshot.status === "live" ? "LIVE" : snapshot.status === "degraded" ? "PARTIAL" : "STALE",
    onPatch: (patch: Partial<DomPanelValues>) => patchPanelSettings(panelId, patch),
    onPreset: (preset: string) => setPanelRegistry((current) => applyDomPanelPreset(current, panelId, preset)),
    onReset: () => setPanelRegistry((current) => resetDomPanel(current, panelId)),
    onSaveDefault: () => setPanelRegistry((current) => ({
      ...current,
      panels: { ...current.panels, [panelId]: { ...current.panels[panelId], defaultSettings: { ...current.panels[panelId].settings }, updatedAt: Date.now() } }
    })),
    collapsed: layout.panelStates[panelId].collapsed,
    maximized: layout.maximizedPanel === panelId,
    onCollapse: () => setLayout((current) => patchDomPanelLayout(current, panelId, { collapsed: !current.panelStates[panelId].collapsed })),
    onMaximize: () => setLayout((current) => maximizeDomPanel(current, current.maximizedPanel === panelId ? null : panelId))
  });
  const ladderLabelStride = ladderModel.rows.length > 72 ? 4 : ladderModel.rows.length > 48 ? 3 : ladderModel.rows.length > 36 ? 2 : 1;
  const ladderCoverageTop = ladderModel.coverage.max === null ? null : domPriceToTopPct(ladderPriceCamera, ladderModel.coverage.max);
  const ladderCoverageBottom = ladderModel.coverage.min === null ? null : domPriceToTopPct(ladderPriceCamera, ladderModel.coverage.min);
  const showLadderCoverage = booleanSetting(ladderPanelValues, "showLiveCoverage", true);
  const showWallConfluence = booleanSetting(ladderPanelValues, "showWallConfluence", true);
  const ladderShared = ladderCameraMode === "shared";
  const ladderUnit = ladderUnitLabel(ladderDisplayUnits, marketSymbol);

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
          <label>
            <span>Performance</span>
            <select value={settings.performanceMode} onChange={(event) => patchSettings({ performanceMode: event.target.value as DomPerformanceMode })}>
              <option value="maximum-performance">Maximum Performance</option>
              <option value="balanced">Balanced</option>
              <option value="maximum-detail">Maximum Detail</option>
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
            <Field label="Macro Lookback" value={settings.macroLookbackDays} min={90} max={1000} onChange={(value) => patchSettings({ macroLookbackDays: value })} />
            <Field label="Macro Bands" value={settings.macroBandCount} min={4} max={18} onChange={(value) => patchSettings({ macroBandCount: value })} />
            <label className="dom-pro-layout-preset-field"><span>Workspace Layout</span><select value={layout.preset} onChange={(event) => setLayout((current) => applyDomProLayoutPreset(current, event.target.value as DomProLayoutPreset))}><option value="scalper">Scalper</option><option value="intraday">Intraday</option><option value="institutional">Institutional</option><option value="macro">Macro</option><option value="compact-execution">Compact Execution</option><option value="analysis-focus">Analysis Focus</option></select></label>
            {customLayoutPresets.length > 0 && <label className="dom-pro-layout-preset-field"><span>Custom Preset</span><select defaultValue="" onChange={(event) => { const next = readDomProLayoutPreset(workspaceId, event.target.value); if (next) setLayout(next); event.currentTarget.value = ""; }}><option value="" disabled>Load preset</option>{customLayoutPresets.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>}
            <Toggle label="Auto-Save Layout" checked={layout.autoSave} onChange={(value) => setLayout((current) => ({ ...current, autoSave: value, updatedAt: Date.now() }))} />
            <button type="button" className="dom-pro-global-reset" onClick={() => { writeDomProLayout(layout, windowMode); setSettingsTransferStatus("Workspace layout saved"); }}>Save Layout</button>
            <button type="button" className="dom-pro-global-reset" onClick={() => { const name = window.prompt("Preset name"); if (name) { saveDomProLayoutPreset(layout, name); setCustomLayoutPresets(listDomProLayoutPresets(workspaceId)); setSettingsTransferStatus(`Saved layout preset: ${name.trim()}`); } }}>Save as New Preset</button>
            <button type="button" className="dom-pro-global-reset" onClick={() => setLayout((current) => { const target = createDomProLayout(workspaceId, current.preset).rootSplit.ratio; return resizeDomSplit(current, "root", "workspace-upper-bottom", target - current.rootSplit.ratio); })}>Reset Bottom Row</button>
            <button type="button" className="dom-pro-global-reset" onClick={() => { if (window.confirm("Reset the complete DOM Pro layout to its factory preset?")) setLayout(createDomProLayout(workspaceId, layout.preset)); }}>Restore Factory Layout</button>
            <button type="button" className="dom-pro-global-reset" onClick={() => setPanelRegistry((current) => resetAllDomPanels(current))}>Reset All Panels</button>
            <button type="button" className="dom-pro-global-reset" onClick={() => void exportPanelSettings()}>Export Settings</button>
            <button type="button" className="dom-pro-global-reset" onClick={importPanelSettings}>Import Settings</button>
            {settingsTransferStatus && <span className="dom-pro-settings-status">{settingsTransferStatus}</span>}
            {settings.bucketMultiplier === "custom" && <Field label="Custom Bucket" value={settings.customBucketSize} min={0.01} max={10000} step={0.01} onChange={(value) => patchSettings({ customBucketSize: value })} />}
          </section>
        )}

        <main
          ref={gridRef}
          className={`dom-pro-grid ${resizeActive ? "resize-active" : ""} ${layout.maximizedPanel ? "has-maximized" : ""}`}
          style={{ "--dom-upper-height": `${layout.rootSplit.ratio * 100}%` } as CSSProperties}
        >
          <div
            ref={upperWorkspaceRef}
            className={`dom-pro-workspace-region dom-pro-upper-workspace ${layout.maximizedPanel && ["depth-chart", "liquidity-flow-delta", "execution"].includes(layout.maximizedPanel) ? "workspace-hidden" : ""} ${layout.maximizedPanel ? "workspace-maximized" : ""}`}
            style={{ gridTemplateColumns: upperColumns }}
          >
          <section className={panelLayoutClass("ladder", "dom-pro-ladder")}>
            <PanelTitle title="Aggregated DOM Ladder" status={`${ladderShared ? "SHARED" : ladderCameraMode.toUpperCase()} / ${ladderModel.coverage.state.toUpperCase()} ${ladderModel.coverage.subscribedDepth ?? Math.max(ladderModel.coverage.bidLevels, ladderModel.coverage.askLevels)}L`} {...panelHeaderProps("ladder")} />
            <div className="dom-pro-ladder-head"><span>Price ({marketSymbol.quoteAsset})</span><span>Bid Size ({ladderUnit})</span><span>Ask Size ({ladderUnit})</span></div>
            <div
              className={`dom-pro-ladder-book shared-camera ${ladderShared ? "is-shared" : "is-independent"}`}
              data-camera-version={ladderPriceCamera.version}
              data-camera-min={ladderPriceCamera.visiblePriceMin}
              data-camera-max={ladderPriceCamera.visiblePriceMax}
              data-bucket-size={ladderPriceCamera.bucketSize}
              data-current-price-top={domPriceToTopPct(ladderPriceCamera, ladderSnapshot.lastPrice ?? ladderPriceCamera.centerPrice)}
              onWheel={ladderShared ? handleHeatmapWheel : undefined}
              onMouseDown={ladderShared ? handleHeatmapMouseDown : undefined}
              onMouseMove={handleLadderMouseMove}
              onMouseLeave={() => setDomHover(null)}
              onDoubleClick={ladderShared ? centerMarketCamera : undefined}
            >
              {showLadderCoverage && ladderCoverageTop !== null && ladderCoverageBottom !== null && (
                <div className="dom-pro-ladder-coverage" style={{ top: `${ladderCoverageTop}%`, height: `${Math.max(0.35, ladderCoverageBottom - ladderCoverageTop)}%` }} aria-hidden="true" />
              )}
              {ladderModel.rows.map((row, index) => {
                const showValues = index % ladderLabelStride === 0 || row.totalSize > 0 || row.isCurrentPrice || row.wall !== null;
                return (
                  <div
                    className={`dom-pro-ladder-row shared-row ${row.coverage} ${ladderCoverageMode === "dim" && row.coverage === "unavailable" ? "dimmed" : ""} ${row.isCurrentPrice ? "current" : ""} ${row.isBestBid ? "best-bid" : ""} ${row.isBestAsk ? "best-ask" : ""} ${domHover?.price !== undefined && domHover.price >= row.priceLow && domHover.price <= row.priceHigh ? "hovered" : ""} ${row.wall && showWallConfluence ? `wall-confluence ${row.wall.side}` : ""}`}
                    key={row.key}
                    data-bucket-key={row.key}
                    data-price-low={row.priceLow}
                    data-price-high={row.priceHigh}
                    data-coverage={row.coverage}
                    data-bid-size={row.bidSize}
                    data-ask-size={row.askSize}
                    style={{ top: `${row.topPct}%`, height: `${row.heightPct}%` }}
                  >
                    <span>{showValues ? formatPrice(row.centerPrice) : ""}</span>
                    <span>{showValues ? formatDomLadderQuantity(row, "bid", ladderDisplayUnits === "notional" ? 0 : 3, ladderDisplayUnits) : ""}</span>
                    <span className="red">{showValues ? formatDomLadderQuantity(row, "ask", ladderDisplayUnits === "notional" ? 0 : 3, ladderDisplayUnits) : ""}</span>
                    <i className="bid-depth" style={{ transform: `scaleX(${row.bidDepth})` }} />
                    <i className="ask-depth" style={{ transform: `scaleX(${row.askDepth})` }} />
                    {row.wall && showWallConfluence && <mark title={`${row.wall.side.toUpperCase()} wall / ${row.wall.persistencePct.toFixed(0)}% persistence`}>{row.wall.side === "buy" ? "B" : "S"}</mark>}
                  </div>
                );
              })}
              {ladderSnapshot.lastPrice !== null && (
                <div className="dom-pro-ladder-current-line" style={{ top: `${domPriceToTopPct(ladderPriceCamera, ladderSnapshot.lastPrice)}%` }}>
                  <b>{formatPrice(ladderSnapshot.lastPrice)}</b><span>Spread {formatPrice(ladderSnapshot.spread ?? 0)}</span>
                </div>
              )}
              {showLadderCoverage && <div className="dom-pro-ladder-coverage-label">LIVE BOOK {formatPrice(ladderModel.coverage.min)} - {formatPrice(ladderModel.coverage.max)} · {ladderModel.coverage.bidLevels}B/{ladderModel.coverage.askLevels}A</div>}
              {domHover && <HoverTooltip hover={domHover} />}
            </div>
          </section>

          <section className={panelLayoutClass("volume-profile", "dom-pro-profile")}>
            <PanelTitle title="Volume Profile" status="ESTIMATED / VISIBLE RANGE" {...panelHeaderProps("volume-profile")} />
            {!settings.showVolumeProfile ? <EmptyState text="Volume profile hidden in DOM settings." /> : institutionalProfile.length === 0 ? <EmptyState text="Awaiting live orderbook or historical candles." /> : (
                  <div className="dom-pro-profile-scale shared-camera" data-camera-version={sharedPriceCamera.version} data-camera-min={sharedPriceCamera.visiblePriceMin} data-camera-max={sharedPriceCamera.visiblePriceMax} data-resolution-rows={institutionalProfile.length} data-current-price-top={domPriceToTopPct(sharedPriceCamera, snapshot.lastPrice ?? lastPrice)} onWheel={handleHeatmapWheel} onMouseDown={handleHeatmapMouseDown} onMouseMove={handleProfileMouseMove} onMouseLeave={() => setDomHover(null)} onDoubleClick={centerMarketCamera}>
                <div className="dom-pro-profile-axis">
                  {buildPriceScale(sharedPriceRange).map((price) => <span key={price} style={{ top: priceToTop(price, sharedPriceRange) }}>{formatPrice(price)}</span>)}
                </div>
                <svg className="dom-pro-profile-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                  {profileOutline.area && <polygon points={profileOutline.area} />}
                  {profileOutline.line && <polyline points={profileOutline.line} />}
                </svg>
                {institutionalProfile.map((node) => (
                  <div className={`dom-pro-profile-node native-row ${node.kind} ${node.volume <= 0 ? "empty" : ""} ${domHover?.price !== undefined && domHover.price >= node.low && domHover.price <= node.high ? "hovered" : ""}`} data-profile-key={node.key} data-price-low={node.low} data-price-high={node.high} key={node.key} style={{ top: `${node.topPct}%`, height: `${node.heightPct}%` }}>
                    <i style={{ width: `${node.volume <= 0 ? 0 : Math.max(3, node.volume / maxProfileVolume * 100)}%` }} />
                  </div>
                ))}
                {profileShowLabels && <div className="dom-pro-profile-label-layer dense" aria-hidden="true">
                  {institutionalProfile.map((node) => node.volume > 0 ? (
                    <div className={`dom-pro-profile-label ${node.kind}`} key={`label:${node.key}`} style={{ top: `${node.topPct + node.heightPct / 2}%` }}>
                      <span>{formatPrice(node.price)}</span>
                      <b>{node.kind.toUpperCase()}</b>
                    </div>
                  ) : null)}
                </div>}
                <div className="dom-pro-profile-current-line" style={{ top: `${domPriceToTopPct(sharedPriceCamera, snapshot.lastPrice ?? lastPrice)}%` }} aria-hidden="true" />
                <div className="dom-pro-profile-legend"><span>POC</span><span>VALUE AREA</span><span>HVN</span><span>LVN</span></div>
              </div>
            )}
          </section>

          <section className={panelLayoutClass("liquidity-heatmap", "dom-pro-heatmap")}>
            <PanelTitle title="Liquidity Heatmap" status={`${settings.heatmapHorizon.toUpperCase()} HISTORICAL DEPTH`} {...panelHeaderProps("liquidity-heatmap")} />
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
                <DomHeatmapCanvas
                  frames={heatmapFrames}
                  camera={sharedPriceCamera}
                  macroBands={macroBands}
                  depthPoints={depthHistory.points}
                  ribbons={heatmapStructureRibbons}
                  gaps={depthCoverageGaps}
                  currentPrice={snapshot.lastPrice ?? lastPrice}
                  quality={effectiveVisualQuality}
                  interactionActive={interactionActive}
                  hoveredPrice={domHover?.price}
                  enhancedGraphics={booleanSetting(heatmapPanelValues, "enhancedGraphics", true)}
                  showLevelDetails={booleanSetting(heatmapPanelValues, "showLabels", true)}
                />
                {domHover && <HoverTooltip hover={domHover} />}
                <div className="dom-pro-heatmap-footer"><span>{macroStatus}</span><span>{qualityLabel(effectiveVisualQuality)} / {sharedPriceRange.source.replace("-", " ").toUpperCase()} / {formatCameraZoom(heatmapViewport, macroRange)} / {formatPrice(sharedPriceRange.min)}-{formatPrice(sharedPriceRange.max)}</span></div>
              </div>
            )}
          </section>

          <section className={panelLayoutClass("wall-detection", "dom-pro-walls")} onMouseEnter={() => setPanelHoverFreeze("wall-detection", true)} onMouseLeave={() => setPanelHoverFreeze("wall-detection", false)}>
            <PanelTitle title="Wall Detection" status="DERIVED / PERSISTENCE" {...panelHeaderProps("wall-detection")} />
            {!settings.showWallDetection ? <EmptyState text="Wall detection hidden in DOM settings." /> : stableWalls.length === 0 ? <EmptyState text="No walls meet current persistence threshold." /> : (
              <>
                <div className="dom-pro-wall-head"><span>Type</span><span>Price</span><span>Size</span><span>Age</span></div>
                {stableWalls.map((wall) => (
                  <div className={`dom-pro-wall ${wall.side}`} key={wall.id}>
                    <b>{wall.side === "sell" ? "SELL WALL" : "BUY WALL"}</b>
                    <span>{formatPrice(wall.price)}</span>
                    <em>{formatSize(wall.size)} {marketSymbol.baseAsset}</em>
                    <small>{formatDuration(wall.persistenceMs)} / {wall.persistencePct.toFixed(0)}% / {wall.lifecycle?.toUpperCase() ?? "ACTIVE"} / R{(wall.reliability ?? wall.score).toFixed(0)}</small>
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

          <section className={panelLayoutClass("trade-tape", "dom-pro-tape")} onMouseEnter={() => setPanelHoverFreeze("trade-tape", true)} onMouseLeave={() => setPanelHoverFreeze("trade-tape", false)}>
            <PanelTitle title="Trade Tape" status={feed.tradeStatus} {...panelHeaderProps("trade-tape")} />
            {stableTrades.length === 0 ? <EmptyState text="Trade classification unavailable." /> : (
              <>
                <div className="dom-pro-tape-head"><span>Time</span><span>Price</span><span>Size</span><span>Side</span></div>
                {stableTrades.map((trade) => (
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

          <section className={panelLayoutClass("dom-metrics", "dom-pro-metrics")} onMouseEnter={() => setPanelHoverFreeze("dom-metrics", true)} onMouseLeave={() => setPanelHoverFreeze("dom-metrics", false)}>
            <PanelTitle title="DOM Metrics" status={`SMOOTHED / ${exchangeLabel.toUpperCase()}`} {...panelHeaderProps("dom-metrics")} />
            <Metric label="Orderbook Imbalance" value={`${(stableMetrics?.orderBookImbalance ?? snapshot.metrics.orderBookImbalance).toFixed(2)}%`} note={(stableMetrics?.orderBookImbalance ?? snapshot.metrics.orderBookImbalance) >= 0 ? "BID HEAVY" : "ASK HEAVY"} />
            <Metric label="Depth Imbalance" value={`${(stableMetrics?.depthImbalance ?? snapshot.metrics.depthImbalance).toFixed(1)}%`} note="VISIBLE" />
            <Metric label="Derived Liquidity Score" value={`${(stableMetrics?.liquidityScore ?? snapshot.metrics.liquidityScore).toFixed(0)} / 100`} note="STRUCTURE" />
            <Metric label="Absorption" value={snapshot.absorption.detected ? "DETECTED" : "NONE"} note={snapshot.absorption.label} hot={snapshot.absorption.detected} />
            <Metric label="Pulling / Stacking" value={stableMetrics?.liquidityState ?? "BALANCED"} note={`${(stableMetrics?.confidence ?? 0).toFixed(0)}% CONFIDENCE`} hot />
            <Metric label="Large Trades (1m)" value={String(Math.round(stableMetrics?.largeTradesLastMinute ?? snapshot.metrics.largeTradesLastMinute))} note="LAST 60S" />
            <Metric label="Est. Icebergs" value={`${snapshot.iceberg.estimatedCount}`} note={`${snapshot.iceberg.probability.toUpperCase()} PROBABILITY`} hot={snapshot.iceberg.probability !== "low"} />
            <Metric label="Latency" value={`${snapshot.metrics.latencyMs.toFixed(0)} ms`} note={feed.bookStatus} />
          </section>

          {settings.showCvd && (
            <section className={panelLayoutClass("heuristic-cvd", "dom-pro-cvd")}>
              <PanelTitle title="Structural CVD" status={`${cvdSourceTimeframe.toUpperCase()} / ${cvdStats.trend.toUpperCase()}`} {...panelHeaderProps("heuristic-cvd")} />
              <div className="dom-pro-cvd-card">
                {cvdStructure.length === 0 ? <EmptyState text="Historical OHLCV and classified trade flow are unavailable." /> : (
                  <>
                    <div className="dom-pro-cvd-stats">
                      <span>Delta <b>{formatSignedCompact(cvdStats.current)}</b></span>
                      <span>Change <b>{formatSignedCompact(cvdStats.windowDelta)}</b></span>
                      <span>Buy <b>{cvdStats.buyPct.toFixed(0)}%</b></span>
                      <span>Sell <b>{cvdStats.sellPct.toFixed(0)}%</b></span>
                      <span>Source <b>{cvdHistoryCandles.length ? "EST OHLCV" : "LIVE TAPE"}</b></span>
                    </div>
                    <div className="dom-pro-cvd-chart" onWheel={handleCvdWheel} onMouseDown={handleCvdMouseDown} onMouseMove={handleCvdMouseMove} onMouseUp={handleCvdMouseUp} onMouseLeave={handleCvdMouseUp} onDoubleClick={handleCvdDoubleClick}>
                      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Structural cumulative volume delta">
                        {buildStructuralCvdAxis(cvdValueDomain).map((level) => (
                          <g key={level.label}><line className={level.value === 0 ? "cvd-zero" : "cvd-grid"} x1="5" x2="98" y1={level.y} y2={level.y} /><text x="97" y={Math.max(6, level.y - 1.4)} textAnchor="end">{level.label}</text></g>
                        ))}
                        {booleanSetting(cvdPanelValues, "showDeltaBars", true) && cvdVisibleStructure.map((point, index) => {
                          const geometry = structuralCvdBarGeometry(point, index, cvdVisibleStructure, cvdValueDomain);
                          return <rect key={`${point.time}-${index}`} className={`cvd-delta-bar ${point.cumulativeDelta >= 0 ? "positive" : "negative"}`} x={geometry.x} y={geometry.y} width={geometry.width} height={geometry.height}><title>{formatCvdTimestamp(point.time)} · rolling {formatSignedCompact(point.cumulativeDelta)} · bar {formatSignedCompact(point.delta)}</title></rect>;
                        })}
                        {booleanSetting(cvdPanelValues, "showBuySellEnvelope", true) && <>
                          <path className="cvd-structure-line buy" d={buildStructuralCvdStepPath(cvdVisibleStructure, "cumulativeBuy", cvdValueDomain)} />
                          <path className="cvd-structure-line sell" d={buildStructuralCvdStepPath(cvdVisibleStructure, "cumulativeSell", cvdValueDomain)} />
                        </>}
                        {buildStructuralCvdTimeAxis(cvdVisibleStructure).map((label) => <text className="cvd-time-label" key={`${label.time}-${label.x}`} x={label.x} y="98" textAnchor={label.anchor}>{label.label}</text>)}
                      </svg>
                      <div className="dom-pro-cvd-source"><span>{cvdHistoryStatus}</span><span>{cvdCameraLabel}</span></div>
                    </div>
                  </>
                )}
              </div>
            </section>
          )}

          {settings.showDiagnostics && (
            <section className={panelLayoutClass("performance", "dom-pro-performance")}>
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

          {upperSeparators.map((separator) => <DomResizeHandle key={separator.splitId} region="upper" splitId={separator.splitId} position={separator.position} orientation="vertical" onPointerDown={beginLayoutResize} onKeyDown={keyboardResize} onReset={resetLayoutSplit} />)}
          </div>

          <DomResizeHandle region="root" splitId="workspace-upper-bottom" position={layout.rootSplit.ratio} orientation="horizontal" onPointerDown={beginLayoutResize} onKeyDown={keyboardResize} onReset={resetLayoutSplit} />

          <div
            ref={bottomWorkspaceRef}
            className={`dom-pro-workspace-region dom-pro-bottom-workspace ${layout.maximizedPanel && !["depth-chart", "liquidity-flow-delta", "execution"].includes(layout.maximizedPanel) ? "workspace-hidden" : ""} ${layout.maximizedPanel ? "workspace-maximized" : ""}`}
            style={{ gridTemplateColumns: bottomColumns }}
          >

          <section className={panelLayoutClass("depth-chart", "dom-pro-depth-chart")}>
            <PanelTitle title="Depth Chart" status={`${stringSetting(depthPanelValues, "mode", "structural").toUpperCase()} DEPTH`} {...panelHeaderProps("depth-chart")} />
            {!settings.showDepthChart ? <EmptyState text="Depth chart hidden in DOM settings." /> : depthChart.empty ? <EmptyState text="Depth chart awaiting bid/ask buckets." /> : (
              <div className="dom-pro-depth-wrap">
                <svg className="dom-pro-depth-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Cumulative market depth">
                  <line className="axis" x1="50" y1="8" x2="50" y2="94" />
                  <line className="axis zero" x1="0" y1="94" x2="100" y2="94" />
                  {depthChart.bidArea && <polygon className="bid-fill" points={depthChart.bidArea} />}
                  {depthChart.askArea && <polygon className="ask-fill" points={depthChart.askArea} />}
                  {depthChart.bidLine && <polyline className="bid-line" points={depthChart.bidLine} />}
                  {depthChart.askLine && <polyline className="ask-line" points={depthChart.askLine} />}
                </svg>
                <div className="dom-pro-depth-summary"><b>Structural Bias {depthChart.bias}</b><span>Bid {depthChart.bidPct.toFixed(0)}% / Ask {depthChart.askPct.toFixed(0)}%</span></div>
                {depthChart.warning && <span>{depthChart.warning}</span>}
              </div>
            )}
          </section>

          <section className={panelLayoutClass("liquidity-flow-delta", "dom-pro-flow")}>
            <PanelTitle title="Liquidity Flow Delta" status="DERIVED / PULL / STACK" {...panelHeaderProps("liquidity-flow-delta")} />
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

          {settings.showExecutionPanel && (
            <section className={panelLayoutClass("execution", "dom-pro-execution")}>
              <PanelTitle title="Execution" status={selectedConnection ? selectedConnection.label.toUpperCase() : "NO ACCOUNT"} {...panelHeaderProps("execution")} />
              <div className="dom-pro-product-switch" role="tablist" aria-label="Trading product">
                <button type="button" role="tab" aria-selected={executionMarketKind === "spot"} className={executionMarketKind === "spot" ? "active" : ""} onClick={() => setExecutionMarketKind("spot")}>Spot</button>
                <button type="button" role="tab" aria-selected={executionMarketKind !== "spot"} className={executionMarketKind !== "spot" ? "active" : ""} onClick={() => setExecutionMarketKind("perpetual")}>Futures</button>
              </div>
              <div className="dom-pro-execution-form">
                <label><span>Order Type</span><select value={orderType} onChange={(event) => setOrderType(event.target.value as OrderType)}>{venueOrderTypes.map((type) => <option key={type} value={type}>{formatOrderTypeLabel(type)}</option>)}</select></label>
                {venueTimeInForce.length > 0 ? (
                  <label><span>TIF</span><select value={timeInForce} onChange={(event) => setTimeInForce(event.target.value as TimeInForce)}>{venueTimeInForce.map((tif) => <option key={tif} value={tif}>{tif.toUpperCase()}</option>)}</select></label>
                ) : <label className="read-only"><span>TIF</span><b>Venue Default</b></label>}
                {executionMarketKind !== "spot" && <label><span>Margin</span><select value={marginMode} onChange={(event) => setMarginMode(event.target.value as MarginMode)}>{(venueSchema?.supportedMarginModes.length ? venueSchema.supportedMarginModes : ["cross", "isolated"]).map((mode) => <option key={mode} value={mode}>{titleCase(String(mode))}</option>)}</select></label>}
                {executionMarketKind !== "spot" && <label><span>Leverage</span><select value={leverage} onChange={(event) => setLeverage(Number(event.target.value))}>{leverageOptions.map((value) => <option key={value} value={value}>{value}x</option>)}</select></label>}
                <label><span>Qty ({marketSymbol.baseAsset})</span><input value={quantity} onChange={(event) => { setQuantity(event.target.value); setEquityAllocation(0); }} inputMode="decimal" /></label>
                {requiresLimitPrice && <label><span>Price ({marketSymbol.quoteAsset})</span><input value={price} placeholder={formatPrice(executionPrice)} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" /></label>}
              </div>
              {["stop-market", "stop-limit"].includes(orderType) && <div className="dom-pro-strategy-grid">
                <label><span>Trigger Price</span><input value={stopPrice} onChange={(event) => setStopPrice(event.target.value)} inputMode="decimal" /></label>
                <label><span>Trigger By</span><select value={triggerBy} onChange={(event) => setTriggerBy(event.target.value as TriggerSource)}><option value="last">Last Price</option><option value="mark">Mark Price</option><option value="index">Index Price</option></select></label>
              </div>}
              {orderType === "chase-limit" && <div className="dom-pro-strategy-grid">
                <label><span>Chase Unit</span><select value={strategyChaseUnit} onChange={(event) => setStrategyChaseUnit(event.target.value as "distance" | "percent")}><option value="distance">Price Distance</option><option value="percent">Percentage</option></select></label>
                <label><span>Chase {strategyChaseUnit === "distance" ? "Distance" : "%"}</span><input value={strategyChaseValue} onChange={(event) => setStrategyChaseValue(event.target.value)} inputMode="decimal" /></label>
                <label><span>Trigger Price</span><input value={strategyTriggerPrice} onChange={(event) => setStrategyTriggerPrice(event.target.value)} placeholder="Optional" inputMode="decimal" /></label>
                <label><span>Maximum Chase</span><input value={strategyMaxChasePrice} onChange={(event) => setStrategyMaxChasePrice(event.target.value)} placeholder="Optional" inputMode="decimal" /></label>
              </div>}
              {orderType === "twap" && <div className="dom-pro-strategy-grid">
                <label><span>Running Time</span><select value={strategyDurationSeconds} onChange={(event) => setStrategyDurationSeconds(Number(event.target.value))}><option value={600}>10 minutes</option><option value={1800}>30 minutes</option><option value={3600}>1 hour</option><option value={14400}>4 hours</option><option value={28800}>8 hours</option></select></label>
                <label><span>Child Interval</span><select value={strategyIntervalSeconds} onChange={(event) => setStrategyIntervalSeconds(Number(event.target.value))}><option value={5}>5 seconds</option><option value={10}>10 seconds</option><option value={15}>15 seconds</option><option value={30}>30 seconds</option><option value={60}>60 seconds</option><option value={120}>120 seconds</option></select></label>
                <label><span>Trigger Price</span><input value={strategyTriggerPrice} onChange={(event) => setStrategyTriggerPrice(event.target.value)} placeholder="Optional" inputMode="decimal" /></label>
                <label><span>Price Protection</span><input value={strategyMaxChasePrice} onChange={(event) => setStrategyMaxChasePrice(event.target.value)} placeholder="Optional" inputMode="decimal" /></label>
                <label className="dom-pro-strategy-check"><input type="checkbox" checked={strategyRandomize} onChange={(event) => setStrategyRandomize(event.target.checked)} /> Randomize child size</label>
              </div>}
              {orderType === "iceberg" && <div className="dom-pro-strategy-grid">
                <label><span>Order Preference</span><select value={icebergPreference} onChange={(event) => setIcebergPreference(event.target.value as typeof icebergPreference)}><option value="maker">Chase Limit / Maker</option><option value="taker">Chase Limit / Taker</option><option value="offset">Chase Limit / Offset</option><option value="fixed">Fixed Price</option></select></label>
                <label><span>Visible Child Size</span><input value={strategySubSize} onChange={(event) => setStrategySubSize(event.target.value)} placeholder="Uses count when empty" inputMode="decimal" /></label>
                <label><span>Order Count</span><input value={strategyOrderCount} min="2" step="1" onChange={(event) => setStrategyOrderCount(Math.max(2, Number(event.target.value || 2)))} inputMode="numeric" /></label>
                {icebergPreference === "offset" && <label><span>Chase Offset</span><input value={strategyChaseValue} onChange={(event) => setStrategyChaseValue(event.target.value)} inputMode="decimal" /></label>}
                <label><span>Price Protection</span><input value={strategyMaxChasePrice} onChange={(event) => setStrategyMaxChasePrice(event.target.value)} placeholder="Optional" inputMode="decimal" /></label>
              </div>}
              {orderType === "pov" && <div className="dom-pro-strategy-grid">
                <label><span>Volume Reference</span><select value={povMode} onChange={(event) => setPovMode(event.target.value as typeof povMode)}><option value="TradedVolume">Traded Volume</option><option value="OppositeSideLiquidity">Opposite Liquidity</option><option value="SameSideLiquidity">Same-side Liquidity</option></select></label>
                <label><span>Participation %</span><input value={povParticipationRate} min="1" max="100" step="0.1" onChange={(event) => setPovParticipationRate(Math.min(100, Math.max(1, Number(event.target.value || 1))))} inputMode="decimal" /></label>
                <label><span>Sampling Interval</span><input value={strategyIntervalSeconds} min="0" max="3600" step="1" onChange={(event) => setStrategyIntervalSeconds(Number(event.target.value || 0))} inputMode="numeric" /></label>
                <label><span>Maximum Duration</span><input value={strategyDurationSeconds} min="900" max="86400" step="60" onChange={(event) => setStrategyDurationSeconds(Number(event.target.value || 900))} inputMode="numeric" /></label>
                {povMode === "TradedVolume" ? <label><span>Reference Window</span><input value={povReferenceWindow} min="60" max="14400" step="60" onChange={(event) => setPovReferenceWindow(Number(event.target.value || 60))} inputMode="numeric" /></label> : <label><span>Book Depth</span><input value={povDepthReference} min="1" max="10" step="1" onChange={(event) => setPovDepthReference(Math.min(10, Math.max(1, Number(event.target.value || 1))))} inputMode="numeric" /></label>}
              </div>}
              <div className="dom-pro-equity-allocation">
                <div><span>Equity Allocation</span><b>{equityAllocation}%</b></div>
                <input aria-label="Equity allocation percentage" type="range" min="0" max="100" step="1" value={equityAllocation} onChange={(event) => applyEquityAllocation(Number(event.target.value))} />
                <div className="dom-pro-allocation-markers">{DOM_EQUITY_ALLOCATION_MARKERS.map((marker) => <button key={marker} type="button" style={{ left: `${marker}%` }} onClick={() => applyEquityAllocation(marker)}><i />{marker}%</button>)}</div>
              </div>
              <div className="dom-pro-checks">
                {supportsPostOnly && <label><input type="checkbox" checked={postOnly} onChange={(event) => setPostOnly(event.target.checked)} /> Post Only</label>}
                {supportsReduceOnly && <label><input type="checkbox" checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} /> Reduce Only</label>}
                {supportsTpSl && <label><input type="checkbox" checked={tpSlEnabled} disabled={reduceOnly} onChange={(event) => setTpSlEnabled(event.target.checked)} /> TP/SL</label>}
              </div>
              {tpSlEnabled && <div className="dom-pro-protection-fields"><label><span>TP</span><input value={takeProfit} onChange={(event) => setTakeProfit(event.target.value)} inputMode="decimal" /></label><label><span>SL</span><input value={stopLoss} onChange={(event) => setStopLoss(event.target.value)} inputMode="decimal" /></label></div>}
              <div className="dom-pro-execution-preview">
                <span>Available Equity <b>{formatUsd(venueSchema?.accountMetrics?.availableBalanceUsd)}</b></span>
                <span>Order Value <b>{formatUsd(executionPreview?.notional)}</b></span>
                <span>Required Margin <b>{formatUsd(executionPreview?.requiredMargin)}</b></span>
                <span>Estimated Fee <b>{formatUsd(executionPreview?.entryFee)}</b></span>
                <span>Balance After <b>{formatUsd(executionPreview?.availableAfter)}</b></span>
              </div>
              <div className="dom-pro-submit-row">
                <button type="button" disabled={!executionValidation.valid} onClick={() => { setSide("buy"); void submitQuickOrder("buy"); }}>{executionMarketKind === "spot" ? "Buy" : "Long"}</button>
                <button type="button" className="sell" disabled={!executionValidation.valid} onClick={() => { setSide("sell"); void submitQuickOrder("sell"); }}>{executionMarketKind === "spot" ? "Sell" : "Short"}</button>
              </div>
              <p>{executionStatus || accountSyncError || executionValidation.reasons[0] || "Orders route through OMS / EMS / Risk."}</p>
            </section>
          )}
          {bottomSeparators.map((separator) => <DomResizeHandle key={separator.splitId} region="bottom" splitId={separator.splitId} position={separator.position} orientation="vertical" onPointerDown={beginLayoutResize} onKeyDown={keyboardResize} onReset={resetLayoutSplit} />)}
          </div>
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

function DomResizeHandle({ region, splitId, position, orientation, onPointerDown, onKeyDown, onReset }: {
  region: "root" | "upper" | "bottom";
  splitId: string;
  position: number;
  orientation: "horizontal" | "vertical";
  onPointerDown: (region: "root" | "upper" | "bottom", splitId: string, event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (region: "root" | "upper" | "bottom", splitId: string, event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onReset: (region: "root" | "upper" | "bottom", splitId: string) => void;
}) {
  const style = orientation === "vertical" ? { left: `${position * 100}%` } : undefined;
  return (
    <div
      className={`dom-pro-resize-handle ${orientation}`}
      style={style}
      role="separator"
      aria-orientation={orientation}
      aria-valuemin={8}
      aria-valuemax={92}
      aria-valuenow={Math.round(position * 100)}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={(event) => onPointerDown(region, splitId, event)}
      onKeyDown={(event) => onKeyDown(region, splitId, event)}
      onDoubleClick={() => onReset(region, splitId)}
    />
  );
}

function PanelTitle({
  title,
  status,
  panelId,
  panel,
  scheduler,
  dataQuality,
  onPatch,
  onPreset,
  onReset,
  onSaveDefault,
  collapsed,
  maximized,
  onCollapse,
  onMaximize
}: {
  title: string;
  status?: string;
  panelId?: DomPanelId;
  panel?: DomPanelSettingsRegistry["panels"][DomPanelId];
  scheduler?: ReturnType<DomPanelUpdateScheduler["reportMetrics"]>[number];
  dataQuality?: string;
  onPatch?: (patch: Partial<DomPanelValues>) => void;
  onPreset?: (preset: string) => void;
  onReset?: () => void;
  onSaveDefault?: () => void;
  collapsed?: boolean;
  maximized?: boolean;
  onCollapse?: () => void;
  onMaximize?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const positionPopover = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition(placePanelPopover(rect, { width: window.innerWidth, height: window.innerHeight }));
  }, []);

  useEffect(() => {
    if (!open) return;
    positionPopover();
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popoverRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener("resize", positionPopover);
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      window.removeEventListener("resize", positionPopover);
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [open, positionPopover]);

  return (
    <div className="dom-pro-panel-title">
      <div className="dom-pro-panel-title-main">
        <span>{title}</span>
        {panelId && panel && (
          <button
            ref={buttonRef}
            type="button"
            className="dom-pro-panel-cog"
            title="Panel Settings"
            aria-label={`${title} panel settings`}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <Settings size={13} />
          </button>
        )}
      </div>
      <div className="dom-pro-panel-title-status">
        {dataQuality && <em title="Panel data quality">{dataQuality}</em>}
        {status && <b>{status}</b>}
        {onCollapse && <button type="button" className="dom-pro-panel-layout-action" title={collapsed ? "Restore panel" : "Collapse panel"} aria-label={collapsed ? `Restore ${title}` : `Collapse ${title}`} onClick={onCollapse}>{collapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}</button>}
        {onMaximize && <button type="button" className="dom-pro-panel-layout-action" title={maximized ? "Restore workspace" : "Maximize panel"} aria-label={maximized ? `Restore ${title}` : `Maximize ${title}`} onClick={onMaximize}>{maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}</button>}
      </div>
      {open && panelId && panel && onPatch && createPortal(
        <div ref={popoverRef} className="dom-pro-panel-popover" role="dialog" aria-label={`${title} settings`} style={position}>
          <header><b>{title} Settings</b><button type="button" aria-label="Close panel settings" onClick={() => setOpen(false)}><X size={14} /></button></header>
          <label className="dom-pro-panel-setting"><span>Preset</span><select value={panel.preset} onChange={(event) => onPreset?.(event.target.value)}>{Object.keys(domPanelPresets[panelId]).map((preset) => <option key={preset}>{preset}</option>)}</select></label>
          <div className="dom-pro-panel-setting-grid">
            {domPanelFields[panelId].map((field) => <PanelSettingControl key={field.key} field={field} value={panel.settings[field.key]} onChange={(value) => onPatch({ [field.key]: value })} />)}
          </div>
          <details>
            <summary>Diagnostics</summary>
            <dl>
              <dt>Source</dt><dd>Shared Black Core feed</dd>
              <dt>Quality</dt><dd>{dataQuality ?? "UNKNOWN"}</dd>
              <dt>Calculation</dt><dd>{scheduler?.calculationMs ?? 0} ms</dd>
              <dt>Render</dt><dd>{scheduler?.renderMs?.toFixed(0) ?? 0} ms</dd>
              <dt>Calculations</dt><dd>{scheduler?.calculations ?? 0}</dd>
              <dt>Coalesced</dt><dd>{scheduler?.coalesced ?? 0}</dd>
              <dt>Visibility</dt><dd>{scheduler?.suspended ? "SUSPENDED" : "ACTIVE"}</dd>
              <dt>Worker</dt><dd>SHARED / LATEST-WINS</dd>
            </dl>
          </details>
          <footer><button type="button" onClick={onReset}>Reset</button><button type="button" onClick={onSaveDefault}>Save as Default</button><button type="button" onClick={() => setOpen(false)}>Close</button></footer>
        </div>,
        document.body
      )}
    </div>
  );
}

function PanelSettingControl({ field, value, onChange }: { field: (typeof domPanelFields)[DomPanelId][number]; value: string | number | boolean | undefined; onChange: (value: string | number | boolean) => void }) {
  if (field.kind === "toggle") {
    return <label className="dom-pro-panel-setting toggle"><span>{field.label}</span><input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} /></label>;
  }
  if (field.kind === "select") {
    return <label className="dom-pro-panel-setting"><span>{field.label}</span><select value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
  }
  return <label className="dom-pro-panel-setting"><span>{field.label}</span><input type="number" value={Number(value ?? 0)} min={field.min} max={field.max} step={field.step} onChange={(event) => onChange(Number(event.target.value))} /></label>;
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

function buildInstitutionalProfile(
  liveProfile: VolumeProfileNode[],
  candles: Candle[],
  camera: DomProPriceCamera,
  requestedRows: number
): DomVolumeProfileNode[] {
  const historicalSource = candles.slice(-365);
  const overlappingSource = historicalSource.filter((candle) => candle.high >= camera.visiblePriceMin && candle.low <= camera.visiblePriceMax);
  const source = overlappingSource.length >= 8 ? overlappingSource : historicalSource.filter((candle) => candle.close >= camera.visiblePriceMin && candle.close <= camera.visiblePriceMax);
  const rowCount = Math.max(64, Math.min(256, Math.round(requestedRows)));
  const rangeSpan = Math.max(0.00000001, camera.visiblePriceMax - camera.visiblePriceMin);
  const rowSize = rangeSpan / rowCount;
  const bins = Array.from({ length: rowCount + 1 }, (_, index) => {
    const price = camera.visiblePriceMin + index * rowSize;
    const low = Math.max(camera.visiblePriceMin, price - rowSize / 2);
    const high = Math.min(camera.visiblePriceMax, price + rowSize / 2);
    return {
      key: `profile:${camera.version}:${index}`,
      index,
      low,
      high,
      price,
      topPct: (camera.visiblePriceMax - high) / rangeSpan * 100,
      heightPct: (high - low) / rangeSpan * 100,
      volume: 0
    };
  });

  for (const candle of source) {
    const width = Math.max(candle.high - candle.low, rowSize);
    const volume = Math.max(1, candle.volume || 1);
    for (const bin of bins) {
      if (bin.price < candle.low || bin.price > candle.high) continue;
      bin.volume += volume / Math.max(1, width / rowSize);
    }
  }

  for (const node of liveProfile) {
    if (node.volume <= 0 || node.price < camera.visiblePriceMin || node.price > camera.visiblePriceMax) continue;
    const index = Math.max(0, Math.min(bins.length - 1, Math.round((node.price - camera.visiblePriceMin) / rowSize)));
    bins[index].volume += node.volume * Math.max(8, source.length ? 1 : 18);
  }

  const volumes = bins.map((bin) => bin.volume);
  const max = Math.max(...volumes, 1);
  const positiveVolumes = volumes.filter((volume) => volume > 0);
  const avg = positiveVolumes.reduce((sum, value) => sum + value, 0) / Math.max(1, positiveVolumes.length);
  return bins
    .map((bin) => ({
      key: bin.key,
      price: bin.price,
      low: bin.low,
      high: bin.high,
      topPct: bin.topPct,
      heightPct: bin.heightPct,
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

function defaultCvdCamera(): CvdViewportState {
  return {
    startIndex: null,
    visibleCount: null,
    followLatest: true
  };
}

function resolveCvdCamera(camera: CvdViewportState, total: number, settings: DomSettings): CvdResolvedCamera {
  if (total <= 0) {
    return { start: 0, end: 0, visibleCount: 0, total: 0, followLatest: camera.followLatest };
  }
  const preferredVisible = camera.visibleCount ?? settings.cvdVisibleCandles ?? 120;
  const visibleCount = clampCvdVisibleCount(preferredVisible, total);
  const maxStart = Math.max(0, total - visibleCount);
  const start = camera.followLatest || camera.startIndex === null
    ? maxStart
    : clampCvdStart(camera.startIndex, total, visibleCount);
  return {
    start,
    end: Math.min(total, start + visibleCount),
    visibleCount,
    total,
    followLatest: camera.followLatest
  };
}

function clampCvdVisibleCount(value: number, total: number) {
  if (total <= 0) return 0;
  const minVisible = Math.min(total, 8);
  const maxVisible = Math.max(minVisible, total);
  return Math.max(minVisible, Math.min(maxVisible, Math.round(value)));
}

function clampCvdStart(value: number, total: number, visibleCount: number) {
  const maxStart = Math.max(0, total - visibleCount);
  return Math.max(0, Math.min(maxStart, Math.round(value)));
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

function buildHeatmapHoverAt(
  x: number,
  y: number,
  rect: DOMRect,
  camera: DomProPriceCamera,
  frames: AggregatedDomSnapshot["heatmap"],
  bands: MacroLiquidityBand[],
  walls: AggregatedDomSnapshot["walls"]
): DomHoverInfo {
  const range = domCameraRange(camera);
  const price = priceFromY(y, rect, range);
  const bucket = domPriceBucketAt(camera, price);
  const xPct = Math.max(0, Math.min(1, x / Math.max(1, rect.width)));
  const frame = frames[Math.round(xPct * Math.max(0, frames.length - 1))];
  const priceWindow = Math.max((range.max - range.min) * 0.008, 0.00000001);
  const nearestCell = nearestByPrice(frame?.cells ?? [], price, priceWindow);
  const nearestBand = nearestBandAtPrice(bands, price, priceWindow);
  const nearestWall = nearestByPrice(walls, price, priceWindow);
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
    price,
    priceBucketKey: bucket?.key,
    title: nearestBand?.label ?? (nearestWall ? `${nearestWall.side.toUpperCase()} WALL` : "LIQUIDITY POINT"),
    lines: bucket ? [`Bucket ${formatPrice(bucket.low)} - ${formatPrice(bucket.high)}`, ...lines] : lines
  };
}

function nearestByPrice<T extends { price: number }>(values: T[], price: number, window: number) {
  let nearest: T | undefined;
  let nearestDistance = window;
  for (const value of values) {
    const distance = Math.abs(value.price - price);
    if (distance <= nearestDistance) { nearest = value; nearestDistance = distance; }
  }
  return nearest;
}

function nearestBandAtPrice(values: MacroLiquidityBand[], price: number, window: number) {
  let nearest: MacroLiquidityBand | undefined;
  let nearestDistance = window;
  for (const value of values) {
    if (value.high < price - window || value.low > price + window) continue;
    const distance = Math.abs(value.price - price);
    if (distance <= nearestDistance) { nearest = value; nearestDistance = distance; }
  }
  return nearest;
}

function qualityLabel(quality: DomVisualQuality) {
  if (quality === "degraded") return "PERFORMANCE DEGRADED";
  if (quality === "balanced") return "BALANCED";
  return "FULL QUALITY";
}

function traceCalculation<T>(name: string, inputSize: number, calculate: () => T) {
  const startedAt = performance.now();
  const result = calculate();
  const outputSize = Array.isArray(result) ? result.length : 1;
  domPerformanceTrace.record(name, performance.now() - startedAt, inputSize, outputSize);
  return result;
}

function resolveVisualQuality(mode: DomPerformanceMode, adaptive: DomVisualQuality): DomVisualQuality {
  if (mode === "maximum-performance") return "degraded";
  if (mode === "balanced" && adaptive === "full") return "balanced";
  return adaptive;
}

function buildProfileHover(event: ReactMouseEvent<HTMLDivElement>, rect: DOMRect, camera: DomProPriceCamera, profile: DomVolumeProfileNode[]): DomHoverInfo {
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const price = priceFromY(y, rect, domCameraRange(camera));
  const nearest = profile.find((node) => price >= node.low && price <= node.high)
    ?? profile.slice().sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))[0];
  return {
    x,
    y,
    price: nearest?.price ?? price,
    title: nearest ? nearest.kind.toUpperCase() : "PROFILE",
    lines: [
      nearest ? `Profile row ${formatPrice(nearest.low)} - ${formatPrice(nearest.high)}` : `Price ${formatPrice(price)}`,
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

function buildStructuralCvdAxis(range: { min: number; max: number }) {
  const half = range.max / 2;
  return [range.max, half, 0, -half, range.min].map((value) => ({
    value,
    y: structuralCvdValueToY(value, range),
    label: value === 0 ? "0" : formatSignedCompact(value)
  }));
}

function structuralCvdBarGeometry(point: StructuralCvdPoint, index: number, points: StructuralCvdPoint[], range: { min: number; max: number }) {
  const spacing = 90 / Math.max(1, points.length);
  const xCenter = structuralCvdX(index, points.length);
  const zeroY = structuralCvdValueToY(0, range);
  const valueY = structuralCvdValueToY(point.cumulativeDelta, range);
  return {
    x: xCenter - Math.max(0.18, spacing * 0.38),
    y: Math.min(zeroY, valueY),
    width: Math.max(0.36, spacing * 0.76),
    height: Math.max(0.3, Math.abs(valueY - zeroY))
  };
}

function buildStructuralCvdStepPath(points: StructuralCvdPoint[], key: "cumulativeBuy" | "cumulativeSell", range: { min: number; max: number }) {
  if (!points.length) return "";
  return points.map((point, index) => {
    const x = structuralCvdX(index, points.length);
    const y = structuralCvdValueToY(point[key], range);
    if (index === 0) return `M ${x.toFixed(2)} ${y.toFixed(2)}`;
    const previousX = structuralCvdX(index - 1, points.length);
    return `H ${((previousX + x) / 2).toFixed(2)} V ${y.toFixed(2)} H ${x.toFixed(2)}`;
  }).join(" ");
}

function buildStructuralCvdTimeAxis(points: StructuralCvdPoint[]) {
  if (!points.length) return [];
  const count = Math.min(5, points.length);
  return Array.from({ length: count }, (_, index) => {
    const pointIndex = Math.round(index / Math.max(1, count - 1) * (points.length - 1));
    const point = points[pointIndex];
    return {
      time: point.time,
      x: structuralCvdX(pointIndex, points.length),
      label: formatCvdTimestamp(point.time),
      anchor: index === 0 ? "start" as const : index === count - 1 ? "end" as const : "middle" as const
    };
  });
}

function structuralCvdX(index: number, count: number) {
  return 5 + index / Math.max(1, count - 1) * 90;
}

function structuralCvdValueToY(value: number, range: { min: number; max: number }) {
  return 91 - (value - range.min) / Math.max(1, range.max - range.min) * 82;
}

function formatCvdTimestamp(time: number) {
  const date = new Date(time * 1000);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function timeframeSeconds(timeframe: Timeframe) {
  const value: Partial<Record<Timeframe, number>> = {
    "1m": 60,
    "3m": 180,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "2h": 7200,
    "4h": 14400,
    "6h": 21600,
    "8h": 28800,
    "12h": 43200,
    "1d": 86400,
    "1w": 604800
  };
  return value[timeframe] ?? 14400;
}

function sameCandleSeries(current: Candle[], next: Candle[]) {
  if (current.length !== next.length) return false;
  if (!current.length) return true;
  const before = current.at(-1);
  const after = next.at(-1);
  return before?.time === after?.time && before?.open === after?.open && before?.high === after?.high && before?.low === after?.low && before?.close === after?.close && before?.volume === after?.volume;
}

function resolveDepthChartRange(snapshot: AggregatedDomSnapshot): MacroLiquidityRange {
  const rawBids = (snapshot.sourceBook?.bids ?? []).filter((level) => Number.isFinite(level.price) && level.price > 0 && level.quantity > 0);
  const rawAsks = (snapshot.sourceBook?.asks ?? []).filter((level) => Number.isFinite(level.price) && level.price > 0 && level.quantity > 0);
  const bidPrices = rawBids.length >= 2
    ? rawBids.map((level) => level.price)
    : snapshot.bids.filter((level) => level.bidSize > 0).map((level) => level.price);
  const askPrices = rawAsks.length >= 2
    ? rawAsks.map((level) => level.price)
    : snapshot.asks.filter((level) => level.askSize > 0).map((level) => level.price);
  const finitePrices = [...bidPrices, ...askPrices].filter((price) => Number.isFinite(price) && price > 0);
  const bookMid = snapshot.bestBid && snapshot.bestAsk ? (snapshot.bestBid + snapshot.bestAsk) / 2 : null;
  const currentPrice = snapshot.midPrice ?? snapshot.lastPrice ?? bookMid ?? (finitePrices.length ? (Math.min(...finitePrices) + Math.max(...finitePrices)) / 2 : 1);
  const lowerLevels = bidPrices
    .filter((price) => price > 0 && price <= currentPrice)
    .sort((a, b) => b - a)
    .slice(0, 180);
  const upperLevels = askPrices
    .filter((price) => price > 0 && price >= currentPrice)
    .sort((a, b) => a - b)
    .slice(0, 180);
  const lowerSpan = lowerLevels.length ? currentPrice - lowerLevels[lowerLevels.length - 1] : 0;
  const upperSpan = upperLevels.length ? upperLevels[upperLevels.length - 1] - currentPrice : 0;
  const sourceHalfSpan = Math.max(lowerSpan, upperSpan);
  const spreadSpan = Number.isFinite(snapshot.spread ?? NaN) ? Number(snapshot.spread) * 12 : 0;
  const fallbackHalfSpan = currentPrice * 0.0015;
  const naturalHalfSpan = sourceHalfSpan > 0 ? sourceHalfSpan * 1.18 : fallbackHalfSpan;
  const minHalfSpan = Math.max(spreadSpan, currentPrice * 0.00005, 1);
  const maxHalfSpan = currentPrice * 0.025;
  const halfSpan = Math.max(minHalfSpan, Math.min(naturalHalfSpan, maxHalfSpan));
  return {
    min: Math.max(0.00000001, currentPrice - halfSpan),
    max: Math.max(currentPrice + halfSpan, currentPrice + 0.00000002),
    source: rawBids.length >= 2 || rawAsks.length >= 2 ? "live-depth" : finitePrices.length ? "fallback" : "fallback"
  };
}

function buildDepthChart(
  snapshot: AggregatedDomSnapshot,
  range: MacroLiquidityRange,
  settings: DomSettings,
  mode = "raw",
  structural?: { bids: Array<{ price: number; quantity: number }>; asks: Array<{ price: number; quantity: number }> }
) {
  const currentPrice = snapshot.midPrice ?? snapshot.lastPrice ?? midpoint(range);
  const rawBidSource = (snapshot.sourceBook?.bids ?? [])
    .map((level) => ({ price: level.price, bidSize: level.quantity, askSize: 0 }))
    .filter((level) => level.price > 0 && level.bidSize > 0);
  const rawAskSource = (snapshot.sourceBook?.asks ?? [])
    .map((level) => ({ price: level.price, askSize: level.quantity, bidSize: 0 }))
    .filter((level) => level.price > 0 && level.askSize > 0);
  const structuralMode = mode === "structural" || mode === "macro";
  const structuralBids = structural?.bids.map((level) => ({ price: level.price, bidSize: level.quantity, askSize: 0 })) ?? [];
  const structuralAsks = structural?.asks.map((level) => ({ price: level.price, askSize: level.quantity, bidSize: 0 })) ?? [];
  const bidSource = structuralMode && structuralBids.length >= 2 ? structuralBids : rawBidSource.length >= 2 ? rawBidSource : snapshot.bids;
  const askSource = structuralMode && structuralAsks.length >= 2 ? structuralAsks : rawAskSource.length >= 2 ? rawAskSource : snapshot.asks;
  const depthLevelLimit = Math.max(20, Math.min(420, Math.round(settings.depthDisplayLevels)));
  const smoothingGroupSize = Math.max(1, Math.min(24, Math.round(settings.depthSmoothingLevels)));
  const curvePower = Math.max(0.45, Math.min(1.4, settings.depthCurvePower));
  const rawBidLevels = bidSource
    .filter((level) => level.price >= range.min && level.price <= Math.min(currentPrice, range.max) && level.bidSize > 0)
    .sort((a, b) => b.price - a.price)
    .slice(0, depthLevelLimit);
  const rawAskLevels = askSource
    .filter((level) => level.price <= range.max && level.price >= Math.max(currentPrice, range.min) && level.askSize > 0)
    .sort((a, b) => a.price - b.price)
    .slice(0, depthLevelLimit);
  const bidLevels = aggregateDepthLevels(rawBidLevels, "bid", smoothingGroupSize);
  const askLevels = aggregateDepthLevels(rawAskLevels, "ask", smoothingGroupSize);
  if (bidLevels.length === 0 && askLevels.length === 0) {
    return { empty: true, bidLine: "", askLine: "", bidArea: "", askArea: "", bidPoints: 0, askPoints: 0, bidPct: 0, askPct: 0, bias: "UNAVAILABLE", warning: "Awaiting valid bid/ask depth." };
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
  const combinedTotal = Math.max(1, bidTotal + askTotal);
  const bidPct = bidTotal / combinedTotal * 100;
  const askPct = askTotal / combinedTotal * 100;
  const startX = 50;
  bidLevels.forEach((level, index) => {
    const x = 50 - ((index + 1) / Math.max(1, bidLevels.length)) * 50;
    const y = 94 - Math.pow(bidTotals[index] / maxTotal, curvePower) * 82;
    bidCumulative.push({ x, y });
  });
  askLevels.forEach((level, index) => {
    const x = 50 + ((index + 1) / Math.max(1, askLevels.length)) * 50;
    const y = 94 - Math.pow(askTotals[index] / maxTotal, curvePower) * 82;
    askCumulative.push({ x, y });
  });
  const bidLinePoints = bidCumulative.length
    ? buildDepthStepPath([{ x: startX, y: 94 }, ...bidCumulative], "bid")
    : [];
  const askLinePoints = askCumulative.length
    ? buildDepthStepPath([{ x: startX, y: 94 }, ...askCumulative], "ask")
    : [];
  const pointString = (points: Array<{ x: number; y: number }>) => points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
  return {
    empty: false,
    bidLine: pointString(bidLinePoints),
    askLine: pointString(askLinePoints),
    bidArea: bidLinePoints.length ? `${pointString(bidLinePoints)} ${bidLinePoints[bidLinePoints.length - 1].x.toFixed(2)},94 ${startX.toFixed(2)},94` : "",
    askArea: askLinePoints.length ? `${pointString(askLinePoints)} ${askLinePoints[askLinePoints.length - 1].x.toFixed(2)},94 ${startX.toFixed(2)},94` : "",
    bidPoints: bidLinePoints.length,
    askPoints: askLinePoints.length,
    bidPct,
    askPct,
    bias: bidPct > 55 ? "BID HEAVY" : askPct > 55 ? "ASK HEAVY" : "BALANCED",
    warning: bidLinePoints.length === 0 ? "Only ask side available from source." : askLinePoints.length === 0 ? "Only bid side available from source." : rawBidSource.length < 2 || rawAskSource.length < 2 ? "Raw depth sparse; using aggregated fallback." : smoothingGroupSize > 1 ? `Depth smoothed ${smoothingGroupSize} levels per step.` : ""
  };
}

function aggregateDepthLevels(
  levels: Array<{ price: number; bidSize: number; askSize: number }>,
  side: "bid" | "ask",
  groupSize: number
) {
  if (groupSize <= 1) return levels;
  const grouped: Array<{ price: number; bidSize: number; askSize: number }> = [];
  for (let index = 0; index < levels.length; index += groupSize) {
    const group = levels.slice(index, index + groupSize);
    if (group.length === 0) continue;
    grouped.push({
      price: group[group.length - 1].price,
      bidSize: side === "bid" ? group.reduce((sum, level) => sum + level.bidSize, 0) : 0,
      askSize: side === "ask" ? group.reduce((sum, level) => sum + level.askSize, 0) : 0
    });
  }
  return grouped;
}

function buildDepthStepPath(points: Array<{ x: number; y: number }>, side: "bid" | "ask") {
  const ordered = side === "bid"
    ? points.slice().sort((a, b) => b.x - a.x)
    : points.slice().sort((a, b) => a.x - b.x);
  const stepped: Array<{ x: number; y: number }> = [];
  for (const point of ordered) {
    const previous = stepped[stepped.length - 1];
    if (previous) stepped.push({ x: point.x, y: previous.y });
    stepped.push(point);
  }
  return stepped;
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

function createPanelSnapshotMap(snapshot: AggregatedDomSnapshot): Record<DomPanelId, AggregatedDomSnapshot> {
  return Object.fromEntries(configurablePanelIds.map((panelId) => [panelId, snapshot])) as Record<DomPanelId, AggregatedDomSnapshot>;
}

function numberSetting(settings: DomPanelValues, key: string, fallback: number) {
  const value = Number(settings[key]);
  return Number.isFinite(value) ? value : fallback;
}

function stringSetting(settings: DomPanelValues, key: string, fallback: string) {
  const value = settings[key];
  return typeof value === "string" ? value : fallback;
}

function booleanSetting(settings: DomPanelValues, key: string, fallback: boolean) {
  const value = settings[key];
  return typeof value === "boolean" ? value : fallback;
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

function buildExecutionAccount(connection: ConnectionDiagnostics, sync: ExchangeAccountSyncPayload | null): PortfolioAccount {
  const metrics = sync?.accountMetrics;
  const tradingEnabled = connection.health.permissions.trading === true;
  const storedControls = connection.metadata.accountRiskControls as PortfolioAccount["riskControls"] | undefined;
  const accountDrivenBybit = connection.provider === "bybit" && Number(sync?.executionState.maxNotionalUsd || 0) <= 0;
  const riskControls = {
    ...(storedControls || defaultRiskControls),
    maxPositionUsd: accountDrivenBybit ? 0 : storedControls?.maxPositionUsd ?? defaultRiskControls.maxPositionUsd,
    maxPortfolioExposureUsd: storedControls?.maxPortfolioExposureUsd ?? (accountDrivenBybit ? 0 : defaultRiskControls.maxPortfolioExposureUsd),
    readOnlyMode: !tradingEnabled,
    tradingEnabled
  };
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
    balanceUsd: metrics?.walletBalanceUsd ?? 0,
    equityUsd: metrics?.equityUsd ?? 0,
    marginUsed: metrics?.initialMarginUsd ?? 0,
    availableMargin: metrics?.availableBalanceUsd ?? 0,
    buyingPower: (metrics?.availableBalanceUsd ?? 0) * Math.max(1, Number(storedControls?.maxLeverage || 1)),
    leverage: sync?.selectedPosition?.leverage ?? 1,
    dailyPnl: 0,
    monthlyPnl: 0,
    openPositions: sync?.positions.length ?? 0,
    openOrders: sync?.openOrders.length ?? 0,
    riskControls
  };
}

function formatPrice(value?: number | null) {
  if (!Number.isFinite(value ?? NaN)) return "--";
  return Number(value).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function ladderUnitLabel(displayUnit: DomLadderDisplayUnit, symbol: MarketSymbol) {
  if (displayUnit === "notional") return symbol.quoteAsset;
  if (displayUnit === "contracts") return "CONTRACTS";
  return symbol.baseAsset;
}

function formatLadderNetDepth(netDepth: number, centerPrice: number, displayUnit: DomLadderDisplayUnit) {
  const value = displayUnit === "notional" ? netDepth * centerPrice : netDepth;
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString(undefined, { minimumFractionDigits: displayUnit === "notional" ? 0 : 3, maximumFractionDigits: displayUnit === "notional" ? 0 : 3 })}`;
}

function formatUsd(value?: number | null) {
  return Number.isFinite(value) ? `${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD` : "--";
}

function formatOrderTypeLabel(value: OrderType) {
  return value.split("-").map(titleCase).join(" ");
}

function titleCase(value: string) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function formatSize(value?: number | null) {
  if (!Number.isFinite(value ?? NaN)) return "--";
  return Number(value).toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

function formatCompact(value?: number | null) {
  if (!Number.isFinite(value ?? NaN)) return "--";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(Number(value));
}

function formatSignedCompact(value?: number | null) {
  if (!Number.isFinite(value ?? NaN)) return "--";
  const numeric = Number(value);
  const sign = numeric > 0 ? "+" : "";
  return `${sign}${formatCompact(numeric)}`;
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
