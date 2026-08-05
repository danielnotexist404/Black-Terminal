import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, SetStateAction } from "react";
import { Bell, Brush, Columns3, Copy, Eye, EyeOff, Minus, Play, Plus, SlidersHorizontal, Square, TrendingUp, Type, X } from "lucide-react";
import { BlackChartEngine } from "../chart-engine/BlackChartEngine";
import type { ChartPoint, IndicatorAlertLevel, IndicatorAlertLine } from "../chart-engine/BlackChartEngine";
import type { ChartPriceTransformSnapshot } from "../chart-engine/priceTransform";
import {
  AdaptiveSwingStrategySettings,
  Candle,
  ChartDisplayType,
  DrawingToolId,
  FeedEvent,
  IndicatorAdvancedSettings,
  IndicatorColorKey,
  IndicatorPeriods,
  OscillatorIndicatorKey,
  OscillatorPaneSettings,
  IndicatorVisualSettings,
  ReplayControls,
  ReplaySelection,
  ReplayStatus,
  VisibleIndicators,
  VolumeProfileSettings,
  VwapSettings,
  WaveTrendOscillatorSettings,
  ZScoreOscillatorSettings
} from "../chart-engine/types";
import {
  defaultAdaptiveSwingStrategySettings,
  defaultOscillatorPaneSettings,
  defaultVolumeProfileSettings,
  defaultVwapSettings,
  defaultWaveTrendOscillatorSettings,
  defaultZScoreOscillatorSettings
} from "../chart-engine/profile/volumeProfileDefaults";
import { OSCILLATOR_KEYS, resolveOscillatorStack } from "../chart-engine/indicators/oscillatorLayout";
import { createMockCandles } from "../data/mockMarket";
import type { AlertCondition, AlertIndicatorTarget, IndicatorAlertDefinition } from "../automation/alerts";
import { canUseIndicator } from "../features/premium";
import { sendIndicatorAlert, sendWebhook } from "../lib/tauri";
import type { CompiledPlot } from "./ScriptCompiler";
import { getMarketDataEngineAdapter } from "../market-data/engine/marketDataEngine";
import { ExchangeId, MarketDataAdapter, MarketDataSubscription, MarketSymbol, Timeframe } from "../market-data/types";
import { UnifiedExecutionTicket, type UnifiedExecutionTicketPreset } from "../execution/components/UnifiedExecutionTicket";
import type { ExecutionSource, OrderSide, OrderType } from "../execution/types";
import type { OrderUpdate } from "../execution/types";
import { blackCorePositionManager } from "../positions/positionManager";
import type { ManagedPosition, PositionProtectionOrder, PositionProtectionType } from "../positions/types";
import { AifIndicatorOverlay } from "../modules/aif/components/AifIndicatorOverlay";
import { canonicalOrderKey, deduplicateCanonicalOrders } from "../orders/canonicalOrder";
import { OrderManagementMenu } from "../orders/OrderManagementMenu";
import {
  canonicalClusterHash,
  type KioseffSnapshot
} from "../modules/kioseff-stop-loss-clustering/core/canonical";
import {
  kioseffCalculationSettingsHash,
  kioseffSettingsHash,
  normalizeKioseffTimeframeInput,
  type KioseffSettingsV1
} from "../modules/kioseff-stop-loss-clustering/core/settings";
import {
  KioseffHistoryCoordinator,
  shouldRefreshKioseffHistory
} from "../modules/kioseff-stop-loss-clustering/data/historyCoordinator";
import { certifiedKioseffInputTail } from "../modules/kioseff-stop-loss-clustering/data/qualityGate";
import { KioseffDataUnavailableError } from "../modules/kioseff-stop-loss-clustering/data/types";
import {
  emptyKioseffRuntimeDiagnostics,
  type KioseffLoadState,
  type KioseffRuntimeDiagnostics
} from "../modules/kioseff-stop-loss-clustering/data/loadState";
import {
  kioseffUnavailableDiagnostic,
  type KioseffUnavailableDiagnostic
} from "../modules/kioseff-stop-loss-clustering/data/unavailability";
import { KioseffWorkerClient } from "../modules/kioseff-stop-loss-clustering/workers/KioseffWorkerClient";
import { KioseffSettingsPanel } from "../modules/kioseff-stop-loss-clustering/components/KioseffSettingsPanel";
import { KioseffOverlays } from "../modules/kioseff-stop-loss-clustering/components/KioseffOverlays";
import { buildKioseffRenderModel } from "../modules/kioseff-stop-loss-clustering/rendering/renderModel";
import { AuctionProfileSettingsPanel } from "../modules/auction-profile/components/AuctionProfileSettings";
import { AuctionProfileDiagnostics } from "../modules/auction-profile/components/AuctionProfileDiagnostics";
import { AuctionProfileLegend } from "../modules/auction-profile/components/AuctionProfileLegend";
import { auctionProfileCalculationSettingsHash, migrateAuctionProfileSettings } from "../modules/auction-profile/core/settings";
import type { AuctionProfileSettings, AuctionProfileSnapshot, CanonicalTrade } from "../modules/auction-profile/core/types";
import { retainCertifiedRadapSnapshots } from "../modules/auction-profile/core/stability";
import { canonicalCvdService, normalizeCanonicalTrade } from "../modules/auction-profile/data/tradeSource";
import { AuctionProfileWorkerClient } from "../modules/auction-profile/worker/AuctionProfileWorkerClient";
import { resolveAuctionVisualizationLayers } from "../modules/auction-profile/rendering/visualization";
import type { TradeTick } from "../market-data/types";
import { migrateLiquidationFieldSettings } from "../modules/liquidation-field/core/settings";
import type { LiquidationFieldRuntimeStatus, LiquidationFieldSettings, LiquidationFieldSnapshot } from "../modules/liquidation-field/core/types";
import { LiquidationFieldController } from "../modules/liquidation-field/data/LiquidationFieldController";
import { LiquidationFieldSettingsPanel } from "../modules/liquidation-field/components/LiquidationFieldSettingsPanel";
import { LiquidationFieldOverlays } from "../modules/liquidation-field/components/LiquidationFieldOverlays";

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}


type PixiBlackChartProps = {
  workspaceId: string;
  marketSymbol: MarketSymbol;
  displaySymbol: string;
  exchangeLabel: string;
  timeframe: Timeframe;
  timeframeLabel: string;
  chartType: ChartDisplayType;
  snapToLatest: boolean;
  activeDrawingTool: DrawingToolId;
  drawingsVisible: boolean;
  drawingsLocked: boolean;
  drawingClearSignal: number;
  replayControls: ReplayControls;
  visibleIndicators: VisibleIndicators;
  indicatorPeriods: IndicatorPeriods;
  indicatorVisualSettings: IndicatorVisualSettings;
  indicatorAdvancedSettings: IndicatorAdvancedSettings;
  kioseffSettings: KioseffSettingsV1;
  auctionProfileSettings: AuctionProfileSettings;
  alertDefinitions: IndicatorAlertDefinition[];
  onVisibleIndicatorsChange: Dispatch<SetStateAction<VisibleIndicators>>;
  onIndicatorPeriodsChange: Dispatch<SetStateAction<IndicatorPeriods>>;
  onIndicatorVisualSettingsChange: Dispatch<SetStateAction<IndicatorVisualSettings>>;
  onIndicatorAdvancedSettingsChange: Dispatch<SetStateAction<IndicatorAdvancedSettings>>;
  onKioseffSettingsChange: Dispatch<SetStateAction<KioseffSettingsV1>>;
  onAuctionProfileSettingsChange: Dispatch<SetStateAction<AuctionProfileSettings>>;
  onAlertDefinitionsChange?: Dispatch<SetStateAction<IndicatorAlertDefinition[]>>;
  onDrawingToolRequest?: (tool: DrawingToolId) => void;
  onOpenAlerts?: () => void;
  onOpenStrategyLab?: () => void;
  onPriceChange?: (price: number) => void;
  onCandleChange?: (candle: import("../chart-engine/types").Candle) => void;
  onReplayStatusChange?: (status: ReplayStatus) => void;
  onReplayStartSelected?: (selection: ReplaySelection) => void;
  customPlots?: CompiledPlot[];
  onAlertFired?: (symbol: string, message: string) => void;
  priceLineColor?: string;
  priceLineIntensity?: number;
  activeOrders?: OrderUpdate[];
  onRefreshOrders?: () => void | Promise<unknown>;
  allowedIndicators: readonly string[];
};

type IndicatorKey = keyof VisibleIndicators;
type HistoryDepth = 1000 | 2500 | 5000 | 10000 | 20000;
type VolumeProfileSettingsTab = "inputs" | "style" | "visibility";
type AdaptiveSwingSettingsTab = "signals" | "engine" | "optimization" | "alerts";
type LineAlertIndicatorKey = "vwap" | "ema20" | "ema50" | "ema200";
const vwapAnchorLabels: Record<VwapSettings["anchorMode"], string> = {
  session: "Session / UTC",
  week: "Weekly Auction",
  month: "Monthly Auction",
  fullHistory: "Full History",
  rolling: "Rolling Execution",
  swingHigh: "Swing High Supply",
  swingLow: "Swing Low Demand",
  volumeClimax: "Volume Climax",
  volatilityBreak: "Volatility Break",
  autoRegime: "Black Core Auto-Regime"
};

type ChartContextMenuState = {
  x: number;
  y: number;
  point: ChartPoint;
};

type OrderContextMenuState = { x: number; y: number; order: OrderUpdate };

type AlertToast = {
  id: number;
  title: string;
  message: string;
};

type IndicatorAlertSettings = {
  enabled: boolean;
  webhook: boolean;
  email: boolean;
  emailTo: string;
  cooldownSeconds: number;
  volumeProfile: {
    any: boolean;
    poc: boolean;
    vah: boolean;
    val: boolean;
    lvn: boolean;
  };
  line: Record<LineAlertIndicatorKey, {
    touch: boolean;
    crossAbove: boolean;
    crossBelow: boolean;
  }>;
};

const historyDepthOptions: { label: string; value: HistoryDepth }[] = [
  { label: "1K bars", value: 1000 },
  { label: "2.5K bars", value: 2500 },
  { label: "5K bars", value: 5000 },
  { label: "10K bars", value: 10000 },
  { label: "20K bars", value: 20000 }
];
const MAX_RETAINED_CHART_BARS = 22_000;

const timeframeSeconds: Record<any, number> = {
  "1s": 1,
  "10s": 10,
  "30s": 30,
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
  "1w": 604800,
  "1M": 2592000,
  "10t": 10,
  "100t": 100
};

const indicatorColorOptions: { label: string; value: IndicatorColorKey }[] = [
  { label: "Red", value: "red" },
  { label: "White", value: "white" },
  { label: "Silver", value: "silver" },
  { label: "Gray", value: "gray" },
  { label: "Green", value: "green" },
  { label: "Orange", value: "orange" }
];

const lineAlertIndicatorLabels: Record<LineAlertIndicatorKey, string> = {
  vwap: "VWAP",
  ema20: "EMA 20",
  ema50: "EMA 50",
  ema200: "EMA 200"
};

const configuredAlertIndicatorLabels: Record<AlertIndicatorTarget, string> = {
  price: "Price",
  hdlxProfile: "HDLX Profile",
  vwap: "VWAP",
  ema20: "EMA 20",
  ema50: "EMA 50",
  ema200: "EMA 200"
};

const configuredAlertConditionLabels: Record<AlertCondition, string> = {
  testing: "testing",
  crossingAbove: "crossing above",
  crossingBelow: "crossing below"
};

const defaultIndicatorAlertSettings: IndicatorAlertSettings = {
  enabled: false,
  webhook: true,
  email: false,
  emailTo: typeof window === "undefined" ? "" : localStorage.getItem("bt_alert_email") ?? "",
  cooldownSeconds: 90,
  volumeProfile: {
    any: true,
    poc: true,
    vah: true,
    val: true,
    lvn: true
  },
  line: {
    vwap: { touch: true, crossAbove: true, crossBelow: true },
    ema20: { touch: true, crossAbove: true, crossBelow: true },
    ema50: { touch: true, crossAbove: true, crossBelow: true },
    ema200: { touch: true, crossAbove: true, crossBelow: true }
  }
};

const liveCandleStaleMs = 2500;
const priceHeartbeatStaleMs = 3500;
const priceHeartbeatIntervalMs = 1500;

function pageLimitFor(exchange: MarketSymbol["exchange"]) {
  return exchange === "okx" ? 300 : 1000;
}

function uniqueSortedCandles(candles: Candle[]) {
  const byTime = new Map<number, Candle>();
  for (const candle of candles) {
    byTime.set(candle.time, candle);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function historyFallbackOrder(exchange: ExchangeId) {
  const order: ExchangeId[] = ["bybit", "okx", "binance"];
  return order.filter((candidate) => candidate !== exchange);
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function makeAlertId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `alert-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatAlertPrice(price: number) {
  return price.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function normalizeChartSymbol(symbol: string) {
  return symbol.replace(/[-_/:\s]/g, "").toUpperCase();
}

function protectionLabel(type: PositionProtectionType) {
  if (type === "take-profit") return "TAKE PROFIT";
  if (type === "stop-loss") return "STOP LOSS";
  if (type === "trailing-stop") return "TRAILING STOP";
  if (type === "break-even") return "BREAK EVEN";
  return "OCO";
}

function formatReplayLabel(time?: number) {
  if (!time) return "Waiting";
  return new Date(time * 1000).toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function PixiBlackChart({
  workspaceId,
  marketSymbol,
  displaySymbol,
  exchangeLabel,
  timeframe,
  timeframeLabel,
  chartType,
  snapToLatest,
  activeDrawingTool,
  drawingsVisible,
  drawingsLocked,
  drawingClearSignal,
  replayControls,
  visibleIndicators,
  indicatorPeriods,
  indicatorVisualSettings,
  indicatorAdvancedSettings,
  kioseffSettings,
  auctionProfileSettings,
  alertDefinitions,
  onVisibleIndicatorsChange,
  onIndicatorPeriodsChange,
  onIndicatorVisualSettingsChange,
  onIndicatorAdvancedSettingsChange,
  onKioseffSettingsChange,
  onAuctionProfileSettingsChange,
  onAlertDefinitionsChange,
  onDrawingToolRequest,
  onOpenAlerts,
  onOpenStrategyLab,
  onPriceChange,
  onCandleChange,
  onReplayStatusChange,
  onReplayStartSelected,
  customPlots,
  onAlertFired,
  priceLineColor,
  priceLineIntensity,
  activeOrders = [],
  onRefreshOrders,
  allowedIndicators
}: PixiBlackChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<BlackChartEngine | null>(null);
  const oscillatorResizeRef = useRef<{
    key: OscillatorIndicatorKey;
    pointerId: number;
    startY: number;
    startHeight: number;
    maximumHeight: number;
  } | null>(null);
  const previousOscillatorVisibilityRef = useRef<Record<OscillatorIndicatorKey, boolean>>({
    openInterestOscillator: visibleIndicators.openInterestOscillator,
    zScoreOscillator: visibleIndicators.zScoreOscillator,
    waveTrendOscillator: visibleIndicators.waveTrendOscillator
  });
  const aifActiveRef = useRef(visibleIndicators.aif);
  const [oscillatorHostHeight, setOscillatorHostHeight] = useState(600);
  const [lastPrice, setLastPrice] = useState(66678.1);
  const [lastCandle, setLastCandle] = useState<Candle | null>(null);
  const [aifPriceTransform, setAifPriceTransform] = useState<ChartPriceTransformSnapshot | null>(null);
  const [kioseffSnapshot, setKioseffSnapshot] = useState<KioseffSnapshot | null>(null);
  const [auctionProfileSnapshots, setAuctionProfileSnapshots] = useState<AuctionProfileSnapshot[]>([]);
  const auctionProfileSnapshotsRef = useRef<AuctionProfileSnapshot[]>([]);
  const auctionProfileSnapshot = auctionProfileSnapshots.at(-1) ?? null;
  const [auctionProfileLoading, setAuctionProfileLoading] = useState(false);
  const [auctionProfileError, setAuctionProfileError] = useState<string | null>(null);
  const [liquidationFieldSnapshot, setLiquidationFieldSnapshot] = useState<LiquidationFieldSnapshot | null>(null);
  const [liquidationFieldStatus, setLiquidationFieldStatus] = useState<LiquidationFieldRuntimeStatus>({
    state: "IDLE", message: "Awaiting activation", source: "NONE", lastInputAt: null
  });
  const liquidationFieldControllerRef = useRef<LiquidationFieldController | null>(null);
  const [auctionProfileSourceRevision, setAuctionProfileSourceRevision] = useState(0);
  const [kioseffUnavailable, setKioseffUnavailable] = useState<KioseffUnavailableDiagnostic | null>(null);
  const [kioseffLoadState, setKioseffLoadState] = useState<KioseffLoadState>({ stage: "idle" });
  const [kioseffDiagnostics, setKioseffDiagnostics] = useState<KioseffRuntimeDiagnostics>(
    emptyKioseffRuntimeDiagnostics
  );
  const [kioseffSourceRevision, setKioseffSourceRevision] = useState(0);
  const kioseffCalculationVersion = kioseffCalculationSettingsHash(kioseffSettings);
  const normalizedAuctionProfileSettings = useMemo(() => migrateAuctionProfileSettings(auctionProfileSettings), [auctionProfileSettings]);
  const liquidationFieldSettings = useMemo(
    () => migrateLiquidationFieldSettings(indicatorAdvancedSettings.liquidationField),
    [indicatorAdvancedSettings.liquidationField]
  );
  const latestLiquidationFieldSettingsRef = useRef(liquidationFieldSettings);
  latestLiquidationFieldSettingsRef.current = liquidationFieldSettings;
  const liquidationFieldCalculationKey = [
    liquidationFieldSettings.horizon,
    liquidationFieldSettings.customHours,
    liquidationFieldSettings.venue,
    liquidationFieldSettings.modelPreset,
    liquidationFieldSettings.priceRows,
    liquidationFieldSettings.timeColumns,
    liquidationFieldSettings.leverageMinimum,
    liquidationFieldSettings.leverageMaximum,
    liquidationFieldSettings.visualFixture
  ].join(":");
  const latestAuctionProfileSettingsRef = useRef(normalizedAuctionProfileSettings);
  latestAuctionProfileSettingsRef.current = normalizedAuctionProfileSettings;
  const auctionDataRequired = resolveAuctionVisualizationLayers(
    visibleIndicators.auctionProfile,
    chartType === "volumeFootprint",
    normalizedAuctionProfileSettings.rendering.visualizationType
  ).dataRequired;
  const auctionProfileCalculationVersion = auctionProfileCalculationSettingsHash(normalizedAuctionProfileSettings);
  const debouncedAuctionProfileCalculationVersion = useDebouncedValue(auctionProfileCalculationVersion, 220);
  const auctionProfileDataRevision = normalizedAuctionProfileSettings.compositeLocked
    ? "locked:" + debouncedAuctionProfileCalculationVersion
    : "chart:" + auctionProfileSourceRevision;
  const [dataStatus, setDataStatus] = useState("CONNECTING");
  const [chartHistoryState, setChartHistoryState] = useState<
    "loading" | "ready" | "unavailable"
  >("loading");
  const [activeIndicator, setActiveIndicator] = useState<IndicatorKey | null>(null);
  const [volumeProfileSettingsTab, setVolumeProfileSettingsTab] = useState<VolumeProfileSettingsTab>("inputs");
  const [adaptiveSwingSettingsTab, setAdaptiveSwingSettingsTab] = useState<AdaptiveSwingSettingsTab>("signals");
  const [historyDepth, setHistoryDepth] = useState<HistoryDepth>(() => {
    const configuredDepth = Number(indicatorAdvancedSettings.volumeProfile?.fixedRangeLength ?? 5000);
    if (configuredDepth >= 20000) return 20000;
    if (configuredDepth >= 10000) return 10000;
    return 5000;
  });
  const marketHistoryTarget = Math.min(20000, Math.max(
    historyDepth,
    visibleIndicators.volatilityHeatmap ? kioseffSettings.historyLookbackBars : 0,
    auctionDataRequired ? normalizedAuctionProfileSettings.lookbackBars : 0
  ));
  const [indicatorsCollapsed, setIndicatorsCollapsed] = useState(false);
  const [mountedIndicators, setMountedIndicators] = useState<Record<IndicatorKey, boolean>>(() => ({ ...visibleIndicators }));
  const [alertSettings, setAlertSettings] = useState<IndicatorAlertSettings>(defaultIndicatorAlertSettings);
  const [chartContextMenu, setChartContextMenu] = useState<ChartContextMenuState | null>(null);
  const [orderContextMenu, setOrderContextMenu] = useState<OrderContextMenuState | null>(null);
  const [executionTicketPreset, setExecutionTicketPreset] = useState<UnifiedExecutionTicketPreset | null>(null);
  const [managedPositions, setManagedPositions] = useState<ManagedPosition[]>(() => blackCorePositionManager.listActivePositions());
  const [positionOverlayTick, setPositionOverlayTick] = useState(0);
  const [alertToast, setAlertToast] = useState<AlertToast | null>(null);
  const [editingChartAlertId, setEditingChartAlertId] = useState<string | null>(null);
  const replaySourceRef = useRef<Candle[]>([]);
  const replayControlsRef = useRef(replayControls);
  const replayStatusCallbackRef = useRef(onReplayStatusChange);
  const replaySelectionCallbackRef = useRef(onReplayStartSelected);
  const replayActiveRef = useRef(replayControls.enabled);
  const replayTimerRef = useRef<number | undefined>(undefined);
  const replayCursorRef = useRef(0);
  const replayStartIndexRef = useRef(0);
  const replayCommandIdRef = useRef(-1);
  const kioseffRefreshTimerRef = useRef<number | undefined>(undefined);
  const chartSourceVenueRef = useRef<ExchangeId | null>(null);
  const auctionRefreshTimerRef = useRef<number | undefined>(undefined);
  const auctionWorkerRef = useRef<AuctionProfileWorkerClient | null>(null);
  const auctionTradeHistoryRef = useRef<CanonicalTrade[]>([]);
  const auctionTradeBufferRef = useRef<CanonicalTrade[]>([]);
  const auctionTradeFlushTimerRef = useRef<number | undefined>(undefined);
  const replayAppliedRef = useRef(false);
  const alertSettingsRef = useRef(alertSettings);
  const lastAlertSentAtRef = useRef(new Map<string, number>());
  const configuredAlertRuntimeRef = useRef(new Map<string, { lastFiredAt: number; fired: boolean }>());
  const alertToastTimerRef = useRef<number | undefined>(undefined);
  aifActiveRef.current = visibleIndicators.aif;

  const scopedChartAlerts = useMemo(() => {
    return alertDefinitions.filter((definition) =>
      definition.symbol === displaySymbol &&
      definition.exchange === exchangeLabel &&
      (definition.indicator === "price" || definition.timeframe === timeframe)
    );
  }, [alertDefinitions, displaySymbol, exchangeLabel, timeframe]);

  const editingChartAlert = useMemo(
    () => scopedChartAlerts.find((alert) => alert.id === editingChartAlertId) ?? null,
    [editingChartAlertId, scopedChartAlerts]
  );

  const activeChartPosition = useMemo(() => {
    const symbol = normalizeChartSymbol(displaySymbol || marketSymbol.rawSymbol);
    return managedPositions.find((position) =>
      normalizeChartSymbol(position.symbol) === symbol &&
      (!marketSymbol.exchange || position.exchange === marketSymbol.exchange)
    ) ?? null;
  }, [displaySymbol, managedPositions, marketSymbol.exchange, marketSymbol.rawSymbol]);

  const positionLines = useMemo(() => {
    if (!activeChartPosition) return [];
    const lines: Array<{
      id: string;
      label: string;
      price: number;
      tone: "entry" | "tp" | "sl" | "trail" | "liq";
      protection?: PositionProtectionOrder;
      y?: number | null;
    }> = [
      { id: "entry", label: "AVG ENTRY", price: activeChartPosition.averagePrice, tone: "entry" }
    ];

    if (activeChartPosition.liquidationPrice) {
      lines.push({ id: "liq", label: "LIQUIDATION", price: activeChartPosition.liquidationPrice, tone: "liq" });
    }

    for (const protection of activeChartPosition.protections) {
      if (protection.status !== "active" || !protection.price) continue;
      lines.push({
        id: protection.id,
        label: protectionLabel(protection.type),
        price: protection.price,
        tone: protection.type === "take-profit" ? "tp" : protection.type === "trailing-stop" ? "trail" : "sl",
        protection
      });
    }

    return lines
      .map((line) => ({ ...line, y: engineRef.current?.getScreenYForPrice(line.price) ?? null }))
      .filter((line) => line.y !== null);
  }, [activeChartPosition, positionOverlayTick]);

  const activeChartOrders = useMemo(() => {
    const chartSymbol = normalizeChartSymbol(displaySymbol || marketSymbol.rawSymbol);
    return deduplicateCanonicalOrders(activeOrders).orders
      .filter((order) => ["pending", "accepted", "working", "partially-filled"].includes(order.status))
      .filter((order) => normalizeChartSymbol(order.normalizedSymbol || order.symbol) === chartSymbol)
      .filter((order) => !marketSymbol.exchange || order.exchange === marketSymbol.exchange)
      .filter((order) => Number.isFinite(order.price) && Number(order.price) > 0);
  }, [activeOrders, displaySymbol, marketSymbol.exchange, marketSymbol.rawSymbol]);

  const chartOrderLines = useMemo(() => activeChartOrders
    .map((order) => ({ order, y: engineRef.current?.getScreenYForPrice(Number(order.price)) ?? null }))
    .filter((line) => line.y !== null), [activeChartOrders, positionOverlayTick]);

  useEffect(() => blackCorePositionManager.subscribe(setManagedPositions), []);

  useEffect(() => {
    if (!activeChartPosition && activeChartOrders.length === 0) return;
    const timer = window.setInterval(() => setPositionOverlayTick((tick) => tick + 1), 250);
    return () => window.clearInterval(timer);
  }, [activeChartPosition, activeChartOrders.length]);

  const emitReplayStatus = (active = replayControlsRef.current.enabled, playing = replayControlsRef.current.playing) => {
    const source = replaySourceRef.current;
    const total = source.length;
    const index = total > 0 ? clampNumber(replayCursorRef.current, 0, total - 1) : 0;
    const candle = source[index];

    replayStatusCallbackRef.current?.({
      active,
      playing: active && playing,
      selecting: active && replayControlsRef.current.selecting,
      index,
      total,
      progress: total > 1 ? index / (total - 1) : active ? 1 : 0,
      time: candle?.time,
      label: formatReplayLabel(candle?.time)
    });
  };

  const computeReplayStartIndex = () => {
    const source = replaySourceRef.current;
    if (source.length === 0) return 0;
    const { selectedIndex, startPercent } = replayControlsRef.current;
    if (selectedIndex !== undefined) return clampNumber(selectedIndex, 0, source.length - 1);

    return clampNumber(Math.round((source.length - 1) * (startPercent / 100)), 0, source.length - 1);
  };

  const applyReplayCursor = (index: number, resetView = false) => {
    const engine = engineRef.current;
    const source = replaySourceRef.current;
    if (!engine || source.length === 0) {
      emitReplayStatus(true, false);
      return;
    }

    const cursor = clampNumber(index, 0, source.length - 1);
    replayCursorRef.current = cursor;
    engine.setCandles(source.slice(0, cursor + 1), {
      preserveView: !resetView,
      heatmapSource: source,
      heatmapUntilIndex: cursor
    });
    setDataStatus(`REPLAY ${formatReplayLabel(source[cursor]?.time)} - ${cursor + 1}/${source.length}`);
    emitReplayStatus(true, replayControlsRef.current.playing && cursor < source.length - 1);
  };

  const setReplaySource = (candles: Candle[]) => {
    replaySourceRef.current = uniqueSortedCandles(candles).slice(-MAX_RETAINED_CHART_BARS);
    setKioseffSourceRevision((revision) => revision + 1);
    setAuctionProfileSourceRevision((revision) => revision + 1);
    if (replayActiveRef.current) {
      if (replayControlsRef.current.selecting) {
        engineRef.current?.setCandles(replaySourceRef.current, {
          heatmapSource: replaySourceRef.current,
          heatmapUntilIndex: replaySourceRef.current.length - 1
        });
        setDataStatus("REPLAY - CLICK A CANDLE TO START");
        emitReplayStatus(true, false);
        return;
      }
      replayStartIndexRef.current = computeReplayStartIndex();
      applyReplayCursor(replayStartIndexRef.current, true);
    } else {
      emitReplayStatus(false, false);
    }
  };

  const upsertReplaySourceCandle = (candle: Candle) => {
    const source = replaySourceRef.current;
    const last = source[source.length - 1];
    if (last && candle.time < last.time) return;
    const historyAdvanced = shouldRefreshKioseffHistory(last?.time, candle.time);

    replaySourceRef.current =
      last?.time === candle.time
        ? [...source.slice(0, -1), candle]
        : [...source, candle].slice(-MAX_RETAINED_CHART_BARS);
    if (
      historyAdvanced &&
      visibleIndicators.volatilityHeatmap &&
      !kioseffRefreshTimerRef.current
    ) {
      kioseffRefreshTimerRef.current = window.setTimeout(() => {
        kioseffRefreshTimerRef.current = undefined;
        setKioseffSourceRevision((revision) => revision + 1);
      }, 1000);
    }
    if (historyAdvanced && auctionDataRequired && !auctionRefreshTimerRef.current) {
      auctionRefreshTimerRef.current = window.setTimeout(() => {
        auctionRefreshTimerRef.current = undefined;
        setAuctionProfileSourceRevision((revision) => revision + 1);
      }, 1000);
    }


  };

  const ingestTradeIntoReplaySource = (price: number, quantity: number, time: number) => {
    const source = replaySourceRef.current;
    const last = source[source.length - 1];
    if (!last) return;

    const bucket = Math.floor(time / timeframeSeconds[timeframe]) * timeframeSeconds[timeframe];
    if (bucket < last.time) return;

    if (bucket === last.time) {
      upsertReplaySourceCandle({
        ...last,
        high: Math.max(last.high, price),
        low: Math.min(last.low, price),
        close: price,
        volume: last.volume + quantity
      });
      return;
    }

    upsertReplaySourceCandle({
      time: bucket,
      open: last.close,
      high: Math.max(last.close, price),
      low: Math.min(last.close, price),
      close: price,
      volume: quantity
    });
  };

  useEffect(() => {
    replayStatusCallbackRef.current = onReplayStatusChange;
  }, [onReplayStatusChange]);

  useEffect(() => {
    replaySelectionCallbackRef.current = onReplayStartSelected;
  }, [onReplayStartSelected]);

  useEffect(() => {
    engineRef.current?.setReplaySelectionMode(
      replayControls.enabled && replayControls.selecting,
      (selection) => replaySelectionCallbackRef.current?.(selection)
    );
  }, [replayControls.enabled, replayControls.selecting]);

  useEffect(() => {
    let disposed = false;
    let initialized = false;
    let liveCandles: MarketDataSubscription<unknown> | undefined;
    let liveTrades: MarketDataSubscription<unknown> | undefined;
    let tradePollTimer: number | undefined;
    let tickerHeartbeatTimer: number | undefined;
    let tradePollingStarted = false;
    let synthesizeCandlesFromTrades = false;
    let mockSeedPrice = lastPrice;
    let lastLiveCandleAt = 0;
    let lastTradeAt = 0;
    let lastTickerHeartbeatAt = 0;
    let loadingOlderHistory = false;
    let historyExhausted = false;
    let lastHistoryCursor: number | undefined;
    const seenTrades = new Set<string>();
    const seenTradeOrder: string[] = [];
    const host = hostRef.current;
    if (!host) return;
    const adapter = getMarketDataEngineAdapter(marketSymbol.exchange);
    const allowSimulatedFallback =
      marketSymbol.exchange === "mock" || import.meta.env.VITE_ALLOW_SIMULATED_MARKET_FALLBACK === "true";
    replaySourceRef.current = [];
    replayCursorRef.current = 0;
    replayAppliedRef.current = false;
    emitReplayStatus(replayActiveRef.current, false);
    let historyAdapter = adapter;
    let historyExchange = marketSymbol.exchange;
    let historySymbol = marketSymbol.rawSymbol;
    let historyLabel = adapter?.label ?? "Mock";
    setLastCandle(null);
    setChartHistoryState("loading");
    setDataStatus(adapter ? `${adapter.label.toUpperCase()} CONNECTING` : allowSimulatedFallback ? "SIMULATION" : "MARKET DATA UNAVAILABLE");
    synthesizeCandlesFromTrades = !adapter?.subscribeCandles;

    const chartQuery = {
      exchange: marketSymbol.exchange,
      symbol: marketSymbol.rawSymbol,
      timeframe,
      marketKind: marketSymbol.marketKind
    } as const;
    const pageLimit = pageLimitFor(marketSymbol.exchange);

    const fetchHistoryWindowFrom = async (
      sourceAdapter: MarketDataAdapter,
      sourceExchange: ExchangeId,
      sourceSymbol: string,
      targetBars: number,
      onProgress?: (loaded: number, target: number) => void
    ) => {
      const sourcePageLimit = pageLimitFor(sourceExchange);

      const collected: Candle[] = [];
      const seenTimes = new Set<number>();
      let beforeTime: number | undefined;
      const maxPages = Math.ceil(targetBars / sourcePageLimit) + 3;

      for (let page = 0; page < maxPages && collected.length < targetBars; page++) {
        const remaining = targetBars - collected.length;
        const cursor = beforeTime;
        const candles = await sourceAdapter.getHistoricalCandles({
          exchange: sourceExchange,
          symbol: sourceSymbol,
          timeframe,
          marketKind: marketSymbol.marketKind,
          limit: Math.min(sourcePageLimit, remaining),
          to: cursor ? cursor - timeframeSeconds[timeframe] : undefined
        });

        const eligibleCandles = cursor ? candles.filter((candle) => candle.time < cursor) : candles;
        const newCandles = eligibleCandles.filter((candle) => {
          if (seenTimes.has(candle.time)) return false;
          seenTimes.add(candle.time);
          return true;
        });

        if (newCandles.length === 0) break;
        collected.push(...newCandles);
        onProgress?.(Math.min(seenTimes.size, targetBars), targetBars);
        beforeTime = Math.min(...newCandles.map((candle) => candle.time));
        if (eligibleCandles.length < Math.min(sourcePageLimit, remaining)) break;
      }

      const history = uniqueSortedCandles(collected).slice(-targetBars);
      if (history.length === 0) {
        throw new Error(`${sourceAdapter.label} returned no historical candles`);
      }
      return history;
    };

    const fetchHistoryWindow = async (
      targetBars: number,
      onProgress?: (loaded: number, target: number) => void
    ) => {
      if (!adapter) return [];
      return fetchHistoryWindowFrom(
        adapter,
        marketSymbol.exchange,
        marketSymbol.rawSymbol,
        targetBars,
        onProgress
      );
    };

    const fetchFallbackHistoryWindow = async (
      targetBars: number,
      onProgress?: (loaded: number, target: number) => void
    ) => {
      const failures: string[] = [];

      for (const exchange of historyFallbackOrder(marketSymbol.exchange)) {
        const sourceAdapter = getMarketDataEngineAdapter(exchange);
        if (!sourceAdapter) continue;

        try {
          const sourceSymbol = sourceAdapter.normalizeSymbol(`${marketSymbol.baseAsset}${marketSymbol.quoteAsset}`, marketSymbol.marketKind);
          const candles = await fetchHistoryWindowFrom(
            sourceAdapter,
            exchange,
            sourceSymbol,
            targetBars,
            onProgress
          );
          return { candles, adapter: sourceAdapter };
        } catch (err) {
          failures.push(`${sourceAdapter.label}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      throw new Error(`No cross-exchange history fallback available (${failures.join(" | ")})`);
    };

    const loadOlderHistory = (oldestTime: number) => {
      if (!historyAdapter || loadingOlderHistory || historyExhausted || lastHistoryCursor === oldestTime) return;
      loadingOlderHistory = true;
      lastHistoryCursor = oldestTime;
      setDataStatus(`${historyLabel.toUpperCase()} HISTORY`);

      historyAdapter
        .getHistoricalCandles({
          exchange: historyExchange,
          symbol: historySymbol,
          timeframe,
          marketKind: marketSymbol.marketKind,
          limit: pageLimitFor(historyExchange),
          to: oldestTime - timeframeSeconds[timeframe]
        })
        .then((candles) => {
          if (disposed) return;
          const olderCandles = candles.filter((candle) => candle.time < oldestTime);
          if (olderCandles.length === 0) {
            historyExhausted = true;
            setDataStatus(`${historyLabel.toUpperCase()} LIVE`);
            return;
          }

          replaySourceRef.current = uniqueSortedCandles([
            ...olderCandles,
            ...replaySourceRef.current
          ]).slice(-MAX_RETAINED_CHART_BARS);
          if (replayActiveRef.current) {
            setDataStatus("REPLAY HISTORY EXTENDED");
            return;
          }

          engineRef.current?.prependCandles(olderCandles);
          setDataStatus(`${historyLabel.toUpperCase()} LIVE - +${olderCandles.length} BARS`);
        })
        .catch((err: unknown) => {
          console.error(`${historyLabel} older candle request failed`, err);
          lastHistoryCursor = undefined;
          setDataStatus(`${historyLabel.toUpperCase()} LIVE`);
        })
        .finally(() => {
          loadingOlderHistory = false;
        });
    };

    const candleStreamIsStale = () => !lastLiveCandleAt || Date.now() - lastLiveCandleAt > liveCandleStaleMs;

    const ingestTrades = (trades: TradeTick[]) => {
      const newTrades = trades.filter((trade) => !seenTrades.has(trade.tradeId));
      const canonicalTrades = newTrades.map(normalizeCanonicalTrade);
      canonicalCvdService.ingest(canonicalTrades);
      auctionTradeHistoryRef.current = [...auctionTradeHistoryRef.current, ...canonicalTrades].slice(-250_000);
      if (auctionDataRequired && !normalizedAuctionProfileSettings.compositeLocked && auctionWorkerRef.current && canonicalTrades.length) {
        auctionTradeBufferRef.current.push(...canonicalTrades);
        if (!auctionTradeFlushTimerRef.current) {
          auctionTradeFlushTimerRef.current = window.setTimeout(() => {
            auctionTradeFlushTimerRef.current = undefined;
            const buffered = auctionTradeBufferRef.current.splice(0);
            const client = auctionWorkerRef.current;
            if (!client || !buffered.length) return;
            void client.appendTrades(buffered, "live:" + Date.now()).then((snapshots) => {
              const previousFingerprint = auctionProfileSnapshotsRef.current.map(snapshot => snapshot.profileVersion).join("|");
              const nextFingerprint = snapshots.map(snapshot => snapshot.profileVersion).join("|");
              if (previousFingerprint === nextFingerprint) return;
              const retained = retainCertifiedRadapSnapshots(auctionProfileSnapshotsRef.current, snapshots);
              auctionProfileSnapshotsRef.current = retained;
              setAuctionProfileSnapshots(retained);
              engineRef.current?.setAuctionProfileState(retained, latestAuctionProfileSettingsRef.current);
            }).catch(() => undefined);
          }, 600);
        }
      }
      for (const trade of newTrades) {
        if (seenTrades.has(trade.tradeId)) continue;
        seenTrades.add(trade.tradeId);
        seenTradeOrder.push(trade.tradeId);
        if (seenTradeOrder.length > 2500) {
          const expiredTradeId = seenTradeOrder.shift();
          if (expiredTradeId) seenTrades.delete(expiredTradeId);
        }

        lastTradeAt = Date.now();
        if (synthesizeCandlesFromTrades || candleStreamIsStale()) {
          ingestTradeIntoReplaySource(trade.price, trade.quantity, trade.time);
          if (replayActiveRef.current) continue;
          engineRef.current?.ingestTrade(trade.price, trade.quantity, trade.time, timeframeSeconds[timeframe]);
        } else {
          if (replayActiveRef.current) continue;
          engineRef.current?.updateLastPrice(trade.price);
        }
      }
    };

    const pollTrades = () => {
      if (!adapter) return;
      adapter
        .getRecentTrades?.(marketSymbol, 25)
        .then((trades) => {
          if (!disposed) ingestTrades(trades);
        })
        .catch((err: unknown) => {
          console.error(`${adapter.label} trade REST heartbeat failed`, err);
        });
    };

    const startTradePolling = () => {
      if (!adapter?.getRecentTrades || tradePollingStarted || disposed) return;
      tradePollingStarted = true;
      pollTrades();
      tradePollTimer = window.setInterval(pollTrades, 1000);
    };

    const applyTickerHeartbeat = (price: number, time: number) => {
      if (!Number.isFinite(price) || price <= 0) return;
      lastTickerHeartbeatAt = Date.now();
      ingestTradeIntoReplaySource(price, 0, time);
      if (replayActiveRef.current) return;
      engineRef.current?.ingestTrade(price, 0, time, timeframeSeconds[timeframe]);
    };

    const pollTickerHeartbeat = () => {
      if (!adapter?.getTickerSnapshot || disposed) return;
      const latestActivity = Math.max(lastLiveCandleAt, lastTradeAt, lastTickerHeartbeatAt);
      if (latestActivity && Date.now() - latestActivity < priceHeartbeatStaleMs) return;

      adapter
        .getTickerSnapshot(marketSymbol)
        .then((snapshot) => {
          if (disposed) return;
          applyTickerHeartbeat(snapshot.lastPrice, snapshot.time || Math.floor(Date.now() / 1000));
          setDataStatus((current) => current.includes("REPLAY") ? current : `${adapter.label.toUpperCase()} HEARTBEAT`);
        })
        .catch((err: unknown) => {
          console.error(`${adapter.label} ticker heartbeat failed`, err);
        });
    };

    const startTickerHeartbeat = () => {
      if (!adapter?.getTickerSnapshot || tickerHeartbeatTimer || disposed) return;
      tickerHeartbeatTimer = window.setInterval(pollTickerHeartbeat, priceHeartbeatIntervalMs);
    };

    const safeAnchorPrice = (price?: number) => {
      if (price && Number.isFinite(price) && price > 0) return price;
      if (lastPrice && Number.isFinite(lastPrice) && lastPrice > 0) return lastPrice;
      return 66678.1;
    };

    const startMockFallback = (anchorPrice?: number, onEvent?: (event: FeedEvent) => void) => {
      synthesizeCandlesFromTrades = true;
      mockSeedPrice = safeAnchorPrice(anchorPrice);
      setDataStatus("MOCK FALLBACK");
      const mockCandles = createMockCandles(historyDepth, timeframeSeconds[timeframe], mockSeedPrice);
      chartSourceVenueRef.current = "mock";
      setReplaySource(mockCandles);
      if (!replayActiveRef.current) {
        engine.setCandles(mockCandles);
        engine.startMockFeed(timeframeSeconds[timeframe], onEvent);
      }

      if (adapter?.subscribeTrades && !liveTrades) {
        liveTrades = adapter.subscribeTrades(marketSymbol, (trade) => {
          if (disposed) return;
          const driftFromSeed = mockSeedPrice ? Math.abs(trade.price - mockSeedPrice) / mockSeedPrice : 0;
          if (driftFromSeed > 0.035) {
            mockSeedPrice = trade.price;
            const nextMockCandles = createMockCandles(historyDepth, timeframeSeconds[timeframe], mockSeedPrice);
            setReplaySource(nextMockCandles);
            if (!replayActiveRef.current) engine.setCandles(nextMockCandles);
          }
          ingestTrades([trade]);
        });

        liveTrades.onError((err) => {
          console.error(`${adapter.label} fallback trade stream failed`, err);
          startTradePolling();
        });
      } else {
        startTradePolling();
      }

      startTickerHeartbeat();
    };

    const startPrimaryLiveFeeds = () => {
      if (!adapter || disposed) return;

      liveCandles = adapter.subscribeCandles?.({ ...chartQuery, limit: pageLimit }, (candle) => {
        lastLiveCandleAt = Date.now();
        upsertReplaySourceCandle(candle);
        if (replayActiveRef.current) return;
        engine.upsertCandle(candle);
      });

      liveTrades = adapter.subscribeTrades?.(marketSymbol, (trade) => {
        ingestTrades([trade]);
      });

      if (!liveTrades) {
        startTradePolling();
      }

      startTickerHeartbeat();

      liveCandles?.onError((err) => {
        console.error(`${adapter.label} live candle stream failed`, err);
        setDataStatus((current) => current.includes("VIA") ? current : `${adapter.label.toUpperCase()} REST`);
        synthesizeCandlesFromTrades = true;
        liveCandles?.unsubscribe();
        liveCandles = undefined;
        startTradePolling();
      });

      liveTrades?.onError((err) => {
        console.error(`${adapter.label} live trade stream failed`, err);
        liveTrades?.unsubscribe();
        liveTrades = undefined;
        startTradePolling();
      });
    };

    const engine = new BlackChartEngine({
      host,
      candles: !adapter && allowSimulatedFallback
        ? createMockCandles(historyDepth, timeframeSeconds[timeframe], lastPrice)
        : [],
      chartType,
      snapToLatest,
      visibleIndicators,
      indicatorPeriods,
      indicatorVisualSettings,
      indicatorAdvancedSettings,
      kioseffSettings,
      alertDefinitions: scopedChartAlerts,
      customPlots: customPlots || [],
      onAlertFired: (alertId, price) => onAlertFired?.(alertId, price),
      auctionProfileSettings: normalizedAuctionProfileSettings,
      auctionProfileSnapshots,
      onAlertEditRequest: (alertId) => {
        setEditingChartAlertId(alertId);
        setChartContextMenu(null);
        onOpenAlerts?.();
      },
      onNeedMoreHistory: (oldestCandle) => loadOlderHistory(oldestCandle.time),
      onPriceChange: (price) => {
        setLastPrice(price);
        onPriceChange?.(price);
      },
      onCandleChange: (candle) => {
        setLastCandle(candle);
        onCandleChange?.(candle);
      },
      onPriceTransformChange: (transform) => {
        if (aifActiveRef.current) setAifPriceTransform(transform);
      },
      priceLineColor,
      priceLineIntensity
    });
    engineRef.current = engine;
    engine.setReplaySelectionMode(
      replayControlsRef.current.enabled && replayControlsRef.current.selecting,
      (selection) => replaySelectionCallbackRef.current?.(selection)
    );

    engine
      .init()
      .then(() => {
        initialized = true;
        if (disposed) {
          engine.destroy();
          return;
        }

        if (!adapter) {
          if (allowSimulatedFallback) startMockFallback();
          else {
            setDataStatus("MARKET DATA UNAVAILABLE - NO ADAPTER");
            setChartHistoryState("unavailable");
          }
          return;
        }

        const reportChartHistoryProgress = (loaded: number, target: number) => {
          if (disposed || !visibleIndicators.volatilityHeatmap) return;
          setKioseffLoadState({ stage: "fetching-chart-history", loaded, target });
        };
        setDataStatus(`${adapter.label.toUpperCase()} HISTORY ${marketHistoryTarget.toLocaleString()} BARS`);
        return fetchHistoryWindow(marketHistoryTarget, reportChartHistoryProgress)
          .then((candles) => {
            if (disposed) return;
            chartSourceVenueRef.current = marketSymbol.exchange;
            setReplaySource(candles);
            setChartHistoryState("ready");
            if (!replayActiveRef.current) {
              engine.setCandles(candles);
              setDataStatus(`${adapter.label.toUpperCase()} LIVE - ${candles.length.toLocaleString()} BARS`);
            }
            startPrimaryLiveFeeds();
          })
          .catch((err: unknown) => {
            console.error(`${adapter.label} market data failed; trying cross-exchange history`, err);
            setDataStatus(`${adapter.label.toUpperCase()} HISTORY FALLBACK`);

            return fetchFallbackHistoryWindow(
              marketHistoryTarget,
              reportChartHistoryProgress
            )
              .then(({ candles, adapter: sourceAdapter }) => {
                if (disposed) return;
                synthesizeCandlesFromTrades = !adapter.subscribeCandles;
                historyAdapter = sourceAdapter;
                historyExchange = sourceAdapter.id;
                historySymbol = sourceAdapter.normalizeSymbol(`${marketSymbol.baseAsset}${marketSymbol.quoteAsset}`, marketSymbol.marketKind);
                historyLabel = `${adapter.label} VIA ${sourceAdapter.label}`;
                historyExhausted = false;
                lastHistoryCursor = undefined;
                chartSourceVenueRef.current = sourceAdapter.id;
                setReplaySource(candles);
                setChartHistoryState("ready");
                if (!replayActiveRef.current) {
                  engine.setCandles(candles);
                  setDataStatus(`${adapter.label.toUpperCase()} VIA ${sourceAdapter.label.toUpperCase()} - ${candles.length.toLocaleString()} BARS`);
                }
                startPrimaryLiveFeeds();
              })
              .catch((fallbackErr: unknown) => {
                console.error(`${adapter.label} cross-exchange history failed`, fallbackErr);
                if (allowSimulatedFallback) {
                  startMockFallback(undefined, (event) => {
                    if (event.type === "alert") {
                      sendWebhook({
                        terminal: "Black-Terminal",
                        engine: "PixiJS GPU renderer",
                        symbol: displaySymbol,
                        timeframe,
                        signal: event.signal,
                        price: event.price,
                        timestamp: new Date().toISOString()
                      });
                    }
                  });
                  return;
                }
                setDataStatus(`${adapter.label.toUpperCase()} LIVE - HISTORY UNAVAILABLE`);
                setChartHistoryState("unavailable");
                startPrimaryLiveFeeds();
              });
          });
      })
      .catch((err: unknown) => {
        console.error("Chart engine failed to initialize", err);
        setDataStatus("ENGINE ERROR");
        setChartHistoryState("unavailable");
      });

    return () => {
      disposed = true;
      liveCandles?.unsubscribe();
      liveTrades?.unsubscribe();
      if (tradePollTimer) window.clearInterval(tradePollTimer);
      if (tickerHeartbeatTimer) window.clearInterval(tickerHeartbeatTimer);
      if (kioseffRefreshTimerRef.current) {
        window.clearTimeout(kioseffRefreshTimerRef.current);
        kioseffRefreshTimerRef.current = undefined;
      }
      chartSourceVenueRef.current = null;
      if (initialized) {
        engine.destroy();
      }
      if (auctionRefreshTimerRef.current) {
        window.clearTimeout(auctionRefreshTimerRef.current);
        auctionRefreshTimerRef.current = undefined;
      }
      if (auctionTradeFlushTimerRef.current) {
        window.clearTimeout(auctionTradeFlushTimerRef.current);
        auctionTradeFlushTimerRef.current = undefined;
      }
      engineRef.current = null;
      setAifPriceTransform(null);
    };
  }, [
    marketSymbol.exchange,
    marketSymbol.rawSymbol,
    marketSymbol.marketKind,
    marketSymbol.baseAsset,
    marketSymbol.quoteAsset,
    displaySymbol,
    timeframe,
    historyDepth,
    marketHistoryTarget,
    visibleIndicators.volatilityHeatmap,
    auctionDataRequired,
    onPriceChange
  ]);

  useEffect(() => {
    let disposed = false;
    const coordinator = new KioseffHistoryCoordinator();
    let client: KioseffWorkerClient | null = null;
    const abort = new AbortController();
    let processedSourceVersion: string | null = null;
    let processedChartBarCount = 0;
    let processedFullyCertified = false;
    let lastCoverage: import("../modules/kioseff-stop-loss-clustering/data/types").IntrabarCoverage | undefined;
    const lowerTimeframe = normalizeKioseffTimeframeInput(
      kioseffSettings.model === "volatility-at-entry"
        ? "1"
        : kioseffSettings.absorbtion.lowerTimeframe
    );
    const trace = (stage: string, data: Record<string, unknown>) => {
      if (import.meta.env.DEV) {
        console.debug("[Kioseff pipeline]", {
          stage,
          exchange: marketSymbol.exchange,
          symbol: marketSymbol.rawSymbol,
          chartTimeframe: timeframe,
          lowerTimeframe,
          ...data
        });
      }
    };
    const setLoadStage = (state: KioseffLoadState) => {
      if (disposed) return;
      setKioseffLoadState(state);
      const parityState: KioseffRuntimeDiagnostics["parityState"] =
        state.stage === "idle"
          ? "NO_DATA"
          : state.stage === "requesting-symbol-metadata" ||
              state.stage === "fetching-chart-history" ||
              state.stage === "fetching-intrabar-history" ||
              state.stage === "grouping-intrabars"
            ? "FETCHING"
            : state.stage === "validating"
              ? "VALIDATING"
              : state.stage === "starting-worker" ||
                  state.stage === "rebuilding" ||
                  state.stage === "calculating" ||
                  state.stage === "rendering"
                ? "REBUILDING"
                : state.stage === "warming"
                  ? "WARMING"
                  : state.stage === "ready"
                    ? "READY"
                    : state.stage === "error"
                      ? "ERROR"
                      : "DEGRADED";
      setKioseffDiagnostics((current) => ({
        ...current,
        loadStage: state.stage,
        parityState
      }));
    };
    const degraded = (message: string) => {
      if (disposed || !processedSourceVersion || processedChartBarCount === 0) return false;
      setKioseffUnavailable(null);
      setLoadStage({ stage: "degraded", message });
      setKioseffDiagnostics((current) => ({
        ...current,
        workerStatus: "degraded",
        lastDiagnostic: message
      }));
      trace("degraded", {
        completedChartBars: processedChartBarCount,
        targetChartBars: kioseffSettings.historyLookbackBars,
        message
      });
      return true;
    };
    const unavailable = (
      reason: KioseffUnavailableDiagnostic["reason"],
      message: string,
      expected = 0,
      actual = 0,
      start: number | null = null,
      end: number | null = null
    ) => {
      if (disposed) return;
      const diagnostic = kioseffUnavailableDiagnostic({
        reason,
        venue: marketSymbol.exchange,
        symbol: marketSymbol.rawSymbol,
        chartTimeframe: timeframe,
        requestedLowerTimeframe: lowerTimeframe,
        expected,
        actual,
        start,
        end,
        realtimeSource: marketSymbol.exchange,
        message,
        coverage: lastCoverage
      });
      setKioseffSnapshot(null);
      setKioseffUnavailable(diagnostic);
      setLoadStage({ stage: "unavailable", reason });
      setKioseffDiagnostics((current) => ({
        ...current,
        workerStatus: "unavailable",
        lastDiagnostic: `${reason}: ${message}`
      }));
      engineRef.current?.setKioseffState(null, kioseffSettings);
      trace("unavailable", {
        rejectionReason: reason,
        message,
        expected,
        actual,
        start,
        end
      });
    };
    if (!visibleIndicators.volatilityHeatmap) {
      setKioseffSnapshot(null);
      setKioseffUnavailable(null);
      setLoadStage({ stage: "idle" });
      engineRef.current?.setKioseffState(null, kioseffSettings);
      return () => coordinator.reset();
    }
    setKioseffSnapshot(null);
    setKioseffUnavailable(null);
    engineRef.current?.setKioseffState(null, kioseffSettings);
    const selectedAdapter = getMarketDataEngineAdapter(marketSymbol.exchange);
    trace("selected-symbol", {
      entered: true,
      inputCount: 1,
      outputCount: selectedAdapter ? 1 : 0,
      normalizedSymbol:
        selectedAdapter?.normalizeSymbol(
          marketSymbol.rawSymbol,
          marketSymbol.marketKind
        ) ?? null,
      marketCategory: marketSymbol.marketKind,
      source: marketSymbol.exchange,
      generation: null,
      sourceVersion: null,
      rejectionReason: selectedAdapter ? null : "adapter-symbol-category-mismatch"
    });
    setKioseffDiagnostics({
      ...emptyKioseffRuntimeDiagnostics(),
      engineMode: "Pine Compatibility",
      exchange: marketSymbol.exchange,
      rawSymbol: marketSymbol.rawSymbol,
      normalizedSymbol: "",
      marketCategory: marketSymbol.marketKind,
      chartTimeframe: timeframe,
      requestedLowerTimeframe: lowerTimeframe,
      chartHistoryCount: kioseffSettings.historyLookbackBars,
      loadStage: "fetching-chart-history",
      settingsHash: kioseffSettingsHash(kioseffSettings),
      percentileMode:
        kioseffSettings.volatilityAtEntry.granularity === "lower"
          ? "SIGNED / PINE LOWER"
          : "ABSOLUTE BIN / PINE HIGHER"
    });
    const adapter = selectedAdapter;
    const chartCandles = replaySourceRef.current.slice(
      -kioseffSettings.historyLookbackBars
    );
    // The setting is a maximum ceiling. On large chart timeframes the venue's
    // entire market history can contain fewer bars (11,000 daily bars would be
    // roughly 30 years). Once chart history is loaded, certify every available
    // bar instead of misreporting a mathematically impossible target as a
    // degraded heatmap.
    const availableChartBarTarget = chartCandles.length;
    if (!adapter) {
      unavailable("unsupported-symbol-metadata", "The selected venue has no certified market-data adapter.");
      return () => coordinator.reset();
    }
    if (!chartCandles.length) {
      if (chartHistoryState === "unavailable") {
        unavailable(
          "missing-request-range",
          "No retained chart history was available to construct the one-minute request range."
        );
        return () => coordinator.reset();
      }
      setLoadStage({
        stage: "fetching-chart-history",
        loaded: 0,
        target: kioseffSettings.historyLookbackBars
      });
      trace("fetching-chart-history", {
        inputCount: 0,
        outputCount: 0,
        target: kioseffSettings.historyLookbackBars,
        rejectionReason: null
      });
      return () => coordinator.reset();
    }
    if (chartSourceVenueRef.current !== marketSymbol.exchange) {
      unavailable(
        "source-history-live-mismatch",
        `Chart history is from ${chartSourceVenueRef.current ?? "an unknown venue"}, not ${marketSymbol.exchange}.`
      );
      return () => coordinator.reset();
    }
    const calculateHistory = async (
      history: import("../modules/kioseff-stop-loss-clustering/data/types").KioseffHistoryResult
    ) => {
      if (disposed) return;
      lastCoverage = history.coverage;
      const intrabarCount = history.coverage.receivedIntrabars;
      const certifiedChartBars = certifiedKioseffInputTail(history.chartBars);
      const provisional = certifiedChartBars.at(-1);
      setLoadStage({
        stage: "validating",
        bars: history.chartBars.length,
        intrabars: intrabarCount,
        targetBars: history.warmup.targetChartBars
      });
      setKioseffDiagnostics((current) => ({
        ...current,
        normalizedSymbol: history.provenance.normalizedSymbol,
        tickSize: history.provenance.metadata.tickSize,
        chartHistoryCount: history.warmup.targetChartBars,
        minuteHistoryCount: intrabarCount,
        expectedIntrabars: history.coverage.expectedIntrabars,
        coveragePercent:
          history.coverage.expectedIntrabars > 0
            ? (history.coverage.receivedIntrabars /
                history.coverage.expectedIntrabars) *
              100
            : 0,
        missingIntervals: history.coverage.missingIntervals,
        duplicateIntervals: history.coverage.duplicateIntervals,
        outOfOrderIntervals: history.coverage.outOfOrderIntervals,
        requestStart: history.requestRange.start,
        requestEnd: history.requestRange.end,
        firstMinute: history.coverage.firstReceivedTime,
        lastMinute: history.coverage.lastReceivedTime,
        groupedChartBarCount: history.chartBars.length,
        completeCoverage: history.coverage.chartBarsWithCompleteIntrabars,
        partialCoverage: history.coverage.chartBarsWithPartialIntrabars,
        missingCoverage: history.coverage.chartBarsWithNoIntrabars,
        currentProvisionalIntrabars:
          provisional && !provisional.chartBarClosed
            ? provisional.intrabars.length
            : 0,
        sourceVersion: history.sourceVersion,
        dataHash: history.sourceVersion,
        settingsHash: kioseffSettingsHash(kioseffSettings),
        generation: history.generation
      }));
      if (!certifiedChartBars.length) {
        throw new KioseffDataUnavailableError("missing-intrabar-history", {
          chartBars: history.chartBars.length,
          cause: "no-contiguous-certified-tail"
        });
      }
      const trimmedChartBars = history.chartBars.length - certifiedChartBars.length;
      if (trimmedChartBars > 0) {
        setKioseffDiagnostics((current) => ({
          ...current,
          lastDiagnostic: `Retained ${certifiedChartBars.length.toLocaleString()} contiguous certified bars; omitted ${trimmedChartBars.toLocaleString()} older bars with unavailable one-minute coverage.`
        }));
      }
      setLoadStage({
        stage: "starting-worker",
        bars: history.warmup.completedChartBars,
        targetBars: history.warmup.targetChartBars
      });
      const context = {
        metadata: history.provenance.metadata,
        timeframe,
        sourceVersion: history.sourceVersion,
        settings: kioseffSettings,
        diagnostics: import.meta.env.DEV
      };
      if (!client) {
        client = new KioseffWorkerClient(context);
      }
      setKioseffDiagnostics((current) => ({
        ...current,
        workerStatus: "resetting"
      }));
      await client.reset(context);
      if (disposed) return;
      const chartBarsSent = certifiedChartBars.length;
      const intrabarsSent = certifiedChartBars.reduce(
        (sum, bar) => sum + bar.intrabars.length,
        0
      );
      setLoadStage({
        stage: "rebuilding",
        bars: chartBarsSent,
        intrabars: intrabarsSent,
        targetBars: history.warmup.targetChartBars
      });
      setLoadStage({
        stage: "calculating",
        bars: chartBarsSent,
        intrabars: intrabarsSent,
        targetBars: history.warmup.targetChartBars
      });
      setKioseffDiagnostics((current) => ({
        ...current,
        workerStatus: "calculating",
        chartBarsSent,
        intrabarsSent,
        groupOffsetsSent: 0
      }));
      trace("worker-request", {
        chartBarsSent,
        intrabarsSent,
        groupOffsetsSent: 0,
        generation: client.activeGeneration,
        sourceVersion: history.sourceVersion,
        provisionalBarTime:
          provisional && !provisional.chartBarClosed
            ? provisional.chartBar.time
            : null,
        rejectionReason: null
      });
      const snapshot = await client.calculateBatchChunked(
        certifiedChartBars,
        250,
        (progress) => {
          if (disposed) return;
          setLoadStage({
            stage: "calculating",
            bars: progress.totalBars,
            intrabars: progress.totalIntrabars,
            processedBars: progress.completedBars,
            processedIntrabars: progress.completedIntrabars,
            targetBars: history.warmup.targetChartBars
          });
          setKioseffDiagnostics((current) => ({
            ...current,
            workerStatus: "calculating",
            workerChartBarsReceived: progress.completedBars,
            workerIntrabarsReceived: progress.completedIntrabars
          }));
        }
      );
      if (disposed) return;
      const renderModel = buildKioseffRenderModel(snapshot, kioseffSettings);
      const clusterCount =
        renderModel.activeZones.length + renderModel.violatedZones.length;
      setLoadStage({
        stage: "rendering",
        clusters: clusterCount,
        completedBars: history.warmup.completedChartBars,
        targetBars: history.warmup.targetChartBars
      });
      setKioseffSnapshot(snapshot);
      setKioseffUnavailable(null);
      const chartEngine = engineRef.current;
      chartEngine?.setKioseffState(snapshot, kioseffSettings);
      const renderMetrics = chartEngine?.getKioseffRenderMetrics();
      const telemetry = client.lastTelemetry;
      setKioseffDiagnostics((current) => ({
        ...current,
        generation: client?.activeGeneration ?? history.generation,
        workerStatus: "complete",
        workerChartBarsReceived: telemetry.workerChartBarsReceived,
        workerIntrabarsReceived: telemetry.workerIntrabarsReceived,
        activeClusterCount: snapshot.activeClusters.length,
        activeBuyClusterCount: snapshot.activeClusters.filter(
          (cluster) => cluster.side === "buy-stop"
        ).length,
        activeSellClusterCount: snapshot.activeClusters.filter(
          (cluster) => cluster.side === "sell-stop"
        ).length,
        violatedClusterCount: snapshot.violatedClusters.length,
        panePointCount: snapshot.pane.length,
        renderActiveZones:
          renderMetrics?.activeZones ?? renderModel.activeZones.length,
        renderViolatedZones:
          renderMetrics?.violatedZones ?? renderModel.violatedZones.length,
        renderPanePoints: renderMetrics?.panePoints ?? renderModel.pane.length,
        renderGeometryCommands:
          renderMetrics?.geometryCommandCount ??
          renderModel.geometryCommandCount,
        renderContainerVisible: renderMetrics?.containerVisible ?? false,
        outputDiagnostics: telemetry.outputDiagnostics,
        lastDiagnostic: snapshot.diagnostics.at(-1)?.message ?? null,
        calculationMilliseconds: client?.lastCalculationMs ?? null,
        clusterHash: canonicalClusterHash(snapshot),
        lastClosedCandle: snapshot.committedThrough,
        lastRebuild: Math.floor(Date.now() / 1000)
      }));
      processedSourceVersion = history.sourceVersion;
      processedChartBarCount = certifiedChartBars.length;
      processedFullyCertified =
        history.warmup.full && certifiedChartBars.length === history.chartBars.length;
      if (processedFullyCertified) {
        setLoadStage({ stage: "ready" });
      } else {
        setLoadStage({
          stage: "warming",
          completedBars: certifiedChartBars.length,
          targetBars: history.warmup.targetChartBars
        });
      }
      trace("render-model", {
        activeClusters: snapshot.activeClusters.length,
        violatedClusters: snapshot.violatedClusters.length,
        panePoints: snapshot.pane.length,
        activeZones: renderModel.activeZones.length,
        violatedZones: renderModel.violatedZones.length,
        geometryCommands: renderModel.geometryCommandCount,
        pixiContainerVisible: renderMetrics?.containerVisible ?? false,
        generation: client.activeGeneration,
        sourceVersion: history.sourceVersion,
        calculationMs: client.lastCalculationMs,
        rejectionReason: null
      });
    };
    void coordinator
      .load({
        adapter,
        symbol: marketSymbol,
        chartCandles,
        targetChartBars: availableChartBarTarget,
        chartTimeframe: timeframe,
        lowerTimeframe,
        transport:
          typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
            ? "tauri"
            : "browser",
        signal: abort.signal,
        onProgress: (progress) => {
          if (disposed) return;
          if (progress.stage === "requesting-symbol-metadata") {
            setLoadStage({ stage: "requesting-symbol-metadata" });
            trace(progress.stage, {
              inputCount: chartCandles.length,
              outputCount: 0,
              generation: null,
              sourceVersion: null,
              rejectionReason: null
            });
          } else if (progress.stage === "fetching-intrabar-history") {
            setLoadStage({
              stage: "fetching-intrabar-history",
              loaded: progress.loaded,
              target: progress.target
            });
            setKioseffDiagnostics((current) => ({
              ...current,
              minuteHistoryCount: progress.loaded,
              requestStart: progress.requestRange.start,
              requestEnd: progress.requestRange.end
            }));
            trace(progress.stage, {
              inputCount: progress.loaded,
              outputCount: progress.loaded,
              target: progress.target,
              completedPages: progress.completedPages,
              targetPages: progress.targetPages,
              rejectionReason: null
            });
          } else {
            setLoadStage({
              stage: "grouping-intrabars",
              bars: progress.bars,
              intrabars: progress.intrabars,
              targetBars: availableChartBarTarget
            });
          }
        },
        onWarmup: calculateHistory
      })
      .then(async (history) => {
        if (disposed) return;
        if (processedSourceVersion !== history.sourceVersion) {
          await calculateHistory(history);
        } else if (history.warmup.full && processedFullyCertified) {
          setLoadStage({ stage: "ready" });
        } else {
          const retained = degraded(
            `Using ${processedChartBarCount.toLocaleString()} contiguous certified bars from ${availableChartBarTarget.toLocaleString()} available ${timeframe} bars. Older one-minute coverage is unavailable; the calculated heatmap remains active.`
          );
          if (!retained) {
            setLoadStage({
              stage: "warming",
              completedBars: history.warmup.completedChartBars,
              targetBars: history.warmup.targetChartBars
            });
          }
        }
      })
      .catch((error: unknown) => {
        if (disposed) return;
        if (error instanceof KioseffDataUnavailableError) {
          const retained = degraded(
            `Certified partial warmup retained (${processedChartBarCount.toLocaleString()} of ${kioseffSettings.historyLookbackBars.toLocaleString()} bars). Full history paused: ${error.reason}.`
          );
          if (!retained) unavailable(error.reason, error.message);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (
          !degraded(
            `Certified partial warmup retained (${processedChartBarCount.toLocaleString()} of ${kioseffSettings.historyLookbackBars.toLocaleString()} bars). Worker continuation paused: ${message}.`
          )
        ) {
          unavailable("worker-failure", message);
        }
      });
    return () => {
      disposed = true;
      abort.abort("effect-cleanup");
      coordinator.reset();
      client?.dispose();
    };
  }, [
    visibleIndicators.volatilityHeatmap,
    marketSymbol,
    timeframe,
    kioseffCalculationVersion,
    kioseffSourceRevision,
    historyDepth,
    chartHistoryState
  ]);

  useEffect(() => {
    engineRef.current?.setKioseffState(kioseffSnapshot, kioseffSettings);
  }, [kioseffSnapshot, kioseffSettings.style.heatmapBrightness]);

  useEffect(() => {
    if (!auctionDataRequired) {
      auctionWorkerRef.current?.dispose();
      auctionWorkerRef.current = null;
      auctionProfileSnapshotsRef.current = [];
      setAuctionProfileSnapshots([]);
      setAuctionProfileLoading(false);
      setAuctionProfileError(null);
      engineRef.current?.setAuctionProfileState(null, normalizedAuctionProfileSettings);
      return;
    }
    if (chartHistoryState !== "ready" || replaySourceRef.current.length === 0) return;

    let disposed = false;
    const client = new AuctionProfileWorkerClient();
    auctionWorkerRef.current?.dispose();
    auctionWorkerRef.current = client;
    setAuctionProfileLoading(auctionProfileSnapshotsRef.current.length === 0);
    setAuctionProfileError(null);
    const bars = replaySourceRef.current.slice(-normalizedAuctionProfileSettings.lookbackBars);
    const start = bars[0]?.time ?? 0;
    const interval = bars.length > 1 ? Math.max(1, bars[bars.length - 1]!.time - bars[bars.length - 2]!.time) : timeframeSeconds[timeframe];
    const end = (bars[bars.length - 1]?.time ?? 0) + interval;
    const trades = auctionTradeHistoryRef.current.filter(trade =>
      trade.venue === marketSymbol.exchange &&
      trade.symbol === marketSymbol.rawSymbol &&
      trade.timestamp >= start &&
      trade.timestamp <= end
    );

    void client.initialize({
      venue: marketSymbol.exchange,
      symbol: marketSymbol.rawSymbol,
      timeframe,
      metadata: marketSymbol.metadata,
      bars,
      trades,
      settings: normalizedAuctionProfileSettings,
      sourceRevision: auctionProfileDataRevision
    }).then(snapshots => {
      if (disposed) return;
      const retained = retainCertifiedRadapSnapshots(auctionProfileSnapshotsRef.current, snapshots);
      auctionProfileSnapshotsRef.current = retained;
      setAuctionProfileSnapshots(retained);
      setAuctionProfileLoading(false);
      if (!retained.length) setAuctionProfileError("RADAP produced no certified range for the selected parameters.");
      engineRef.current?.setAuctionProfileState(retained, latestAuctionProfileSettingsRef.current);
    }).catch(error => {
      if (disposed || String(error).includes("CANCELLED")) return;
      setAuctionProfileLoading(false);
      setAuctionProfileError(error instanceof Error ? error.message : String(error));
      if (auctionProfileSnapshotsRef.current.length === 0) {
        engineRef.current?.setAuctionProfileState(null, latestAuctionProfileSettingsRef.current);
      }
    });

    return () => {
      disposed = true;
      if (auctionWorkerRef.current === client) auctionWorkerRef.current = null;
      client.dispose();
    };
  }, [
    auctionDataRequired,
    marketSymbol.exchange,
    marketSymbol.rawSymbol,
    timeframe,
    chartHistoryState,
    debouncedAuctionProfileCalculationVersion,
    auctionProfileDataRevision
  ]);

  useEffect(() => {
    engineRef.current?.setAuctionProfileState(
      auctionDataRequired ? auctionProfileSnapshots : null,
      normalizedAuctionProfileSettings
    );
  }, [
    auctionProfileSnapshots,
    normalizedAuctionProfileSettings.rendering,
    normalizedAuctionProfileSettings.diagnosticsVisible,
    auctionDataRequired
  ]);

  useEffect(() => {
    replayControlsRef.current = replayControls;
    replayActiveRef.current = replayControls.enabled;

    if (replayTimerRef.current) {
      window.clearInterval(replayTimerRef.current);
      replayTimerRef.current = undefined;
    }

    const engine = engineRef.current;
    const source = replaySourceRef.current;

    if (!replayControls.enabled) {
      replayAppliedRef.current = false;
      replayCommandIdRef.current = replayControls.commandId;
      if (engine && source.length > 0) {
        engine.setCandles(source, {
          heatmapSource: source,
          heatmapUntilIndex: source.length - 1
        });
        setDataStatus(`${exchangeLabel.toUpperCase()} LIVE - ${source.length.toLocaleString()} BARS`);
      }
      emitReplayStatus(false, false);
      return;
    }

    if (!engine || source.length === 0) {
      setDataStatus("REPLAY WAITING FOR HISTORY");
      emitReplayStatus(true, false);
      return;
    }

    if (replayControls.selecting) {
      replayAppliedRef.current = false;
      replayCommandIdRef.current = replayControls.commandId;
      engine.setCandles(source, {
        heatmapSource: source,
        heatmapUntilIndex: source.length - 1
      });
      setDataStatus("REPLAY - CLICK A CANDLE TO START");
      emitReplayStatus(true, false);
      return;
    }

    const commandChanged = replayCommandIdRef.current !== replayControls.commandId;
    if (!replayAppliedRef.current || commandChanged) {
      replayCommandIdRef.current = replayControls.commandId;
      if (replayControls.command === "rewind" || replayControls.command === "start" || !replayAppliedRef.current) {
        replayStartIndexRef.current = computeReplayStartIndex();
        applyReplayCursor(replayStartIndexRef.current, true);
      }
      replayAppliedRef.current = true;
    } else {
      applyReplayCursor(replayCursorRef.current);
    }

    if (replayControls.playing) {
      const intervalMs = Math.max(50, Math.round(1000 / Math.max(0.25, replayControls.speed)));
      replayTimerRef.current = window.setInterval(() => {
        const nextSource = replaySourceRef.current;
        const nextIndex = Math.min(nextSource.length - 1, replayCursorRef.current + 1);
        applyReplayCursor(nextIndex);

        if (nextIndex >= nextSource.length - 1 && replayTimerRef.current) {
          window.clearInterval(replayTimerRef.current);
          replayTimerRef.current = undefined;
          emitReplayStatus(true, false);
        }
      }, intervalMs);
    }

    return () => {
      if (replayTimerRef.current) {
        window.clearInterval(replayTimerRef.current);
        replayTimerRef.current = undefined;
      }
    };
  }, [exchangeLabel, replayControls]);

  useEffect(() => {
    engineRef.current?.setChartType(chartType);
  }, [chartType]);

  useEffect(() => {
    engineRef.current?.setSnapToLatest(snapToLatest);
  }, [snapToLatest]);

  useEffect(() => {
    engineRef.current?.setDrawingTool(activeDrawingTool);
  }, [activeDrawingTool]);

  useEffect(() => {
    engineRef.current?.setDrawingsVisible(drawingsVisible);
  }, [drawingsVisible]);

  useEffect(() => {
    engineRef.current?.setDrawingsLocked(drawingsLocked);
  }, [drawingsLocked]);

  useEffect(() => {
    if (drawingClearSignal > 0) engineRef.current?.clearDrawings();
  }, [drawingClearSignal]);

  useEffect(() => {
    engineRef.current?.setIndicatorState(visibleIndicators, indicatorPeriods, indicatorVisualSettings, indicatorAdvancedSettings);
  }, [visibleIndicators, indicatorPeriods, indicatorVisualSettings, indicatorAdvancedSettings]);

  useEffect(() => {
    liquidationFieldControllerRef.current?.updateSettings(liquidationFieldSettings);
    engineRef.current?.setLiquidationFieldState(
      visibleIndicators.liquidationHeatmap ? liquidationFieldSnapshot : null,
      liquidationFieldSettings
    );
  }, [liquidationFieldSettings, liquidationFieldSnapshot, visibleIndicators.liquidationHeatmap]);

  useEffect(() => {
    liquidationFieldControllerRef.current?.dispose();
    liquidationFieldControllerRef.current = null;
    if (!visibleIndicators.liquidationHeatmap) {
      setLiquidationFieldSnapshot(null);
      setLiquidationFieldStatus({ state: "IDLE", message: "Awaiting activation", source: "NONE", lastInputAt: null });
      engineRef.current?.setLiquidationFieldState(null, liquidationFieldSettings);
      return;
    }
    if (!liquidationFieldSettings.visualFixture && marketSymbol.exchange !== "bybit") {
      const status: LiquidationFieldRuntimeStatus = {
        state: "UNAVAILABLE",
        message: "This build currently has venue-calibrated liquidation intelligence for Bybit linear contracts only.",
        source: "NONE",
        lastInputAt: null
      };
      setLiquidationFieldStatus(status);
      setLiquidationFieldSnapshot(null);
      return;
    }
    if (chartHistoryState !== "ready" || !engineRef.current) {
      setLiquidationFieldStatus({ state: "LOADING", message: "Waiting for canonical chart history…", source: "BYBIT_PUBLIC", lastInputAt: null });
      return;
    }
    const controller = new LiquidationFieldController({
      symbol: marketSymbol.rawSymbol,
      settings: liquidationFieldSettings,
      getCandles: () => engineRef.current?.getSourceCandles() ?? [],
      onSnapshot: (snapshot) => {
        setLiquidationFieldSnapshot(snapshot);
        engineRef.current?.setLiquidationFieldState(snapshot, latestLiquidationFieldSettingsRef.current);
      },
      onStatus: setLiquidationFieldStatus
    });
    liquidationFieldControllerRef.current = controller;
    void controller.start();
    return () => {
      controller.dispose();
      if (liquidationFieldControllerRef.current === controller) liquidationFieldControllerRef.current = null;
    };
  }, [
    visibleIndicators.liquidationHeatmap,
    marketSymbol.exchange,
    marketSymbol.rawSymbol,
    chartHistoryState,
    liquidationFieldCalculationKey
  ]);

  useEffect(() => {
    if (!visibleIndicators.aif) {
      setAifPriceTransform(null);
      return;
    }
    const engine = engineRef.current;
    if (engine) setAifPriceTransform(engine.getPriceTransformSnapshot());
  }, [visibleIndicators.aif]);

  useEffect(() => {
    engineRef.current?.setPriceLineSettings(priceLineColor ?? "", priceLineIntensity ?? 75);
  }, [priceLineColor, priceLineIntensity]);

  useEffect(() => {
    engineRef.current?.setAlertDefinitions(scopedChartAlerts);
  }, [scopedChartAlerts]);

  useEffect(() => {
    setMountedIndicators((current) => {
      let changed = false;
      const next = { ...current };
      (Object.keys(visibleIndicators) as IndicatorKey[]).forEach((key) => {
        if (visibleIndicators[key] && !next[key]) {
          next[key] = true;
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [visibleIndicators]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const updateHeight = () => setOscillatorHostHeight(host.clientHeight || 600);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const previous = previousOscillatorVisibilityRef.current;
    onIndicatorAdvancedSettingsChange((current) => {
      const existing = current.oscillatorPane?.order ?? [];
      const nextOrder: OscillatorIndicatorKey[] = [];
      for (const key of existing) {
        if (visibleIndicators[key] && !nextOrder.includes(key)) nextOrder.push(key);
      }
      for (const key of OSCILLATOR_KEYS) {
        if (previous[key] && visibleIndicators[key] && !nextOrder.includes(key)) nextOrder.push(key);
      }
      for (const key of OSCILLATOR_KEYS) {
        if (!previous[key] && visibleIndicators[key] && !nextOrder.includes(key)) nextOrder.push(key);
      }
      if (nextOrder.length === existing.length && nextOrder.every((key, index) => key === existing[index])) {
        return current;
      }
      return {
        ...current,
        oscillatorPane: {
          ...defaultOscillatorPaneSettings,
          ...current.oscillatorPane,
          paneHeights: {
            ...defaultOscillatorPaneSettings.paneHeights,
            ...(current.oscillatorPane?.paneHeights ?? {})
          },
          order: nextOrder
        }
      };
    });
    previousOscillatorVisibilityRef.current = {
      openInterestOscillator: visibleIndicators.openInterestOscillator,
      zScoreOscillator: visibleIndicators.zScoreOscillator,
      waveTrendOscillator: visibleIndicators.waveTrendOscillator
    };
  }, [
    onIndicatorAdvancedSettingsChange,
    visibleIndicators.openInterestOscillator,
    visibleIndicators.zScoreOscillator,
    visibleIndicators.waveTrendOscillator
  ]);

  useEffect(() => {
    return () => {
      if (alertToastTimerRef.current) window.clearTimeout(alertToastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!chartContextMenu) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setChartContextMenu(null);
    };
    const closeOnResize = () => setChartContextMenu(null);

    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnResize);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [chartContextMenu]);

  useEffect(() => {
    alertSettingsRef.current = alertSettings;
    if (alertSettings.emailTo.trim()) {
      localStorage.setItem("bt_alert_email", alertSettings.emailTo.trim());
    }
  }, [alertSettings]);

  const updateAlertSettings = (patch: Partial<IndicatorAlertSettings>) => {
    setAlertSettings((current) => ({ ...current, ...patch }));
  };

  const updateVolumeProfileAlertSettings = (patch: Partial<IndicatorAlertSettings["volumeProfile"]>) => {
    setAlertSettings((current) => ({
      ...current,
      volumeProfile: {
        ...current.volumeProfile,
        ...patch
      }
    }));
  };

  const updateLineAlertSettings = (
    key: LineAlertIndicatorKey,
    patch: Partial<IndicatorAlertSettings["line"][LineAlertIndicatorKey]>
  ) => {
    setAlertSettings((current) => ({
      ...current,
      line: {
        ...current.line,
        [key]: {
          ...current.line[key],
          ...patch
        }
      }
    }));
  };

  const dispatchAlert = (key: string, payload: Record<string, unknown>) => {
    const settings = alertSettingsRef.current;
    const now = Date.now();
    const cooldownMs = Math.max(10, settings.cooldownSeconds) * 1000;
    const previousSentAt = lastAlertSentAtRef.current.get(key) ?? 0;
    if (now - previousSentAt < cooldownMs) return;

    lastAlertSentAtRef.current.set(key, now);
    void sendIndicatorAlert(
      {
        terminal: "Black-Terminal",
        type: "indicator_alert",
        symbol: displaySymbol,
        exchange: exchangeLabel,
        timeframe,
        timestamp: new Date().toISOString(),
        ...payload
      },
      {
        webhook: settings.webhook,
        email: settings.email,
        emailTo: settings.emailTo
      }
    );
  };

  const showLocalAlertToast = (title: string, message: string) => {
    if (alertToastTimerRef.current) window.clearTimeout(alertToastTimerRef.current);
    setAlertToast({ id: Date.now(), title, message });
    alertToastTimerRef.current = window.setTimeout(() => {
      setAlertToast(null);
      alertToastTimerRef.current = undefined;
    }, 5200);
  };

  const handleChartContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const point = engineRef.current?.getChartPointFromClient(event.clientX, event.clientY);
    if (!point) {
      setChartContextMenu(null);
      return;
    }

    const chartBounds = event.currentTarget.closest(".chart-wrap")?.getBoundingClientRect();
    if (!chartBounds) return;
    setChartContextMenu({
      x: Math.min(Math.max(8, event.clientX - chartBounds.left), Math.max(8, chartBounds.width - 252)),
      y: Math.min(Math.max(52, event.clientY - chartBounds.top), Math.max(52, chartBounds.height - 620)),
      point
    });
  };

  const createPriceAlertAtContext = (condition: AlertCondition) => {
    const point = chartContextMenu?.point;
    if (!point || !onAlertDefinitionsChange) return;

    const price = Number(point.price.toFixed(2));
    const conditionText = configuredAlertConditionLabels[condition];
    const alert: IndicatorAlertDefinition = {
      id: makeAlertId(),
      enabled: true,
      name: `${displaySymbol} price ${conditionText} ${formatAlertPrice(price)}`,
      symbol: displaySymbol,
      exchange: exchangeLabel,
      timeframe,
      indicator: "price",
      targetPrice: price,
      color: "#ffffff",
      condition,
      runMode: "perpetual",
      cooldownSeconds: 60,
      webhookUrl: "",
      emailTo: "",
      message: "{{name}}: {{symbol}} {{condition}} {{level}}. Last price {{price}}",
      script: "",
      createdAt: Date.now(),
      fired: false
    };

    onAlertDefinitionsChange((current) => [alert, ...current]);
    showLocalAlertToast("Price Alert Armed", `${displaySymbol} ${conditionText} ${formatAlertPrice(price)}`);
    setChartContextMenu(null);
    onOpenAlerts?.();
  };

  const updateEditingChartAlert = (patch: Partial<IndicatorAlertDefinition>) => {
    if (!editingChartAlertId || !onAlertDefinitionsChange) return;
    onAlertDefinitionsChange((current) =>
      current.map((alert) => alert.id === editingChartAlertId ? { ...alert, ...patch } : alert)
    );
  };

  const deleteEditingChartAlert = () => {
    if (!editingChartAlertId || !onAlertDefinitionsChange) return;
    onAlertDefinitionsChange((current) => current.filter((alert) => alert.id !== editingChartAlertId));
    setEditingChartAlertId(null);
  };

  const addDrawingFromContext = (tool: Extract<DrawingToolId, "horizontalLine" | "verticalLine" | "text">) => {
    const point = chartContextMenu?.point;
    if (!point) return;
    engineRef.current?.addDrawingAtPoint(tool, point.index, point.price, "Note");
    setChartContextMenu(null);
  };

  const requestDrawingToolFromContext = (tool: DrawingToolId) => {
    onDrawingToolRequest?.(tool);
    setChartContextMenu(null);
  };

  const copyContextPrice = () => {
    const point = chartContextMenu?.point;
    if (!point) return;
    void navigator.clipboard?.writeText(String(Number(point.price.toFixed(2))));
    showLocalAlertToast("Price Copied", formatAlertPrice(point.price));
    setChartContextMenu(null);
  };

  const openExecutionTicketFromContext = (
    side: OrderSide,
    orderType: OrderType,
    source: ExecutionSource = "chart",
    allocationEnabled = false,
    patch: Partial<UnifiedExecutionTicketPreset> = {}
  ) => {
    const point = chartContextMenu?.point;
    setExecutionTicketPreset({
      symbol: displaySymbol,
      price: point?.price,
      side,
      orderType,
      source,
      allocationEnabled,
      marketKind: marketSymbol.marketKind,
      ...patch
    });
    setChartContextMenu(null);
  };

  const openPositionProtectionTicket = (type: "take-profit" | "stop-loss" | "trailing-stop") => {
    const position = activeChartPosition;
    const point = chartContextMenu?.point;
    if (!position || !point) return;
    const price = Number(point.price.toFixed(2));
    const exitSide: OrderSide = position.direction === "long" ? "sell" : "buy";

    if (type === "take-profit") {
      blackCorePositionManager.setProtection(position.id, "take-profit", { price, metadata: { source: "chart-context" } });
      openExecutionTicketFromContext(exitSide, "limit", "positions", false, {
        quantity: String(position.quantity),
        reduceOnly: true,
        takeProfit: String(price),
        positionId: position.id,
        protectionIntent: "take-profit"
      });
      return;
    }

    if (type === "stop-loss") {
      blackCorePositionManager.setProtection(position.id, "stop-loss", { price, metadata: { source: "chart-context" } });
      openExecutionTicketFromContext(exitSide, "stop-market", "positions", false, {
        quantity: String(position.quantity),
        reduceOnly: true,
        stopLoss: String(price),
        stopPrice: String(price),
        positionId: position.id,
        protectionIntent: "stop-loss"
      });
      return;
    }

    blackCorePositionManager.enableTrailingStop(position.id, {
      price,
      trailBy: Math.max(1, Math.abs(price - position.currentPrice)),
      trailMode: "usd",
      activation: "immediate",
      metadata: { source: "chart-context" }
    });
    openExecutionTicketFromContext(exitSide, "trailing-stop", "positions", false, {
      quantity: String(position.quantity),
      reduceOnly: true,
      trailingStopEnabled: true,
      trailingTrailBy: String(Math.max(1, Math.abs(price - position.currentPrice)).toFixed(2)),
      trailingMode: "usd",
      trailingActivation: "immediate",
      positionId: position.id,
      protectionIntent: "trailing-stop"
    });
  };

  const recordPositionContextAction = (action: "add" | "scaleIn" | "scaleOut" | "partialClose" | "close" | "reverse" | "moveProtection" | "cancelTp" | "cancelSl" | "cancelTrailing" | "stats" | "notes" | "timeline") => {
    const position = activeChartPosition;
    if (!position) return;
    setChartContextMenu(null);

    if (action === "add" || action === "scaleIn") {
      blackCorePositionManager.scaleIn(position.id, Math.max(1, position.quantity * 0.25), position.currentPrice);
      showLocalAlertToast("Position Scaled", `${position.symbol} scale-in recorded.`);
      return;
    }
    if (action === "scaleOut" || action === "partialClose") {
      blackCorePositionManager.scaleOut(position.id, Math.max(1, position.quantity * 0.25));
      showLocalAlertToast("Position Reduced", `${position.symbol} scale-out recorded.`);
      return;
    }
    if (action === "close") {
      openExecutionTicketFromContext(position.direction === "long" ? "sell" : "buy", "market", "positions", false, {
        quantity: String(position.quantity),
        reduceOnly: true,
        positionId: position.id
      });
      return;
    }
    if (action === "reverse") {
      openExecutionTicketFromContext(position.direction === "long" ? "sell" : "buy", "market", "positions", false, {
        quantity: String(position.quantity * 2),
        positionId: position.id
      });
      return;
    }
    if (action === "moveProtection") {
      showLocalAlertToast("Move Protection", "Drag a TP, SL, or trailing line to move protection.");
      return;
    }
    if (action === "cancelTp") {
      blackCorePositionManager.cancelProtection(position.id, "take-profit");
      showLocalAlertToast("TP Cancelled", position.symbol);
      return;
    }
    if (action === "cancelSl") {
      blackCorePositionManager.cancelProtection(position.id, "stop-loss");
      showLocalAlertToast("SL Cancelled", position.symbol);
      return;
    }
    if (action === "cancelTrailing") {
      blackCorePositionManager.cancelProtection(position.id, "trailing-stop");
      showLocalAlertToast("Trailing Cancelled", position.symbol);
      return;
    }
    if (action === "notes") {
      const note = window.prompt(`Trade note for ${position.symbol}`, "");
      if (note) blackCorePositionManager.addNote(position.id, note);
      return;
    }
    if (action === "timeline") {
      showLocalAlertToast("Trade Timeline", position.timeline.slice(0, 3).map((item) => item.message).join(" | ") || "No timeline events.");
      return;
    }
    showLocalAlertToast("Position Statistics", `PnL ${formatAlertPrice(position.health.currentPnl)} | RR ${position.health.riskReward?.toFixed(2) ?? "-"}`);
  };

  const dragProtectionLine = (protection: PositionProtectionOrder | undefined) => (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!activeChartPosition || !protection) return;
    event.preventDefault();
    event.stopPropagation();
    const move = (moveEvent: MouseEvent) => {
      const price = engineRef.current?.getPriceFromClientY(moveEvent.clientY);
      if (price && Number.isFinite(price)) {
        blackCorePositionManager.moveProtection(activeChartPosition.id, protection.id, Number(price.toFixed(2)));
      }
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const priceTouchesLevel = (candle: Candle | undefined, price: number | undefined) => {
    if (!candle || !Number.isFinite(price)) return false;
    return candle.low <= price! && candle.high >= price!;
  };

  const priceTouchesBand = (
    candle: Candle | undefined,
    priceLow: number | undefined,
    priceHigh: number | undefined
  ) => {
    if (!candle || !Number.isFinite(priceLow) || !Number.isFinite(priceHigh)) return false;
    return candle.low <= priceHigh! && candle.high >= priceLow!;
  };

  const evaluateLineAlerts = (
    key: LineAlertIndicatorKey,
    line: IndicatorAlertLine | undefined,
    current: Candle,
    previous: Candle
  ) => {
    if (!visibleIndicators[key]) return;
    const settings = alertSettingsRef.current.line[key];
    if (!line || !Number.isFinite(line.current) || !Number.isFinite(line.previous)) return;

    const label = lineAlertIndicatorLabels[key];
    const currentValue = line.current!;
    const previousValue = line.previous!;
    const touched = priceTouchesLevel(current, currentValue) && !priceTouchesLevel(previous, previousValue);
    const crossedAbove = previous.close <= previousValue && current.close > currentValue;
    const crossedBelow = previous.close >= previousValue && current.close < currentValue;

    if (settings.touch && touched) {
      dispatchAlert(`${key}:touch`, {
        indicator: label,
        event: "touch",
        price: current.close,
        level: currentValue
      });
    }
    if (settings.crossAbove && crossedAbove) {
      dispatchAlert(`${key}:cross-above`, {
        indicator: label,
        event: "cross_above",
        price: current.close,
        level: currentValue
      });
    }
    if (settings.crossBelow && crossedBelow) {
      dispatchAlert(`${key}:cross-below`, {
        indicator: label,
        event: "cross_below",
        price: current.close,
        level: currentValue
      });
    }
  };

  const conditionMatches = (
    condition: AlertCondition,
    current: Candle,
    previous: Candle,
    currentLevel: number,
    previousLevel: number,
    currentTouched: boolean,
    previousTouched: boolean
  ) => {
    if (condition === "testing") return currentTouched && !previousTouched;
    if (condition === "crossingAbove") return previous.close <= previousLevel && current.close > currentLevel;
    return previous.close >= previousLevel && current.close < currentLevel;
  };

  const lineForConfiguredAlert = (
    indicator: AlertIndicatorTarget,
    snapshot: NonNullable<ReturnType<BlackChartEngine["getIndicatorAlertSnapshot"]>>
  ) => {
    if (indicator === "vwap") return snapshot.vwap;
    if (indicator === "ema20") return snapshot.ema20;
    if (indicator === "ema50") return snapshot.ema50;
    if (indicator === "ema200") return snapshot.ema200;
    return undefined;
  };

  const formatConfiguredAlertMessage = (
    definition: IndicatorAlertDefinition,
    context: Record<string, string | number | undefined>
  ) => {
    const template = definition.message.trim() || "{{name}}: {{indicator}} {{condition}} on {{symbol}} at {{price}}";
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, token: string) => {
      const value = context[token];
      return value === undefined ? "" : String(value);
    });
  };

  const resolveProfileAlertTrigger = (
    definition: IndicatorAlertDefinition,
    levels: IndicatorAlertLevel[],
    current: Candle,
    previous: Candle
  ) => {
    const target = definition.levelTarget ?? "poc";
    const matchingLevels = target === "any" ? levels : levels.filter((level) => level.kind === target);

    for (const level of matchingLevels) {
      const currentTouched = level.kind === "lvn"
        ? priceTouchesBand(current, level.priceLow, level.priceHigh)
        : priceTouchesLevel(current, level.price);
      const previousTouched = level.kind === "lvn"
        ? priceTouchesBand(previous, level.priceLow, level.priceHigh)
        : priceTouchesLevel(previous, level.price);
      const previousLevel = level.price;

      if (!conditionMatches(definition.condition, current, previous, level.price, previousLevel, currentTouched, previousTouched)) {
        continue;
      }

      return {
        indicator: "HDLX Profile",
        event: definition.condition,
        levelType: level.label,
        level: level.price,
        priceLow: level.priceLow,
        priceHigh: level.priceHigh,
        strength: level.strength
      };
    }

    return null;
  };

  const resolveLineAlertTrigger = (
    definition: IndicatorAlertDefinition,
    line: IndicatorAlertLine | undefined,
    current: Candle,
    previous: Candle
  ) => {
    if (!line || !Number.isFinite(line.current) || !Number.isFinite(line.previous)) return null;
    const currentLevel = line.current!;
    const previousLevel = line.previous!;
    const currentTouched = priceTouchesLevel(current, currentLevel);
    const previousTouched = priceTouchesLevel(previous, previousLevel);

    if (!conditionMatches(definition.condition, current, previous, currentLevel, previousLevel, currentTouched, previousTouched)) {
      return null;
    }

    return {
      indicator: configuredAlertIndicatorLabels[definition.indicator],
      event: definition.condition,
      period: line.period,
      level: currentLevel
    };
  };

  const resolvePriceAlertTrigger = (
    definition: IndicatorAlertDefinition,
    current: Candle,
    previous: Candle
  ) => {
    const targetPrice = definition.targetPrice;
    if (!Number.isFinite(targetPrice)) return null;
    const level = targetPrice!;
    const currentTouched = priceTouchesLevel(current, level);
    const previousTouched = priceTouchesLevel(previous, level);

    if (!conditionMatches(definition.condition, current, previous, level, level, currentTouched, previousTouched)) {
      return null;
    }

    return {
      indicator: "Price",
      event: definition.condition,
      level,
      targetPrice: level
    };
  };

  const dispatchConfiguredAlert = (
    definition: IndicatorAlertDefinition,
    current: Candle,
    trigger: Record<string, unknown>
  ) => {
    const now = Date.now();
    const runtime = configuredAlertRuntimeRef.current.get(definition.id) ?? { lastFiredAt: 0, fired: false };
    if (definition.fired || (definition.runMode === "once" && runtime.fired)) return;

    const cooldownMs = Math.max(5, definition.cooldownSeconds) * 1000;
    if (now - runtime.lastFiredAt < cooldownMs) return;

    runtime.lastFiredAt = now;
    runtime.fired = true;
    configuredAlertRuntimeRef.current.set(definition.id, runtime);

    const indicator = String(trigger.indicator ?? configuredAlertIndicatorLabels[definition.indicator]);
    const level = typeof trigger.level === "number" ? trigger.level : undefined;
    const context = {
      name: definition.name,
      symbol: displaySymbol,
      exchange: exchangeLabel,
      timeframe,
      indicator,
      condition: configuredAlertConditionLabels[definition.condition],
      price: current.close.toFixed(2),
      level: level === undefined ? undefined : level.toFixed(2)
    };

    if (definition.runMode === "once") {
      onAlertDefinitionsChange?.((currentAlerts) =>
        currentAlerts.map((alert) => alert.id === definition.id ? { ...alert, fired: true } : alert)
      );
    }

    showLocalAlertToast(definition.name, formatConfiguredAlertMessage(definition, context));
    onAlertFired?.(displaySymbol, formatConfiguredAlertMessage(definition, context));

    void sendIndicatorAlert(
      {
        terminal: "Black-Terminal",
        type: "indicator_alert",
        alertId: definition.id,
        alertName: definition.name,
        runMode: definition.runMode,
        symbol: displaySymbol,
        exchange: exchangeLabel,
        timeframe,
        timestamp: new Date().toISOString(),
        price: current.close,
        message: formatConfiguredAlertMessage(definition, context),
        script: definition.script,
        ...trigger
      },
      {
        webhook: Boolean(definition.webhookUrl?.trim()),
        webhookUrl: definition.webhookUrl,
        p2pEndpoint: definition.p2pEndpoint,
        sshTarget: definition.sshTarget,
        email: Boolean(definition.emailTo?.trim()),
        emailTo: definition.emailTo
      }
    );
  };

  useEffect(() => {
    if (replayActiveRef.current || alertDefinitions.length === 0) return;

    const scopedAlerts = alertDefinitions.filter((definition) =>
      definition.enabled &&
      definition.symbol === displaySymbol &&
      definition.exchange === exchangeLabel &&
      (definition.indicator === "price" || definition.timeframe === timeframe)
    );
    if (scopedAlerts.length === 0) return;

    const snapshot = engineRef.current?.getIndicatorAlertSnapshot({
      includeVolumeProfile: scopedAlerts.some((definition) => definition.indicator === "hdlxProfile")
    });
    const current = snapshot?.current;
    const previous = snapshot?.previous;
    if (!snapshot || !current || !previous) return;

    for (const definition of scopedAlerts) {
      const trigger = definition.indicator === "price"
        ? resolvePriceAlertTrigger(definition, current, previous)
        : definition.indicator === "hdlxProfile"
          ? resolveProfileAlertTrigger(definition, snapshot.volumeProfileLevels, current, previous)
          : resolveLineAlertTrigger(definition, lineForConfiguredAlert(definition.indicator, snapshot), current, previous);

      if (trigger) {
        dispatchConfiguredAlert(definition, current, trigger);
      }
    }
  }, [alertDefinitions, lastCandle, visibleIndicators, displaySymbol, exchangeLabel, timeframe]);

  // Synchronize compiled indicators scripts overlays
  useEffect(() => {
    if (customPlots && engineRef.current) {
      engineRef.current.setCustomPlots(customPlots);
    }
  }, [customPlots]);

  const displayCandle = lastCandle ?? {
    time: 0,
    open: lastPrice,
    high: lastPrice,
    low: lastPrice,
    close: lastPrice,
    volume: 0
  };
  const change = displayCandle.close - displayCandle.open;
  const changePercent = displayCandle.open ? (change / displayCandle.open) * 100 : 0;
  const indicatorRows: { key: IndicatorKey; label: string; value: string }[] = [
    { key: "aif", label: "A.I.F.", value: "auction intelligence" },
    {
      key: "auctionProfile",
      label: "RADAP",
      value: auctionProfileLoading ? "building…" : auctionProfileError ? "unavailable" : normalizedAuctionProfileSettings.calculationEngine.replaceAll("_", " ")
    },
    {
      key: "liquidationHeatmap",
      label: "Liquidation Intelligence",
      value: `${liquidationFieldSettings.horizon} · ${liquidationFieldStatus.state.toLowerCase()}`
    },
    {
      key: "volatilityHeatmap",
      label: "Market Maker Heatmap",
      value: kioseffSettings.model === "absorbtion-extremes" ? "Absorbtion Extremes" : `VAE ${kioseffSettings.volatilityAtEntry.granularity}`
    },
    { key: "volumeProfile", label: "HDLX Profile", value: indicatorAdvancedSettings.volumeProfile.rangeMode === "visible" ? "visible" : `lock ${indicatorAdvancedSettings.volumeProfile.fixedRangeLength}` },
    {
      key: "adaptiveSwingStrategy",
      label: "Adaptive Swing Reversal",
      value: `L${indicatorAdvancedSettings.adaptiveSwingStrategy?.swingLookback ?? defaultAdaptiveSwingStrategySettings.swingLookback} / ATR ${indicatorAdvancedSettings.adaptiveSwingStrategy?.atrStopMultiplier ?? defaultAdaptiveSwingStrategySettings.atrStopMultiplier}`
    },
    {
      key: "vwap",
      label: "VWAP",
      value: vwapAnchorLabels[indicatorAdvancedSettings.vwap?.anchorMode ?? defaultVwapSettings.anchorMode]
    },
    { key: "ema20", label: "EMA", value: String(indicatorPeriods.ema20) },
    { key: "ema50", label: "EMA", value: String(indicatorPeriods.ema50) },
    { key: "ema200", label: "EMA", value: String(indicatorPeriods.ema200) },
    { key: "sma20", label: "SMA", value: String(indicatorPeriods.sma20) },
    { key: "sma50", label: "SMA", value: String(indicatorPeriods.sma50) },
    { key: "bollinger", label: "Bollinger", value: String(indicatorPeriods.bollinger) },
    { key: "openInterestOscillator", label: "OI Osc", value: String(indicatorPeriods.openInterestOscillator) },
    { key: "zScoreOscillator", label: "Z-Score", value: String(indicatorPeriods.zScoreOscillator) },
    { key: "waveTrendOscillator", label: "WaveTrend", value: String(indicatorPeriods.waveTrendOscillator) },
    {
      key: "volume",
      label: "Volume",
      value: displayCandle.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })
    }
  ];
  const mountedIndicatorRows = indicatorRows.filter((indicator) => mountedIndicators[indicator.key]);

  const toggleIndicator = (key: IndicatorKey) => {
    if (!canUseIndicator(key, { allowedIndicators })) return;
    onVisibleIndicatorsChange((current) => ({ ...current, [key]: !current[key] }));
  };

  const removeIndicator = (key: IndicatorKey) => {
    setMountedIndicators((current) => ({ ...current, [key]: false }));
    onVisibleIndicatorsChange((current) => ({ ...current, [key]: false }));
    if (activeIndicator === key) setActiveIndicator(null);
  };

  const updateIndicatorPeriod = (key: keyof IndicatorPeriods, value: number) => {
    const max = key === "volumeProfile" ? 20000 : 500;
    const nextValue = Math.max(2, Math.min(max, Number.isFinite(value) ? value : indicatorPeriods[key]));
    onIndicatorPeriodsChange((current) => ({
      ...current,
      [key]: nextValue
    }));
    if (key === "volumeProfile") {
      updateVolumeProfileSetting("fixedRangeLength", nextValue);
    }
  };

  const updateIndicatorVisual = (key: IndicatorKey, patch: Partial<IndicatorVisualSettings[IndicatorKey]>) => {
    onIndicatorVisualSettingsChange((current) => ({
      ...current,
      [key]: {
        ...current[key],
        ...patch
      }
    }));
  };

  const volumeProfileSettings = indicatorAdvancedSettings.volumeProfile ?? defaultVolumeProfileSettings;
  const adaptiveSwingSettings = indicatorAdvancedSettings.adaptiveSwingStrategy ?? defaultAdaptiveSwingStrategySettings;
  const oscillatorPaneSettings: OscillatorPaneSettings = {
    ...defaultOscillatorPaneSettings,
    ...indicatorAdvancedSettings.oscillatorPane,
    paneHeights: {
      ...defaultOscillatorPaneSettings.paneHeights,
      ...(indicatorAdvancedSettings.oscillatorPane?.paneHeights ?? {})
    },
    order: indicatorAdvancedSettings.oscillatorPane?.order ?? defaultOscillatorPaneSettings.order
  };
  const zScoreSettings: ZScoreOscillatorSettings = {
    ...defaultZScoreOscillatorSettings,
    ...indicatorAdvancedSettings.zScoreOscillator
  };
  const waveTrendSettings: WaveTrendOscillatorSettings = {
    ...defaultWaveTrendOscillatorSettings,
    ...indicatorAdvancedSettings.waveTrendOscillator
  };
  const vwapSettings: VwapSettings = {
    ...defaultVwapSettings,
    ...indicatorAdvancedSettings.vwap
  };
  const oscillatorStack = resolveOscillatorStack(
    visibleIndicators,
    oscillatorPaneSettings,
    waveTrendSettings,
    oscillatorHostHeight,
    58,
    38
  );
  const oscillatorPaneVisible = oscillatorStack.panes.length > 0;
  const oscillatorSettingsOpen =
    activeIndicator === "openInterestOscillator" ||
    activeIndicator === "zScoreOscillator" ||
    activeIndicator === "waveTrendOscillator";
  const activeOscillatorKey = oscillatorSettingsOpen
    ? activeIndicator as OscillatorIndicatorKey
    : undefined;
  const activeOscillatorPaneHeight = activeOscillatorKey
    ? oscillatorPaneSettings.paneHeights[activeOscillatorKey]
    : oscillatorPaneSettings.height;
  const primaryOscillator = oscillatorPaneSettings.order.find((key) =>
    key !== "waveTrendOscillator" && visibleIndicators[key]
  ) ?? (visibleIndicators.zScoreOscillator
    ? "zScoreOscillator"
    : visibleIndicators.openInterestOscillator
      ? "openInterestOscillator"
      : undefined);

  const updateOscillatorPaneSetting = <Key extends keyof OscillatorPaneSettings>(
    key: Key,
    value: OscillatorPaneSettings[Key]
  ) => {
    onIndicatorAdvancedSettingsChange((current) => ({
      ...current,
      oscillatorPane: {
        ...defaultOscillatorPaneSettings,
        ...current.oscillatorPane,
        paneHeights: {
          ...defaultOscillatorPaneSettings.paneHeights,
          ...(current.oscillatorPane?.paneHeights ?? {})
        },
        [key]: value
      }
    }));
  };

  const updateOscillatorPaneHeight = (key: OscillatorIndicatorKey, value: number) => {
    const height = clampNumber(Math.round(value), 82, 420);
    onIndicatorAdvancedSettingsChange((current) => ({
      ...current,
      oscillatorPane: {
        ...defaultOscillatorPaneSettings,
        ...current.oscillatorPane,
        paneHeights: {
          ...defaultOscillatorPaneSettings.paneHeights,
          ...(current.oscillatorPane?.paneHeights ?? {}),
          [key]: height
        },
        order: current.oscillatorPane?.order ?? defaultOscillatorPaneSettings.order,
        height
      }
    }));
  };

  const updateZScoreSetting = <Key extends keyof ZScoreOscillatorSettings>(
    key: Key,
    value: ZScoreOscillatorSettings[Key]
  ) => {
    onIndicatorAdvancedSettingsChange((current) => ({
      ...current,
      zScoreOscillator: {
        ...defaultZScoreOscillatorSettings,
        ...current.zScoreOscillator,
        [key]: value
      }
    }));
  };

  const updateWaveTrendSetting = <Key extends keyof WaveTrendOscillatorSettings>(
    key: Key,
    value: WaveTrendOscillatorSettings[Key]
  ) => {
    onIndicatorAdvancedSettingsChange((current) => ({
      ...current,
      waveTrendOscillator: {
        ...defaultWaveTrendOscillatorSettings,
        ...current.waveTrendOscillator,
        [key]: value
      }
    }));
  };

  const updateVwapSetting = <Key extends keyof VwapSettings>(
    key: Key,
    value: VwapSettings[Key]
  ) => {
    onIndicatorAdvancedSettingsChange((current) => ({
      ...current,
      vwap: {
        ...defaultVwapSettings,
        ...current.vwap,
        preset: key === "preset" ? value as VwapSettings["preset"] : "Custom",
        [key]: value
      }
    }));
  };

  const applyVwapPreset = (preset: VwapSettings["preset"]) => {
    const presetValues = {
      Custom: {},
      "Institutional Session": {
        anchorMode: "session",
        source: "hlc3",
        weightingModel: "volume",
        smoothingMethod: "none",
        bandMode: "weightedStd",
        showBand1: true,
        showBand2: true,
        showBand3: false,
        dynamicSlopeColor: false,
        showPreviousVwap: true
      },
      "Rolling Execution": {
        anchorMode: "rolling",
        source: "ohlc4",
        weightingModel: "volume",
        lookbackBars: 250,
        smoothingMethod: "ema",
        smoothingLength: 3,
        bandMode: "weightedStd",
        showBand1: true,
        showBand2: true,
        showPreviousVwap: false
      },
      "Liquidity Discovery": {
        anchorMode: "session",
        source: "weightedClose",
        weightingModel: "liquidityAdjusted",
        smoothingMethod: "rma",
        smoothingLength: 2,
        bandMode: "microstructure",
        dynamicSlopeColor: true,
        showBand1: true,
        showBand2: true
      },
      "Event Shock": {
        anchorMode: "volatilityBreak",
        source: "hlc3",
        weightingModel: "volatilityParticipation",
        anchorLookbackBars: 1_000,
        bandMode: "atr",
        dynamicSlopeColor: true,
        showAnchorMarkers: true,
        showPreviousVwap: false
      },
      "Black Core Adaptive": {
        anchorMode: "autoRegime",
        source: "weightedClose",
        weightingModel: "blackCoreHybrid",
        smoothingMethod: "ema",
        smoothingLength: 3,
        bandMode: "microstructure",
        regimeSensitivity: 2.2,
        volumeThreshold: 1.8,
        minimumBarsBetweenAnchors: 24,
        dynamicSlopeColor: true,
        showBand1: true,
        showBand2: true,
        showBand3: true,
        showAnchorMarkers: true,
        showPreviousVwap: true
      }
    } satisfies Record<VwapSettings["preset"], Partial<VwapSettings>>;

    onIndicatorAdvancedSettingsChange((current) => ({
      ...current,
      vwap: {
        ...defaultVwapSettings,
        ...current.vwap,
        preset,
        ...presetValues[preset]
      }
    }));
  };

  const beginOscillatorResize = (
    event: ReactPointerEvent<HTMLDivElement>,
    key: OscillatorIndicatorKey
  ) => {
    if (event.button !== 0) return;
    const hostHeight = hostRef.current?.clientHeight ?? 0;
    oscillatorResizeRef.current = {
      key,
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: oscillatorPaneSettings.paneHeights[key],
      maximumHeight: Math.max(82, Math.min(420, hostHeight - 140))
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const resizeOscillatorPane = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = oscillatorResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const nextHeight = clampNumber(
      Math.round(resize.startHeight + resize.startY - event.clientY),
      82,
      resize.maximumHeight
    );
    updateOscillatorPaneHeight(resize.key, nextHeight);
    event.preventDefault();
    event.stopPropagation();
  };

  const finishOscillatorResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = oscillatorResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    oscillatorResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const updateVolumeProfileSetting = <Key extends keyof VolumeProfileSettings>(
    key: Key,
    value: VolumeProfileSettings[Key]
  ) => {
    onIndicatorAdvancedSettingsChange((current) => ({
      ...current,
      volumeProfile: {
        ...current.volumeProfile,
        [key]: value
      }
    }));
  };

  const updateAdaptiveSwingSetting = <Key extends keyof AdaptiveSwingStrategySettings>(
    key: Key,
    value: AdaptiveSwingStrategySettings[Key]
  ) => {
    onIndicatorAdvancedSettingsChange((current) => ({
      ...current,
      adaptiveSwingStrategy: {
        ...defaultAdaptiveSwingStrategySettings,
        ...current.adaptiveSwingStrategy,
        [key]: value
      }
    }));
  };

  const applyHdlxPreset = (preset: VolumeProfileSettings["hdlxPreset"]) => {
    const presetValues = {
      Custom: {},
      Default: { hdlxLookback: 100, hdlxSmooth: 5 },
      "Fast Response": { hdlxLookback: 50, hdlxSmooth: 3 },
      "Smooth Trend": { hdlxLookback: 200, hdlxSmooth: 8 }
    } satisfies Record<VolumeProfileSettings["hdlxPreset"], Partial<VolumeProfileSettings>>;

    onIndicatorAdvancedSettingsChange((current) => ({
      ...current,
      volumeProfile: {
        ...current.volumeProfile,
        hdlxPreset: preset,
        ...presetValues[preset]
      }
    }));
  };

  const renderProfileColorSetting = (label: string, key: keyof VolumeProfileSettings) => (
    <label className="indicator-color-setting">
      {label}
      <input
        type="color"
        value={String(volumeProfileSettings[key])}
        onChange={(event) => updateVolumeProfileSetting(key, event.target.value as never)}
      />
    </label>
  );

  const renderAlertDeliverySettings = () => (
    <>
      <label>
        Alerts Enabled
        <input
          type="checkbox"
          checked={alertSettings.enabled}
          onChange={(event) => updateAlertSettings({ enabled: event.target.checked })}
        />
      </label>
      <label>
        Webhook
        <input
          type="checkbox"
          checked={alertSettings.webhook}
          onChange={(event) => updateAlertSettings({ webhook: event.target.checked })}
        />
      </label>
      <label>
        Email Relay
        <input
          type="checkbox"
          checked={alertSettings.email}
          onChange={(event) => updateAlertSettings({ email: event.target.checked })}
        />
      </label>
      <label>
        Email
        <input
          type="email"
          value={alertSettings.emailTo}
          onChange={(event) => updateAlertSettings({ emailTo: event.target.value })}
        />
      </label>
      <label>
        Cooldown Seconds
        <input
          type="number"
          min={10}
          max={3600}
          value={alertSettings.cooldownSeconds}
          onChange={(event) => updateAlertSettings({ cooldownSeconds: clampNumber(Number(event.target.value), 10, 3600) })}
        />
      </label>
    </>
  );

  const renderLineAlertControls = (key: LineAlertIndicatorKey) => (
    <>
      <div className="indicator-settings-section">Alerts</div>
      {renderAlertDeliverySettings()}
      <label>
        Touch
        <input
          type="checkbox"
          checked={alertSettings.line[key].touch}
          onChange={(event) => updateLineAlertSettings(key, { touch: event.target.checked })}
        />
      </label>
      <label>
        Cross Above
        <input
          type="checkbox"
          checked={alertSettings.line[key].crossAbove}
          onChange={(event) => updateLineAlertSettings(key, { crossAbove: event.target.checked })}
        />
      </label>
      <label>
        Cross Below
        <input
          type="checkbox"
          checked={alertSettings.line[key].crossBelow}
          onChange={(event) => updateLineAlertSettings(key, { crossBelow: event.target.checked })}
        />
      </label>
    </>
  );

  const renderStrategyColorSetting = (label: string, key: keyof AdaptiveSwingStrategySettings) => (
    <label className="indicator-color-setting">
      {label}
      <input
        type="color"
        value={String(adaptiveSwingSettings[key])}
        onChange={(event) => updateAdaptiveSwingSetting(key, event.target.value as never)}
      />
    </label>
  );

  const renderAdaptiveSwingSettings = () => (
    <div className="indicator-settings tv-profile-settings strategy-overlay-settings">
      <div className="tv-settings-head">
        <strong>Adaptive Swing Reversal</strong>
        <button type="button" aria-label="Close settings" onClick={() => setActiveIndicator(null)}>
          <X size={22} />
        </button>
      </div>
      <div className="tv-settings-tabs">
        {(["signals", "engine", "optimization", "alerts"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            className={adaptiveSwingSettingsTab === tab ? "active" : ""}
            onClick={() => setAdaptiveSwingSettingsTab(tab)}
          >
            {tab === "signals" ? "Signals" : tab === "engine" ? "Engine" : tab === "optimization" ? "Optimization" : "Alerts"}
          </button>
        ))}
      </div>
      <div className="tv-settings-body">
        {adaptiveSwingSettingsTab === "signals" && (
          <div className="strategy-overlay-settings-body">
            <div className="indicator-settings-section">Chart Display</div>
            <label>
              Visible
              <input
                type="checkbox"
                checked={visibleIndicators.adaptiveSwingStrategy}
                onChange={() => toggleIndicator("adaptiveSwingStrategy")}
              />
            </label>
            <label>
              Entry Signals
              <input
                type="checkbox"
                checked={adaptiveSwingSettings.showSignals}
                onChange={(event) => updateAdaptiveSwingSetting("showSignals", event.target.checked)}
              />
            </label>
            <label>
              Signal Labels
              <input
                type="checkbox"
                checked={adaptiveSwingSettings.showSignalLabels}
                onChange={(event) => updateAdaptiveSwingSetting("showSignalLabels", event.target.checked)}
              />
            </label>
            <label>
              TP Markers
              <input
                type="checkbox"
                checked={adaptiveSwingSettings.showTakeProfits}
                onChange={(event) => updateAdaptiveSwingSetting("showTakeProfits", event.target.checked)}
              />
            </label>
            <label>
              Stop Markers
              <input
                type="checkbox"
                checked={adaptiveSwingSettings.showStopLosses}
                onChange={(event) => updateAdaptiveSwingSetting("showStopLosses", event.target.checked)}
              />
            </label>
            <label>
              Regime EMA
              <input
                type="checkbox"
                checked={adaptiveSwingSettings.showRegimeEma}
                onChange={(event) => updateAdaptiveSwingSetting("showRegimeEma", event.target.checked)}
              />
            </label>
            <label>
              Swing Levels
              <input
                type="checkbox"
                checked={adaptiveSwingSettings.showSwingLevels}
                onChange={(event) => updateAdaptiveSwingSetting("showSwingLevels", event.target.checked)}
              />
            </label>
            <label>
              Marker Size
              <input
                type="number"
                min={5}
                max={18}
                value={adaptiveSwingSettings.markerSize}
                onChange={(event) => updateAdaptiveSwingSetting("markerSize", clampNumber(Number(event.target.value), 5, 18))}
              />
            </label>
            <label>
              Label Size
              <select
                value={adaptiveSwingSettings.labelSize}
                onChange={(event) => updateAdaptiveSwingSetting("labelSize", event.target.value as AdaptiveSwingStrategySettings["labelSize"])}
              >
                <option value="Tiny">Tiny</option>
                <option value="Small">Small</option>
                <option value="Normal">Normal</option>
              </select>
            </label>
            {renderStrategyColorSetting("Long Color", "longColor")}
            {renderStrategyColorSetting("Short Color", "shortColor")}
            {renderStrategyColorSetting("TP Color", "takeProfitColor")}
            {renderStrategyColorSetting("Stop Color", "stopLossColor")}
            {renderStrategyColorSetting("Regime EMA", "regimeEmaColor")}
            {renderStrategyColorSetting("Swing Level", "swingLevelColor")}
          </div>
        )}
        {adaptiveSwingSettingsTab === "engine" && (
          <div className="strategy-overlay-settings-body">
            <div className="indicator-settings-section">Adaptive Engine</div>
            <label>
              Swing Lookback
              <input type="number" min={8} max={300} value={adaptiveSwingSettings.swingLookback} onChange={(event) => updateAdaptiveSwingSetting("swingLookback", clampNumber(Number(event.target.value), 8, 300))} />
            </label>
            <label>
              ATR Length
              <input type="number" min={5} max={200} value={adaptiveSwingSettings.atrLength} onChange={(event) => updateAdaptiveSwingSetting("atrLength", clampNumber(Number(event.target.value), 5, 200))} />
            </label>
            <label>
              Regime EMA
              <input type="number" min={34} max={500} value={adaptiveSwingSettings.regimeEmaLength} onChange={(event) => updateAdaptiveSwingSetting("regimeEmaLength", clampNumber(Number(event.target.value), 34, 500))} />
            </label>
            <label>
              RSI Length
              <input type="number" min={5} max={100} value={adaptiveSwingSettings.rsiLength} onChange={(event) => updateAdaptiveSwingSetting("rsiLength", clampNumber(Number(event.target.value), 5, 100))} />
            </label>
            <label>
              RSI Oversold
              <input type="number" min={5} max={50} value={adaptiveSwingSettings.rsiOversold} onChange={(event) => updateAdaptiveSwingSetting("rsiOversold", clampNumber(Number(event.target.value), 5, 50))} />
            </label>
            <label>
              RSI Overbought
              <input type="number" min={50} max={95} value={adaptiveSwingSettings.rsiOverbought} onChange={(event) => updateAdaptiveSwingSetting("rsiOverbought", clampNumber(Number(event.target.value), 50, 95))} />
            </label>
            <label>
              ATR Stop
              <input type="number" min={0.5} max={8} step={0.05} value={adaptiveSwingSettings.atrStopMultiplier} onChange={(event) => updateAdaptiveSwingSetting("atrStopMultiplier", clampNumber(Number(event.target.value), 0.5, 8))} />
            </label>
            <label>
              Retest ATR
              <input type="number" min={0.05} max={3} step={0.05} value={adaptiveSwingSettings.swingRetestAtr} onChange={(event) => updateAdaptiveSwingSetting("swingRetestAtr", clampNumber(Number(event.target.value), 0.05, 3))} />
            </label>
            <label>
              Stop %
              <input type="number" min={0.05} max={10} step={0.05} value={adaptiveSwingSettings.stopLossPercent} onChange={(event) => updateAdaptiveSwingSetting("stopLossPercent", clampNumber(Number(event.target.value), 0.05, 10))} />
            </label>
            <label>
              TP Ratio
              <input type="number" min={0.5} max={12} step={0.1} value={adaptiveSwingSettings.takeProfitRatio} onChange={(event) => updateAdaptiveSwingSetting("takeProfitRatio", clampNumber(Number(event.target.value), 0.5, 12))} />
            </label>
            <label>
              Trend Quality
              <input type="number" min={0} max={1} step={0.02} value={adaptiveSwingSettings.minTrendQuality} onChange={(event) => updateAdaptiveSwingSetting("minTrendQuality", clampNumber(Number(event.target.value), 0, 1))} />
            </label>
            <label>
              Max Chop Ratio
              <input type="number" min={0.05} max={1} step={0.02} value={adaptiveSwingSettings.maxChopRatio} onChange={(event) => updateAdaptiveSwingSetting("maxChopRatio", clampNumber(Number(event.target.value), 0.05, 1))} />
            </label>
            <label>
              Volume Lookback
              <input type="number" min={5} max={500} value={adaptiveSwingSettings.volumeLookback} onChange={(event) => updateAdaptiveSwingSetting("volumeLookback", clampNumber(Number(event.target.value), 5, 500))} />
            </label>
            <label>
              Min Volume X
              <input type="number" min={0} max={5} step={0.05} value={adaptiveSwingSettings.minVolumeMultiplier} onChange={(event) => updateAdaptiveSwingSetting("minVolumeMultiplier", clampNumber(Number(event.target.value), 0, 5))} />
            </label>
            <label>
              Session Start UTC
              <input
                type="number"
                min={0}
                max={23}
                value={adaptiveSwingSettings.sessionStartHour ?? ""}
                onChange={(event) => updateAdaptiveSwingSetting("sessionStartHour", event.target.value === "" ? undefined : clampNumber(Number(event.target.value), 0, 23))}
              />
            </label>
            <label>
              Session End UTC
              <input
                type="number"
                min={0}
                max={23}
                value={adaptiveSwingSettings.sessionEndHour ?? ""}
                onChange={(event) => updateAdaptiveSwingSetting("sessionEndHour", event.target.value === "" ? undefined : clampNumber(Number(event.target.value), 0, 23))}
              />
            </label>
          </div>
        )}
        {adaptiveSwingSettingsTab === "optimization" && (
          <div className="strategy-overlay-settings-body">
            <div className="indicator-settings-section">Parameter Optimization</div>
            <label>
              Optimizer Ranges
              <input
                type="checkbox"
                checked={adaptiveSwingSettings.optimizationEnabled}
                onChange={(event) => updateAdaptiveSwingSetting("optimizationEnabled", event.target.checked)}
              />
            </label>
            <label>
              Robustness Mode
              <select
                value={adaptiveSwingSettings.robustnessMode}
                onChange={(event) => updateAdaptiveSwingSetting("robustnessMode", event.target.value as AdaptiveSwingStrategySettings["robustnessMode"])}
              >
                <option value="Balanced">Balanced</option>
                <option value="Profit First">Profit First</option>
                <option value="Drawdown First">Drawdown First</option>
              </select>
            </label>
            <div className="strategy-optimizer-ranges">
              <span>Swing Lookback</span>
              <input type="number" value={adaptiveSwingSettings.optimizeSwingLookbackMin} onChange={(event) => updateAdaptiveSwingSetting("optimizeSwingLookbackMin", Number(event.target.value))} />
              <input type="number" value={adaptiveSwingSettings.optimizeSwingLookbackMax} onChange={(event) => updateAdaptiveSwingSetting("optimizeSwingLookbackMax", Number(event.target.value))} />
              <input type="number" value={adaptiveSwingSettings.optimizeSwingLookbackStep} onChange={(event) => updateAdaptiveSwingSetting("optimizeSwingLookbackStep", Number(event.target.value))} />
            </div>
            <div className="strategy-optimizer-ranges">
              <span>ATR Stop</span>
              <input type="number" step={0.1} value={adaptiveSwingSettings.optimizeAtrStopMin} onChange={(event) => updateAdaptiveSwingSetting("optimizeAtrStopMin", Number(event.target.value))} />
              <input type="number" step={0.1} value={adaptiveSwingSettings.optimizeAtrStopMax} onChange={(event) => updateAdaptiveSwingSetting("optimizeAtrStopMax", Number(event.target.value))} />
              <input type="number" step={0.1} value={adaptiveSwingSettings.optimizeAtrStopStep} onChange={(event) => updateAdaptiveSwingSetting("optimizeAtrStopStep", Number(event.target.value))} />
            </div>
            <div className="strategy-optimizer-ranges">
              <span>TP Ratio</span>
              <input type="number" step={0.1} value={adaptiveSwingSettings.optimizeTakeProfitMin} onChange={(event) => updateAdaptiveSwingSetting("optimizeTakeProfitMin", Number(event.target.value))} />
              <input type="number" step={0.1} value={adaptiveSwingSettings.optimizeTakeProfitMax} onChange={(event) => updateAdaptiveSwingSetting("optimizeTakeProfitMax", Number(event.target.value))} />
              <input type="number" step={0.1} value={adaptiveSwingSettings.optimizeTakeProfitStep} onChange={(event) => updateAdaptiveSwingSetting("optimizeTakeProfitStep", Number(event.target.value))} />
            </div>
            <div className="strategy-optimizer-ranges">
              <span>Trend Quality</span>
              <input type="number" step={0.01} value={adaptiveSwingSettings.optimizeTrendQualityMin} onChange={(event) => updateAdaptiveSwingSetting("optimizeTrendQualityMin", Number(event.target.value))} />
              <input type="number" step={0.01} value={adaptiveSwingSettings.optimizeTrendQualityMax} onChange={(event) => updateAdaptiveSwingSetting("optimizeTrendQualityMax", Number(event.target.value))} />
              <input type="number" step={0.01} value={adaptiveSwingSettings.optimizeTrendQualityStep} onChange={(event) => updateAdaptiveSwingSetting("optimizeTrendQualityStep", Number(event.target.value))} />
            </div>
            <button type="button" className="profile-inline-button strategy-lab-jump" onClick={onOpenStrategyLab}>
              Open Lab
            </button>
          </div>
        )}
        {adaptiveSwingSettingsTab === "alerts" && (
          <div className="strategy-overlay-settings-body">
            <div className="indicator-settings-section">Signal Alerts</div>
            {renderAlertDeliverySettings()}
            <label>
              Long Entry
              <input type="checkbox" checked readOnly />
            </label>
            <label>
              Short Entry
              <input type="checkbox" checked readOnly />
            </label>
            <label>
              TP Long
              <input type="checkbox" checked readOnly />
            </label>
            <label>
              TP Short
              <input type="checkbox" checked readOnly />
            </label>
          </div>
        )}
      </div>
      <div className="tv-settings-footer">
        <button
          type="button"
          className="tv-defaults"
          onClick={() => {
            onIndicatorAdvancedSettingsChange((current) => ({
              ...current,
              adaptiveSwingStrategy: defaultAdaptiveSwingStrategySettings
            }));
          }}
        >
          Defaults
        </button>
        <span />
        <button type="button" className="tv-cancel" onClick={() => setActiveIndicator(null)}>Cancel</button>
        <button type="button" className="tv-ok" onClick={() => setActiveIndicator(null)}>Ok</button>
      </div>
    </div>
  );

  const renderVolumeProfileSettings = () => (
    <div className="indicator-settings tv-profile-settings">
      <div className="tv-settings-head">
        <strong>HDLX Profile</strong>
        <button type="button" aria-label="Close settings" onClick={() => setActiveIndicator(null)}>
          <X size={22} />
        </button>
      </div>
      <div className="tv-settings-tabs">
        {(["inputs", "style", "visibility"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            className={volumeProfileSettingsTab === tab ? "active" : ""}
            onClick={() => setVolumeProfileSettingsTab(tab)}
          >
            {tab === "inputs" ? "Inputs" : tab === "style" ? "Style" : "Visibility"}
          </button>
        ))}
      </div>
      <div className="tv-settings-body">
        {volumeProfileSettingsTab === "inputs" && (
          <div className="volume-profile-settings">
      <div className="indicator-settings-section">Volume & Sentiment Profile</div>
      <label>
        HDLX Profile
        <input
          type="checkbox"
          checked={volumeProfileSettings.showVolumeProfile}
          onChange={(event) => updateVolumeProfileSetting("showVolumeProfile", event.target.checked)}
        />
      </label>
      {renderProfileColorSetting("Up Volume", "upVolumeColor")}
      {renderProfileColorSetting("Down Volume", "downVolumeColor")}
      {renderProfileColorSetting("Value Area Up", "valueAreaUpColor")}
      {renderProfileColorSetting("Value Area Down", "valueAreaDownColor")}
      <label>
        Sentiment Profile
        <input
          type="checkbox"
          checked={volumeProfileSettings.showSentimentProfile}
          onChange={(event) => updateVolumeProfileSetting("showSentimentProfile", event.target.checked)}
        />
      </label>
      {renderProfileColorSetting("Bullish Sentiment", "sentimentBullishColor")}
      {renderProfileColorSetting("Bearish Sentiment", "sentimentBearishColor")}
      <label>
        Supply & Demand Zones
        <input
          type="checkbox"
          checked={volumeProfileSettings.showSupplyDemandZones}
          onChange={(event) => updateVolumeProfileSetting("showSupplyDemandZones", event.target.checked)}
        />
      </label>
      {renderProfileColorSetting("Supply Zones", "supplyZoneColor")}
      {renderProfileColorSetting("Demand Zones", "demandZoneColor")}
      <label className="indicator-range-row">
        S/R Zone Intensity
        <span>
          <input
            type="range"
            min={0}
            max={100}
            value={volumeProfileSettings.supplyDemandIntensity ?? 60}
            onChange={(event) => updateVolumeProfileSetting("supplyDemandIntensity", Number(event.target.value))}
          />
          <b>{volumeProfileSettings.supplyDemandIntensity ?? 60}%</b>
        </span>
      </label>
      <label>
        Supply & Demand Threshold %
        <input
          type="number"
          min={0}
          max={41}
          value={volumeProfileSettings.supplyDemandThreshold}
          onChange={(event) => updateVolumeProfileSetting("supplyDemandThreshold", clampNumber(Number(event.target.value), 0, 41))}
        />
      </label>
      <label>
        HDLX Gaps / LVN
        <input
          type="checkbox"
          checked={volumeProfileSettings.showProfileGaps}
          onChange={(event) => updateVolumeProfileSetting("showProfileGaps", event.target.checked)}
        />
      </label>
      {renderProfileColorSetting("Profile Gap Color", "profileGapColor")}
      <label>
        Node Detection %
        <input
          type="number"
          min={0}
          max={100}
          value={volumeProfileSettings.nodeDetectionPercent}
          onChange={(event) => updateVolumeProfileSetting("nodeDetectionPercent", clampNumber(Number(event.target.value), 0, 100))}
        />
      </label>
      <label className="indicator-range-row">
        LVN Intensity
        <span>
          <input
            type="range"
            min={15}
            max={100}
            value={volumeProfileSettings.profileGapIntensity}
            onChange={(event) => updateVolumeProfileSetting("profileGapIntensity", Number(event.target.value))}
          />
          <b>{volumeProfileSettings.profileGapIntensity}</b>
        </span>
      </label>
      <label>
        Point of Control
        <select
          value={volumeProfileSettings.pocMode}
          onChange={(event) => updateVolumeProfileSetting("pocMode", event.target.value as VolumeProfileSettings["pocMode"])}
        >
          <option value="none">None</option>
          <option value="developing">Developing POC</option>
          <option value="lastLine">Static POC</option>
        </select>
      </label>
      {renderProfileColorSetting("POC Color", "pocColor")}
      <label>
        POC Width
        <input
          type="number"
          min={1}
          max={5}
          value={volumeProfileSettings.pocWidth}
          onChange={(event) => updateVolumeProfileSetting("pocWidth", clampNumber(Number(event.target.value), 1, 5))}
        />
      </label>
      <label>
        Value Area %
        <input
          type="number"
          min={0}
          max={100}
          value={volumeProfileSettings.valueAreaPercent}
          onChange={(event) => updateVolumeProfileSetting("valueAreaPercent", clampNumber(Number(event.target.value), 0, 100))}
        />
      </label>
      <label>
        Value Area High
        <input
          type="checkbox"
          checked={volumeProfileSettings.showVAH}
          onChange={(event) => updateVolumeProfileSetting("showVAH", event.target.checked)}
        />
      </label>
      {renderProfileColorSetting("VAH Color", "vahColor")}
      <label>
        VAH Width
        <input
          type="number"
          min={1}
          max={5}
          value={volumeProfileSettings.vahWidth}
          onChange={(event) => updateVolumeProfileSetting("vahWidth", clampNumber(Number(event.target.value), 1, 5))}
        />
      </label>
      <label>
        Value Area Low
        <input
          type="checkbox"
          checked={volumeProfileSettings.showVAL}
          onChange={(event) => updateVolumeProfileSetting("showVAL", event.target.checked)}
        />
      </label>
      {renderProfileColorSetting("VAL Color", "valColor")}
      <label>
        VAL Width
        <input
          type="number"
          min={1}
          max={5}
          value={volumeProfileSettings.valWidth}
          onChange={(event) => updateVolumeProfileSetting("valWidth", clampNumber(Number(event.target.value), 1, 5))}
        />
      </label>
      <label>
        Profile Polarity Method
        <select
          value={volumeProfileSettings.polarityMethod}
          onChange={(event) => updateVolumeProfileSetting("polarityMethod", event.target.value as VolumeProfileSettings["polarityMethod"])}
        >
          <option value="barPolarity">Bar Polarity</option>
          <option value="pressure">Bar Buying/Selling Pressure</option>
        </select>
      </label>
      <label>
        Profile Range Mode
        <select
          value={volumeProfileSettings.rangeMode}
          onChange={(event) => updateVolumeProfileSetting("rangeMode", event.target.value as VolumeProfileSettings["rangeMode"])}
        >
          <option value="fixed">Fixed Locked</option>
          <option value="visible">Visible Range</option>
        </select>
      </label>
      <label>
        Fixed Range Length
        <select
          value={volumeProfileSettings.fixedRangeLength}
          onChange={(event) => {
            const value = Number(event.target.value) as HistoryDepth;
            updateVolumeProfileSetting("fixedRangeLength", value);
            onIndicatorPeriodsChange((current) => ({ ...current, volumeProfile: value }));
            setHistoryDepth(value);
          }}
        >
          <option value={5000}>5,000 bars</option>
          <option value={10000}>10,000 bars</option>
          <option value={20000}>20,000 bars</option>
        </select>
      </label>
      <label>
        Locked Window
        <button
          type="button"
          className="profile-inline-button"
          onClick={() => updateVolumeProfileSetting("fixedRangeResetToken", volumeProfileSettings.fixedRangeResetToken + 1)}
        >
          Lock Latest
        </button>
      </label>
      <label>
        Profile Stats
        <input
          type="checkbox"
          checked={volumeProfileSettings.showProfileStats}
          onChange={(event) => updateVolumeProfileSetting("showProfileStats", event.target.checked)}
        />
      </label>
      <label>
        Stats Text Size
        <select
          value={volumeProfileSettings.statsSize}
          onChange={(event) => updateVolumeProfileSetting("statsSize", event.target.value as VolumeProfileSettings["statsSize"])}
        >
          <option>Tiny</option>
          <option>Small</option>
          <option>Normal</option>
        </select>
      </label>
      <label>
        Stats Position
        <select
          value={volumeProfileSettings.statsPosition}
          onChange={(event) => updateVolumeProfileSetting("statsPosition", event.target.value as VolumeProfileSettings["statsPosition"])}
        >
          <option>Top Right</option>
          <option>Middle Right</option>
          <option>Bottom Left</option>
        </select>
      </label>
      <label>
        Profile Price Levels
        <input
          type="checkbox"
          checked={volumeProfileSettings.showPriceLevels}
          onChange={(event) => updateVolumeProfileSetting("showPriceLevels", event.target.checked)}
        />
      </label>
      <label>
        Price Label Size
        <select
          value={volumeProfileSettings.priceLabelSize}
          onChange={(event) => updateVolumeProfileSetting("priceLabelSize", event.target.value as VolumeProfileSettings["priceLabelSize"])}
        >
          <option>Tiny</option>
          <option>Small</option>
          <option>Normal</option>
        </select>
      </label>
      <label>
        Profile Placement
        <select
          value={volumeProfileSettings.placement}
          onChange={(event) => updateVolumeProfileSetting("placement", event.target.value as VolumeProfileSettings["placement"])}
        >
          <option value="right">Right</option>
          <option value="left">Left</option>
        </select>
      </label>
      <label>
        Profile Number of Rows
        <input
          type="number"
          min={10}
          max={150}
          step={10}
          value={volumeProfileSettings.rows}
          onChange={(event) => updateVolumeProfileSetting("rows", clampNumber(Number(event.target.value), 10, 150))}
        />
      </label>
      <label>
        Profile Width %
        <input
          type="number"
          min={0}
          max={250}
          value={volumeProfileSettings.widthPercent}
          onChange={(event) => updateVolumeProfileSetting("widthPercent", clampNumber(Number(event.target.value), 0, 250))}
        />
      </label>
      <label>
        Horizontal Offset
        <input
          type="number"
          min={0}
          max={50}
          value={volumeProfileSettings.horizontalOffset}
          onChange={(event) => updateVolumeProfileSetting("horizontalOffset", clampNumber(Number(event.target.value), 0, 50))}
        />
      </label>
      <label>
        Value Area Background
        <input
          type="checkbox"
          checked={volumeProfileSettings.showValueAreaBackground}
          onChange={(event) => updateVolumeProfileSetting("showValueAreaBackground", event.target.checked)}
        />
      </label>
      {renderProfileColorSetting("Value Area BG Color", "valueAreaBackgroundColor")}
      <label>
        Profile Range Background
        <input
          type="checkbox"
          checked={volumeProfileSettings.showProfileBackground}
          onChange={(event) => updateVolumeProfileSetting("showProfileBackground", event.target.checked)}
        />
      </label>
      {renderProfileColorSetting("Profile BG Color", "profileBackgroundColor")}

      <div className="indicator-settings-section">HDLX Oscillator - Volume Weighted Price Z-Score</div>
      <label>
        HDLX Oscillator
        <input
          type="checkbox"
          checked={volumeProfileSettings.hdlxOscillator}
          onChange={(event) => updateVolumeProfileSetting("hdlxOscillator", event.target.checked)}
        />
      </label>
      <label>
        Price Source
        <select
          value={volumeProfileSettings.hdlxPriceSource}
          onChange={(event) => updateVolumeProfileSetting("hdlxPriceSource", event.target.value as VolumeProfileSettings["hdlxPriceSource"])}
        >
          <option value="close">Close</option>
          <option value="hl2">(H + L) / 2</option>
          <option value="hlc3">HLC3</option>
          <option value="ohlc4">OHLC4</option>
        </select>
      </label>
      <label>
        Lookback Period
        <input
          type="number"
          min={20}
          max={5000}
          value={volumeProfileSettings.hdlxLookback}
          onChange={(event) => updateVolumeProfileSetting("hdlxLookback", clampNumber(Number(event.target.value), 20, 5000))}
        />
      </label>
      <label>
        Smoothing Period
        <input
          type="number"
          min={1}
          max={50}
          value={volumeProfileSettings.hdlxSmooth}
          onChange={(event) => updateVolumeProfileSetting("hdlxSmooth", clampNumber(Number(event.target.value), 1, 50))}
        />
      </label>
      <label>
        Preset Configuration
        <select
          value={volumeProfileSettings.hdlxPreset}
          onChange={(event) => applyHdlxPreset(event.target.value as VolumeProfileSettings["hdlxPreset"])}
        >
          <option>Custom</option>
          <option>Default</option>
          <option>Fast Response</option>
          <option>Smooth Trend</option>
        </select>
      </label>
      <label>
        Extreme Threshold
        <input
          type="number"
          min={1}
          max={4}
          step={0.5}
          value={volumeProfileSettings.hdlxExtreme}
          onChange={(event) => updateVolumeProfileSetting("hdlxExtreme", clampNumber(Number(event.target.value), 1, 4))}
        />
      </label>
      <label>
        Visual Clamp
        <input
          type="number"
          min={2}
          max={6}
          step={0.5}
          value={volumeProfileSettings.hdlxClamp}
          onChange={(event) => updateVolumeProfileSetting("hdlxClamp", clampNumber(Number(event.target.value), 2, 6))}
        />
      </label>
      <label>
        Color Preset
        <select
          value={volumeProfileSettings.hdlxColorPreset}
          onChange={(event) => updateVolumeProfileSetting("hdlxColorPreset", event.target.value as VolumeProfileSettings["hdlxColorPreset"])}
        >
          <option>Classic</option>
          <option>Aqua</option>
          <option>Cosmic</option>
          <option>Ember</option>
          <option>Neon</option>
          <option>Custom</option>
        </select>
      </label>
      {renderProfileColorSetting("Positive Deviation", "hdlxPositiveColor")}
      {renderProfileColorSetting("Negative Deviation", "hdlxNegativeColor")}
      <label>
        Custom Wave Line Color
        <input
          type="checkbox"
          checked={volumeProfileSettings.hdlxUseCustomLineColor}
          onChange={(event) => updateVolumeProfileSetting("hdlxUseCustomLineColor", event.target.checked)}
        />
      </label>
      {renderProfileColorSetting("Wave Line Color", "hdlxLineColor")}
      <label>
        Wave Line Thickness
        <input
          type="number"
          min={1}
          max={5}
          value={volumeProfileSettings.hdlxLineWidth}
          onChange={(event) => updateVolumeProfileSetting("hdlxLineWidth", clampNumber(Number(event.target.value), 1, 5))}
        />
      </label>
      <label>
        Fill Transparency
        <input
          type="number"
          min={0}
          max={100}
          value={volumeProfileSettings.hdlxFillTransparency}
          onChange={(event) => updateVolumeProfileSetting("hdlxFillTransparency", clampNumber(Number(event.target.value), 0, 100))}
        />
      </label>
      <label>
        Panel Height
        <input
          type="number"
          min={0.03}
          max={0.4}
          step={0.005}
          value={(volumeProfileSettings.hdlxHeight / 100).toFixed(3)}
          onChange={(event) => updateVolumeProfileSetting("hdlxHeight", clampNumber(Number(event.target.value), 0.03, 0.4) * 100)}
        />
      </label>
      <label>
        Vertical Offset
        <input
          type="number"
          min={0}
          max={0.5}
          step={0.005}
          value={(volumeProfileSettings.hdlxOffset / 100).toFixed(3)}
          onChange={(event) => updateVolumeProfileSetting("hdlxOffset", clampNumber(Number(event.target.value), 0, 0.5) * 100)}
        />
      </label>
      <label>
        Draw Zero / Extreme Levels
        <input
          type="checkbox"
          checked={volumeProfileSettings.hdlxDrawLevels}
          onChange={(event) => updateVolumeProfileSetting("hdlxDrawLevels", event.target.checked)}
        />
      </label>
      <label>
        Panel Background
        <input
          type="checkbox"
          checked={volumeProfileSettings.hdlxShowBackground}
          onChange={(event) => updateVolumeProfileSetting("hdlxShowBackground", event.target.checked)}
        />
      </label>
      {renderProfileColorSetting("Background Color", "hdlxBackgroundColor")}
      <label>
        Color Price Bars From HDLX
        <input
          type="checkbox"
          checked={volumeProfileSettings.hdlxEnableBarColoring}
          onChange={(event) => updateVolumeProfileSetting("hdlxEnableBarColoring", event.target.checked)}
        />
      </label>

      <div className="indicator-settings-section">Volume-Weighted Bar Coloring</div>
      <label>
        Volume-Weighted Bar Coloring
        <input
          type="checkbox"
          checked={volumeProfileSettings.volumeWeightedBarColoring}
          onChange={(event) => updateVolumeProfileSetting("volumeWeightedBarColoring", event.target.checked)}
        />
      </label>
      <label>
        Volume MA Length
        <input
          type="number"
          min={1}
          max={500}
          value={volumeProfileSettings.volumeMaLength}
          onChange={(event) => updateVolumeProfileSetting("volumeMaLength", clampNumber(Number(event.target.value), 1, 500))}
        />
      </label>
      <label>
        Upper Threshold
        <input
          type="number"
          min={1}
          max={10}
          step={0.001}
          value={volumeProfileSettings.upperThreshold}
          onChange={(event) => updateVolumeProfileSetting("upperThreshold", clampNumber(Number(event.target.value), 1, 10))}
        />
      </label>
      <label>
        Lower Threshold
        <input
          type="number"
          min={0.1}
          max={1}
          step={0.001}
          value={volumeProfileSettings.lowerThreshold}
          onChange={(event) => updateVolumeProfileSetting("lowerThreshold", clampNumber(Number(event.target.value), 0.1, 1))}
        />
      </label>
      {renderProfileColorSetting("Strong Up Bar", "strongBarUpColor")}
      {renderProfileColorSetting("Strong Down Bar", "strongBarDownColor")}
      {renderProfileColorSetting("Weak Up Bar", "weakBarUpColor")}
      {renderProfileColorSetting("Weak Down Bar", "weakBarDownColor")}
          </div>
        )}
        {volumeProfileSettingsTab === "style" && (
          <div className="volume-profile-settings">
            <div className="indicator-settings-section">Lines & Profile Colors</div>
            {renderProfileColorSetting("Up Volume", "upVolumeColor")}
            {renderProfileColorSetting("Down Volume", "downVolumeColor")}
            {renderProfileColorSetting("Value Area Up", "valueAreaUpColor")}
            {renderProfileColorSetting("Value Area Down", "valueAreaDownColor")}
            {renderProfileColorSetting("POC Color", "pocColor")}
            {renderProfileColorSetting("VAH Color", "vahColor")}
            {renderProfileColorSetting("VAL Color", "valColor")}
            {renderProfileColorSetting("LVN / Profile Gap Color", "profileGapColor")}
            <label className="indicator-range-row">
              LVN Intensity
              <span>
                <input
                  type="range"
                  min={15}
                  max={100}
                  value={volumeProfileSettings.profileGapIntensity}
                  onChange={(event) => updateVolumeProfileSetting("profileGapIntensity", Number(event.target.value))}
                />
                <b>{volumeProfileSettings.profileGapIntensity}</b>
              </span>
            </label>
            <label>
              POC Line Width
              <input
                type="number"
                min={1}
                max={5}
                value={volumeProfileSettings.pocWidth}
                onChange={(event) => updateVolumeProfileSetting("pocWidth", clampNumber(Number(event.target.value), 1, 5))}
              />
            </label>
            <label>
              VAH Line Width
              <input
                type="number"
                min={1}
                max={5}
                value={volumeProfileSettings.vahWidth}
                onChange={(event) => updateVolumeProfileSetting("vahWidth", clampNumber(Number(event.target.value), 1, 5))}
              />
            </label>
            <label>
              VAL Line Width
              <input
                type="number"
                min={1}
                max={5}
                value={volumeProfileSettings.valWidth}
                onChange={(event) => updateVolumeProfileSetting("valWidth", clampNumber(Number(event.target.value), 1, 5))}
              />
            </label>
            <div className="indicator-settings-section">HDLX Style</div>
            {renderProfileColorSetting("Positive Deviation Color", "hdlxPositiveColor")}
            {renderProfileColorSetting("Negative Deviation Color", "hdlxNegativeColor")}
            {renderProfileColorSetting("Wave Line Color", "hdlxLineColor")}
            {renderProfileColorSetting("Background Color", "hdlxBackgroundColor")}
            <label>
              Wave Line Thickness
              <input
                type="number"
                min={1}
                max={5}
                value={volumeProfileSettings.hdlxLineWidth}
                onChange={(event) => updateVolumeProfileSetting("hdlxLineWidth", clampNumber(Number(event.target.value), 1, 5))}
              />
            </label>
            <label>
              Fill Transparency
              <input
                type="number"
                min={0}
                max={100}
                value={volumeProfileSettings.hdlxFillTransparency}
                onChange={(event) => updateVolumeProfileSetting("hdlxFillTransparency", clampNumber(Number(event.target.value), 0, 100))}
              />
            </label>
          </div>
        )}
        {volumeProfileSettingsTab === "visibility" && (
          <div className="volume-profile-settings visibility-settings">
            <div className="indicator-settings-section">Visibility On Intervals</div>
            {["Seconds", "Minutes", "Hours", "Days", "Weeks", "Months"].map((label) => (
              <label key={label}>
                {label}
                <input type="checkbox" checked readOnly />
              </label>
            ))}
          </div>
        )}
      </div>
      <div className="tv-settings-footer">
        <button
          type="button"
          className="tv-defaults"
          onClick={() => {
            onIndicatorAdvancedSettingsChange((current) => ({
              ...current,
              volumeProfile: defaultVolumeProfileSettings
            }));
            onIndicatorPeriodsChange((current) => ({ ...current, volumeProfile: defaultVolumeProfileSettings.fixedRangeLength }));
          }}
        >
          Defaults
        </button>
        <span />
        <button type="button" className="tv-cancel" onClick={() => setActiveIndicator(null)}>Cancel</button>
        <button type="button" className="tv-ok" onClick={() => setActiveIndicator(null)}>Ok</button>
      </div>
    </div>
  );

  return (
    <div className="chart-wrap">
      <div className="chart-header">
        <div>
          <span className="pair">{displaySymbol} PERP - {timeframeLabel} - {exchangeLabel.toUpperCase()}</span>
          <span className="status-dot" />
          <span className="ohlc">
            O {displayCandle.open.toLocaleString(undefined, { maximumFractionDigits: 1 })}&nbsp;&nbsp;
            H {displayCandle.high.toLocaleString(undefined, { maximumFractionDigits: 1 })}&nbsp;&nbsp;
            L {displayCandle.low.toLocaleString(undefined, { maximumFractionDigits: 1 })}&nbsp;&nbsp;
            C {displayCandle.close.toLocaleString(undefined, { maximumFractionDigits: 1 })}&nbsp;&nbsp;
            {change.toFixed(1)} ({changePercent.toFixed(2)}%)
          </span>
        </div>
        <div className="chart-metrics">
          <span>{dataStatus}</span>
          <select
            className="select history-select"
            value={historyDepth}
            aria-label="History depth"
            onChange={(event) => setHistoryDepth(Number(event.target.value) as HistoryDepth)}
          >
            {historyDepthOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select className="select tiny">
            <option>USDT</option>
          </select>
        </div>
      </div>

      {!indicatorsCollapsed && (
        <div className="indicator-stack">
          {mountedIndicatorRows.map((indicator) => (
            <div
              key={indicator.key}
              className={visibleIndicators[indicator.key] ? "indicator-row" : "indicator-row hidden"}
              role="button"
              tabIndex={0}
              onClick={() => setActiveIndicator(indicator.key)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setActiveIndicator(indicator.key);
                }
              }}
            >
              <span>{indicator.label}</span>
              <b className={indicator.key === "aif" || indicator.key === "auctionProfile" || indicator.key === "ema200" || indicator.key === "volume" || indicator.key === "liquidationHeatmap" || indicator.key === "volatilityHeatmap" || indicator.key === "volumeProfile" || indicator.key === "adaptiveSwingStrategy" ? "red" : ""}>{indicator.value}</b>
              <button
                type="button"
                className="indicator-action"
                aria-label={visibleIndicators[indicator.key] ? `Hide ${indicator.label}` : `Show ${indicator.label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleIndicator(indicator.key);
                }}
                onKeyDown={(event) => event.stopPropagation()}
              >
                {visibleIndicators[indicator.key] ? <Eye size={12} /> : <EyeOff size={12} />}
              </button>
              <button
                type="button"
                className="indicator-action"
                aria-label={`Open ${indicator.label} settings`}
                onClick={(event) => {
                  event.stopPropagation();
                  setActiveIndicator(indicator.key);
                }}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <SlidersHorizontal size={12} />
              </button>
              <button
                type="button"
                className="indicator-action remove"
                aria-label={`Remove ${indicator.label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  removeIndicator(indicator.key);
                }}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {activeIndicator === "volumeProfile" && renderVolumeProfileSettings()}
      {activeIndicator === "adaptiveSwingStrategy" && renderAdaptiveSwingSettings()}
      {activeIndicator === "volatilityHeatmap" && (
        <KioseffSettingsPanel
          settings={kioseffSettings}
          chartTimeframe={timeframe}
          onChange={onKioseffSettingsChange}
          onClose={() => setActiveIndicator(null)}
        />
      )}
      {activeIndicator === "auctionProfile" && (
        <AuctionProfileSettingsPanel
          settings={normalizedAuctionProfileSettings}
          onChange={onAuctionProfileSettingsChange}
          onClose={() => setActiveIndicator(null)}
        />
      )}


      {activeIndicator && activeIndicator !== "aif" && activeIndicator !== "auctionProfile" && activeIndicator !== "volumeProfile" && activeIndicator !== "adaptiveSwingStrategy" && activeIndicator !== "volatilityHeatmap" && (
        <div
          className={
            activeIndicator === "zScoreOscillator"
              ? "indicator-settings profile-settings oscillator-settings"
              : activeIndicator === "vwap"
                ? "indicator-settings profile-settings vwap-settings"
                : "indicator-settings"
          }
        >
          <div className="indicator-settings-title">
            <span>{indicatorRows.find((indicator) => indicator.key === activeIndicator)?.label}</span>
            <button type="button" onClick={() => setActiveIndicator(null)}>DONE</button>
          </div>
          <label>
            Visible
            <input
              type="checkbox"
              checked={visibleIndicators[activeIndicator]}
              onChange={() => toggleIndicator(activeIndicator)}
            />
          </label>
          {activeIndicator in indicatorPeriods && (
            <label>
              Length
              <input
                type="number"
                min={2}
                max={500}
                value={indicatorPeriods[activeIndicator as keyof IndicatorPeriods]}
                onChange={(event) => updateIndicatorPeriod(activeIndicator as keyof IndicatorPeriods, Number(event.target.value))}
              />
            </label>
          )}
          <label>
            Color
            <select
              value={indicatorVisualSettings[activeIndicator].color}
              onChange={(event) => updateIndicatorVisual(activeIndicator, { color: event.target.value as IndicatorColorKey })}
            >
              {indicatorColorOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="indicator-range-row">
            Intensity
            <span>
              <input
                type="range"
                min={15}
                max={100}
                value={indicatorVisualSettings[activeIndicator].intensity}
                onChange={(event) => updateIndicatorVisual(activeIndicator, { intensity: Number(event.target.value) })}
              />
              <b>{indicatorVisualSettings[activeIndicator].intensity}</b>
            </span>
          </label>
          {activeIndicator === "vwap" && (
            <>
              <div className="indicator-settings-section">Institutional Engine</div>
              <label>
                Engine Preset
                <select
                  value={vwapSettings.preset}
                  onChange={(event) => applyVwapPreset(event.target.value as VwapSettings["preset"])}
                >
                  <option value="Custom">Custom</option>
                  <option value="Institutional Session">Institutional Session</option>
                  <option value="Rolling Execution">Rolling Execution</option>
                  <option value="Liquidity Discovery">Liquidity Discovery</option>
                  <option value="Event Shock">Event Shock</option>
                  <option value="Black Core Adaptive">Black Core Adaptive</option>
                </select>
              </label>
              <label>
                Anchor Architecture
                <select
                  value={vwapSettings.anchorMode}
                  onChange={(event) => updateVwapSetting("anchorMode", event.target.value as VwapSettings["anchorMode"])}
                >
                  {Object.entries(vwapAnchorLabels).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <div className="vwap-mode-note">
                Stable candle/time anchors—never recalculated from the visible chart edge.
              </div>
              <label>
                Price Source
                <select
                  value={vwapSettings.source}
                  onChange={(event) => updateVwapSetting("source", event.target.value as VwapSettings["source"])}
                >
                  <option value="close">Close</option>
                  <option value="hl2">HL2</option>
                  <option value="hlc3">HLC3 / Typical</option>
                  <option value="ohlc4">OHLC4</option>
                  <option value="weightedClose">Weighted Close</option>
                </select>
              </label>
              <label>
                Weighting Model
                <select
                  value={vwapSettings.weightingModel}
                  onChange={(event) => updateVwapSetting("weightingModel", event.target.value as VwapSettings["weightingModel"])}
                >
                  <option value="volume">Canonical Volume</option>
                  <option value="time">Execution TWAP</option>
                  <option value="exponentialVolume">Decayed Volume</option>
                  <option value="liquidityAdjusted">Liquidity Adjusted</option>
                  <option value="volatilityParticipation">Volatility Participation</option>
                  <option value="directionalConviction">Directional Conviction</option>
                  <option value="blackCoreHybrid">Black Core Hybrid</option>
                </select>
              </label>
              {(vwapSettings.anchorMode === "session" || vwapSettings.anchorMode === "week" || vwapSettings.anchorMode === "month") && (
                <label>
                  UTC Anchor Hour
                  <input
                    type="number"
                    min={0}
                    max={23}
                    value={vwapSettings.sessionAnchorHourUtc}
                    onChange={(event) => updateVwapSetting("sessionAnchorHourUtc", clampNumber(Number(event.target.value), 0, 23))}
                  />
                </label>
              )}
              {vwapSettings.anchorMode === "rolling" && (
                <label>
                  Rolling Window
                  <input
                    type="number"
                    min={2}
                    max={20_000}
                    value={vwapSettings.lookbackBars}
                    onChange={(event) => updateVwapSetting("lookbackBars", clampNumber(Number(event.target.value), 2, 20_000))}
                  />
                </label>
              )}
              {(["swingHigh", "swingLow", "volumeClimax", "volatilityBreak"] as VwapSettings["anchorMode"][]).includes(vwapSettings.anchorMode) && (
                <label>
                  Event Search Depth
                  <input
                    type="number"
                    min={10}
                    max={20_000}
                    value={vwapSettings.anchorLookbackBars}
                    onChange={(event) => updateVwapSetting("anchorLookbackBars", clampNumber(Number(event.target.value), 10, 20_000))}
                  />
                </label>
              )}
              {vwapSettings.weightingModel === "exponentialVolume" && (
                <label>
                  Decay Half-Life
                  <input
                    type="number"
                    min={2}
                    max={5_000}
                    value={vwapSettings.decayHalfLife}
                    onChange={(event) => updateVwapSetting("decayHalfLife", clampNumber(Number(event.target.value), 2, 5_000))}
                  />
                </label>
              )}
              <label>
                Volatility Length
                <input
                  type="number"
                  min={2}
                  max={500}
                  value={vwapSettings.atrLength}
                  onChange={(event) => updateVwapSetting("atrLength", clampNumber(Number(event.target.value), 2, 500))}
                />
              </label>
              {(vwapSettings.weightingModel === "directionalConviction" || vwapSettings.weightingModel === "blackCoreHybrid") && (
                <label>
                  Conviction Bias
                  <input
                    type="number"
                    min={0}
                    max={5}
                    step={0.05}
                    value={vwapSettings.directionalBias}
                    onChange={(event) => updateVwapSetting("directionalBias", clampNumber(Number(event.target.value), 0, 5))}
                  />
                </label>
              )}
              {vwapSettings.anchorMode === "autoRegime" && (
                <>
                  <label>
                    Shock Sensitivity
                    <input
                      type="number"
                      min={0.5}
                      max={10}
                      step={0.1}
                      value={vwapSettings.regimeSensitivity}
                      onChange={(event) => updateVwapSetting("regimeSensitivity", clampNumber(Number(event.target.value), 0.5, 10))}
                    />
                  </label>
                  <label>
                    Volume Trigger
                    <input
                      type="number"
                      min={0.25}
                      max={10}
                      step={0.05}
                      value={vwapSettings.volumeThreshold}
                      onChange={(event) => updateVwapSetting("volumeThreshold", clampNumber(Number(event.target.value), 0.25, 10))}
                    />
                  </label>
                  <label>
                    Anchor Cooldown
                    <input
                      type="number"
                      min={2}
                      max={5_000}
                      value={vwapSettings.minimumBarsBetweenAnchors}
                      onChange={(event) => updateVwapSetting("minimumBarsBetweenAnchors", clampNumber(Number(event.target.value), 2, 5_000))}
                    />
                  </label>
                </>
              )}
              <label>
                Execution Smoothing
                <select
                  value={vwapSettings.smoothingMethod}
                  onChange={(event) => updateVwapSetting("smoothingMethod", event.target.value as VwapSettings["smoothingMethod"])}
                >
                  <option value="none">None / Exact</option>
                  <option value="ema">EMA</option>
                  <option value="rma">RMA / Wilder</option>
                </select>
              </label>
              {vwapSettings.smoothingMethod !== "none" && (
                <label>
                  Smoothing Length
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={vwapSettings.smoothingLength}
                    onChange={(event) => updateVwapSetting("smoothingLength", clampNumber(Number(event.target.value), 1, 100))}
                  />
                </label>
              )}

              <div className="indicator-settings-section">Institutional Envelopes</div>
              <label>
                Dispersion Model
                <select
                  value={vwapSettings.bandMode}
                  onChange={(event) => updateVwapSetting("bandMode", event.target.value as VwapSettings["bandMode"])}
                >
                  <option value="weightedStd">Weighted Deviation</option>
                  <option value="atr">ATR Execution Bands</option>
                  <option value="percentage">Percentage Bands</option>
                  <option value="microstructure">Microstructure Composite</option>
                </select>
              </label>
              {vwapSettings.bandMode === "percentage" && (
                <label>
                  Base Distance %
                  <input
                    type="number"
                    min={0.01}
                    max={25}
                    step={0.01}
                    value={vwapSettings.bandPercentage}
                    onChange={(event) => updateVwapSetting("bandPercentage", clampNumber(Number(event.target.value), 0.01, 25))}
                  />
                </label>
              )}
              <label>
                Inner Band
                <input
                  type="checkbox"
                  checked={vwapSettings.showBand1}
                  onChange={(event) => updateVwapSetting("showBand1", event.target.checked)}
                />
              </label>
              <label>
                Inner Multiplier
                <input
                  type="number"
                  min={0.1}
                  max={20}
                  step={0.1}
                  value={vwapSettings.band1Multiplier}
                  onChange={(event) => updateVwapSetting("band1Multiplier", clampNumber(Number(event.target.value), 0.1, 20))}
                />
              </label>
              <label className="indicator-color-setting">
                Inner Band Color
                <input
                  type="color"
                  value={vwapSettings.band1Color}
                  onChange={(event) => updateVwapSetting("band1Color", event.target.value)}
                />
              </label>
              <label>
                Outer Band
                <input
                  type="checkbox"
                  checked={vwapSettings.showBand2}
                  onChange={(event) => updateVwapSetting("showBand2", event.target.checked)}
                />
              </label>
              <label>
                Outer Multiplier
                <input
                  type="number"
                  min={0.1}
                  max={20}
                  step={0.1}
                  value={vwapSettings.band2Multiplier}
                  onChange={(event) => updateVwapSetting("band2Multiplier", clampNumber(Number(event.target.value), 0.1, 20))}
                />
              </label>
              <label className="indicator-color-setting">
                Outer Band Color
                <input
                  type="color"
                  value={vwapSettings.band2Color}
                  onChange={(event) => updateVwapSetting("band2Color", event.target.value)}
                />
              </label>
              <label>
                Tail-Risk Band
                <input
                  type="checkbox"
                  checked={vwapSettings.showBand3}
                  onChange={(event) => updateVwapSetting("showBand3", event.target.checked)}
                />
              </label>
              <label>
                Tail Multiplier
                <input
                  type="number"
                  min={0.1}
                  max={20}
                  step={0.1}
                  value={vwapSettings.band3Multiplier}
                  onChange={(event) => updateVwapSetting("band3Multiplier", clampNumber(Number(event.target.value), 0.1, 20))}
                />
              </label>
              <label className="indicator-color-setting">
                Tail Band Color
                <input
                  type="color"
                  value={vwapSettings.band3Color}
                  onChange={(event) => updateVwapSetting("band3Color", event.target.value)}
                />
              </label>
              <label className="indicator-range-row">
                Band Intensity
                <span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={vwapSettings.bandIntensity}
                    onChange={(event) => updateVwapSetting("bandIntensity", Number(event.target.value))}
                  />
                  <b>{vwapSettings.bandIntensity}</b>
                </span>
              </label>
              <label>
                Value Corridor Fill
                <input
                  type="checkbox"
                  checked={vwapSettings.showBandFill}
                  onChange={(event) => updateVwapSetting("showBandFill", event.target.checked)}
                />
              </label>
              <label className="indicator-color-setting">
                Corridor Color
                <input
                  type="color"
                  value={vwapSettings.bandFillColor}
                  onChange={(event) => updateVwapSetting("bandFillColor", event.target.value)}
                />
              </label>
              <label className="indicator-range-row">
                Corridor Intensity
                <span>
                  <input
                    type="range"
                    min={0}
                    max={35}
                    value={vwapSettings.bandFillIntensity}
                    onChange={(event) => updateVwapSetting("bandFillIntensity", Number(event.target.value))}
                  />
                  <b>{vwapSettings.bandFillIntensity}</b>
                </span>
              </label>

              <div className="indicator-settings-section">Signal & Execution Style</div>
              <label className="indicator-range-row">
                Core Line Width
                <span>
                  <input
                    type="range"
                    min={0.5}
                    max={6}
                    step={0.25}
                    value={vwapSettings.lineWidth}
                    onChange={(event) => updateVwapSetting("lineWidth", Number(event.target.value))}
                  />
                  <b>{vwapSettings.lineWidth.toFixed(2)}</b>
                </span>
              </label>
              <label>
                Custom Core Color
                <input
                  type="checkbox"
                  checked={vwapSettings.useCustomLineColor}
                  onChange={(event) => updateVwapSetting("useCustomLineColor", event.target.checked)}
                />
              </label>
              <label className="indicator-color-setting">
                Core Line Color
                <input
                  type="color"
                  disabled={!vwapSettings.useCustomLineColor}
                  value={vwapSettings.lineColor}
                  onChange={(event) => updateVwapSetting("lineColor", event.target.value)}
                />
              </label>
              <label>
                Dynamic Slope Regime
                <input
                  type="checkbox"
                  checked={vwapSettings.dynamicSlopeColor}
                  onChange={(event) => updateVwapSetting("dynamicSlopeColor", event.target.checked)}
                />
              </label>
              {vwapSettings.dynamicSlopeColor && (
                <>
                  <label className="indicator-color-setting">
                    Bullish Regime
                    <input
                      type="color"
                      value={vwapSettings.bullishColor}
                      onChange={(event) => updateVwapSetting("bullishColor", event.target.value)}
                    />
                  </label>
                  <label className="indicator-color-setting">
                    Bearish Regime
                    <input
                      type="color"
                      value={vwapSettings.bearishColor}
                      onChange={(event) => updateVwapSetting("bearishColor", event.target.value)}
                    />
                  </label>
                  <label className="indicator-color-setting">
                    Neutral Regime
                    <input
                      type="color"
                      value={vwapSettings.neutralColor}
                      onChange={(event) => updateVwapSetting("neutralColor", event.target.value)}
                    />
                  </label>
                  <label>
                    Slope Window
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={vwapSettings.slopeLookback}
                      onChange={(event) => updateVwapSetting("slopeLookback", clampNumber(Number(event.target.value), 1, 100))}
                    />
                  </label>
                  <label>
                    Neutral Threshold
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.05}
                      value={vwapSettings.slopeThresholdBps}
                      onChange={(event) => updateVwapSetting("slopeThresholdBps", clampNumber(Number(event.target.value), 0, 100))}
                    />
                  </label>
                </>
              )}
              <label>
                Anchor Markers
                <input
                  type="checkbox"
                  checked={vwapSettings.showAnchorMarkers}
                  onChange={(event) => updateVwapSetting("showAnchorMarkers", event.target.checked)}
                />
              </label>
              <label className="indicator-color-setting">
                Anchor Marker Color
                <input
                  type="color"
                  disabled={!vwapSettings.showAnchorMarkers}
                  value={vwapSettings.anchorMarkerColor}
                  onChange={(event) => updateVwapSetting("anchorMarkerColor", event.target.value)}
                />
              </label>
              <label>
                Previous Auction VWAP
                <input
                  type="checkbox"
                  checked={vwapSettings.showPreviousVwap}
                  onChange={(event) => updateVwapSetting("showPreviousVwap", event.target.checked)}
                />
              </label>
              <label className="indicator-color-setting">
                Previous VWAP Color
                <input
                  type="color"
                  disabled={!vwapSettings.showPreviousVwap}
                  value={vwapSettings.previousVwapColor}
                  onChange={(event) => updateVwapSetting("previousVwapColor", event.target.value)}
                />
              </label>
              <label className="indicator-range-row">
                Previous Intensity
                <span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    disabled={!vwapSettings.showPreviousVwap}
                    value={vwapSettings.previousVwapIntensity}
                    onChange={(event) => updateVwapSetting("previousVwapIntensity", Number(event.target.value))}
                  />
                  <b>{vwapSettings.previousVwapIntensity}</b>
                </span>
              </label>
            </>
          )}
          {oscillatorSettingsOpen && (
            <>
              <div className="indicator-settings-section">Pane</div>
              <label className="indicator-range-row">
                Pane Height
                <span>
                  <input
                    type="range"
                    min={82}
                    max={420}
                    value={activeOscillatorPaneHeight}
                    onChange={(event) => {
                      if (activeOscillatorKey) updateOscillatorPaneHeight(activeOscillatorKey, Number(event.target.value));
                    }}
                  />
                  <b>{activeOscillatorPaneHeight}px</b>
                </span>
              </label>
              <label className="indicator-color-setting">
                Pane Background
                <input
                  type="color"
                  value={oscillatorPaneSettings.backgroundColor}
                  onChange={(event) => updateOscillatorPaneSetting("backgroundColor", event.target.value)}
                />
              </label>
              <label className="indicator-range-row">
                Background Intensity
                <span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={oscillatorPaneSettings.backgroundIntensity}
                    onChange={(event) => updateOscillatorPaneSetting("backgroundIntensity", Number(event.target.value))}
                  />
                  <b>{oscillatorPaneSettings.backgroundIntensity}</b>
                </span>
              </label>
              <label className="indicator-color-setting">
                Zero Line
                <input
                  type="color"
                  value={oscillatorPaneSettings.zeroLineColor}
                  onChange={(event) => updateOscillatorPaneSetting("zeroLineColor", event.target.value)}
                />
              </label>
              <label className="indicator-range-row">
                Zero Line Intensity
                <span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={oscillatorPaneSettings.zeroLineIntensity}
                    onChange={(event) => updateOscillatorPaneSetting("zeroLineIntensity", Number(event.target.value))}
                  />
                  <b>{oscillatorPaneSettings.zeroLineIntensity}</b>
                </span>
              </label>
            </>
          )}
          {activeIndicator === "waveTrendOscillator" && (
            <>
              <div className="indicator-settings-section">Wave Injection</div>
              {primaryOscillator ? (
                <>
                  <label>
                    Inject Wave in Main Oscillator
                    <input
                      type="checkbox"
                      checked={waveTrendSettings.injectIntoPrimary}
                      onChange={(event) => updateWaveTrendSetting("injectIntoPrimary", event.target.checked)}
                    />
                  </label>
                  <div className="vwap-mode-note">
                    {waveTrendSettings.injectIntoPrimary
                      ? `WaveTrend is injected into ${primaryOscillator === "zScoreOscillator" ? "Z-Score" : "OI Osc"}; its separate pane is hidden.`
                      : "WaveTrend remains in its own independently resizable pane above the existing oscillator stack."}
                  </div>
                </>
              ) : (
                <div className="vwap-mode-note">
                  Load Z-Score or OI Osc first to unlock WaveTrend injection.
                </div>
              )}
              <label className="indicator-range-row">
                Main Wave Width
                <span>
                  <input
                    type="range"
                    min={0.5}
                    max={4}
                    step={0.05}
                    value={waveTrendSettings.mainLineWidth}
                    onChange={(event) => updateWaveTrendSetting("mainLineWidth", Number(event.target.value))}
                  />
                  <b>{waveTrendSettings.mainLineWidth.toFixed(2)}</b>
                </span>
              </label>
              <label className="indicator-color-setting">
                Signal Wave
                <input
                  type="color"
                  value={waveTrendSettings.signalColor}
                  onChange={(event) => updateWaveTrendSetting("signalColor", event.target.value)}
                />
              </label>
              <label className="indicator-range-row">
                Signal Intensity
                <span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={waveTrendSettings.signalIntensity}
                    onChange={(event) => updateWaveTrendSetting("signalIntensity", Number(event.target.value))}
                  />
                  <b>{waveTrendSettings.signalIntensity}</b>
                </span>
              </label>
              <label className="indicator-range-row">
                Signal Wave Width
                <span>
                  <input
                    type="range"
                    min={0.5}
                    max={4}
                    step={0.05}
                    value={waveTrendSettings.signalLineWidth}
                    onChange={(event) => updateWaveTrendSetting("signalLineWidth", Number(event.target.value))}
                  />
                  <b>{waveTrendSettings.signalLineWidth.toFixed(2)}</b>
                </span>
              </label>
            </>
          )}
          {activeIndicator === "zScoreOscillator" && (
            <>
              <div className="indicator-settings-section">Z-Score Engine</div>
              <label>
                Price Source
                <select
                  value={zScoreSettings.source}
                  onChange={(event) => updateZScoreSetting("source", event.target.value as ZScoreOscillatorSettings["source"])}
                >
                  <option value="close">Close</option>
                  <option value="hl2">HL2</option>
                  <option value="hlc3">HLC3</option>
                  <option value="ohlc4">OHLC4</option>
                </select>
              </label>
              <label>
                Calculation
                <select
                  value={zScoreSettings.calculationMethod}
                  onChange={(event) => updateZScoreSetting("calculationMethod", event.target.value as ZScoreOscillatorSettings["calculationMethod"])}
                >
                  <option value="price">Price Z-Score</option>
                  <option value="logReturn">Log Return Z-Score</option>
                  <option value="percentReturn">Percent Return Z-Score</option>
                  <option value="robust">Robust Median / MAD</option>
                </select>
              </label>
              <label>
                Basis
                <select
                  value={zScoreSettings.basisMethod}
                  onChange={(event) => updateZScoreSetting("basisMethod", event.target.value as ZScoreOscillatorSettings["basisMethod"])}
                >
                  <option value="sma">SMA</option>
                  <option value="ema">EMA</option>
                </select>
              </label>
              <label>
                Deviation
                <select
                  value={zScoreSettings.deviationMode}
                  onChange={(event) => updateZScoreSetting("deviationMode", event.target.value as ZScoreOscillatorSettings["deviationMode"])}
                >
                  <option value="population">Population</option>
                  <option value="sample">Sample</option>
                </select>
              </label>
              <label>
                Smoothing
                <select
                  value={zScoreSettings.smoothingMethod}
                  onChange={(event) => updateZScoreSetting("smoothingMethod", event.target.value as ZScoreOscillatorSettings["smoothingMethod"])}
                >
                  <option value="none">None</option>
                  <option value="sma">SMA</option>
                  <option value="ema">EMA</option>
                  <option value="rma">RMA / Wilder</option>
                </select>
              </label>
              <label>
                Smoothing Length
                <input
                  type="number"
                  min={1}
                  max={100}
                  disabled={zScoreSettings.smoothingMethod === "none"}
                  value={zScoreSettings.smoothingLength}
                  onChange={(event) => updateZScoreSetting("smoothingLength", clampNumber(Number(event.target.value), 1, 100))}
                />
              </label>
              <label>
                Extreme Clamp
                <input
                  type="number"
                  min={1}
                  max={20}
                  step={0.25}
                  value={zScoreSettings.clamp}
                  onChange={(event) => updateZScoreSetting("clamp", clampNumber(Number(event.target.value), 1, 20))}
                />
              </label>
              <div className="indicator-settings-section">Bands & Style</div>
              <label>
                Upper Band
                <input
                  type="number"
                  min={0.25}
                  max={10}
                  step={0.25}
                  value={zScoreSettings.upperBand}
                  onChange={(event) => updateZScoreSetting("upperBand", clampNumber(Number(event.target.value), 0.25, 10))}
                />
              </label>
              <label className="indicator-color-setting">
                Upper Band Color
                <input
                  type="color"
                  value={zScoreSettings.upperBandColor}
                  onChange={(event) => updateZScoreSetting("upperBandColor", event.target.value)}
                />
              </label>
              <label>
                Lower Band
                <input
                  type="number"
                  min={-10}
                  max={-0.25}
                  step={0.25}
                  value={zScoreSettings.lowerBand}
                  onChange={(event) => updateZScoreSetting("lowerBand", clampNumber(Number(event.target.value), -10, -0.25))}
                />
              </label>
              <label className="indicator-color-setting">
                Lower Band Color
                <input
                  type="color"
                  value={zScoreSettings.lowerBandColor}
                  onChange={(event) => updateZScoreSetting("lowerBandColor", event.target.value)}
                />
              </label>
              <label className="indicator-color-setting">
                Midline Color
                <input
                  type="color"
                  value={zScoreSettings.midlineColor}
                  onChange={(event) => updateZScoreSetting("midlineColor", event.target.value)}
                />
              </label>
              <label className="indicator-range-row">
                Band Intensity
                <span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={zScoreSettings.bandIntensity}
                    onChange={(event) => updateZScoreSetting("bandIntensity", Number(event.target.value))}
                  />
                  <b>{zScoreSettings.bandIntensity}</b>
                </span>
              </label>
              <label className="indicator-range-row">
                Line Width
                <span>
                  <input
                    type="range"
                    min={0.5}
                    max={4}
                    step={0.25}
                    value={zScoreSettings.lineWidth}
                    onChange={(event) => updateZScoreSetting("lineWidth", Number(event.target.value))}
                  />
                  <b>{zScoreSettings.lineWidth.toFixed(2)}</b>
                </span>
              </label>
              <label className="indicator-range-row">
                Line Intensity
                <span>
                  <input
                    type="range"
                    min={10}
                    max={100}
                    value={zScoreSettings.lineIntensity}
                    onChange={(event) => updateZScoreSetting("lineIntensity", Number(event.target.value))}
                  />
                  <b>{zScoreSettings.lineIntensity}</b>
                </span>
              </label>
              <label>
                Extreme Fill
                <input
                  type="checkbox"
                  checked={zScoreSettings.showBandFill}
                  onChange={(event) => updateZScoreSetting("showBandFill", event.target.checked)}
                />
              </label>
              <label className="indicator-range-row">
                Fill Intensity
                <span>
                  <input
                    type="range"
                    min={0}
                    max={50}
                    disabled={!zScoreSettings.showBandFill}
                    value={zScoreSettings.bandFillIntensity}
                    onChange={(event) => updateZScoreSetting("bandFillIntensity", Number(event.target.value))}
                  />
                  <b>{zScoreSettings.bandFillIntensity}</b>
                </span>
              </label>
            </>
          )}
          {activeIndicator === "liquidationHeatmap" ? (
            <LiquidationFieldSettingsPanel
              settings={liquidationFieldSettings}
              onChange={(settings) => onIndicatorAdvancedSettingsChange((current) => ({ ...current, liquidationField: settings }))}
            />
          ) : !oscillatorSettingsOpen && activeIndicator !== "vwap" ? (
            <label>
              Source
              <select value="close" onChange={() => undefined}>
                <option value="close">Close</option>
                <option value="hlc3">HLC3</option>
              </select>
            </label>
          ) : null}
        </div>
      )}

      {chartContextMenu && (
        <div
          className="chart-context-menu"
          style={{ left: chartContextMenu.x, top: chartContextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          role="menu"
        >
          <div className="chart-context-head">
            <span>{displaySymbol}</span>
            <b>{formatAlertPrice(chartContextMenu.point.price)}</b>
          </div>
          <div className="chart-context-section">
            <small>{activeChartPosition ? "Position Lifecycle" : "Execution"}</small>
            {activeChartPosition ? (
              <>
                <button type="button" onClick={() => recordPositionContextAction("stats")}><Eye size={14} />Position Statistics</button>
                <button type="button" onClick={() => recordPositionContextAction("add")}><Plus size={14} />Add To Position</button>
                <button type="button" onClick={() => recordPositionContextAction("scaleIn")}><Plus size={14} />Scale In</button>
                <button type="button" onClick={() => recordPositionContextAction("scaleOut")}><Minus size={14} />Scale Out</button>
                <button type="button" onClick={() => recordPositionContextAction("partialClose")}><Minus size={14} />Partial Close</button>
                <button type="button" onClick={() => recordPositionContextAction("close")}><X size={14} />Close Position</button>
                <button type="button" onClick={() => recordPositionContextAction("reverse")}><TrendingUp size={14} />Reverse Position</button>
                <button type="button" onClick={() => openPositionProtectionTicket("take-profit")}><Plus size={14} />Set Take Profit Here</button>
                <button type="button" onClick={() => openPositionProtectionTicket("stop-loss")}><Minus size={14} />Set Stop Loss Here</button>
                <button type="button" onClick={() => openPositionProtectionTicket("trailing-stop")}><SlidersHorizontal size={14} />Set Trailing Stop</button>
                <button type="button" onClick={() => recordPositionContextAction("moveProtection")}><SlidersHorizontal size={14} />Move Protection</button>
                <button type="button" onClick={() => recordPositionContextAction("cancelTp")}><X size={14} />Cancel TP</button>
                <button type="button" onClick={() => recordPositionContextAction("cancelSl")}><X size={14} />Cancel SL</button>
                <button type="button" onClick={() => recordPositionContextAction("cancelTrailing")}><X size={14} />Cancel Trailing</button>
                <button type="button" onClick={() => recordPositionContextAction("notes")}><Type size={14} />Trade Notes</button>
                <button type="button" onClick={() => recordPositionContextAction("timeline")}><Copy size={14} />Trade Timeline</button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => openExecutionTicketFromContext("buy", "market")}>
                  <Play size={14} />
                  Execute Order
                </button>
                <button type="button" onClick={() => openExecutionTicketFromContext("buy", "market", "capital-allocation", true)}>
                  <Copy size={14} />
                  Execute Copy Trade Order
                </button>
                <button type="button" onClick={() => openExecutionTicketFromContext("buy", "market")}>
                  <Plus size={14} />
                  Buy Market
                </button>
                <button type="button" onClick={() => openExecutionTicketFromContext("sell", "market")}>
                  <Minus size={14} />
                  Sell Market
                </button>
                <button type="button" onClick={() => openExecutionTicketFromContext("buy", "limit")}>
                  <Plus size={14} />
                  Buy Limit Here
                </button>
                <button type="button" onClick={() => openExecutionTicketFromContext("sell", "limit")}>
                  <Minus size={14} />
                  Sell Limit Here
                </button>
              </>
            )}
          </div>
          <div className="chart-context-section">
            <small>Price Alert</small>
            <button type="button" onClick={() => createPriceAlertAtContext("testing")}>
              <Bell size={14} />
              Test This Price
            </button>
            <button type="button" onClick={() => createPriceAlertAtContext("crossingAbove")}>
              <Plus size={14} />
              Crossing Above
            </button>
            <button type="button" onClick={() => createPriceAlertAtContext("crossingBelow")}>
              <Minus size={14} />
              Crossing Below
            </button>
          </div>
          <div className="chart-context-section">
            <small>Drawing</small>
            <button type="button" onClick={() => addDrawingFromContext("horizontalLine")}>
              <Minus size={14} />
              Horizontal Line
            </button>
            <button type="button" onClick={() => addDrawingFromContext("verticalLine")}>
              <Columns3 size={14} />
              Vertical Line
            </button>
            <button type="button" onClick={() => addDrawingFromContext("text")}>
              <Type size={14} />
              Text Note
            </button>
            <button type="button" onClick={() => requestDrawingToolFromContext("trendLine")}>
              <TrendingUp size={14} />
              Trend Line Tool
            </button>
            <button type="button" onClick={() => requestDrawingToolFromContext("rectangle")}>
              <Square size={14} />
              Rectangle Tool
            </button>
            <button type="button" onClick={() => requestDrawingToolFromContext("brush")}>
              <Brush size={14} />
              Brush Tool
            </button>
          </div>
          <div className="chart-context-section compact">
            <button type="button" onClick={copyContextPrice}>
              <Copy size={14} />
              Copy Price
            </button>
            <button type="button" onClick={() => {
              setChartContextMenu(null);
              onOpenAlerts?.();
            }}>
              <Bell size={14} />
              Open Alerts
            </button>
          </div>
        </div>
      )}

      {executionTicketPreset && (
        <UnifiedExecutionTicket
          preset={executionTicketPreset}
          onClose={() => setExecutionTicketPreset(null)}
        />
      )}

      {editingChartAlert && (
        <div
          className="chart-alert-editor"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="chart-alert-editor-head">
            <div>
              <span>PRICE ALERT</span>
              <b>{editingChartAlert.name}</b>
            </div>
            <button type="button" aria-label="Close alert editor" onClick={() => setEditingChartAlertId(null)}>
              <X size={15} />
            </button>
          </div>
          <label>
            Name
            <input
              value={editingChartAlert.name}
              onChange={(event) => updateEditingChartAlert({ name: event.target.value })}
            />
          </label>
          <div className="chart-alert-editor-grid">
            <label>
              Price
              <input
                type="number"
                step="0.1"
                value={editingChartAlert.targetPrice ?? ""}
                onChange={(event) => updateEditingChartAlert({ targetPrice: Number(event.target.value) })}
              />
            </label>
            <label>
              Color
              <input
                type="color"
                value={editingChartAlert.color ?? "#ffffff"}
                onChange={(event) => updateEditingChartAlert({ color: event.target.value })}
              />
            </label>
          </div>
          <label>
            Condition
            <select
              value={editingChartAlert.condition}
              onChange={(event) => updateEditingChartAlert({ condition: event.target.value as AlertCondition })}
            >
              <option value="testing">Testing</option>
              <option value="crossingAbove">Crossing Above</option>
              <option value="crossingBelow">Crossing Below</option>
            </select>
          </label>
          <label>
            Message
            <textarea
              rows={2}
              value={editingChartAlert.message}
              onChange={(event) => updateEditingChartAlert({ message: event.target.value })}
            />
          </label>
          <div className="chart-alert-editor-actions">
            <button type="button" className="danger" onClick={deleteEditingChartAlert}>Delete</button>
            <button type="button" onClick={() => updateEditingChartAlert({ enabled: !editingChartAlert.enabled })}>
              {editingChartAlert.enabled ? "Disable" : "Enable"}
            </button>
            <button type="button" className="primary" onClick={() => setEditingChartAlertId(null)}>Done</button>
          </div>
        </div>
      )}

      {alertToast && (
        <div className="chart-alert-toast" key={alertToast.id}>
          <Bell size={15} />
          <div>
            <strong>{alertToast.title}</strong>
            <span>{alertToast.message}</span>
          </div>
        </div>
      )}

      {(positionLines.length > 0 || chartOrderLines.length > 0) && (
        <div className="position-protection-overlay" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
          {activeChartPosition && positionLines.map((line) => (
            <div
              key={line.id}
              className={`position-line ${line.tone}${line.protection ? " draggable" : ""}`}
              style={{ top: Number(line.y) }}
              title={`${activeChartPosition.exchange.toUpperCase()} ${activeChartPosition.symbol} ${line.label} ${formatAlertPrice(line.price)} | PnL ${formatAlertPrice(activeChartPosition.health.currentPnl)} | RR ${activeChartPosition.health.riskReward?.toFixed(2) ?? "-"}`}
              onMouseDown={dragProtectionLine(line.protection)}
            >
              <span>{line.label}</span>
              <b>{formatAlertPrice(line.price)}</b>
            </div>
          ))}
          {chartOrderLines.map(({ order, y }) => (
            <div
              key={canonicalOrderKey(order)}
              className={`venue-order-line ${order.side === "sell" ? "sell" : "buy"}`}
              style={{ top: Number(y) }}
              title={`${order.exchange.toUpperCase()} ${order.side?.toUpperCase()} ${String(order.type || order.orderType || "ORDER").toUpperCase()} | ${formatAlertPrice(Number(order.price))} | Remaining ${order.remainingQuantity ?? order.quantity ?? 0} | ${order.externallyCreated ? "EXTERNAL" : "BLACK TERMINAL"}`}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setChartContextMenu(null);
                setOrderContextMenu({ x: event.clientX, y: event.clientY, order });
              }}
            >
              <span>{order.exchange.toUpperCase()} {order.side?.toUpperCase()} {String(order.type || order.orderType || "ORDER").toUpperCase()}</span>
              <b>{formatAlertPrice(Number(order.price))}</b>
              <em>{order.remainingQuantity ?? order.quantity ?? 0} {order.externallyCreated ? "EXTERNAL" : "BLACK TERMINAL"}</em>
            </div>
          ))}
        </div>
      )}

      {orderContextMenu && (
        <OrderManagementMenu
          order={orderContextMenu.order}
          x={orderContextMenu.x}
          y={orderContextMenu.y}
          onClose={() => setOrderContextMenu(null)}
          onSynchronized={onRefreshOrders}
        />
      )}

      <button
        className={indicatorsCollapsed ? "chart-collapse collapsed" : "chart-collapse"}
        style={indicatorsCollapsed ? undefined : { top: 57 + mountedIndicatorRows.length * 26 + 8 }}
        aria-label={indicatorsCollapsed ? "Show indicator legend" : "Collapse indicator legend"}
        onClick={() => {
          setIndicatorsCollapsed((value) => !value);
          setActiveIndicator(null);
        }}
      >
        {indicatorsCollapsed ? "v" : "^"}
      </button>
      <div ref={hostRef} className="pixi-chart-host" onContextMenu={handleChartContextMenu} onClick={() => setChartContextMenu(null)} />
      {oscillatorPaneVisible && oscillatorStack.panes.map((pane) => (
        <div
          key={pane.key}
          className="oscillator-pane-resizer"
          style={{ bottom: `min(${74 + pane.topOffset}px, calc(100% - 110px))` }}
          role="separator"
          aria-label={`Resize ${pane.key === "zScoreOscillator" ? "Z-Score" : pane.key === "waveTrendOscillator" ? "WaveTrend" : "OI Osc"} pane`}
          aria-orientation="horizontal"
          onPointerDown={(event) => beginOscillatorResize(event, pane.key)}
          onPointerMove={resizeOscillatorPane}
          onPointerUp={finishOscillatorResize}
          onPointerCancel={finishOscillatorResize}
          onDoubleClick={() => updateOscillatorPaneHeight(pane.key, defaultOscillatorPaneSettings.paneHeights[pane.key])}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <span />
        </div>
      ))}
      {auctionDataRequired && <>
        <AuctionProfileLegend snapshot={auctionProfileSnapshot} settings={normalizedAuctionProfileSettings} chartType={chartType} />
        {normalizedAuctionProfileSettings.diagnosticsVisible && <AuctionProfileDiagnostics snapshot={auctionProfileSnapshot} />}
        {auctionProfileLoading && <div className="auction-profile-loading"><b>BLACK CORE RADAP ENGINE</b><span>Rebuilding deterministic range × price data…</span><i /></div>}
        {auctionProfileError && <div className="auction-profile-error"><b>RADAP DATA UNAVAILABLE</b><span>{auctionProfileError}</span></div>}
      </>}

      <LiquidationFieldOverlays
        visible={visibleIndicators.liquidationHeatmap}
        snapshot={liquidationFieldSnapshot}
        settings={liquidationFieldSettings}
        status={liquidationFieldStatus}
      />



      <KioseffOverlays
        visible={visibleIndicators.volatilityHeatmap}
        snapshot={kioseffSnapshot}
        unavailable={kioseffUnavailable}
        settings={kioseffSettings}
        loadState={kioseffLoadState}
        diagnostics={kioseffDiagnostics}
        currentPrice={lastPrice}
      />
      <AifIndicatorOverlay
        active={visibleIndicators.aif}
        settingsOpen={activeIndicator === "aif"}
        onCloseSettings={() => setActiveIndicator(null)}
        workspaceId={workspaceId}
        marketSymbol={marketSymbol}
        timeframe={timeframe}
        currentPrice={lastPrice}
        latestCandle={lastCandle}
        chartEngine={engineRef.current}
        priceTransform={aifPriceTransform}
      />
    </div>
  );
}
