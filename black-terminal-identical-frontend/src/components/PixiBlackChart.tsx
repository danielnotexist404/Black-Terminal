import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  QalcIndicatorSettings,
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
  defaultQalcIndicatorSettings,
  defaultVolumeProfileSettings,
  defaultVwapSettings,
  defaultWaveTrendOscillatorSettings,
  defaultZScoreOscillatorSettings
} from "../chart-engine/profile/volumeProfileDefaults";
import { DDAProWorkerClient } from "../modules/dda-pro/workers/DDAProWorkerClient";
import { DEFAULT_DDA_PRO_SETTINGS, applyDDAProPreset, applyDDAProSignalIntelligenceMode, migrateDDAProSettings, resetDDAProSignalIntelligence } from "../modules/dda-pro/core/settings";
import {
  calculationHash as ddaProCalculationHash,
  confirmedNewestDDAProSignals,
  ddaProAlertSignalStream,
  latestConfirmedDDAProCandleTime
} from "../modules/dda-pro/core/engineShared";
import { BC_RDA_CAUSAL_V2, BC_RDA_LEGACY_REPAINTING, type DDAProPreset, type DDAProSettings, type DDAProSignalIntelligenceMode, type DDAProSnapshot } from "../modules/dda-pro/core/types";
import { BC_RDA_ALERTS_ELIGIBLE } from "../modules/dda-pro/core/certification";
import {
  DEFAULT_CUSTOM_OSCILLATOR_PANE_HEIGHT,
  OSCILLATOR_KEYS,
  customOscillatorScriptIds,
  resolveOscillatorStack
} from "../chart-engine/indicators/oscillatorLayout";
import { createMockCandles } from "../data/mockMarket";
import type { AlertCondition, AlertIndicatorTarget, IndicatorAlertDefinition } from "../automation/alerts";
import { canUseIndicator } from "../features/premium";
import { sendIndicatorAlert, sendWebhook } from "../lib/tauri";
import {
  compileAndRunScript,
  extractScriptInputs,
  finalizedScriptResult,
  newlyConfirmedScriptEvents,
  type CompiledMarker,
  type CompiledPlot,
  type CompiledScriptActivation,
  type ScriptInputValue
} from "./ScriptCompiler";
import {
  mergeCustomScriptOutput,
  nextCustomScriptProjectionRevision
} from "../scripts/customScriptLifecycle";
import { getMarketDataEngineAdapter } from "../market-data/engine/marketDataEngine";
import { ExchangeId, MarketDataAdapter, MarketDataSubscription, MarketSymbol, Timeframe } from "../market-data/types";
import {
  buildCandlesFromTrades,
  CandleAggregationEngine,
  isTradeBuiltTimeframe,
  requiresTradeSynthesis
} from "../market-data/aggregation/candleAggregator";
import { UnifiedExecutionTicket, type UnifiedExecutionTicketPreset } from "../execution/components/UnifiedExecutionTicket";
import { InteractionShield } from "./InteractionShield";
import type { ExecutionSource, OrderSide, OrderType } from "../execution/types";
import { requestUserText } from "../ui/requestUserText";
import type { OrderUpdate } from "../execution/types";
import { blackCorePositionManager } from "../positions/positionManager";
import type { ManagedPosition, PositionProtectionOrder, PositionProtectionType } from "../positions/types";
import {
  buildBybitProtectionDraft,
  buildBybitProtectionCancelDraft,
  formatSignedPositionMoney,
  isEditableNativeProtection,
  projectedLinearPositionPnl,
  quantizeProtectionPrice,
  type EditableProtectionType
} from "../positions/positionPresentation";
import { modifyVenueOrderViaApi, updateBybitPositionProtectionViaApi } from "../portfolio/portfolioApiClient";
import { AifIndicatorOverlay } from "../modules/aif/components/AifIndicatorOverlay";
import { QalcIndicatorOverlay } from "../modules/qalc-indicator/QalcIndicatorOverlay";
import { saveQalcStrategyHandoff } from "../modules/qalc-indicator/config";
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
import { resolveAuctionProfileReplayWindow } from "../modules/auction-profile/core/replay";
import type { AuctionProfileSettings, AuctionProfileSnapshot, CanonicalTrade } from "../modules/auction-profile/core/types";
import { retainCertifiedRadapSnapshots } from "../modules/auction-profile/core/stability";
import { canonicalCvdService, normalizeCanonicalTrade } from "../modules/auction-profile/data/tradeSource";
import { buildDDAProFlowInput } from "../modules/dda-pro/data/flowPressureSource";
import { AcvdWorkerClient } from "../modules/acvd/workers/AcvdWorkerClient";
import { DEFAULT_ACVD_SETTINGS, migrateAcvdSettings, stableHash as acvdStableHash } from "../modules/acvd/core/settings";
import type { AcvdSettings, AcvdSnapshot } from "../modules/acvd/core/types";
import { DEFAULT_CVD_OSCILLATOR_SETTINGS, migrateCvdOscillatorSettings } from "../modules/cvd-oscillator/core/settings";
import type { CvdOscillatorSettings } from "../modules/cvd-oscillator/core/types";
import { calculateMarketSentiment } from "../modules/market-sentiment/core/engine";
import { DEFAULT_MARKET_SENTIMENT_SETTINGS, migrateMarketSentimentSettings } from "../modules/market-sentiment/core/settings";
import type { MarketSentimentSettings } from "../modules/market-sentiment/core/types";
import { fetchPersistentAuthenticFlow, type PersistentFlowSnapshot } from "../modules/acvd/data/persistentFlowClient";
import { authenticFlowRevision, mergePersistentAndLiveFlow } from "../modules/acvd/data/flowMerge";
import { AuctionProfileWorkerClient } from "../modules/auction-profile/worker/AuctionProfileWorkerClient";
import { resolveAuctionVisualizationLayers } from "../modules/auction-profile/rendering/visualization";
import type { TradeTick } from "../market-data/types";
import {
  bclifPriceDisplayForRangeMode,
  liquidationFieldModelSettingsKey,
  migrateLiquidationFieldSettings,
  resolveLiquidationFieldRuntimeSettings
} from "../modules/liquidation-field/core/settings";
import type { LiquidationFieldRuntimeStatus, LiquidationFieldSettings, LiquidationFieldSnapshot } from "../modules/liquidation-field/core/types";
import { LiquidationFieldController, isBclifVisualFixtureEnabled } from "../modules/liquidation-field/data/LiquidationFieldController";
import { InMemoryBclifSnapshotStore } from "../modules/liquidation-field/data/BclifSnapshotStore";
import { LiquidationFieldSettingsPanel } from "../modules/liquidation-field/components/LiquidationFieldSettingsPanel";
import type { BclifRendererMetrics } from "../modules/liquidation-field/rendering/BlackCoreLiquidationFieldRenderer";
import { LiquidationFieldOverlays } from "../modules/liquidation-field/components/LiquidationFieldOverlays";
import {
  applyBclifVisualFixtureSettings,
  createBclifVisualChartCandles
} from "../modules/liquidation-field/testing/fixtures";
import {
  horizonLabel,
  horizonQualityLabel,
  loadHorizonCandleMode,
  migrateHorizonCandleMode,
  persistHorizonCandleMode
} from "../modules/horizon-candles/core/settings";
import type { HorizonCandleMode, HorizonDataQuality } from "../modules/horizon-candles/core/types";
import { createHorizonVisualFixture, isHorizonVisualFixtureEnabled } from "../modules/horizon-candles/testing/fixtures";

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
  onPriceTransformChange?: (transform: ChartPriceTransformSnapshot) => void;
  onCandleChange?: (candle: import("../chart-engine/types").Candle) => void;
  onReplayStatusChange?: (status: ReplayStatus) => void;
  onReplayStartSelected?: (selection: ReplaySelection) => void;
  customPlots?: CompiledPlot[];
  customMarkers?: CompiledMarker[];
  activeCustomScripts?: readonly CompiledScriptActivation[];
  onRemoveCustomScript?: (scriptId: string) => void;
  onToggleCustomScriptVisibility?: (scriptId: string) => void;
  onUpdateCustomScriptInputs?: (scriptId: string, values: Record<string, ScriptInputValue>) => { success: boolean; message?: string };
  onCandleReaderChange?: (reader: (() => Candle[]) | null) => void;
  onAlertFired?: (symbol: string, message: string) => void;
  priceLineColor?: string;
  priceLineIntensity?: number;
  activeOrders?: OrderUpdate[];
  onRefreshOrders?: () => void | Promise<unknown>;
  liquidationProfileRequested?: boolean;
  onLiquidationProfileSnapshotChange?: (snapshot: LiquidationFieldSnapshot | null) => void;
  onLiquidationProfileStatusChange?: (status: LiquidationFieldRuntimeStatus) => void;
  allowedIndicators: readonly string[];
};

type IndicatorKey = keyof VisibleIndicators;
type OscillatorResizeTarget =
  | { kind: "native"; key: OscillatorIndicatorKey }
  | { kind: "custom"; scriptId: string };
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

type DDAProFlowCaptureState = {
  venue: string;
  symbol: string;
  captureStartedAt: number | null;
  streamHealthy: boolean;
};

type PendingProtectionChange = {
  positionId: string;
  protectionId: string;
  type: EditableProtectionType;
  symbol: string;
  originalPrice: number;
  proposedPrice: number;
  phase: "dragging" | "confirming" | "submitting";
  error?: string;
};

type PendingOrderPriceChange = {
  order: OrderUpdate;
  orderKey: string;
  originalPrice: number;
  proposedPrice: number;
  phase: "dragging" | "confirming" | "submitting" | "synchronizing";
  error?: string;
};

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
  "3h": 10800,
  "4h": 14400,
  "6h": 21600,
  "8h": 28800,
  "12h": 43200,
  "1d": 86400,
  "1w": 604800,
  "1M": 2592000,
  "1t": 1,
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
  ema200: "EMA 200",
  ddaPro: "BC-RDA",
  acvd: "BC-ACVD",
  marketSentiment: "BC-MSO"
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

function isDraggableLimitOrder(order: OrderUpdate) {
  const type = String(order.orderType || order.type || "").trim().toLowerCase();
  return (type === "limit" || type === "post-only") &&
    ["pending", "accepted", "working", "partially-filled"].includes(order.status) &&
    Number.isFinite(order.price) && Number(order.price) > 0;
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
  onPriceTransformChange,
  onCandleChange,
  onReplayStatusChange,
  onReplayStartSelected,
  customPlots,
  customMarkers,
  activeCustomScripts = [],
  onRemoveCustomScript,
  onToggleCustomScriptVisibility,
  onUpdateCustomScriptInputs,
  onCandleReaderChange,
  onAlertFired,
  priceLineColor,
  priceLineIntensity,
  activeOrders = [],
  onRefreshOrders,
  liquidationProfileRequested = false,
  onLiquidationProfileSnapshotChange,
  onLiquidationProfileStatusChange,
  allowedIndicators
}: PixiBlackChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<BlackChartEngine | null>(null);
  const oscillatorResizeRef = useRef<{
    target: OscillatorResizeTarget;
    pointerId: number;
    startY: number;
    startHeight: number;
    maximumHeight: number;
  } | null>(null);
  const previousOscillatorVisibilityRef = useRef<Record<OscillatorIndicatorKey, boolean>>({
    openInterestOscillator: visibleIndicators.openInterestOscillator,
    ddaProOscillator: visibleIndicators.ddaProOscillator,
    acvdOscillator: visibleIndicators.acvdOscillator,
    cvdOscillator: visibleIndicators.cvdOscillator,
    marketSentimentOscillator: visibleIndicators.marketSentimentOscillator,
    zScoreOscillator: visibleIndicators.zScoreOscillator,
    waveTrendOscillator: visibleIndicators.waveTrendOscillator
  });
  const aifActiveRef = useRef(visibleIndicators.aif);
  const qalcActiveRef = useRef(visibleIndicators.qalc);
  const liquidationFieldActiveRef = useRef(visibleIndicators.liquidationHeatmap);
  const liquidationFieldOverlayVisibleRef = useRef(visibleIndicators.liquidationHeatmap);
  const [oscillatorHostHeight, setOscillatorHostHeight] = useState(600);
  const [lastPrice, setLastPrice] = useState(66678.1);
  const [lastCandle, setLastCandle] = useState<Candle | null>(null);
  const [customScriptFeedRevision, setCustomScriptFeedRevision] = useState(0);
  const handleCustomScriptFeedChange = useCallback(() => {
    setCustomScriptFeedRevision(nextCustomScriptProjectionRevision);
  }, []);
  const [aifPriceTransform, setAifPriceTransform] = useState<ChartPriceTransformSnapshot | null>(null);
  const [kioseffSnapshot, setKioseffSnapshot] = useState<KioseffSnapshot | null>(null);
  const [ddaProSnapshot, setDDAProSnapshot] = useState<DDAProSnapshot | null>(null);
  const [ddaProStatus, setDDAProStatus] = useState<"IDLE" | "CALCULATING" | "READY" | "UNAVAILABLE">("IDLE");
  const ddaProWorkerRef = useRef<DDAProWorkerClient | null>(null);
  const ddaCalculationIdentityRef = useRef("");
  const ddaDispatchedEventsRef = useRef(new Set<string>());
  const ddaConfiguredEventsRef = useRef(new Set<string>());
  const ddaSignalAlertArmedAtRef = useRef(new Map<string, number>());
  const [acvdSnapshot, setAcvdSnapshot] = useState<AcvdSnapshot | null>(null);
  const [acvdStatus, setAcvdStatus] = useState<"IDLE" | "CALCULATING" | "READY" | "UNAVAILABLE">("IDLE");
  const [acvdPersistentFlow, setAcvdPersistentFlow] = useState<PersistentFlowSnapshot | null>(null);
  const [acvdPersistentFlowError, setAcvdPersistentFlowError] = useState<string | null>(null);
  const acvdPersistentRequestRef = useRef("");
  const acvdWorkerRef = useRef<AcvdWorkerClient | null>(null);
  const acvdCalculationIdentityRef = useRef("");
  const acvdDispatchedSignalsRef = useRef(new Set<string>());
  const acvdConfiguredSignalsRef = useRef(new Set<string>());
  const acvdSignalAlertArmedAtRef = useRef(new Map<string, number>());
  const marketSentimentConfiguredEventsRef = useRef(new Set<string>());
  const marketSentimentAlertArmedAtRef = useRef(new Map<string, number>());
  const marketSentimentSettings = migrateMarketSentimentSettings({
    ...DEFAULT_MARKET_SENTIMENT_SETTINGS,
    ...indicatorAdvancedSettings.marketSentimentOscillator,
    lookback: indicatorPeriods.marketSentimentOscillator
  });
  const marketSentimentSettingsKey = JSON.stringify(marketSentimentSettings);
  const cvdAuthenticFlowRequested = visibleIndicators.cvdOscillator
    && migrateCvdOscillatorSettings({
      ...indicatorAdvancedSettings.cvdOscillator,
      lookback: indicatorPeriods.cvdOscillator
    }).useAuthenticAggressorFlow;
  const acvdRuntimeRequested = visibleIndicators.acvdOscillator || cvdAuthenticFlowRequested;
  const acvdRuntimeLookback = Math.max(
    visibleIndicators.acvdOscillator ? indicatorPeriods.acvdOscillator : 0,
    cvdAuthenticFlowRequested ? indicatorPeriods.cvdOscillator : 0
  );
  const [auctionProfileSnapshots, setAuctionProfileSnapshots] = useState<AuctionProfileSnapshot[]>([]);
  const auctionProfileSnapshotsRef = useRef<AuctionProfileSnapshot[]>([]);
  const auctionProfileSnapshot = auctionProfileSnapshots.at(-1) ?? null;
  const [auctionProfileLoading, setAuctionProfileLoading] = useState(false);
  const [auctionProfileError, setAuctionProfileError] = useState<string | null>(null);
  const [liquidationFieldSnapshot, setLiquidationFieldSnapshot] = useState<LiquidationFieldSnapshot | null>(null);
  const [liquidationFieldRendererMetrics, setLiquidationFieldRendererMetrics] = useState<BclifRendererMetrics | null>(null);
  const [liquidationFieldStatus, setLiquidationFieldStatus] = useState<LiquidationFieldRuntimeStatus>({
    state: "IDLE", message: "Awaiting activation", source: "NONE", lastInputAt: null, lifecycle: "UNMOUNTED"
  });
  const liquidationFieldControllerRef = useRef<LiquidationFieldController | null>(null);
  const liquidationFieldSnapshotStoreRef = useRef(new InMemoryBclifSnapshotStore());
  const [auctionProfileSourceRevision, setAuctionProfileSourceRevision] = useState(0);
  const [auctionProfileReplayCursor, setAuctionProfileReplayCursor] = useState<number | null>(null);
  const [ddaProSourceRevision, setDDAProSourceRevision] = useState(0);
  const [kioseffUnavailable, setKioseffUnavailable] = useState<KioseffUnavailableDiagnostic | null>(null);
  const [kioseffLoadState, setKioseffLoadState] = useState<KioseffLoadState>({ stage: "idle" });
  const [kioseffDiagnostics, setKioseffDiagnostics] = useState<KioseffRuntimeDiagnostics>(
    emptyKioseffRuntimeDiagnostics
  );
  const [kioseffSourceRevision, setKioseffSourceRevision] = useState(0);
  const kioseffCalculationVersion = kioseffCalculationSettingsHash(kioseffSettings);
  const normalizedAuctionProfileSettings = useMemo(() => migrateAuctionProfileSettings(auctionProfileSettings), [auctionProfileSettings]);
  const liquidationFieldSettings = useMemo(
    () => {
      const migrated = migrateLiquidationFieldSettings(indicatorAdvancedSettings.liquidationField);
      return isBclifVisualFixtureEnabled() ? applyBclifVisualFixtureSettings(migrated) : migrated;
    },
    [indicatorAdvancedSettings.liquidationField]
  );
  const patchLiquidationFieldSettings = (patch: Partial<LiquidationFieldSettings>) => {
    onIndicatorAdvancedSettingsChange((current) => ({
      ...current,
      liquidationField: migrateLiquidationFieldSettings({
        ...migrateLiquidationFieldSettings(current.liquidationField),
        ...patch,
        preset: "CUSTOM"
      })
    }));
  };
  const latestLiquidationFieldSettingsRef = useRef(liquidationFieldSettings);
  latestLiquidationFieldSettingsRef.current = liquidationFieldSettings;
  const latestAuctionProfileSettingsRef = useRef(normalizedAuctionProfileSettings);
  latestAuctionProfileSettingsRef.current = normalizedAuctionProfileSettings;
  const auctionDataRequired = resolveAuctionVisualizationLayers(
    visibleIndicators.auctionProfile,
    chartType === "volumeFootprint",
    normalizedAuctionProfileSettings.rendering.visualizationType
  ).dataRequired;
  const auctionProfileCalculationVersion = auctionProfileCalculationSettingsHash(normalizedAuctionProfileSettings);
  const debouncedAuctionProfileCalculationVersion = useDebouncedValue(auctionProfileCalculationVersion, 220);
  const auctionProfileReplayRevision = replayControls.enabled
    ? replayControls.selecting
      ? "replay-selecting"
      : `replay-${auctionProfileReplayCursor ?? "pending"}`
    : "live";
  const auctionProfileDataRevision = normalizedAuctionProfileSettings.compositeLocked
    ? "locked:" + debouncedAuctionProfileCalculationVersion
    : `chart:${auctionProfileSourceRevision}:${auctionProfileReplayRevision}`;
  const [dataStatus, setDataStatus] = useState("CONNECTING");
  const [chartHistoryState, setChartHistoryState] = useState<
    "loading" | "ready" | "unavailable"
  >("loading");
  const [horizonPreferences, setHorizonPreferences] = useState<HorizonCandleMode>(loadHorizonCandleMode);
  const [horizonDataQuality, setHorizonDataQuality] = useState<HorizonDataQuality>("degraded");
  const [horizonCoverageRatio, setHorizonCoverageRatio] = useState(0);
  const [horizonSettingsOpen, setHorizonSettingsOpen] = useState(false);
  const horizonSourceQualityRef = useRef<HorizonDataQuality>("degraded");
  const horizonSettings = useMemo(() => migrateHorizonCandleMode({
    ...horizonPreferences,
    enabled: chartType === "horizon",
    dataQuality: horizonDataQuality
  }), [chartType, horizonDataQuality, horizonPreferences]);
  const sourceTimeframe: Timeframe = chartType === "horizon" ? "1s" : timeframe;
  const horizonExpectedSamples = Math.min(100_000, Math.round(horizonSettings.displayHorizonMs / 1000));
  const [activeIndicator, setActiveIndicator] = useState<IndicatorKey | null>(null);
  const [activeCustomScriptSettingsId, setActiveCustomScriptSettingsId] = useState<string | null>(null);
  const [volumeProfileSettingsTab, setVolumeProfileSettingsTab] = useState<VolumeProfileSettingsTab>("inputs");
  const [adaptiveSwingSettingsTab, setAdaptiveSwingSettingsTab] = useState<AdaptiveSwingSettingsTab>("signals");
  const [historyDepth, setHistoryDepth] = useState<HistoryDepth>(() => {
    const configuredDepth = Number(indicatorAdvancedSettings.volumeProfile?.fixedRangeLength ?? 5000);
    if (configuredDepth >= 20000) return 20000;
    if (configuredDepth >= 10000) return 10000;
    return 5000;
  });
  const maxRetainedChartBars = chartType === "horizon" ? 100_000 : MAX_RETAINED_CHART_BARS;
  const marketHistoryTarget = Math.min(maxRetainedChartBars, Math.max(
    historyDepth,
    chartType === "horizon" ? horizonExpectedSamples : 0,
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
  const [pendingProtectionChange, setPendingProtectionChange] = useState<PendingProtectionChange | null>(null);
  const [pendingOrderPriceChange, setPendingOrderPriceChange] = useState<PendingOrderPriceChange | null>(null);
  const [confirmedOrderPrices, setConfirmedOrderPrices] = useState<Record<string, number>>({});
  const [positionOverlayTick, setPositionOverlayTick] = useState(0);
  const [alertToast, setAlertToast] = useState<AlertToast | null>(null);
  const [editingChartAlertId, setEditingChartAlertId] = useState<string | null>(null);
  const replaySourceRef = useRef<Candle[]>([]);
  const replayControlsRef = useRef(replayControls);
  const replayStatusCallbackRef = useRef(onReplayStatusChange);
  const replaySelectionCallbackRef = useRef(onReplayStartSelected);
  const priceTransformCallbackRef = useRef(onPriceTransformChange);
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
  const auctionReplayRefreshTimerRef = useRef<number | undefined>(undefined);
  const pendingAuctionReplayCursorRef = useRef<number | null>(null);
  const ddaFlowRefreshTimerRef = useRef<number | undefined>(undefined);
  const ddaFlowCaptureRef = useRef<DDAProFlowCaptureState>({
    venue: marketSymbol.exchange,
    symbol: marketSymbol.rawSymbol,
    captureStartedAt: null,
    streamHealthy: false
  });
  const replayAppliedRef = useRef(false);
  const alertSettingsRef = useRef(alertSettings);
  const lastAlertSentAtRef = useRef(new Map<string, number>());
  const configuredAlertRuntimeRef = useRef(new Map<string, { lastFiredAt: number; fired: boolean }>());
  const candleReaderCallbackRef = useRef(onCandleReaderChange);
  const customScriptAlertRuntimeRef = useRef(new Map<string, {
    key: string;
    armedAfter: number;
    lastOpenTime: number;
    delivered: Set<string>;
  }>());
  const alertToastTimerRef = useRef<number | undefined>(undefined);
  candleReaderCallbackRef.current = onCandleReaderChange;
  aifActiveRef.current = visibleIndicators.aif;
  qalcActiveRef.current = visibleIndicators.qalc;
  const liquidationFieldRequested = visibleIndicators.liquidationHeatmap || liquidationProfileRequested;
  const liquidationFieldRuntimeSettings = useMemo(
    () => resolveLiquidationFieldRuntimeSettings(liquidationFieldSettings, {
      liquidationProfileRequested,
      liquidationHeatmapVisible: visibleIndicators.liquidationHeatmap
    }),
    [liquidationFieldSettings, liquidationProfileRequested, visibleIndicators.liquidationHeatmap]
  );
  const liquidationFieldRuntimeCalculationKey = liquidationFieldModelSettingsKey(liquidationFieldRuntimeSettings);
  liquidationFieldActiveRef.current = liquidationFieldRequested;
  liquidationFieldOverlayVisibleRef.current = visibleIndicators.liquidationHeatmap;

  useEffect(() => {
    onLiquidationProfileSnapshotChange?.(liquidationFieldSnapshot);
  }, [liquidationFieldSnapshot, onLiquidationProfileSnapshotChange]);

  useEffect(() => {
    onLiquidationProfileStatusChange?.(liquidationFieldStatus);
  }, [liquidationFieldStatus, onLiquidationProfileStatusChange]);

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
      pnl?: number | null;
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
      .map((line) => {
        const previewPrice = line.protection && pendingProtectionChange?.positionId === activeChartPosition.id && pendingProtectionChange.protectionId === line.protection.id
          ? pendingProtectionChange.proposedPrice
          : line.price;
        return {
          ...line,
          price: previewPrice,
          pnl: line.tone === "entry" ? activeChartPosition.unrealizedPnl : projectedLinearPositionPnl(activeChartPosition, previewPrice),
          y: engineRef.current?.getScreenYForPrice(previewPrice) ?? null
        };
      })
      .filter((line) => line.y !== null);
  }, [activeChartPosition, pendingProtectionChange, positionOverlayTick]);

  const activeChartOrders = useMemo(() => {
    const chartSymbol = normalizeChartSymbol(displaySymbol || marketSymbol.rawSymbol);
    return deduplicateCanonicalOrders(activeOrders).orders
      .filter((order) => ["pending", "accepted", "working", "partially-filled"].includes(order.status))
      .filter((order) => normalizeChartSymbol(order.normalizedSymbol || order.symbol) === chartSymbol)
      .filter((order) => !marketSymbol.exchange || order.exchange === marketSymbol.exchange)
      .filter((order) => Number.isFinite(order.price) && Number(order.price) > 0);
  }, [activeOrders, displaySymbol, marketSymbol.exchange, marketSymbol.rawSymbol]);

  const chartOrderLines = useMemo(() => activeChartOrders
    .map((order) => {
      const orderKey = canonicalOrderKey(order);
      const price = pendingOrderPriceChange?.orderKey === orderKey
        ? pendingOrderPriceChange.proposedPrice
        : confirmedOrderPrices[orderKey] ?? Number(order.price);
      return { order, orderKey, price, y: engineRef.current?.getScreenYForPrice(price) ?? null };
    })
    .filter((line) => line.y !== null), [activeChartOrders, confirmedOrderPrices, pendingOrderPriceChange, positionOverlayTick]);

  useEffect(() => blackCorePositionManager.subscribe(setManagedPositions), []);

  useEffect(() => {
    setConfirmedOrderPrices((current) => {
      const keys = Object.keys(current);
      if (keys.length === 0) return current;
      const next = { ...current };
      let changed = false;
      for (const key of keys) {
        const order = activeChartOrders.find((candidate) => canonicalOrderKey(candidate) === key);
        if (!order || Math.abs(Number(order.price) - current[key]) < 1e-9) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [activeChartOrders]);

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

  const publishAuctionProfileReplayCursor = (cursor: number | null, immediate = false) => {
    pendingAuctionReplayCursorRef.current = cursor;
    if (!auctionDataRequired) return;
    const publish = () => {
      auctionReplayRefreshTimerRef.current = undefined;
      const pending = pendingAuctionReplayCursorRef.current;
      setAuctionProfileReplayCursor(current => current === pending ? current : pending);
    };
    if (immediate) {
      if (auctionReplayRefreshTimerRef.current) window.clearTimeout(auctionReplayRefreshTimerRef.current);
      publish();
      return;
    }
    if (!auctionReplayRefreshTimerRef.current) {
      // Replay can advance at 20x. Coalesce cursor changes so the worker sees
      // the newest causal prefix at a bounded cadence instead of spawning a
      // rebuild for every intermediate frame.
      auctionReplayRefreshTimerRef.current = window.setTimeout(publish, 250);
    }
  };

  const computeReplayStartIndex = () => {
    const source = replaySourceRef.current;
    if (source.length === 0) return 0;
    const { selectedIndex, startPercent } = replayControlsRef.current;
    if (selectedIndex !== undefined) return clampNumber(selectedIndex, 0, source.length - 1);

    return clampNumber(Math.round((source.length - 1) * (startPercent / 100)), 0, source.length - 1);
  };

  const applyReplayCursor = (index: number, resetView = false, refreshRadapImmediately = false) => {
    const engine = engineRef.current;
    const source = replaySourceRef.current;
    if (!engine || source.length === 0) {
      emitReplayStatus(true, false);
      return;
    }

    const cursor = clampNumber(index, 0, source.length - 1);
    replayCursorRef.current = cursor;
    publishAuctionProfileReplayCursor(cursor, refreshRadapImmediately);
    engine.setCandles(source.slice(0, cursor + 1), {
      preserveView: !resetView,
      heatmapSource: source,
      heatmapUntilIndex: cursor
    });
    setDataStatus(`REPLAY ${formatReplayLabel(source[cursor]?.time)} - ${cursor + 1}/${source.length}`);
    emitReplayStatus(true, replayControlsRef.current.playing && cursor < source.length - 1);
  };

  const setReplaySource = (candles: Candle[]) => {
    replaySourceRef.current = uniqueSortedCandles(candles).slice(-maxRetainedChartBars);
    if (chartType === "horizon") {
      const coverage = Math.min(1, replaySourceRef.current.length / Math.max(1, horizonExpectedSamples));
      setHorizonCoverageRatio(coverage);
      const sourceQuality = horizonSourceQualityRef.current;
      setHorizonDataQuality(sourceQuality === "native-trades" && coverage < 0.995 ? "degraded" : sourceQuality);
    }
    setKioseffSourceRevision((revision) => revision + 1);
    setAuctionProfileSourceRevision((revision) => revision + 1);
    setDDAProSourceRevision((revision) => revision + 1);
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
      applyReplayCursor(replayStartIndexRef.current, true, true);
    } else {
      emitReplayStatus(false, false);
    }
  };

  const upsertReplaySourceCandle = (candle: Candle) => {
    const source = replaySourceRef.current;
    const last = source[source.length - 1];
    if (last && candle.time < last.time) return;
    const historyAdvanced = shouldRefreshKioseffHistory(last?.time, candle.time);

    if (last?.time === candle.time) {
      source[source.length - 1] = candle;
    } else {
      source.push(candle);
      const overflow = source.length - maxRetainedChartBars;
      if (overflow > 0) source.splice(0, overflow);
    }
    if (chartType === "horizon" && horizonSourceQualityRef.current === "native-trades") {
      const coverage = Math.min(1, source.length / Math.max(1, horizonExpectedSamples));
      setHorizonCoverageRatio(coverage);
      setHorizonDataQuality(coverage >= 0.995 ? "native-trades" : "degraded");
    }
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

    const bucket = Math.floor(time / timeframeSeconds[sourceTimeframe]) * timeframeSeconds[sourceTimeframe];
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
    priceTransformCallbackRef.current = onPriceTransformChange;
  }, [onPriceTransformChange]);

  useEffect(() => {
    engineRef.current?.setReplaySelectionMode(
      replayControls.enabled && replayControls.selecting,
      (selection) => replaySelectionCallbackRef.current?.(selection)
    );
  }, [replayControls.enabled, replayControls.selecting]);

  useEffect(() => {
    let disposed = false;
    let initialized = false;
    let releaseBclifSnapshotReplay: (() => void) | undefined;
    let liveCandles: MarketDataSubscription<unknown> | undefined;
    let liveTrades: MarketDataSubscription<unknown> | undefined;
    let tradePollTimer: number | undefined;
    let tickerHeartbeatTimer: number | undefined;
    let chartUiPublishTimer: number | undefined;
    let pendingUiPrice: number | undefined;
    let pendingUiCandle: Candle | undefined;
    let tradePollingStarted = false;
    let tradeStreamActive = false;
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
    const tradeCandleBuilder = new CandleAggregationEngine();
    const tradeBuiltTimeframe = isTradeBuiltTimeframe(sourceTimeframe);
    const tradeSynthesizedTimeframe = requiresTradeSynthesis(sourceTimeframe);
    const host = hostRef.current;
    if (!host) return;
    const flushChartUiState = () => {
      chartUiPublishTimer = undefined;
      if (disposed) return;
      if (pendingUiPrice !== undefined) {
        const price = pendingUiPrice;
        pendingUiPrice = undefined;
        setLastPrice(price);
        onPriceChange?.(price);
      }
      if (pendingUiCandle) {
        const candle = pendingUiCandle;
        pendingUiCandle = undefined;
        setLastCandle(candle);
        onCandleChange?.(candle);
      }
    };
    const scheduleChartUiState = () => {
      if (chartUiPublishTimer !== undefined) return;
      chartUiPublishTimer = window.setTimeout(flushChartUiState, 50);
    };
    const bclifVisualFixture = isBclifVisualFixtureEnabled();
    const horizonVisualFixture = chartType === "horizon" && isHorizonVisualFixtureEnabled();
    const adapter = bclifVisualFixture || horizonVisualFixture ? undefined : getMarketDataEngineAdapter(marketSymbol.exchange);
    const allowSimulatedFallback =
      bclifVisualFixture || marketSymbol.exchange === "mock" || import.meta.env.VITE_ALLOW_SIMULATED_MARKET_FALLBACK === "true";
    replaySourceRef.current = [];
    if (chartType === "horizon") {
      horizonSourceQualityRef.current = "degraded";
      setHorizonDataQuality("degraded");
      setHorizonCoverageRatio(0);
    }
    ddaFlowCaptureRef.current = {
      venue: marketSymbol.exchange,
      symbol: marketSymbol.rawSymbol,
      captureStartedAt: null,
      streamHealthy: false
    };
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
    synthesizeCandlesFromTrades = tradeSynthesizedTimeframe || !adapter?.subscribeCandles;

    const chartQuery = {
      exchange: marketSymbol.exchange,
      symbol: marketSymbol.rawSymbol,
      timeframe: sourceTimeframe,
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
          timeframe: sourceTimeframe,
          marketKind: marketSymbol.marketKind,
          limit: Math.min(sourcePageLimit, remaining),
          to: cursor ? cursor - 1 : undefined
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
          timeframe: sourceTimeframe,
          marketKind: marketSymbol.marketKind,
          limit: pageLimitFor(historyExchange),
          to: oldestTime - 1
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
          ]).slice(-maxRetainedChartBars);
          if (replayActiveRef.current) {
            setDataStatus("REPLAY HISTORY EXTENDED");
            return;
          }

          engineRef.current?.prependCandles(olderCandles);
          setDDAProSourceRevision((revision) => revision + 1);
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

    const scheduleDDAFlowRefresh = () => {
      if (ddaFlowRefreshTimerRef.current) return;
      ddaFlowRefreshTimerRef.current = window.setTimeout(() => {
        ddaFlowRefreshTimerRef.current = undefined;
        setDDAProSourceRevision((revision) => revision + 1);
      }, 250);
    };

    const setDDAFlowStreamHealth = (streamHealthy: boolean) => {
      ddaFlowCaptureRef.current = {
        venue: marketSymbol.exchange,
        symbol: marketSymbol.rawSymbol,
        captureStartedAt: streamHealthy ? Date.now() / 1000 : null,
        streamHealthy
      };
      scheduleDDAFlowRefresh();
    };

    const ingestTrades = (trades: TradeTick[]) => {
      const newTrades = trades.filter((trade) => !seenTrades.has(trade.tradeId));
      if (tradeStreamActive && newTrades.length > 0 && !ddaFlowCaptureRef.current.streamHealthy) {
        const firstReceivedAt = Math.min(...newTrades.map((trade) =>
          Number.isFinite(trade.receivedAt) ? Number(trade.receivedAt) : Date.now() / 1000
        ));
        ddaFlowCaptureRef.current = {
          venue: marketSymbol.exchange,
          symbol: marketSymbol.rawSymbol,
          captureStartedAt: firstReceivedAt,
          streamHealthy: true
        };
        scheduleDDAFlowRefresh();
      }
      const canonicalTrades = newTrades.map(normalizeCanonicalTrade);
      const acceptedCanonicalTrades = canonicalCvdService.ingest(canonicalTrades);
      if (acceptedCanonicalTrades > 0) scheduleDDAFlowRefresh();
      const auctionHistory = auctionTradeHistoryRef.current;
      if (canonicalTrades.length >= 250_000) {
        auctionHistory.length = 0;
        auctionHistory.push(...canonicalTrades.slice(-250_000));
      } else {
        const overflow = auctionHistory.length + canonicalTrades.length - 250_000;
        if (overflow > 0) auctionHistory.splice(0, Math.min(auctionHistory.length, Math.max(overflow, 4_096)));
        auctionHistory.push(...canonicalTrades);
      }
      if (auctionDataRequired && !replayActiveRef.current && !normalizedAuctionProfileSettings.compositeLocked && auctionWorkerRef.current && canonicalTrades.length) {
        auctionTradeBufferRef.current.push(...canonicalTrades);
        if (!auctionTradeFlushTimerRef.current) {
          auctionTradeFlushTimerRef.current = window.setTimeout(() => {
            auctionTradeFlushTimerRef.current = undefined;
            const buffered = auctionTradeBufferRef.current.splice(0);
            const client = auctionWorkerRef.current;
            if (replayActiveRef.current || !client || !buffered.length) return;
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
        engineRef.current?.ingestCausalRenkoTrade(trade.price, trade.quantity, trade.time, trade.tradeId);
        if (tradeBuiltTimeframe) {
          const aggregated = tradeCandleBuilder.ingestTrade(trade, sourceTimeframe);
          if (!aggregated) continue;
          upsertReplaySourceCandle(aggregated.candle);
          if (replayActiveRef.current) continue;
          engineRef.current?.upsertCandle(aggregated.candle);
          continue;
        }
        if (synthesizeCandlesFromTrades || candleStreamIsStale()) {
          ingestTradeIntoReplaySource(trade.price, trade.quantity, trade.time);
          if (replayActiveRef.current) continue;
          engineRef.current?.ingestTrade(trade.price, trade.quantity, trade.time, timeframeSeconds[sourceTimeframe]);
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
      if (tradeBuiltTimeframe) {
        if (!replayActiveRef.current) engineRef.current?.updateLastPrice(price);
        return;
      }
      ingestTradeIntoReplaySource(price, 0, time);
      if (replayActiveRef.current) return;
      engineRef.current?.ingestTrade(price, 0, time, timeframeSeconds[sourceTimeframe]);
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
      if (chartType === "horizon") {
        horizonSourceQualityRef.current = "synthetic-1s";
        setHorizonDataQuality("synthetic-1s");
      }
      mockSeedPrice = safeAnchorPrice(anchorPrice);
      setDataStatus("MOCK FALLBACK");
      const mockCandles = createMockCandles(historyDepth, timeframeSeconds[sourceTimeframe], mockSeedPrice);
      chartSourceVenueRef.current = "mock";
      setReplaySource(mockCandles);
      if (!replayActiveRef.current) {
        engine.setCandles(mockCandles);
        engine.startMockFeed(timeframeSeconds[sourceTimeframe], onEvent);
      }

      if (adapter?.subscribeTrades && !liveTrades) {
        liveTrades = adapter.subscribeTrades(marketSymbol, (trade) => {
          if (disposed) return;
          const driftFromSeed = mockSeedPrice ? Math.abs(trade.price - mockSeedPrice) / mockSeedPrice : 0;
          if (driftFromSeed > 0.035) {
            mockSeedPrice = trade.price;
            const nextMockCandles = createMockCandles(historyDepth, timeframeSeconds[sourceTimeframe], mockSeedPrice);
            setReplaySource(nextMockCandles);
            if (!replayActiveRef.current) engine.setCandles(nextMockCandles);
          }
          ingestTrades([trade]);
        });
        tradeStreamActive = Boolean(liveTrades);

        liveTrades.onError((err) => {
          console.error(`${adapter.label} fallback trade stream failed`, err);
          tradeStreamActive = false;
          setDDAFlowStreamHealth(false);
          startTradePolling();
        });
      } else {
        startTradePolling();
      }

      startTickerHeartbeat();
    };

    const startPrimaryLiveFeeds = () => {
      if (!adapter || disposed) return;

      liveCandles = tradeSynthesizedTimeframe
        ? undefined
        : adapter.subscribeCandles?.({ ...chartQuery, limit: pageLimit }, (candle) => {
            lastLiveCandleAt = Date.now();
            upsertReplaySourceCandle(candle);
            if (replayActiveRef.current) return;
            engine.upsertCandle(candle);
          });

      liveTrades = adapter.subscribeTrades?.(marketSymbol, (trade) => {
        ingestTrades([trade]);
      });

      if (!liveTrades) {
        tradeStreamActive = false;
        setDDAFlowStreamHealth(false);
        startTradePolling();
      } else {
        tradeStreamActive = true;
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
        tradeStreamActive = false;
        setDDAFlowStreamHealth(false);
        liveTrades?.unsubscribe();
        liveTrades = undefined;
        startTradePolling();
      });
    };

    const loadTradeBuiltHistory = async () => {
      if (!adapter?.getRecentTrades) throw new Error(`${adapter?.label ?? "Market"} does not provide public trades`);
      const trades = await adapter.getRecentTrades(marketSymbol, 1_000);
      const candles = buildCandlesFromTrades(trades, sourceTimeframe, tradeCandleBuilder);
      const canonicalTrades = trades.map(normalizeCanonicalTrade);
      canonicalCvdService.ingest(canonicalTrades);
      auctionTradeHistoryRef.current.push(...canonicalTrades);
      if (auctionTradeHistoryRef.current.length > 250_000) {
        auctionTradeHistoryRef.current.splice(0, auctionTradeHistoryRef.current.length - 250_000);
      }
      for (const trade of trades) {
        if (seenTrades.has(trade.tradeId)) continue;
        seenTrades.add(trade.tradeId);
        seenTradeOrder.push(trade.tradeId);
      }
      lastTradeAt = trades.length ? Date.now() : 0;
      if (candles.length) return candles;

      const ticker = await adapter.getTickerSnapshot?.(marketSymbol);
      if (!ticker?.lastPrice) throw new Error(`${adapter.label} returned no recent trades or ticker seed`);
      const seedTime = Number(ticker.time || Math.floor(Date.now() / 1000));
      return [{
        time: tradeBuiltTimeframe ? seedTime : Math.floor(seedTime / timeframeSeconds[sourceTimeframe]) * timeframeSeconds[sourceTimeframe],
        open: ticker.lastPrice,
        high: ticker.lastPrice,
        low: ticker.lastPrice,
        close: ticker.lastPrice,
        volume: 0
      }];
    };

    const engine = new BlackChartEngine({
      host,
      candles: horizonVisualFixture
        ? createHorizonVisualFixture(horizonExpectedSamples)
        : !adapter && allowSimulatedFallback
        ? bclifVisualFixture
          ? createBclifVisualChartCandles(marketHistoryTarget, timeframeSeconds[sourceTimeframe])
          : createMockCandles(historyDepth, timeframeSeconds[sourceTimeframe], lastPrice)
        : [],
      chartType,
      horizonSettings,
      snapToLatest,
      visibleIndicators,
      indicatorPeriods,
      indicatorVisualSettings,
      indicatorAdvancedSettings,
      kioseffSettings,
      alertDefinitions: scopedChartAlerts,
      customPlots: customPlots || [],
      customMarkers: customMarkers || [],
      onAlertFired: (alertId, price) => onAlertFired?.(alertId, price),
      auctionProfileSettings: normalizedAuctionProfileSettings,
      auctionProfileSnapshots,
      ddaProSnapshot,
      acvdSnapshot,
      onAlertEditRequest: (alertId) => {
        setEditingChartAlertId(alertId);
        setChartContextMenu(null);
        onOpenAlerts?.();
      },
      onNeedMoreHistory: (oldestCandle) => loadOlderHistory(oldestCandle.time),
      onPriceChange: (price) => {
        pendingUiPrice = price;
        scheduleChartUiState();
      },
      onCandleChange: (candle) => {
        pendingUiCandle = candle;
        scheduleChartUiState();
      },
      onScriptFeedChange: handleCustomScriptFeedChange,
      onPriceTransformChange: (transform) => {
        if (aifActiveRef.current || qalcActiveRef.current || liquidationFieldActiveRef.current) setAifPriceTransform(transform);
        priceTransformCallbackRef.current?.(transform);
      },
      onLiquidationRendererMetrics: setLiquidationFieldRendererMetrics,
      priceLineColor,
      priceLineIntensity
    });
    engineRef.current = engine;
    candleReaderCallbackRef.current?.(() => engine.getCustomScriptCandles());
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
        releaseBclifSnapshotReplay = liquidationFieldSnapshotStoreRef.current.subscribe((snapshot) => {
          if (disposed || !liquidationFieldActiveRef.current) return;
          setLiquidationFieldSnapshot(snapshot);
          engine.setLiquidationFieldState(
            liquidationFieldOverlayVisibleRef.current ? snapshot : null,
            latestLiquidationFieldSettingsRef.current
          );
        });

        if (horizonVisualFixture) {
          horizonSourceQualityRef.current = "synthetic-1s";
          const candles = createHorizonVisualFixture(horizonExpectedSamples);
          chartSourceVenueRef.current = "mock";
          setReplaySource(candles);
          setHorizonDataQuality("synthetic-1s");
          setChartHistoryState("ready");
          if (!replayActiveRef.current) engine.setCandles(candles);
          setDataStatus(`HORIZON VISUAL FIXTURE - ${candles.length.toLocaleString()} TRUE 1S SAMPLES`);
          return;
        }

        if (bclifVisualFixture) {
          if (chartType === "horizon") horizonSourceQualityRef.current = "synthetic-1s";
          const candles = createBclifVisualChartCandles(marketHistoryTarget, timeframeSeconds[sourceTimeframe]);
          chartSourceVenueRef.current = marketSymbol.exchange;
          setReplaySource(candles);
          setChartHistoryState("ready");
          setDataStatus(`BCLIF VISUAL FIXTURE - ${candles.length.toLocaleString()} BARS`);
          return;
        }

        if (!adapter) {
          if (allowSimulatedFallback) startMockFallback();
          else {
            if (chartType === "horizon") {
              horizonSourceQualityRef.current = "degraded";
              setHorizonDataQuality("degraded");
            }
            setDataStatus("MARKET DATA UNAVAILABLE - NO ADAPTER");
            setChartHistoryState("unavailable");
          }
          return;
        }

        if (tradeBuiltTimeframe) {
          historyExhausted = true;
          setDataStatus(`${adapter.label.toUpperCase()} TRADE HISTORY`);
          return loadTradeBuiltHistory()
            .then((candles) => {
              if (disposed) return;
              if (chartType === "horizon") horizonSourceQualityRef.current = "native-trades";
              chartSourceVenueRef.current = marketSymbol.exchange;
              setReplaySource(candles);
              setChartHistoryState("ready");
              if (!replayActiveRef.current) engine.setCandles(candles);
              setDataStatus(`${adapter.label.toUpperCase()} LIVE TRADE BARS - ${candles.length.toLocaleString()} BARS`);
              startPrimaryLiveFeeds();
            })
            .catch((err: unknown) => {
              console.error(`${adapter.label} trade-built history failed`, err);
              if (chartType === "horizon") {
                horizonSourceQualityRef.current = "degraded";
                setHorizonDataQuality("degraded");
              }
              setDataStatus(`${adapter.label.toUpperCase()} LIVE - TRADE HISTORY UNAVAILABLE`);
              setChartHistoryState("unavailable");
              startPrimaryLiveFeeds();
            });
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
      candleReaderCallbackRef.current?.(null);
      releaseBclifSnapshotReplay?.();
      liveCandles?.unsubscribe();
      liveTrades?.unsubscribe();
      if (tradePollTimer) window.clearInterval(tradePollTimer);
      if (tickerHeartbeatTimer) window.clearInterval(tickerHeartbeatTimer);
      if (chartUiPublishTimer !== undefined) window.clearTimeout(chartUiPublishTimer);
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
      if (ddaFlowRefreshTimerRef.current) {
        window.clearTimeout(ddaFlowRefreshTimerRef.current);
        ddaFlowRefreshTimerRef.current = undefined;
      }
      if (auctionReplayRefreshTimerRef.current) {
        window.clearTimeout(auctionReplayRefreshTimerRef.current);
        auctionReplayRefreshTimerRef.current = undefined;
      }
      pendingAuctionReplayCursorRef.current = null;
      const capture = ddaFlowCaptureRef.current;
      if (capture.venue === marketSymbol.exchange && capture.symbol === marketSymbol.rawSymbol) {
        ddaFlowCaptureRef.current = { ...capture, captureStartedAt: null, streamHealthy: false };
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
    sourceTimeframe,
    chartType,
    horizonSettings.displayHorizonMs,
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
    const replayWindow = resolveAuctionProfileReplayWindow(
      replaySourceRef.current,
      normalizedAuctionProfileSettings.lookbackBars,
      {
        enabled: replayControls.enabled,
        selecting: replayControls.selecting,
        cursor: auctionProfileReplayCursor ?? replayCursorRef.current
      },
      timeframeSeconds[timeframe]
    );
    const bars = replayWindow.bars;
    const start = bars[0]?.time ?? 0;
    const interval = bars.length > 1 ? Math.max(1, bars[bars.length - 1]!.time - bars[bars.length - 2]!.time) : timeframeSeconds[timeframe];
    const end = replayWindow.cutoffEnd ?? (bars[bars.length - 1]?.time ?? 0) + interval - 1;
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
      sourceRevision: auctionProfileDataRevision,
      now: replayWindow.replayBounded && replayWindow.cutoffEnd !== null
        ? replayWindow.cutoffEnd * 1_000
        : Date.now()
    }).then(snapshots => {
      if (disposed) return;
      const retained = retainCertifiedRadapSnapshots(
        auctionProfileSnapshotsRef.current,
        snapshots,
        replayWindow.replayBounded ? replayWindow.cutoffEnd ?? undefined : undefined
      );
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
      publishAuctionProfileReplayCursor(null, true);
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
      publishAuctionProfileReplayCursor(null, true);
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
        applyReplayCursor(replayStartIndexRef.current, true, true);
      }
      replayAppliedRef.current = true;
    } else {
      applyReplayCursor(replayCursorRef.current, false, true);
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
    persistHorizonCandleMode(horizonPreferences);
  }, [horizonPreferences]);

  useEffect(() => {
    engineRef.current?.setHorizonSettings(horizonSettings);
  }, [horizonSettings]);

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
    return () => {
      ddaProWorkerRef.current?.dispose();
      ddaProWorkerRef.current = null;
      acvdWorkerRef.current?.dispose();
      acvdWorkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const engine = engineRef.current;
    const timeframeDuration = timeframeSeconds[timeframe];
    if (!acvdRuntimeRequested || !engine || marketSymbol.exchange.toLowerCase() !== "bybit" || timeframeDuration < 60 || timeframeDuration % 60 !== 0) {
      acvdPersistentRequestRef.current = "";
      setAcvdPersistentFlow(null);
      setAcvdPersistentFlowError(null);
      return;
    }
    const lookback = migrateAcvdSettings({ ...indicatorAdvancedSettings.acvdOscillator, lookback: acvdRuntimeLookback }).lookback;
    const source = engine.getSourceCandles().slice(-lookback);
    if (source.length < 2) return;
    const end = source.at(-1)!.time + timeframeDuration;
    const start = Math.max(60, end - lookback * timeframeDuration);
    const identity = `${marketSymbol.exchange}:${marketSymbol.rawSymbol}:${timeframeDuration}:${start}:${end}`;
    if (acvdPersistentRequestRef.current === identity) return;
    acvdPersistentRequestRef.current = identity;
    setAcvdPersistentFlowError(null);
    const controller = new AbortController();
    setAcvdPersistentFlow((current) => current
      && current.venue === marketSymbol.exchange.toUpperCase()
      && current.symbol === marketSymbol.rawSymbol.toUpperCase()
      && current.timeframeSeconds === timeframeDuration
      ? current
      : null);
    const requestTimer = window.setTimeout(() => {
      void fetchPersistentAuthenticFlow({
        venue: marketSymbol.exchange,
        symbol: marketSymbol.rawSymbol,
        timeframeSeconds: timeframeDuration,
        start,
        end,
        signal: controller.signal
      }).then((snapshot) => {
        if (acvdPersistentRequestRef.current !== identity) return;
        setAcvdPersistentFlow(snapshot);
      }).catch((error: unknown) => {
        if (controller.signal.aborted || acvdPersistentRequestRef.current !== identity) return;
        acvdPersistentRequestRef.current = "";
        setAcvdPersistentFlowError(error instanceof Error ? error.message : "Authentic flow archive could not be loaded.");
      });
    }, 450);
    return () => {
      window.clearTimeout(requestTimer);
      controller.abort();
    };
  }, [
    acvdRuntimeRequested,
    acvdRuntimeLookback,
    indicatorPeriods.acvdOscillator,
    indicatorAdvancedSettings.acvdOscillator,
    marketSymbol.exchange,
    marketSymbol.rawSymbol,
    timeframe,
    lastCandle?.time
  ]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!acvdRuntimeRequested || !engine) {
      acvdCalculationIdentityRef.current = "";
      setAcvdSnapshot(null);
      setAcvdStatus("IDLE");
      engine?.setAcvdState(null);
      return;
    }
    const timer = window.setTimeout(() => {
      const settings = migrateAcvdSettings({
        ...indicatorAdvancedSettings.acvdOscillator,
        lookback: acvdRuntimeLookback,
        realtimeMode: cvdAuthenticFlowRequested ? "DEVELOPING_PREVIEW" : indicatorAdvancedSettings.acvdOscillator.realtimeMode
      });
      const timeframeDuration = timeframeSeconds[timeframe];
      const available = engine.getSourceCandles().slice(-settings.lookback);
      const latestIsDeveloping = Boolean(available.length && (available.at(-1)?.time ?? 0) + timeframeDuration > Date.now() / 1000);
      const source = settings.realtimeMode === "CONFIRMED_BARS" && latestIsDeveloping ? available.slice(0, -1) : available;
      if (source.length < 2) return;
      const capture = ddaFlowCaptureRef.current;
      const sourceMatches = capture.streamHealthy
        && capture.venue === marketSymbol.exchange
        && capture.symbol === marketSymbol.rawSymbol
        && chartSourceVenueRef.current === marketSymbol.exchange;
      const liveFlowInput = sourceMatches
        ? buildDDAProFlowInput({
            candles: source,
            trades: canonicalCvdService.getTrades({
              venue: marketSymbol.exchange,
              symbol: marketSymbol.rawSymbol,
              start: source[0]?.time ?? 0,
              end: (source.at(-1)?.time ?? 0) + timeframeDuration
            }),
            timeframeSeconds: timeframeDuration,
            captureStartedAt: capture.captureStartedAt,
            streamHealthy: true,
            consumerLabel: "BC-ACVD"
          })
        : {
            flowBars: undefined,
            flowAuthority: "UNAVAILABLE" as const,
            flowWarning: chartSourceVenueRef.current !== marketSymbol.exchange
              ? "BC-ACVD is unavailable because chart candles and authentic trade flow are from different venues."
              : "BC-ACVD is warming until the venue-matched aggressor stream is continuous and healthy."
          };
      const mergedFlowBars = mergePersistentAndLiveFlow(source.map((candle) => candle.time), acvdPersistentFlow, liveFlowInput.flowBars);
      const archivedAuthority = acvdPersistentFlow?.authority === "EXACT_AGGRESSOR_TRADES";
      const flowInput = {
        flowBars: mergedFlowBars,
        flowAuthority: archivedAuthority || liveFlowInput.flowAuthority === "EXACT_AGGRESSOR_TRADES" ? "EXACT_AGGRESSOR_TRADES" as const : "UNAVAILABLE" as const,
        flowWarning: archivedAuthority
          ? acvdPersistentFlow?.warning ?? null
          : acvdPersistentFlowError ?? liveFlowInput.flowWarning
      };
      const calculationInput = {
        candles: source,
        flowBars: flowInput.flowBars,
        flowAuthority: flowInput.flowAuthority,
        flowWarning: flowInput.flowWarning,
        settings,
        timeframeSeconds: timeframeDuration,
        lastBarConfirmed: settings.realtimeMode === "CONFIRMED_BARS" || !latestIsDeveloping,
        marketIdentity: `${marketSymbol.exchange}:${marketSymbol.rawSymbol}:${timeframe}`
      };
      const calculationIdentity = `${calculationInput.marketIdentity}:${ddaProSourceRevision}:${acvdStableHash([
        settings,
        source.length,
        source.at(-1)?.time,
        source.at(-1)?.close,
        authenticFlowRevision(flowInput.flowBars)
      ])}`;
      if (acvdCalculationIdentityRef.current === calculationIdentity) return;
      acvdCalculationIdentityRef.current = calculationIdentity;
      const worker = acvdWorkerRef.current ?? new AcvdWorkerClient();
      acvdWorkerRef.current = worker;
      setAcvdStatus("CALCULATING");
      void worker.calculate(calculationInput).then((snapshot) => {
        if (acvdCalculationIdentityRef.current !== calculationIdentity) return;
        setAcvdSnapshot(snapshot);
        setAcvdStatus(snapshot.authority === "EXACT_AGGRESSOR_TRADES" ? "READY" : "UNAVAILABLE");
        engineRef.current?.setAcvdState(snapshot);
        const nowSeconds = Date.now() / 1000;
        const freshSignalWindow = Math.max(5, Math.min(60, timeframeDuration * 0.1));
        if (!visibleIndicators.acvdOscillator) return;
        for (const signal of snapshot.signals) {
          if (!signal.finalized || acvdDispatchedSignalsRef.current.has(signal.id)) continue;
          acvdDispatchedSignalsRef.current.add(signal.id);
          if (signal.executionEligibleTimestamp > nowSeconds || nowSeconds - signal.executionEligibleTimestamp > freshSignalWindow) continue;
          window.dispatchEvent(new CustomEvent("black-terminal:acvd-signal", { detail: signal }));
        }
      }).catch((error: unknown) => {
        if (acvdCalculationIdentityRef.current !== calculationIdentity || (error instanceof Error && error.message.includes("STALE_GENERATION"))) return;
        console.error("BC-ACVD calculation failed", error);
        acvdCalculationIdentityRef.current = "";
        setAcvdStatus("UNAVAILABLE");
        engineRef.current?.setAcvdState(null);
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [
    acvdRuntimeRequested,
    acvdRuntimeLookback,
    cvdAuthenticFlowRequested,
    visibleIndicators.acvdOscillator,
    indicatorAdvancedSettings.acvdOscillator,
    marketSymbol.exchange,
    marketSymbol.rawSymbol,
    timeframe,
    ddaProSourceRevision,
    acvdPersistentFlow,
    acvdPersistentFlowError,
    lastCandle?.time,
    lastCandle?.close
  ]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!visibleIndicators.ddaProOscillator || !engine) {
      ddaCalculationIdentityRef.current = "";
      setDDAProSnapshot(null);
      setDDAProStatus("IDLE");
      engine?.setDDAProState(null);
      return;
    }
    const timer = window.setTimeout(() => {
      const settings = migrateDDAProSettings({
        ...indicatorAdvancedSettings.ddaProOscillator,
        lookback: indicatorPeriods.ddaProOscillator
      });
      const timeframeDuration = timeframeSeconds[timeframe];
      const available = engine.getSourceCandles().slice(-20_000);
      const latestIsDeveloping = Boolean(available.length && (available.at(-1)?.time ?? 0) + timeframeDuration > Date.now() / 1000);
      const source = settings.realtimeMode === "confirmed-bars" && latestIsDeveloping ? available.slice(0, -1) : available;
      if (source.length < 2) return;
      const capture = ddaFlowCaptureRef.current;
      const wantsFlowData = settings.showFlowPressure || settings.cvdConfirmation;
      const flowInput = wantsFlowData && capture.streamHealthy && capture.venue === marketSymbol.exchange && capture.symbol === marketSymbol.rawSymbol && chartSourceVenueRef.current === marketSymbol.exchange
        ? buildDDAProFlowInput({
            candles: source,
            trades: canonicalCvdService.getTrades({
              venue: marketSymbol.exchange,
              symbol: marketSymbol.rawSymbol,
              start: source[0]?.time ?? 0,
              end: (source.at(-1)?.time ?? 0) + timeframeDuration
            }),
            timeframeSeconds: timeframeDuration,
            captureStartedAt: capture.captureStartedAt,
            streamHealthy: true
          })
        : {
            flowBars: undefined,
            cvdValues: undefined,
            flowAuthority: "UNAVAILABLE" as const,
            flowWarning: wantsFlowData
              ? chartSourceVenueRef.current !== marketSymbol.exchange
                ? "BC-RDA Flow Pressure is unavailable because chart candles and the live aggressor stream are from different venues."
                : "BC-RDA Flow Pressure is unavailable until a continuous genuine aggressor-trade stream is healthy."
              : "BC-RDA Flow Pressure is disabled."
          };
      const calculationInput = {
        candles: source,
        settings,
        timeframeSeconds: timeframeDuration,
        lastBarConfirmed: settings.realtimeMode === "confirmed-bars" || !latestIsDeveloping,
        signalContext: { exchange: marketSymbol.exchange, symbol: marketSymbol.rawSymbol, timeframe },
        ...flowInput
      };
      const calculationIdentity = marketSymbol.exchange + ":" + marketSymbol.rawSymbol + ":" + timeframe + ":" + ddaProCalculationHash(calculationInput, settings.engineMode);
      if (ddaCalculationIdentityRef.current === calculationIdentity) return;
      ddaCalculationIdentityRef.current = calculationIdentity;
      const worker = ddaProWorkerRef.current ?? new DDAProWorkerClient();
      ddaProWorkerRef.current = worker;
      setDDAProStatus("CALCULATING");
      void worker.calculate(calculationInput).then((snapshot) => {
        if (ddaCalculationIdentityRef.current !== calculationIdentity) return;
        setDDAProSnapshot(snapshot);
        setDDAProStatus("READY");
        engineRef.current?.setDDAProState(snapshot);
        const alertBarIsConfirmed = settings.realtimeMode === "confirmed-bars" || !latestIsDeveloping;
        if (alertBarIsConfirmed) {
          for (const event of snapshot.events.filter((candidate) => candidate.index === snapshot.inputSize - 1)) {
            if (ddaDispatchedEventsRef.current.has(event.id)) continue;
            ddaDispatchedEventsRef.current.add(event.id);
            window.dispatchEvent(new CustomEvent("black-terminal:dda-pro-event", { detail: { ...event, confirmed: true } }));
          }
        }
      }).catch((error: unknown) => {
        if (ddaCalculationIdentityRef.current !== calculationIdentity || (error instanceof Error && error.message.includes("STALE_GENERATION"))) return;
        console.error("BC-RDA calculation failed", error);
        if (ddaCalculationIdentityRef.current === calculationIdentity) ddaCalculationIdentityRef.current = "";
        setDDAProStatus("UNAVAILABLE");
        engineRef.current?.setDDAProState(null);
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    visibleIndicators.ddaProOscillator,
    indicatorPeriods.ddaProOscillator,
    indicatorAdvancedSettings.ddaProOscillator,
    marketSymbol.exchange,
    marketSymbol.rawSymbol,
    timeframe,
    ddaProSourceRevision,
    lastCandle?.time,
    lastCandle?.close
  ]);

  useEffect(() => {
    liquidationFieldControllerRef.current?.updateSettings(liquidationFieldRuntimeSettings);
    engineRef.current?.setLiquidationFieldState(
      visibleIndicators.liquidationHeatmap ? liquidationFieldSnapshot : null,
      liquidationFieldSettings
    );
  }, [liquidationFieldRuntimeSettings, liquidationFieldSettings, liquidationFieldSnapshot, visibleIndicators.liquidationHeatmap]);

  useEffect(() => {
    liquidationFieldSnapshotStoreRef.current.clear();
    setLiquidationFieldSnapshot(null);
    setLiquidationFieldRendererMetrics(null);
  }, [marketSymbol.rawSymbol, liquidationFieldRuntimeCalculationKey]);

  useEffect(() => {
    ddaDispatchedEventsRef.current.clear();
    ddaConfiguredEventsRef.current.clear();
    ddaSignalAlertArmedAtRef.current.clear();
    acvdDispatchedSignalsRef.current.clear();
    acvdConfiguredSignalsRef.current.clear();
    acvdSignalAlertArmedAtRef.current.clear();
    marketSentimentConfiguredEventsRef.current.clear();
    marketSentimentAlertArmedAtRef.current.clear();
  }, [marketSymbol.exchange, marketSymbol.rawSymbol, timeframe]);

  useEffect(() => {
    liquidationFieldControllerRef.current?.dispose();
    liquidationFieldControllerRef.current = null;
    if (!liquidationFieldRequested) {
      setLiquidationFieldSnapshot(null);
      setLiquidationFieldRendererMetrics(null);
      setLiquidationFieldStatus({
        state: "IDLE",
        message: "Awaiting activation",
        source: "NONE",
        lastInputAt: null,
        lifecycle: "UNMOUNTED"
      });
      engineRef.current?.setLiquidationFieldState(null, liquidationFieldSettings);
      return;
    }
    if (!isBclifVisualFixtureEnabled() && marketSymbol.exchange !== "bybit" && !liquidationProfileRequested) {
      const nextStatus: LiquidationFieldRuntimeStatus = {
        state: "UNAVAILABLE",
        message: "This build currently has venue-calibrated liquidation intelligence for Bybit linear contracts only.",
        source: "NONE",
        lastInputAt: null,
        lifecycle: "VENUE_UNSUPPORTED"
      };
      setLiquidationFieldStatus(nextStatus);
      setLiquidationFieldSnapshot(null);
      setLiquidationFieldRendererMetrics(null);
      liquidationFieldSnapshotStoreRef.current.clear();
      engineRef.current?.setLiquidationFieldState(null, liquidationFieldSettings);
      return;
    }
    if (chartHistoryState !== "ready" || !engineRef.current) {
      setLiquidationFieldStatus({
        state: "LOADING",
        message: "Waiting for canonical chart history before resolving persistent BCLIF authority…",
        source: "PERSISTENT_COLLECTOR",
        authority: "PERSISTENT_NODE",
        persistence: "ON",
        lastInputAt: null,
        lifecycle: "WAITING_FOR_MODEL"
      });
      return;
    }
    const retainedBeforeMount = liquidationFieldSnapshotStoreRef.current.getLatestSnapshot();
    if (retainedBeforeMount) {
      setLiquidationFieldSnapshot(retainedBeforeMount);
      engineRef.current.setLiquidationFieldState(
        liquidationFieldOverlayVisibleRef.current ? retainedBeforeMount : null,
        liquidationFieldSettings
      );
    }
    const liquidationAuthoritySymbol = liquidationProfileRequested
      ? `${marketSymbol.baseAsset}USDT`
      : marketSymbol.rawSymbol;
    const controller = new LiquidationFieldController({
      symbol: liquidationAuthoritySymbol,
      settings: liquidationFieldRuntimeSettings,
      getCandles: () => engineRef.current?.getSourceCandles() ?? [],
      getReplayActive: () => replayActiveRef.current,
      onSnapshot: (snapshot) => {
        if (!snapshot) {
          liquidationFieldSnapshotStoreRef.current.clear();
          setLiquidationFieldSnapshot(null);
          engineRef.current?.setLiquidationFieldState(null, latestLiquidationFieldSettingsRef.current);
          return;
        }
        const retained = liquidationFieldSnapshotStoreRef.current.publish(snapshot);
        setLiquidationFieldSnapshot(retained);
        engineRef.current?.setLiquidationFieldState(
          liquidationFieldOverlayVisibleRef.current ? retained : null,
          latestLiquidationFieldSettingsRef.current
        );
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
    liquidationFieldRequested,
    liquidationProfileRequested,
    marketSymbol.exchange,
    marketSymbol.baseAsset,
    marketSymbol.rawSymbol,
    chartHistoryState,
    liquidationFieldRuntimeCalculationKey
  ]);

  useEffect(() => {
    if (!visibleIndicators.aif && !visibleIndicators.qalc && !visibleIndicators.liquidationHeatmap) {
      setAifPriceTransform(null);
      return;
    }
    const engine = engineRef.current;
    if (engine) setAifPriceTransform(engine.getPriceTransformSnapshot());
  }, [visibleIndicators.aif, visibleIndicators.qalc, visibleIndicators.liquidationHeatmap]);

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
      ddaProOscillator: visibleIndicators.ddaProOscillator,
      acvdOscillator: visibleIndicators.acvdOscillator,
      cvdOscillator: visibleIndicators.cvdOscillator,
      marketSentimentOscillator: visibleIndicators.marketSentimentOscillator,
      zScoreOscillator: visibleIndicators.zScoreOscillator,
      waveTrendOscillator: visibleIndicators.waveTrendOscillator
    };
  }, [
    onIndicatorAdvancedSettingsChange,
    visibleIndicators.openInterestOscillator,
    visibleIndicators.ddaProOscillator,
    visibleIndicators.acvdOscillator,
    visibleIndicators.cvdOscillator,
    visibleIndicators.marketSentimentOscillator,
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
    if (type === "trailing-stop") {
      showLocalAlertToast("Native Trailing Stop", "Use the native Bybit protection editor; a chart price is not a trailing-distance instruction.");
      setChartContextMenu(null);
      return;
    }
    const existing = position.protections.find((item) => item.type === type);
    setPendingProtectionChange({
      positionId: position.id,
      protectionId: existing?.id ?? `new-${type}`,
      type,
      symbol: position.symbol,
      originalPrice: existing?.price ?? price,
      proposedPrice: price,
      phase: "confirming"
    });
    setChartContextMenu(null);
  };

  const recordPositionContextAction = async (action: "add" | "scaleIn" | "scaleOut" | "partialClose" | "close" | "reverse" | "moveProtection" | "cancelTp" | "cancelSl" | "cancelTrailing" | "stats" | "notes" | "timeline") => {
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
      const { report } = await updateBybitPositionProtectionViaApi(buildBybitProtectionCancelDraft(position, "take-profit"));
      if (report.status !== "reconciled") throw new Error("Bybit TP cancellation is not reconciled.");
      blackCorePositionManager.cancelProtection(position.id, "take-profit");
      showLocalAlertToast("TP Cancelled", position.symbol);
      return;
    }
    if (action === "cancelSl") {
      const { report } = await updateBybitPositionProtectionViaApi(buildBybitProtectionCancelDraft(position, "stop-loss"));
      if (report.status !== "reconciled") throw new Error("Bybit SL cancellation is not reconciled.");
      blackCorePositionManager.cancelProtection(position.id, "stop-loss");
      showLocalAlertToast("SL Cancelled", position.symbol);
      return;
    }
    if (action === "cancelTrailing") {
      const { report } = await updateBybitPositionProtectionViaApi(buildBybitProtectionCancelDraft(position, "trailing-stop"));
      if (report.status !== "reconciled") throw new Error("Bybit trailing-stop cancellation is not reconciled.");
      blackCorePositionManager.cancelProtection(position.id, "trailing-stop");
      showLocalAlertToast("Trailing Cancelled", position.symbol);
      return;
    }
    if (action === "notes") {
      const note = await requestUserText({ title: "Trade Note", message: `Trade note for ${position.symbol}.` });
      if (note) blackCorePositionManager.addNote(position.id, note);
      return;
    }
    if (action === "timeline") {
      showLocalAlertToast("Trade Timeline", position.timeline.slice(0, 3).map((item) => item.message).join(" | ") || "No timeline events.");
      return;
    }
    showLocalAlertToast("Position Statistics", `PnL ${formatAlertPrice(position.health.currentPnl)} | RR ${position.health.riskReward?.toFixed(2) ?? "-"}`);
  };

  const cancelPendingProtectionChange = () => {
    if (pendingProtectionChange?.phase === "submitting") return;
    setPendingProtectionChange(null);
  };

  const confirmPendingProtectionChange = async () => {
    if (!pendingProtectionChange || pendingProtectionChange.phase === "submitting") return;
    const position = blackCorePositionManager.getPosition(pendingProtectionChange.positionId);
    if (!position) {
      setPendingProtectionChange((current) => current ? { ...current, error: "Position is no longer open." } : current);
      return;
    }
    try {
      setPendingProtectionChange((current) => current ? { ...current, phase: "submitting", error: undefined } : current);
      const draft = buildBybitProtectionDraft(position, pendingProtectionChange.type, pendingProtectionChange.proposedPrice);
      const { report } = await updateBybitPositionProtectionViaApi(draft);
      if (report.status !== "reconciled") throw new Error("Bybit accepted the change but authoritative protection has not reconciled.");
      const existing = position.protections.find((item) => item.id === pendingProtectionChange.protectionId);
      if (existing) blackCorePositionManager.moveProtection(position.id, pendingProtectionChange.protectionId, pendingProtectionChange.proposedPrice);
      else blackCorePositionManager.setProtection(position.id, pendingProtectionChange.type, { price: pendingProtectionChange.proposedPrice, metadata: { source: "bybit-reconciled" } });
      setPendingProtectionChange(null);
      showLocalAlertToast(
        pendingProtectionChange.type === "take-profit" ? "Take Profit Updated" : "Stop Loss Updated",
        `${position.symbol} protection is confirmed by the Bybit API.`
      );
    } catch (error) {
      setPendingProtectionChange((current) => current ? {
        ...current,
        phase: "confirming",
        error: error instanceof Error ? error.message : String(error)
      } : current);
    }
  };

  const dragProtectionLine = (protection: PositionProtectionOrder | undefined) => (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !activeChartPosition || !isEditableNativeProtection(protection) || pendingOrderPriceChange || pendingProtectionChange?.phase === "submitting") return;
    event.preventDefault();
    event.stopPropagation();
    const originalPrice = Number(protection.price);
    if (!Number.isFinite(originalPrice) || originalPrice <= 0) return;
    const initial: PendingProtectionChange = {
      positionId: activeChartPosition.id,
      protectionId: protection.id,
      type: protection.type,
      symbol: activeChartPosition.symbol,
      originalPrice,
      proposedPrice: originalPrice,
      phase: "dragging"
    };
    setPendingProtectionChange(initial);
    let proposedPrice = originalPrice;
    const move = (moveEvent: MouseEvent) => {
      const price = engineRef.current?.getPriceFromClientY(moveEvent.clientY);
      if (price && Number.isFinite(price)) {
        proposedPrice = quantizeProtectionPrice(
          price,
          marketSymbol.metadata?.tickSize,
          marketSymbol.metadata?.pricePrecision ?? marketSymbol.pricePrecision ?? 2
        );
        setPendingProtectionChange((current) => current && current.protectionId === protection.id
          ? { ...current, proposedPrice, phase: "dragging", error: undefined }
          : current);
      }
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (proposedPrice === originalPrice) {
        setPendingProtectionChange(null);
        return;
      }
      setPendingProtectionChange((current) => current && current.protectionId === protection.id
        ? { ...current, proposedPrice, phase: "confirming" }
        : { ...initial, proposedPrice, phase: "confirming" });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const cancelPendingOrderPriceChange = () => {
    if (pendingOrderPriceChange?.phase === "submitting" || pendingOrderPriceChange?.phase === "synchronizing") return;
    setPendingOrderPriceChange(null);
  };

  const confirmPendingOrderPriceChange = async () => {
    if (!pendingOrderPriceChange || pendingOrderPriceChange.phase !== "confirming") return;
    const pending = pendingOrderPriceChange;
    const currentOrder = activeChartOrders.find((candidate) => canonicalOrderKey(candidate) === pending.orderKey);
    if (!currentOrder) {
      setPendingOrderPriceChange((current) => current ? { ...current, error: "This order is no longer active." } : current);
      return;
    }
    const currentPrice = confirmedOrderPrices[pending.orderKey] ?? Number(currentOrder.price);
    if (!Number.isFinite(currentPrice) || Math.abs(currentPrice - pending.originalPrice) > 1e-9) {
      setPendingOrderPriceChange((current) => current ? {
        ...current,
        originalPrice: currentPrice,
        proposedPrice: currentPrice,
        error: "The venue order changed while this confirmation was open. Drag the refreshed line again."
      } : current);
      return;
    }

    try {
      setPendingOrderPriceChange((current) => current ? { ...current, phase: "submitting", error: undefined } : current);
      await modifyVenueOrderViaApi(currentOrder, { limitPrice: pending.proposedPrice });
    } catch (error) {
      setPendingOrderPriceChange((current) => current ? {
        ...current,
        phase: "confirming",
        error: error instanceof Error ? error.message : String(error)
      } : current);
      return;
    }

    setConfirmedOrderPrices((current) => ({ ...current, [pending.orderKey]: pending.proposedPrice }));
    setPendingOrderPriceChange((current) => current ? { ...current, phase: "synchronizing" } : current);
    let synchronizationWarning = "";
    try {
      await onRefreshOrders?.();
    } catch (error) {
      synchronizationWarning = error instanceof Error ? error.message : String(error);
    }
    setPendingOrderPriceChange(null);
    showLocalAlertToast(
      synchronizationWarning ? "Order Updated — Sync Pending" : "Limit Order Updated",
      synchronizationWarning
        ? `${pending.order.exchange.toUpperCase()} acknowledged the price; local refresh will retry automatically.`
        : `${pending.order.exchange.toUpperCase()} acknowledged ${pending.order.symbol} at ${formatAlertPrice(pending.proposedPrice)}.`
    );
  };

  const dragOrderLine = (order: OrderUpdate, displayedPrice: number) => (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !isDraggableLimitOrder(order) || pendingProtectionChange || pendingOrderPriceChange) return;
    event.preventDefault();
    event.stopPropagation();
    const originalPrice = displayedPrice;
    const orderKey = canonicalOrderKey(order);
    const initial: PendingOrderPriceChange = {
      order,
      orderKey,
      originalPrice,
      proposedPrice: originalPrice,
      phase: "dragging"
    };
    setPendingOrderPriceChange(initial);
    let proposedPrice = originalPrice;
    const move = (moveEvent: MouseEvent) => {
      const price = engineRef.current?.getPriceFromClientY(moveEvent.clientY);
      if (price && Number.isFinite(price)) {
        proposedPrice = quantizeProtectionPrice(
          price,
          marketSymbol.metadata?.tickSize,
          marketSymbol.metadata?.pricePrecision ?? marketSymbol.pricePrecision ?? 2
        );
        setPendingOrderPriceChange((current) => current?.orderKey === orderKey
          ? { ...current, proposedPrice, phase: "dragging", error: undefined }
          : current);
      }
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (proposedPrice === originalPrice) {
        setPendingOrderPriceChange(null);
        return;
      }
      setPendingOrderPriceChange((current) => current?.orderKey === orderKey
        ? { ...current, proposedPrice, phase: "confirming" }
        : { ...initial, proposedPrice, phase: "confirming" });
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
    const matchingLevels = target === "any" ? levels
      : target === "srZone" ? levels.filter((level) => level.kind === "supportZone" || level.kind === "resistanceZone")
      : levels.filter((level) => level.kind === target);

    for (const level of matchingLevels) {
      const isBand = level.kind === "lvn" || level.kind === "supportZone" || level.kind === "resistanceZone";
      const currentTouched = isBand
        ? priceTouchesBand(current, level.priceLow, level.priceHigh)
        : priceTouchesLevel(current, level.price);
      const previousTouched = isBand
        ? priceTouchesBand(previous, level.priceLow, level.priceHigh)
        : priceTouchesLevel(previous, level.price);
      const lower = level.priceLow ?? level.price;
      const upper = level.priceHigh ?? level.price;
      const matched = definition.condition === "testing"
        ? currentTouched && !previousTouched
        : definition.condition === "crossingAbove"
          ? previous.close <= upper && current.close > upper
          : previous.close >= lower && current.close < lower;
      if (!matched) {
        continue;
      }

      return {
        indicator: "HDLX Profile",
        event: definition.condition,
        levelType: level.label,
        level: level.price,
        priceLow: level.priceLow,
        priceHigh: level.priceHigh,
        strength: level.strength,
        classification: level.kind,
        eventTimestamp: current.time
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
      condition: definition.indicator === "ddaPro"
        ? (definition.ddaSignal ?? "BC-RDA signal").replaceAll("_", " ")
        : definition.indicator === "acvd"
          ? (definition.acvdSignal ?? "BC-ACVD signal").replaceAll("_", " ")
          : configuredAlertConditionLabels[definition.condition],
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
        timestamp: new Date(Number(trigger.eventTimestamp ?? current.time) * 1000).toISOString(),
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
    // Emergency integrity containment: neither legacy nor causal-v2 browser
    // results may dispatch alerts until headless runtime parity is certified.
    if (!BC_RDA_ALERTS_ELIGIBLE) return;
    if (replayActiveRef.current || !ddaProSnapshot) return;
    const definitions = alertDefinitions.filter((definition) =>
      definition.enabled && definition.indicator === "ddaPro" && definition.symbol === displaySymbol &&
      definition.exchange === exchangeLabel && definition.timeframe === timeframe
    );
    if (definitions.length === 0) return;
    const sourceCandles = engineRef.current?.getSourceCandles() ?? [];
    const signalDefinitions = definitions.filter((definition) => String(definition.ddaSignal ?? "").startsWith("BC_RDA_"));
    const timeframeDuration = timeframeSeconds[timeframe];
    const nowSeconds = Date.now() / 1000;
    const latestConfirmedTime = latestConfirmedDDAProCandleTime(sourceCandles, timeframeDuration, nowSeconds);
    const activeArmKeys = new Set(signalDefinitions.map((definition) => `${definition.id}:${definition.ddaSignal ?? "BC_RDA_ANY_SIGNAL"}`));
    for (const key of ddaSignalAlertArmedAtRef.current.keys()) {
      if (!activeArmKeys.has(key)) ddaSignalAlertArmedAtRef.current.delete(key);
    }
    for (const definition of signalDefinitions) {
      const target = definition.ddaSignal ?? "BC_RDA_ANY_SIGNAL";
      const armKey = `${definition.id}:${target}`;
      const armedAfterTime = ddaSignalAlertArmedAtRef.current.get(armKey);
      if (armedAfterTime === undefined) {
        // Creating, enabling, or retargeting an alert arms it at the latest
        // confirmed candle. Historical dots are never replayed as new alerts.
        ddaSignalAlertArmedAtRef.current.set(armKey, latestConfirmedTime);
        continue;
      }
      const candidates = confirmedNewestDDAProSignals(
        ddaProAlertSignalStream(ddaProSnapshot, ddaProSettings),
        ddaProSnapshot.inputSize,
        timeframeDuration,
        nowSeconds,
        armedAfterTime
      );
      for (const signal of candidates) {
        if (target !== "BC_RDA_ANY_SIGNAL" && target !== `BC_RDA_${signal.direction.toUpperCase()}_SIGNAL`) continue;
        const current = sourceCandles.find((candle) => candle.time === signal.time);
        if (!current) continue;
        const eventKey = `${definition.id}:${signal.id}`;
        if (ddaConfiguredEventsRef.current.has(eventKey)) continue;
        ddaConfiguredEventsRef.current.add(eventKey);
        dispatchConfiguredAlert(definition, current, {
          indicator: "BC-RDA", event: signal.direction.toUpperCase(), direction: signal.direction,
          level: signal.value, signalId: signal.id, sourceEventType: signal.sourceEventType,
          markerTone: signal.markerTone, eventTimestamp: signal.time,
          signalClass: ddaProSettings.signalIntelligenceMode === "RAW" || !ddaProSettings.confirmedAlertsOnly ? "RAW" : "CONFIRMED",
          intelligenceMode: ddaProSettings.signalIntelligenceMode,
          regime: signal.regime,
          signalConfidence: signal.confidence
        });
      }
    }
    const events = ddaProSnapshot.events.filter((event) => event.index === ddaProSnapshot.inputSize - 1);
    for (const event of events) {
      let current: Candle | undefined;
      for (let index = sourceCandles.length - 1; index >= 0; index--) {
        if (sourceCandles[index]?.time === event.time) { current = sourceCandles[index]; break; }
      }
      if (!current) continue;
      for (const definition of definitions) {
        if (String(definition.ddaSignal ?? "").startsWith("BC_RDA_")) continue;
        if ((definition.ddaSignal ?? "DDA_RISK_SCORE_CROSSED_75") !== event.type) continue;
        const eventKey = `${definition.id}:${event.id}`;
        if (ddaConfiguredEventsRef.current.has(eventKey)) continue;
        ddaConfiguredEventsRef.current.add(eventKey);
        dispatchConfiguredAlert(definition, current, {
          indicator: "BC-RDA",
          event: event.type,
          level: event.value,
          engineMode: event.engineMode,
          sourceAuthority: event.sourceAuthority,
          lookback: event.lookback,
          riskScore: event.riskScore,
          riskState: event.state,
          drawdownPercent: event.drawdownPercent,
          confidence: event.confidence,
          confirmed: true
        });
      }
    }
  }, [ddaProSnapshot, alertDefinitions, displaySymbol, exchangeLabel, timeframe, indicatorAdvancedSettings.ddaProOscillator]);

  useEffect(() => {
    if (replayActiveRef.current || !visibleIndicators.acvdOscillator || !acvdSnapshot || acvdSnapshot.authority !== "EXACT_AGGRESSOR_TRADES") return;
    const definitions = alertDefinitions.filter((definition) =>
      definition.enabled && definition.indicator === "acvd" && definition.symbol === displaySymbol
      && definition.exchange === exchangeLabel && definition.timeframe === timeframe
    );
    if (!definitions.length) return;
    const sourceCandles = engineRef.current?.getSourceCandles() ?? [];
    const latestFinalSignalTime = acvdSnapshot.signals.at(-1)?.time ?? 0;
    const activeKeys = new Set(definitions.map((definition) => `${definition.id}:${definition.acvdSignal ?? "BC_ACVD_ANY_SIGNAL"}`));
    for (const key of acvdSignalAlertArmedAtRef.current.keys()) if (!activeKeys.has(key)) acvdSignalAlertArmedAtRef.current.delete(key);
    for (const definition of definitions) {
      const target = definition.acvdSignal ?? "BC_ACVD_ANY_SIGNAL";
      const armKey = `${definition.id}:${target}`;
      const armedAfter = acvdSignalAlertArmedAtRef.current.get(armKey);
      if (armedAfter === undefined) {
        acvdSignalAlertArmedAtRef.current.set(armKey, latestFinalSignalTime);
        continue;
      }
      for (const signal of acvdSnapshot.signals) {
        if (signal.time <= armedAfter || !signal.finalized) continue;
        if (target !== "BC_ACVD_ANY_SIGNAL" && target !== `BC_ACVD_${signal.direction.toUpperCase()}_SIGNAL`) continue;
        const current = sourceCandles.find((candle) => candle.time === signal.time);
        if (!current) continue;
        const eventKey = `${definition.id}:${signal.id}`;
        if (acvdConfiguredSignalsRef.current.has(eventKey)) continue;
        acvdConfiguredSignalsRef.current.add(eventKey);
        dispatchConfiguredAlert(definition, current, {
          indicator: "BC-ACVD",
          event: signal.direction.toUpperCase(),
          direction: signal.direction,
          level: signal.structurePrice,
          signalId: signal.id,
          markerTone: signal.markerTone,
          eventTimestamp: signal.time,
          executionEligibleTimestamp: signal.executionEligibleTimestamp,
          confidence: signal.confidence,
          pressure: signal.pressure,
          deltaRatio: signal.deltaRatio,
          cumulativeDelta: signal.cumulativeDelta,
          regime: signal.regime,
          reasonCodes: signal.reasonCodes,
          sourceAuthority: acvdSnapshot.authority,
          closedBarConfirmed: true
        });
      }
    }
  }, [visibleIndicators.acvdOscillator, acvdSnapshot, alertDefinitions, displaySymbol, exchangeLabel, timeframe]);

  useEffect(() => {
    if (replayActiveRef.current || !visibleIndicators.marketSentimentOscillator) return;
    const definitions = alertDefinitions.filter((definition) =>
      definition.enabled && definition.indicator === "marketSentiment" && definition.symbol === displaySymbol
      && definition.exchange === exchangeLabel && definition.timeframe === timeframe
    );
    if (!definitions.length) return;
    const sourceCandles = engineRef.current?.getSourceCandles().slice(-marketSentimentSettings.lookback) ?? [];
    if (sourceCandles.length < 202) return;
    const latestConfirmedTime = sourceCandles.at(-2)?.time ?? 0;
    const snapshot = calculateMarketSentiment({ candles: sourceCandles, settings: marketSentimentSettings, lastBarConfirmed: false });
    const activeKeys = new Set(definitions.map((definition) => `${definition.id}:${definition.marketSentimentSignal ?? "ANY_BAND_EVENT"}`));
    for (const key of marketSentimentAlertArmedAtRef.current.keys()) if (!activeKeys.has(key)) marketSentimentAlertArmedAtRef.current.delete(key);
    for (const definition of definitions) {
      const target = definition.marketSentimentSignal ?? "ANY_BAND_EVENT";
      const armKey = `${definition.id}:${target}`;
      const armedAfter = marketSentimentAlertArmedAtRef.current.get(armKey);
      if (armedAfter === undefined) {
        marketSentimentAlertArmedAtRef.current.set(armKey, latestConfirmedTime);
        continue;
      }
      for (const bandEvent of snapshot.events) {
        const isBandEvent = bandEvent.kind === "ENTER_OVERBOUGHT" || bandEvent.kind === "EXIT_OVERBOUGHT" || bandEvent.kind === "ENTER_OVERSOLD" || bandEvent.kind === "EXIT_OVERSOLD";
        const isAdaptiveSignal = bandEvent.kind === "CONFIRMED_ADAPTIVE_LONG" || bandEvent.kind === "CONFIRMED_ADAPTIVE_SHORT";
        const matchesTarget = target === bandEvent.kind || (target === "ANY_BAND_EVENT" && isBandEvent) || (target === "ANY_ADAPTIVE_SIGNAL" && isAdaptiveSignal);
        if (bandEvent.time <= armedAfter || !matchesTarget) continue;
        const current = sourceCandles.find((candle) => candle.time === bandEvent.time);
        if (!current) continue;
        const eventKey = `${definition.id}:${bandEvent.time}:${bandEvent.kind}`;
        if (marketSentimentConfiguredEventsRef.current.has(eventKey)) continue;
        marketSentimentConfiguredEventsRef.current.add(eventKey);
        dispatchConfiguredAlert(definition, current, {
          indicator: "BC-MSO",
          event: bandEvent.kind,
          score: bandEvent.score,
          threshold: bandEvent.threshold,
          regime: bandEvent.regime,
          tailProbability: bandEvent.tailProbability,
          calculationMode: marketSentimentSettings.calculationMode,
          overbought: snapshot.series.dynamicUpper[bandEvent.index] ?? marketSentimentSettings.overbought,
          oversold: snapshot.series.dynamicLower[bandEvent.index] ?? marketSentimentSettings.oversold,
          sourceAuthority: snapshot.authority,
          closedBarConfirmed: true
        });
      }
      marketSentimentAlertArmedAtRef.current.set(armKey, Math.max(armedAfter, ...snapshot.events.map((event) => event.time)));
    }
  }, [alertDefinitions, displaySymbol, exchangeLabel, timeframe, visibleIndicators.marketSentimentOscillator, lastCandle?.time, marketSentimentSettingsKey]);

  useEffect(() => {
    if (replayActiveRef.current || alertDefinitions.length === 0) return;

    const scopedAlerts = alertDefinitions.filter((definition) =>
      definition.enabled &&
      definition.indicator !== "ddaPro" &&
      definition.indicator !== "acvd" &&
      definition.indicator !== "marketSentiment" &&
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

  // Synchronize deterministic Black Terminal Python overlays.
  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setCustomScriptOutput(customPlots ?? [], customMarkers ?? []);
    }
  }, [customMarkers, customPlots]);

  // Re-project every independently mounted custom script whenever the selected
  // input stream changes. Outputs are namespaced before they reach the shared
  // chart renderer, so one user script can never replace another implicitly.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (activeCustomScripts.length === 0) {
      engine.setCustomScriptOutput([], []);
      return;
    }
    const candles = engine.getCustomScriptCandles().slice(-20_000);
    if (candles.length < 2) {
      engine.setCustomScriptOutput([], []);
      return;
    }
    const latestConfirmedTime = candles.at(-2)?.time ?? Number.NEGATIVE_INFINITY;
    const mounted = activeCustomScripts.flatMap((activation) => {
      if (activation.visible === false) return [];
      const compiled = compileAndRunScript(activation.source, candles, activation.inputValues);
      if (!compiled.success) return [];
      return [{ activation, result: finalizedScriptResult(compiled, latestConfirmedTime) }];
    });
    const combined = mergeCustomScriptOutput(mounted);
    engine.setCustomScriptOutput(combined.plots, combined.markers);
  }, [activeCustomScripts, chartType, customScriptFeedRevision, displaySymbol, marketSymbol.exchange, marketSymbol.rawSymbol, timeframe]);

  // Custom script alerts are strictly closed-candle, session-local events. A
  // newly activated script arms at the latest finalized candle and never
  // replays its historical signals as live notifications.
  useEffect(() => {
    const runtimes = customScriptAlertRuntimeRef.current;
    if (activeCustomScripts.length === 0 || replayActiveRef.current || !engineRef.current) {
      runtimes.clear();
      return;
    }
    const candles = engineRef.current.getCustomScriptCandles().slice(-20_000);
    if (candles.length < 3) return;
    const latestConfirmedTime = candles.at(-2)!.time;
    const lastOpenTime = candles.at(-1)!.time;
    const inputFeed = engineRef.current.getCustomScriptFeed();
    const activeRuntimeKeys = new Set<string>();

    for (const activeCustomScript of activeCustomScripts) {
      const inputFingerprint = JSON.stringify(activeCustomScript.inputValues ?? {});
      const runtimeKey = `${activeCustomScript.id}:${activeCustomScript.sourceHash}:${inputFingerprint}:${inputFeed}:${marketSymbol.exchange}:${marketSymbol.rawSymbol}:${timeframe}`;
      activeRuntimeKeys.add(runtimeKey);
      let currentRuntime = runtimes.get(runtimeKey);
      if (!currentRuntime) {
        currentRuntime = {
          key: runtimeKey,
          armedAfter: latestConfirmedTime,
          lastOpenTime,
          delivered: new Set()
        };
        runtimes.set(runtimeKey, currentRuntime);
        continue;
      }
      if (lastOpenTime <= currentRuntime.lastOpenTime) continue;

      const compiled = compileAndRunScript(activeCustomScript.source, candles, activeCustomScript.inputValues);
      if (!compiled.success) continue;
      const finalized = finalizedScriptResult(compiled, latestConfirmedTime);
      const alerts = newlyConfirmedScriptEvents({
        // Black Script v3 strategy events are emitted only after the local
        // simulator confirms a fill. They share the closed-candle delivery
        // guard with explicit alertcondition() events and never route orders.
        events: finalized.events,
        armedAfter: currentRuntime.armedAfter,
        latestConfirmedTime,
        deliveredIds: currentRuntime.delivered
      });
      for (const event of alerts) {
        currentRuntime.delivered.add(event.id);
        const message = `${activeCustomScript.name}: ${event.message}`;
        showLocalAlertToast(event.title, message);
        onAlertFired?.(displaySymbol, message);
        if (alertSettingsRef.current.enabled) {
          dispatchAlert(`${runtimeKey}:${event.id}`, {
            type: event.type === "alert" ? "custom_script_alert" : "custom_script_strategy_fill",
            scriptId: activeCustomScript.id,
            scriptName: activeCustomScript.name,
            runtimeVersion: compiled.runtimeVersion,
            conditionId: event.conditionId,
            alertName: event.title,
            timestamp: new Date(event.time * 1000).toISOString(),
            price: event.price,
            message: event.message,
            direction: event.direction
          });
        }
      }
      currentRuntime.armedAfter = latestConfirmedTime;
      currentRuntime.lastOpenTime = lastOpenTime;
    }

    for (const runtimeKey of runtimes.keys()) {
      if (!activeRuntimeKeys.has(runtimeKey)) runtimes.delete(runtimeKey);
    }
  }, [activeCustomScripts, chartType, customScriptFeedRevision, displaySymbol, exchangeLabel, lastCandle?.time, marketSymbol.exchange, marketSymbol.rawSymbol, onAlertFired, timeframe]);

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
    { key: "qalc", label: "BC-QALC", value: `${indicatorAdvancedSettings.qalc.displayMode} · ${indicatorAdvancedSettings.qalc.predictionHorizonMs}ms` },
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
    { key: "ddaProOscillator", label: "BC-RDA", value: `${indicatorAdvancedSettings.ddaProOscillator.engineMode === "pine-compatibility" ? "PINE" : "NATIVE"} · ${ddaProStatus.toLowerCase()}` },
    { key: "acvdOscillator", label: "BC-ACVD", value: `${acvdSnapshot?.latest.regime ?? "AUTHENTIC FLOW"} · ${acvdStatus.toLowerCase()}` },
    { key: "cvdOscillator", label: "BC-CVD-OSC", value: cvdAuthenticFlowRequested ? `AGGRESSOR · ${acvdStatus.toLowerCase()}` : "OHLCV · MARKET STATE" },
    { key: "marketSentimentOscillator", label: "BC-MSO", value: marketSentimentSettings.calculationMode === "ADAPTIVE_EVT" ? "ADAPTIVE EVT · CAUSAL" : marketSentimentSettings.calculationMode === "REGIME_PERCENTILE" ? "REGIME PERCENTILE · CAUSAL" : "PYTHON · 0–10 COMPOSITE" },
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
    const max = key === "volumeProfile" || key === "ddaProOscillator" || key === "acvdOscillator" || key === "cvdOscillator" || key === "marketSentimentOscillator" ? 20000 : 500;
    const min = key === "marketSentimentOscillator" ? 250 : key === "ddaProOscillator" || key === "acvdOscillator" || key === "cvdOscillator" ? 100 : 2;
    const nextValue = Math.max(min, Math.min(max, Number.isFinite(value) ? value : indicatorPeriods[key]));
    onIndicatorPeriodsChange((current) => ({
      ...current,
      [key]: nextValue
    }));
    if (key === "volumeProfile") {
      updateVolumeProfileSetting("fixedRangeLength", nextValue);
    }
    if (key === "ddaProOscillator") {
      onIndicatorAdvancedSettingsChange((current) => ({
        ...current,
        ddaProOscillator: migrateDDAProSettings({ ...current.ddaProOscillator, preset: "Custom", lookback: nextValue })
      }));
    }
    if (key === "acvdOscillator") {
      onIndicatorAdvancedSettingsChange((current) => ({
        ...current,
        acvdOscillator: migrateAcvdSettings({ ...current.acvdOscillator, lookback: nextValue })
      }));
    }
    if (key === "cvdOscillator") {
      onIndicatorAdvancedSettingsChange((current) => ({
        ...current,
        cvdOscillator: migrateCvdOscillatorSettings({ ...current.cvdOscillator, lookback: nextValue })
      }));
    }
    if (key === "marketSentimentOscillator") {
      onIndicatorAdvancedSettingsChange((current) => ({
        ...current,
        marketSentimentOscillator: migrateMarketSentimentSettings({ ...current.marketSentimentOscillator, lookback: nextValue })
      }));
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
  const qalcSettings: QalcIndicatorSettings = {
    ...defaultQalcIndicatorSettings,
    ...indicatorAdvancedSettings.qalc
  };
  const updateQalcSetting = <Key extends keyof QalcIndicatorSettings>(key: Key, value: QalcIndicatorSettings[Key]) => {
    onIndicatorAdvancedSettingsChange((current) => ({
      ...current,
      qalc: { ...defaultQalcIndicatorSettings, ...current.qalc, [key]: value }
    }));
  };
  const openQalcStrategyLab = () => {
    saveQalcStrategyHandoff(displaySymbol, qalcSettings);
    setActiveIndicator(null);
    onOpenStrategyLab?.();
  };
  const adaptiveSwingSettings = indicatorAdvancedSettings.adaptiveSwingStrategy ?? defaultAdaptiveSwingStrategySettings;
  const oscillatorPaneSettings: OscillatorPaneSettings = {
    ...defaultOscillatorPaneSettings,
    ...indicatorAdvancedSettings.oscillatorPane,
    paneHeights: {
      ...defaultOscillatorPaneSettings.paneHeights,
      ...(indicatorAdvancedSettings.oscillatorPane?.paneHeights ?? {})
    },
    customPaneHeights: {
      ...defaultOscillatorPaneSettings.customPaneHeights,
      ...(indicatorAdvancedSettings.oscillatorPane?.customPaneHeights ?? {})
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
  const ddaProSettings: DDAProSettings = migrateDDAProSettings({
    ...DEFAULT_DDA_PRO_SETTINGS,
    ...indicatorAdvancedSettings.ddaProOscillator,
    lookback: indicatorPeriods.ddaProOscillator
  });
  const acvdSettings: AcvdSettings = migrateAcvdSettings({
    ...DEFAULT_ACVD_SETTINGS,
    ...indicatorAdvancedSettings.acvdOscillator,
    lookback: indicatorPeriods.acvdOscillator
  });
  const cvdOscillatorSettings = migrateCvdOscillatorSettings({
    ...DEFAULT_CVD_OSCILLATOR_SETTINGS,
    ...indicatorAdvancedSettings.cvdOscillator,
    lookback: indicatorPeriods.cvdOscillator
  });
  const customOscillatorIds = customOscillatorScriptIds(customPlots ?? []);
  const oscillatorStack = resolveOscillatorStack(
    visibleIndicators,
    oscillatorPaneSettings,
    waveTrendSettings,
    oscillatorHostHeight,
    58,
    38,
    customOscillatorIds
  );
  const oscillatorPaneVisible = oscillatorStack.panes.length > 0 || oscillatorStack.customPanes.length > 0;
  const activeIndicatorVisual = activeIndicator
    ? indicatorVisualSettings[activeIndicator] ?? { color: "red" as IndicatorColorKey, intensity: 80 }
    : null;
  const oscillatorSettingsOpen =
    activeIndicator === "openInterestOscillator" ||
    activeIndicator === "ddaProOscillator" ||
    activeIndicator === "acvdOscillator" ||
    activeIndicator === "cvdOscillator" ||
    activeIndicator === "marketSentimentOscillator" ||
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

  const updateCustomOscillatorPaneHeight = (scriptId: string, value: number) => {
    const height = clampNumber(Math.round(value), 82, 420);
    onIndicatorAdvancedSettingsChange((current) => ({
      ...current,
      oscillatorPane: {
        ...defaultOscillatorPaneSettings,
        ...current.oscillatorPane,
        paneHeights: {
          ...defaultOscillatorPaneSettings.paneHeights,
          ...(current.oscillatorPane?.paneHeights ?? {})
        },
        customPaneHeights: {
          ...defaultOscillatorPaneSettings.customPaneHeights,
          ...(current.oscillatorPane?.customPaneHeights ?? {}),
          [scriptId]: height
        },
        order: current.oscillatorPane?.order ?? defaultOscillatorPaneSettings.order
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

  const updateDDAProSetting = <Key extends keyof DDAProSettings>(
    key: Key,
    value: DDAProSettings[Key]
  ) => {
    const next = migrateDDAProSettings({ ...ddaProSettings, preset: key === "preset" ? value as DDAProPreset : "Custom", [key]: value });
    onIndicatorAdvancedSettingsChange((current) => ({ ...current, ddaProOscillator: next }));
    if (key === "lookback") onIndicatorPeriodsChange((current) => ({ ...current, ddaProOscillator: next.lookback }));
  };

  const updateAcvdSetting = <Key extends keyof AcvdSettings>(key: Key, value: AcvdSettings[Key]) => {
    const next = migrateAcvdSettings({ ...acvdSettings, [key]: value });
    onIndicatorAdvancedSettingsChange((current) => ({ ...current, acvdOscillator: next }));
    if (key === "lookback") onIndicatorPeriodsChange((current) => ({ ...current, acvdOscillator: next.lookback }));
  };

  const updateCvdOscillatorSetting = <Key extends keyof CvdOscillatorSettings>(key: Key, value: CvdOscillatorSettings[Key]) => {
    const next = migrateCvdOscillatorSettings({ ...cvdOscillatorSettings, [key]: value });
    onIndicatorAdvancedSettingsChange((current) => ({ ...current, cvdOscillator: next }));
    if (key === "lookback") onIndicatorPeriodsChange((current) => ({ ...current, cvdOscillator: next.lookback }));
  };

  const updateMarketSentimentSetting = <Key extends keyof MarketSentimentSettings>(key: Key, value: MarketSentimentSettings[Key]) => {
    const next = migrateMarketSentimentSettings({ ...marketSentimentSettings, [key]: value });
    onIndicatorAdvancedSettingsChange((current) => ({ ...current, marketSentimentOscillator: next }));
    if (key === "lookback") onIndicatorPeriodsChange((current) => ({ ...current, marketSentimentOscillator: next.lookback }));
  };

  const selectDDAProPreset = (preset: DDAProPreset) => {
    const next = applyDDAProPreset(ddaProSettings, preset);
    onIndicatorAdvancedSettingsChange((current) => ({ ...current, ddaProOscillator: next }));
    onIndicatorPeriodsChange((current) => ({ ...current, ddaProOscillator: next.lookback }));
  };

  const selectDDAProSignalMode = (mode: DDAProSignalIntelligenceMode) => {
    const next = applyDDAProSignalIntelligenceMode(ddaProSettings, mode);
    onIndicatorAdvancedSettingsChange((current) => ({ ...current, ddaProOscillator: next }));
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
    target: OscillatorResizeTarget,
    configuredHeight: number
  ) => {
    if (event.button !== 0) return;
    const hostHeight = hostRef.current?.clientHeight ?? 0;
    oscillatorResizeRef.current = {
      target,
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: configuredHeight,
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
    if (resize.target.kind === "native") updateOscillatorPaneHeight(resize.target.key, nextHeight);
    else updateCustomOscillatorPaneHeight(resize.target.scriptId, nextHeight);
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
          <option value="fixed">Fixed Look-back</option>
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

  const chartInteractionIsolated = Boolean(
    activeIndicator ||
    activeCustomScriptSettingsId ||
    horizonSettingsOpen ||
    chartContextMenu ||
    orderContextMenu ||
    editingChartAlert ||
    (pendingProtectionChange && pendingProtectionChange.phase !== "dragging") ||
    (pendingOrderPriceChange && pendingOrderPriceChange.phase !== "dragging")
  );

  return (
    <div className={chartInteractionIsolated ? "chart-wrap interaction-isolated" : "chart-wrap"}>
      <div className="chart-header">
        <div>
          <span className="pair">{displaySymbol} PERP - {chartType === "horizon" ? `1s SOURCE / ${horizonLabel(horizonSettings.displayHorizonMs)} HORIZON` : timeframeLabel} - {exchangeLabel.toUpperCase()}</span>
          <span className="status-dot" />
          <span className="ohlc">
            O {displayCandle.open.toLocaleString(undefined, { maximumFractionDigits: 1 })}&nbsp;&nbsp;
            H {displayCandle.high.toLocaleString(undefined, { maximumFractionDigits: 1 })}&nbsp;&nbsp;
            L {displayCandle.low.toLocaleString(undefined, { maximumFractionDigits: 1 })}&nbsp;&nbsp;
            C {displayCandle.close.toLocaleString(undefined, { maximumFractionDigits: 1 })}&nbsp;&nbsp;
            {change.toFixed(1)} ({changePercent.toFixed(2)}%)
          </span>
        </div>
        {visibleIndicators.liquidationHeatmap && <div className="bclif-quick-controls" role="group" aria-label="BCLIF quick controls">
          <label className="bclif-quick-intensity" title="Display intensity only — model exposure is unchanged">
            <span>INT</span>
            <input
              aria-label="BCLIF quick intensity"
              type="range"
              min={50}
              max={200}
              value={liquidationFieldSettings.intensityGain}
              onChange={(event) => patchLiquidationFieldSettings({ intensityGain: Number(event.target.value) })}
            />
            <b>{liquidationFieldSettings.intensityGain}</b>
          </label>
          <select
            aria-label="BCLIF range"
            value={liquidationFieldSettings.rangeMode}
            onChange={(event) => {
              const rangeMode = event.target.value as LiquidationFieldSettings["rangeMode"];
              patchLiquidationFieldSettings({ rangeMode, priceDisplay: bclifPriceDisplayForRangeMode(rangeMode) });
            }}
          >
            <option value="AUTO">Auto</option><option value="VISIBLE">Visible</option><option value="SESSION">Session</option>
            <option value="SWING">Swing</option><option value="MACRO">Macro</option><option value="FULL_LOADED">Full Loaded</option>
          </select>
          <select
            aria-label="BCLIF thermal theme"
            value={liquidationFieldSettings.palette === "BLACK_TERMINAL_BLOOD" ? "BLACK_TERMINAL_BLOOD" : "REFERENCE_THERMAL"}
            onChange={(event) => patchLiquidationFieldSettings({ palette: event.target.value as LiquidationFieldSettings["palette"] })}
          >
            <option value="REFERENCE_THERMAL">Reference Thermal</option>
            <option value="BLACK_TERMINAL_BLOOD">Black Terminal Blood</option>
          </select>
        </div>}
        {chartType === "horizon" && <div className="horizon-chart-controls" role="group" aria-label="Black Horizon Candles controls">
          <b>BLACK HORIZON CANDLES</b>
          <span className="horizon-source-lock">1s SOURCE</span>
          <select
            aria-label="Black Horizon display horizon"
            value={horizonSettings.displayHorizonMs}
            onChange={(event) => setHorizonPreferences((current) => migrateHorizonCandleMode({ ...current, displayHorizonMs: Number(event.target.value) }))}
          >
            <option value={15 * 60_000}>15m Horizon</option>
            <option value={60 * 60_000}>1H Horizon</option>
            <option value={4 * 60 * 60_000}>4H Horizon</option>
            <option value={24 * 60 * 60_000}>1D Horizon</option>
          </select>
          <label title="Controls horizon traversal scale without changing the 1-second source">
            <span>SPEED</span>
            <input
              aria-label="Black Horizon speed scale"
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={horizonSettings.horizonScale}
              onChange={(event) => setHorizonPreferences((current) => migrateHorizonCandleMode({ ...current, horizonScale: Number(event.target.value) }))}
            />
            <em>{horizonSettings.horizonScale.toFixed(2)}x</em>
          </label>
          {horizonSettings.showDataQualityBadge && <i className={`horizon-quality ${horizonDataQuality}`}>{horizonQualityLabel(horizonDataQuality)} · {(horizonCoverageRatio * 100).toFixed(horizonCoverageRatio < 0.1 ? 1 : 0)}%</i>}
          <button type="button" aria-label="Black Horizon settings" className={horizonSettingsOpen ? "active" : ""} onClick={() => setHorizonSettingsOpen((open) => !open)}>
            <SlidersHorizontal size={13} />
          </button>
        </div>}
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

      {chartType === "horizon" && horizonSettingsOpen && <div className="horizon-settings-panel" role="dialog" aria-label="Black Horizon Candles settings">
        <header><div><b>BLACK HORIZON CANDLES</b><span>RESOLUTION / HORIZON DECOUPLING</span></div><button type="button" onClick={() => setHorizonSettingsOpen(false)}><X size={13} /></button></header>
        <label>Source Resolution<select value="1s" disabled><option value="1s">1 second · source truth</option></select></label>
        <label>Level of Detail<select value={horizonSettings.lodMode} onChange={(event) => setHorizonPreferences((current) => migrateHorizonCandleMode({ ...current, lodMode: event.target.value as HorizonCandleMode["lodMode"] }))}><option value="auto">Auto</option><option value="candles">1s Candles</option><option value="clusters">Micro Clusters</option><option value="wave">Wave Envelope</option></select></label>
        <label className="horizon-toggle"><span>Wave Envelope<small>Macro acceptance boundary</small></span><input type="checkbox" checked={horizonSettings.showWaveEnvelope} onChange={(event) => setHorizonPreferences((current) => migrateHorizonCandleMode({ ...current, showWaveEnvelope: event.target.checked }))} /></label>
        <label className="horizon-toggle"><span>Micro Candles<small>True source detail at close LOD</small></span><input type="checkbox" checked={horizonSettings.showMicroCandles} onChange={(event) => setHorizonPreferences((current) => migrateHorizonCandleMode({ ...current, showMicroCandles: event.target.checked }))} /></label>
        <label className="horizon-toggle"><span>Directional Pressure<small>Silver buy / blood-red sell field</small></span><input type="checkbox" checked={horizonSettings.showDirectionalPressure} onChange={(event) => setHorizonPreferences((current) => migrateHorizonCandleMode({ ...current, showDirectionalPressure: event.target.checked }))} /></label>
        <label className="horizon-toggle"><span>Rejection Heat<small>Upper and lower wick rejection</small></span><input type="checkbox" checked={horizonSettings.showRejectionHeat} onChange={(event) => setHorizonPreferences((current) => migrateHorizonCandleMode({ ...current, showRejectionHeat: event.target.checked }))} /></label>
        <label className="horizon-toggle"><span>Data Quality Badge<small>Never hide source degradation</small></span><input type="checkbox" checked={horizonSettings.showDataQualityBadge} onChange={(event) => setHorizonPreferences((current) => migrateHorizonCandleMode({ ...current, showDataQualityBadge: event.target.checked }))} /></label>
        <p>Black Horizon is not a timeframe and does not smooth price. Every crosshair sample resolves to its original 1-second OHLCV candle.</p>
      </div>}

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
          {activeCustomScripts.map((script) => (
            <div key={script.id} className={script.visible === false ? "indicator-row custom-script-row hidden" : "indicator-row custom-script-row"} data-custom-script-id={script.id}>
              <span>{script.name}</span>
              <b>{script.kind === "strategy" ? "USER STRATEGY" : "USER INDICATOR"} · {script.inputFeed === "CAUSAL_RENKO" ? "RENKO" : "OHLCV"}</b>
              <button
                type="button"
                className="indicator-action"
                aria-label={script.visible === false ? `Show custom script ${script.name}` : `Hide custom script ${script.name}`}
                title={script.visible === false ? "Show custom script" : "Hide custom script"}
                onClick={() => onToggleCustomScriptVisibility?.(script.id)}
              >
                {script.visible === false ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
              <button
                type="button"
                className="indicator-action"
                aria-label={`Open custom script ${script.name} settings`}
                title="Custom script settings"
                onClick={() => setActiveCustomScriptSettingsId(script.id)}
              >
                <SlidersHorizontal size={12} />
              </button>
              <button
                type="button"
                className="indicator-action remove"
                aria-label={`Remove custom script ${script.name}`}
                title="Remove from chart (saved source is kept)"
                onClick={() => onRemoveCustomScript?.(script.id)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {chartInteractionIsolated && <InteractionShield variant="dialog" testId="chart-dialog-interaction-shield" />}

      {activeCustomScriptSettingsId && (() => {
        const script = activeCustomScripts.find((candidate) => candidate.id === activeCustomScriptSettingsId);
        return script ? (
          <CustomScriptSettingsPanel
            key={script.id}
            script={script}
            oscillatorPaneHeight={customOscillatorIds.includes(script.id)
              ? oscillatorPaneSettings.customPaneHeights[script.id] ?? DEFAULT_CUSTOM_OSCILLATOR_PANE_HEIGHT
              : undefined}
            onClose={() => setActiveCustomScriptSettingsId(null)}
            onApply={(values) => onUpdateCustomScriptInputs?.(script.id, values) ?? { success: false, message: "Settings updates are unavailable." }}
            onOscillatorPaneHeightChange={(height) => updateCustomOscillatorPaneHeight(script.id, height)}
          />
        ) : null;
      })()}

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

      {activeIndicator === "qalc" && (
        <div className="indicator-settings profile-settings qalc-indicator-settings" role="dialog" aria-label="BC-QALC indicator settings">
          <div className="indicator-settings-title"><span>BC-QALC — QUEUE-AWARE LIQUIDITY CAPTURE</span><button type="button" onClick={() => setActiveIndicator(null)}>DONE</button></div>
          <div className="indicator-settings-section">Canonical Display</div>
          <label>Visible<input type="checkbox" checked={visibleIndicators.qalc} onChange={() => toggleIndicator("qalc")} /></label>
          <label>Event Surface<select value={qalcSettings.displayMode} onChange={(event) => updateQalcSetting("displayMode", event.target.value as QalcIndicatorSettings["displayMode"])}><option value="LIVE">Live / Recorded</option><option value="REPLAY">Replay only</option><option value="COMBINED">Combined</option></select></label>
          <label>Prediction Horizon<select value={qalcSettings.predictionHorizonMs} onChange={(event) => updateQalcSetting("predictionHorizonMs", Number(event.target.value) as QalcIndicatorSettings["predictionHorizonMs"])}>{[250,500,1000,3000,5000,10000].map((value) => <option value={value} key={value}>{value >= 1000 ? `${value / 1000}s` : `${value}ms`}</option>)}</select></label>
          <label>Run Filter<input value={qalcSettings.selectedRunId} placeholder="All recorded runs" onChange={(event) => updateQalcSetting("selectedRunId", event.target.value.slice(0, 160))} /></label>
          <div className="indicator-settings-section">Strategy Configuration</div>
          <label>Minimum Net Edge ×<input type="number" min={1} max={10} step={0.1} value={qalcSettings.minimumNetEdgeMultiplier} onChange={(event) => updateQalcSetting("minimumNetEdgeMultiplier", clampNumber(Number(event.target.value), 1, 10))} /></label>
          <label>Minimum P(fill)<input type="number" min={0.01} max={0.99} step={0.01} value={qalcSettings.minimumFillProbability} onChange={(event) => updateQalcSetting("minimumFillProbability", clampNumber(Number(event.target.value), .01, .99))} /></label>
          <label>Maximum Toxicity<input type="number" min={1} max={100} value={qalcSettings.maximumToxicity} onChange={(event) => updateQalcSetting("maximumToxicity", clampNumber(Number(event.target.value), 1, 100))} /></label>
          <label>Quote Lifetime ms<input type="number" min={100} max={5000} step={50} value={qalcSettings.quoteLifetimeMs} onChange={(event) => updateQalcSetting("quoteLifetimeMs", clampNumber(Number(event.target.value), 100, 5000))} /></label>
          <div className="indicator-settings-section">Marker Semantics</div>
          <label>Research Long / Short Setups<input type="checkbox" checked={qalcSettings.showCandidates} onChange={(event) => updateQalcSetting("showCandidates", event.target.checked)} /></label>
          <label>Rejected Decisions<input type="checkbox" checked={qalcSettings.showRejected} onChange={(event) => updateQalcSetting("showRejected", event.target.checked)} /></label>
          <label>Working Quotes<input type="checkbox" checked={qalcSettings.showQuotes} onChange={(event) => updateQalcSetting("showQuotes", event.target.checked)} /></label>
          <label>Cancels / Expiry<input type="checkbox" checked={qalcSettings.showCancellations} onChange={(event) => updateQalcSetting("showCancellations", event.target.checked)} /></label>
          <label>Partial Fills<input type="checkbox" checked={qalcSettings.showPartialFills} onChange={(event) => updateQalcSetting("showPartialFills", event.target.checked)} /></label>
          <label>Actual Entries<input type="checkbox" checked={qalcSettings.showEntries} onChange={(event) => updateQalcSetting("showEntries", event.target.checked)} /></label>
          <label>Actual Exits<input type="checkbox" checked={qalcSettings.showExits} onChange={(event) => updateQalcSetting("showExits", event.target.checked)} /></label>
          <label>Microstructure Pane<input type="checkbox" checked={qalcSettings.showMicrostructurePane} onChange={(event) => updateQalcSetting("showMicrostructurePane", event.target.checked)} /></label>
          <label>Marker Size<input type="range" min={4} max={18} value={qalcSettings.markerSize} onChange={(event) => updateQalcSetting("markerSize", Number(event.target.value))} /></label>
          <label>Pane Height<input type="range" min={48} max={220} value={qalcSettings.paneHeight} onChange={(event) => updateQalcSetting("paneHeight", Number(event.target.value))} /></label>
          <label>Long Color<input type="color" value={qalcSettings.longColor} onChange={(event) => updateQalcSetting("longColor", event.target.value)} /></label>
          <label>Short Color<input type="color" value={qalcSettings.shortColor} onChange={(event) => updateQalcSetting("shortColor", event.target.value)} /></label>
          <label>Neutral Color<input type="color" value={qalcSettings.neutralColor} onChange={(event) => updateQalcSetting("neutralColor", event.target.value)} /></label>
          <label>Tooltip<select value={qalcSettings.tooltipDetail} onChange={(event) => updateQalcSetting("tooltipDetail", event.target.value as QalcIndicatorSettings["tooltipDetail"])}><option value="COMPACT">Compact</option><option value="FULL">Full Engine Evidence</option></select></label>
          <div className="qalc-settings-truth">RESEARCH LONG/SHORT marks a causal microstructure setup, not an order or fill. MODEL TP and INVALIDATION are recorded projections. PAPER ENTRY/EXIT appears only after the conservative queue simulator records an actual fill lifecycle. The chart never infers BC-QALC signals from candle direction.</div>
          <button type="button" className="profile-inline-button strategy-lab-jump" onClick={openQalcStrategyLab}>OPEN THIS CONFIGURATION IN STRATEGY LAB</button>
          <button type="button" className="tv-defaults" onClick={() => onIndicatorAdvancedSettingsChange((current) => ({ ...current, qalc: defaultQalcIndicatorSettings }))}>Defaults</button>
        </div>
      )}


      {activeIndicator && activeIndicator !== "qalc" && activeIndicator !== "aif" && activeIndicator !== "auctionProfile" && activeIndicator !== "volumeProfile" && activeIndicator !== "adaptiveSwingStrategy" && activeIndicator !== "volatilityHeatmap" && (
        <div
          className={
            activeIndicator === "zScoreOscillator"
              ? "indicator-settings profile-settings oscillator-settings"
              : activeIndicator === "ddaProOscillator"
                ? "indicator-settings profile-settings oscillator-settings dda-pro-settings"
              : activeIndicator === "acvdOscillator"
                ? "indicator-settings profile-settings oscillator-settings dda-pro-settings"
              : activeIndicator === "cvdOscillator"
                ? "indicator-settings profile-settings oscillator-settings dda-pro-settings"
              : activeIndicator === "marketSentimentOscillator"
                ? "indicator-settings profile-settings oscillator-settings dda-pro-settings"
              : activeIndicator === "vwap"
                ? "indicator-settings profile-settings vwap-settings"
                : activeIndicator === "liquidationHeatmap"
                  ? "indicator-settings profile-settings bclif-settings-shell"
                : "indicator-settings"
          }
        >
          <div className="indicator-settings-title">
            <span>{indicatorRows.find((indicator) => indicator.key === activeIndicator)?.label}</span>
            <button type="button" onClick={() => setActiveIndicator(null)}>DONE</button>
          </div>
          {activeIndicator !== "liquidationHeatmap" && <><label>
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
                min={activeIndicator === "marketSentimentOscillator" ? 250 : activeIndicator === "ddaProOscillator" || activeIndicator === "acvdOscillator" || activeIndicator === "cvdOscillator" ? 100 : 2}
                max={activeIndicator === "ddaProOscillator" || activeIndicator === "acvdOscillator" || activeIndicator === "cvdOscillator" || activeIndicator === "marketSentimentOscillator" ? 20000 : 500}
                value={indicatorPeriods[activeIndicator as keyof IndicatorPeriods]}
                onChange={(event) => updateIndicatorPeriod(activeIndicator as keyof IndicatorPeriods, Number(event.target.value))}
              />
            </label>
          )}
          <label>
            Color
            <select
              value={activeIndicatorVisual!.color}
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
                value={activeIndicatorVisual!.intensity}
                onChange={(event) => updateIndicatorVisual(activeIndicator, { intensity: Number(event.target.value) })}
              />
              <b>{activeIndicatorVisual!.intensity}</b>
            </span>
          </label></>}
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
          {activeIndicator === "acvdOscillator" && (
            <>
              <div className="indicator-settings-section">BC-ACVD Authentic Flow Engine</div>
              <div className="bcrda-integrity-warning">
                <strong>CAUSAL · CLOSED-BAR SIGNALS · NO SYNTHETIC CVD</strong>
                <span>Uses only venue-matched trades carrying an exact aggressor classification. Missing or mismatched flow fails closed; candle direction is never substituted.</span>
              </div>
              <label>Realtime Semantics<select value={acvdSettings.realtimeMode} onChange={(event) => updateAcvdSetting("realtimeMode", event.target.value as AcvdSettings["realtimeMode"])}><option value="CONFIRMED_BARS">Confirmed Bars Only</option><option value="DEVELOPING_PREVIEW">Developing Preview · Signals Still Final Only</option></select></label>
              <label>Delta Basis<select value={acvdSettings.deltaBasis} onChange={(event) => updateAcvdSetting("deltaBasis", event.target.value as AcvdSettings["deltaBasis"])}><option value="NOTIONAL">Notional Aggressor Delta</option><option value="QUANTITY">Quantity Aggressor Delta</option></select></label>
              <label>Lookback Bars<select value={acvdSettings.lookback} onChange={(event) => updateAcvdSetting("lookback", Number(event.target.value))}>{[250, 500, 1000, 2500, 5000, 10000, 20000].map((value) => <option key={value} value={value}>{value.toLocaleString()}</option>)}</select></label>
              <div className="indicator-settings-section">Adaptive Delta Transformation</div>
              <label>Smoothing<select value={acvdSettings.smoothingMode} onChange={(event) => updateAcvdSetting("smoothingMode", event.target.value as AcvdSettings["smoothingMode"])}><option value="ADAPTIVE_KAMA">Adaptive KAMA</option><option value="EMA">EMA</option><option value="RMA">RMA / Wilder</option></select></label>
              <label>Smoothing Length<input type="number" min={1} max={200} value={acvdSettings.smoothingLength} onChange={(event) => updateAcvdSetting("smoothingLength", Number(event.target.value))} /></label>
              {acvdSettings.smoothingMode === "ADAPTIVE_KAMA" && <><label>Adaptive Fast<input type="number" min={1} max={50} value={acvdSettings.adaptiveFastLength} onChange={(event) => updateAcvdSetting("adaptiveFastLength", Number(event.target.value))} /></label><label>Adaptive Slow<input type="number" min={2} max={300} value={acvdSettings.adaptiveSlowLength} onChange={(event) => updateAcvdSetting("adaptiveSlowLength", Number(event.target.value))} /></label></>}
              <label>Robust Normalization<input type="number" min={20} max={2000} value={acvdSettings.normalizationLookback} onChange={(event) => updateAcvdSetting("normalizationLookback", Number(event.target.value))} /></label>
              <label>Dynamic Envelope<input type="number" min={30} max={3000} value={acvdSettings.envelopeLookback} onChange={(event) => updateAcvdSetting("envelopeLookback", Number(event.target.value))} /></label>
              <label>Envelope Deviation<input type="number" min={0.5} max={5} step={0.05} value={acvdSettings.envelopeDeviation} onChange={(event) => updateAcvdSetting("envelopeDeviation", Number(event.target.value))} /></label>
              <label>Minimum Envelope Width<input type="number" min={2} max={80} value={acvdSettings.minimumEnvelopeWidth} onChange={(event) => updateAcvdSetting("minimumEnvelopeWidth", Number(event.target.value))} /></label>
              <label>Minimum Exact Coverage %<input type="number" min={50} max={100} value={acvdSettings.minimumCoveragePercent} onChange={(event) => updateAcvdSetting("minimumCoveragePercent", Number(event.target.value))} /></label>
              <div className="indicator-settings-section">Structure Test & Confirmation</div>
              <label>Structure Lookback<input type="number" min={5} max={300} value={acvdSettings.structureLookback} onChange={(event) => updateAcvdSetting("structureLookback", Number(event.target.value))} /></label>
              <label>ATR Length<input type="number" min={3} max={200} value={acvdSettings.atrLength} onChange={(event) => updateAcvdSetting("atrLength", Number(event.target.value))} /></label>
              <label>Structure Tolerance ATR<input type="number" min={0.05} max={3} step={0.05} value={acvdSettings.structureToleranceAtr} onChange={(event) => updateAcvdSetting("structureToleranceAtr", Number(event.target.value))} /></label>
              <label>Minimum Rejection Wick<input type="number" min={0} max={0.9} step={0.01} value={acvdSettings.minimumRejectionWickRatio} onChange={(event) => updateAcvdSetting("minimumRejectionWickRatio", Number(event.target.value))} /></label>
              <label>Confirmation Window<input type="number" min={1} max={10} value={acvdSettings.confirmationBars} onChange={(event) => updateAcvdSetting("confirmationBars", Number(event.target.value))} /></label>
              <div className="indicator-settings-section">Regime & Noise Arbitration</div>
              <label>Trend Protection<input type="checkbox" checked={acvdSettings.trendProtection} onChange={(event) => updateAcvdSetting("trendProtection", event.target.checked)} /></label>
              <label>Trend Efficiency Length<input type="number" min={10} max={500} value={acvdSettings.trendLength} onChange={(event) => updateAcvdSetting("trendLength", Number(event.target.value))} /></label>
              <label>Trend Efficiency Threshold<input type="number" min={0.05} max={0.95} step={0.01} value={acvdSettings.trendEfficiencyThreshold} onChange={(event) => updateAcvdSetting("trendEfficiencyThreshold", Number(event.target.value))} /></label>
              <label>Divergence Lookback<input type="number" min={8} max={500} value={acvdSettings.divergenceLookback} onChange={(event) => updateAcvdSetting("divergenceLookback", Number(event.target.value))} /></label>
              <label>Minimum Divergence Score<input type="number" min={0} max={100} value={acvdSettings.minimumDivergenceScore} onChange={(event) => updateAcvdSetting("minimumDivergenceScore", Number(event.target.value))} /></label>
              <label>Maximum Chop Probability<input type="number" min={0} max={100} value={acvdSettings.maximumChopProbability} onChange={(event) => updateAcvdSetting("maximumChopProbability", Number(event.target.value))} /></label>
              <div className="indicator-settings-section">Signal Selectivity</div>
              <label>Minimum Extreme Score<input type="number" min={20} max={100} value={acvdSettings.minimumExtremeScore} onChange={(event) => updateAcvdSetting("minimumExtremeScore", Number(event.target.value))} /></label>
              <label>Minimum Reversal Impulse<input type="number" min={0} max={80} value={acvdSettings.minimumReversalImpulse} onChange={(event) => updateAcvdSetting("minimumReversalImpulse", Number(event.target.value))} /></label>
              <label>Minimum Signal Confidence<input type="number" min={40} max={100} value={acvdSettings.minimumSignalConfidence} onChange={(event) => updateAcvdSetting("minimumSignalConfidence", Number(event.target.value))} /></label>
              <label>Episode Cooldown Bars<input type="number" min={0} max={500} value={acvdSettings.cooldownBars} onChange={(event) => updateAcvdSetting("cooldownBars", Number(event.target.value))} /></label>
              <label>Episode Reset Threshold<input type="number" min={2} max={80} value={acvdSettings.resetThreshold} onChange={(event) => updateAcvdSetting("resetThreshold", Number(event.target.value))} /></label>
              <div className="indicator-settings-section">Plots & Appearance</div>
              <div className="vwap-mode-note">Pane camera: drag anywhere inside BC-ACVD to inspect time and delta depth. Scroll over its right scale to expand or contract; double-click the scale to reset.</div>
              <label>Adaptive Pressure<input type="checkbox" checked={acvdSettings.showAdaptivePressure} onChange={(event) => updateAcvdSetting("showAdaptivePressure", event.target.checked)} /></label>
              <label>Dynamic Envelope<input type="checkbox" checked={acvdSettings.showDynamicEnvelope} onChange={(event) => updateAcvdSetting("showDynamicEnvelope", event.target.checked)} /></label>
              <label>Delta Impulse Histogram<input type="checkbox" checked={acvdSettings.showDeltaHistogram} onChange={(event) => updateAcvdSetting("showDeltaHistogram", event.target.checked)} /></label>
              <label>Long / Short Dots<input type="checkbox" checked={acvdSettings.showSignals} onChange={(event) => updateAcvdSetting("showSignals", event.target.checked)} /></label>
              <label>Dashboard<input type="checkbox" checked={acvdSettings.showDashboard} onChange={(event) => updateAcvdSetting("showDashboard", event.target.checked)} /></label>
              <label>Regime Diagnostics<input type="checkbox" checked={acvdSettings.showRegimeDiagnostics} onChange={(event) => updateAcvdSetting("showRegimeDiagnostics", event.target.checked)} /></label>
              <label className="indicator-color-setting">Long / Buying<input type="color" value={acvdSettings.bullishColor} onChange={(event) => updateAcvdSetting("bullishColor", event.target.value)} /></label>
              <label className="indicator-color-setting">Short / Selling<input type="color" value={acvdSettings.bearishColor} onChange={(event) => updateAcvdSetting("bearishColor", event.target.value)} /></label>
              <label className="indicator-color-setting">Neutral<input type="color" value={acvdSettings.neutralColor} onChange={(event) => updateAcvdSetting("neutralColor", event.target.value)} /></label>
              <label className="indicator-color-setting">Envelope<input type="color" value={acvdSettings.envelopeColor} onChange={(event) => updateAcvdSetting("envelopeColor", event.target.value)} /></label>
              <label className="indicator-range-row">Line Intensity<span><input type="range" min={0} max={100} value={acvdSettings.lineIntensity} onChange={(event) => updateAcvdSetting("lineIntensity", Number(event.target.value))} /><b>{acvdSettings.lineIntensity}</b></span></label>
              <label className="indicator-range-row">Fill Intensity<span><input type="range" min={0} max={60} value={acvdSettings.fillIntensity} onChange={(event) => updateAcvdSetting("fillIntensity", Number(event.target.value))} /><b>{acvdSettings.fillIntensity}</b></span></label>
              <div className="vwap-mode-note">{acvdStatus} · {acvdSnapshot ? `${acvdSnapshot.authority} · ${acvdSnapshot.inputSize.toLocaleString()} bars · ${acvdSnapshot.integrity.signalCount} finalized signals` : "Awaiting worker result"}</div>
              {acvdSnapshot?.warning && <div className="vwap-mode-note">{acvdSnapshot.warning}</div>}
              <details className="indicator-advanced-details"><summary>Integrity / Diagnostics</summary><div className="vwap-mode-note">Model {acvdSnapshot?.modelVersion ?? "--"} · {acvdSnapshot?.integrity.currentBar ?? "--"} · future bars consumed {acvdSnapshot?.integrity.futureBarsConsumed ?? 0}</div><div className="vwap-mode-note">Worker {acvdWorkerRef.current?.executionMode() ?? "NOT STARTED"} · {acvdWorkerRef.current?.lastCalculationTimeMs()?.toFixed(2) ?? "--"} ms</div></details>
              <button type="button" className="tv-defaults" onClick={() => { onIndicatorAdvancedSettingsChange((current) => ({ ...current, acvdOscillator: DEFAULT_ACVD_SETTINGS })); onIndicatorPeriodsChange((current) => ({ ...current, acvdOscillator: DEFAULT_ACVD_SETTINGS.lookback })); }}>Defaults</button>
            </>
          )}
          {activeIndicator === "cvdOscillator" && (
            <>
              <div className="indicator-settings-section">BC-CVD-OSC Engine</div>
              <div className="vwap-mode-note">Defaults to candle-signed OHLCV. Authentic mode reuses the certified BC-ACVD aggressor-flow runtime and never substitutes estimated data when exact coverage is unavailable.</div>
              <label>Authentic Aggressor CVD<input type="checkbox" checked={cvdOscillatorSettings.useAuthenticAggressorFlow} onChange={(event) => updateCvdOscillatorSetting("useAuthenticAggressorFlow", event.target.checked)} /></label>
              <label>Parameters<select value={cvdOscillatorSettings.parametersMode} onChange={(event) => updateCvdOscillatorSetting("parametersMode", event.target.value as CvdOscillatorSettings["parametersMode"])}><option value="Auto">Auto by Timeframe</option><option value="Custom">Custom</option></select></label>
              <label>OHLCV Volume Model<select disabled={cvdOscillatorSettings.useAuthenticAggressorFlow} value={cvdOscillatorSettings.useVolumeIntegration ? "integrated" : "normalized"} onChange={(event) => updateCvdOscillatorSetting("useVolumeIntegration", event.target.value === "integrated")}><option value="normalized">Range-Normalized Signed Volume</option><option value="integrated">Integrated Signed Volume</option></select></label>
              {cvdOscillatorSettings.parametersMode === "Custom" && <>
                <label>Fast Length<input type="number" min={2} max={1000} value={cvdOscillatorSettings.fastLength} onChange={(event) => updateCvdOscillatorSetting("fastLength", Number(event.target.value))} /></label>
                <label>Fast Method<select value={cvdOscillatorSettings.fastMaType} onChange={(event) => updateCvdOscillatorSetting("fastMaType", event.target.value as CvdOscillatorSettings["fastMaType"])}>{["EMA", "SMA", "WMA", "RMA"].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
                <label>Slow Length<input type="number" min={3} max={2000} value={cvdOscillatorSettings.slowLength} onChange={(event) => updateCvdOscillatorSetting("slowLength", Number(event.target.value))} /></label>
                <label>Slow Method<select value={cvdOscillatorSettings.slowMaType} onChange={(event) => updateCvdOscillatorSetting("slowMaType", event.target.value as CvdOscillatorSettings["slowMaType"])}>{["EMA", "SMA", "WMA", "RMA"].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
              </>}
              <div className="indicator-settings-section">Fast Wave</div>
              <label className="indicator-color-setting">Color<input type="color" value={cvdOscillatorSettings.fastWaveColor} onChange={(event) => updateCvdOscillatorSetting("fastWaveColor", event.target.value)} /></label>
              <label className="indicator-range-row">Thickness<span><input type="range" min={0.5} max={5} step={0.25} value={cvdOscillatorSettings.fastWaveWidth} onChange={(event) => updateCvdOscillatorSetting("fastWaveWidth", Number(event.target.value))} /><b>{cvdOscillatorSettings.fastWaveWidth.toFixed(2)}</b></span></label>
              <label className="indicator-range-row">Intensity<span><input type="range" min={0} max={100} value={cvdOscillatorSettings.fastWaveIntensity} onChange={(event) => updateCvdOscillatorSetting("fastWaveIntensity", Number(event.target.value))} /><b>{cvdOscillatorSettings.fastWaveIntensity}</b></span></label>
              <div className="indicator-settings-section">Slow Wave</div>
              <label className="indicator-color-setting">Color<input type="color" value={cvdOscillatorSettings.slowWaveColor} onChange={(event) => updateCvdOscillatorSetting("slowWaveColor", event.target.value)} /></label>
              <label className="indicator-range-row">Thickness<span><input type="range" min={0.5} max={5} step={0.25} value={cvdOscillatorSettings.slowWaveWidth} onChange={(event) => updateCvdOscillatorSetting("slowWaveWidth", Number(event.target.value))} /><b>{cvdOscillatorSettings.slowWaveWidth.toFixed(2)}</b></span></label>
              <label className="indicator-range-row">Intensity<span><input type="range" min={0} max={100} value={cvdOscillatorSettings.slowWaveIntensity} onChange={(event) => updateCvdOscillatorSetting("slowWaveIntensity", Number(event.target.value))} /><b>{cvdOscillatorSettings.slowWaveIntensity}</b></span></label>
              <div className="indicator-settings-section">CVD Price Line</div>
              <label className="indicator-color-setting">Color<input type="color" value={cvdOscillatorSettings.rawCvdColor} onChange={(event) => updateCvdOscillatorSetting("rawCvdColor", event.target.value)} /></label>
              <label className="indicator-range-row">Intensity<span><input type="range" min={0} max={100} value={cvdOscillatorSettings.rawCvdIntensity} onChange={(event) => updateCvdOscillatorSetting("rawCvdIntensity", Number(event.target.value))} /><b>{cvdOscillatorSettings.rawCvdIntensity}</b></span></label>
              <div className="indicator-settings-section">Display</div>
              <label>CVD Price Line<input type="checkbox" checked={cvdOscillatorSettings.showRawCvd} onChange={(event) => updateCvdOscillatorSetting("showRawCvd", event.target.checked)} /></label>
              <label>Dynamic Cloud<input type="checkbox" checked={cvdOscillatorSettings.showClouds} onChange={(event) => updateCvdOscillatorSetting("showClouds", event.target.checked)} /></label>
              <label>Market Status Panel<input type="checkbox" checked={cvdOscillatorSettings.showStatusPanel} onChange={(event) => updateCvdOscillatorSetting("showStatusPanel", event.target.checked)} /></label>
              <label>Shift Candles Left<input type="checkbox" checked={cvdOscillatorSettings.reserveRightGutter} onChange={(event) => updateCvdOscillatorSetting("reserveRightGutter", event.target.checked)} /></label>
              <label className="indicator-range-row">Panel Width<span><input type="range" min={170} max={300} value={cvdOscillatorSettings.statusPanelWidth} onChange={(event) => updateCvdOscillatorSetting("statusPanelWidth", Number(event.target.value))} /><b>{cvdOscillatorSettings.statusPanelWidth}px</b></span></label>
              {cvdOscillatorSettings.useAuthenticAggressorFlow && <div className="vwap-mode-note">{acvdStatus} · {acvdSnapshot?.authority ?? "AWAITING EXACT FLOW"}{acvdSnapshot?.authority === "EXACT_AGGRESSOR_TRADES" ? ` · ${acvdSnapshot.latest.coveragePercent.toFixed(0)}% latest coverage` : " · no OHLCV fallback"}</div>}
              <button type="button" className="tv-defaults" onClick={() => { onIndicatorAdvancedSettingsChange((current) => ({ ...current, cvdOscillator: DEFAULT_CVD_OSCILLATOR_SETTINGS })); onIndicatorPeriodsChange((current) => ({ ...current, cvdOscillator: DEFAULT_CVD_OSCILLATOR_SETTINGS.lookback })); }}>Defaults</button>
            </>
          )}
          {activeIndicator === "marketSentimentOscillator" && (
            <>
              <div className="indicator-settings-section">BC-MSO Python Engine</div>
              <div className="vwap-mode-note">The original 0–10 composite remains available unchanged. Adaptive modes calibrate a continuous latent score against prior confirmed bars only; EVT automatically falls back to empirical percentiles when its tail sample is insufficient.</div>
              <label>Calculation
                <select value={marketSentimentSettings.calculationMode} onChange={(event) => updateMarketSentimentSetting("calculationMode", event.target.value as MarketSentimentSettings["calculationMode"])}>
                  <option value="ORIGINAL_COMPOSITE">Original Composite</option>
                  <option value="REGIME_PERCENTILE">Regime-Conditioned Percentile</option>
                  <option value="ADAPTIVE_EVT">Adaptive Value Theory Mode (EVT)</option>
                </select>
              </label>
              <label>Candle View<input type="checkbox" checked={marketSentimentSettings.candleView} onChange={(event) => updateMarketSentimentSetting("candleView", event.target.checked)} /></label>
              <label>Heikin Ashi Transform<input type="checkbox" checked={marketSentimentSettings.heikinAshi} onChange={(event) => updateMarketSentimentSetting("heikinAshi", event.target.checked)} /></label>
              <label>Candle Transform<input type="number" min={1} max={100} value={marketSentimentSettings.candleTransform} onChange={(event) => updateMarketSentimentSetting("candleTransform", Number(event.target.value))} /></label>
              <label>Smoothing<input type="checkbox" checked={marketSentimentSettings.smoothingEnabled} onChange={(event) => updateMarketSentimentSetting("smoothingEnabled", event.target.checked)} /></label>
              <label>Smoothing Length<input type="number" min={1} max={100} disabled={!marketSentimentSettings.smoothingEnabled} value={marketSentimentSettings.smoothingLength} onChange={(event) => updateMarketSentimentSetting("smoothingLength", Number(event.target.value))} /></label>
              {marketSentimentSettings.calculationMode === "ORIGINAL_COMPOSITE" ? (
                <>
                  <div className="indicator-settings-section">Fixed OB / OS Bands</div>
                  <label>Overbought<input type="number" min={0.25} max={10} step={0.25} value={marketSentimentSettings.overbought} onChange={(event) => updateMarketSentimentSetting("overbought", Number(event.target.value))} /></label>
                  <label>Oversold<input type="number" min={0} max={9.5} step={0.25} value={marketSentimentSettings.oversold} onChange={(event) => updateMarketSentimentSetting("oversold", Number(event.target.value))} /></label>
                </>
              ) : (
                <>
                  <div className="indicator-settings-section">Adaptive Statistical Extremes</div>
                  <label>Calibration Window<input type="number" min={250} max={5000} step={50} value={marketSentimentSettings.adaptiveWindow} onChange={(event) => updateMarketSentimentSetting("adaptiveWindow", Number(event.target.value))} /></label>
                  <label>Minimum Calibration<input type="number" min={40} max={1000} step={10} value={marketSentimentSettings.minimumCalibrationSamples} onChange={(event) => updateMarketSentimentSetting("minimumCalibrationSamples", Number(event.target.value))} /></label>
                  <label>Tail Confidence %<input type="number" min={90} max={99.5} step={0.25} value={marketSentimentSettings.tailConfidence} onChange={(event) => updateMarketSentimentSetting("tailConfidence", Number(event.target.value))} /></label>
                  <label className="indicator-range-row">Trend Expansion<span><input type="range" min={0} max={2.4} step={0.1} value={marketSentimentSettings.trendExpansion} onChange={(event) => updateMarketSentimentSetting("trendExpansion", Number(event.target.value))} /><b>{marketSentimentSettings.trendExpansion.toFixed(1)}%</b></span></label>
                  <label>Dynamic Bands<input type="checkbox" checked={marketSentimentSettings.showDynamicBands} onChange={(event) => updateMarketSentimentSetting("showDynamicBands", event.target.checked)} /></label>
                  <label>Show Raw Composite<input type="checkbox" checked={marketSentimentSettings.showRawComposite} onChange={(event) => updateMarketSentimentSetting("showRawComposite", event.target.checked)} /></label>
                  <div className="indicator-settings-section">Regime & Swing Confirmation</div>
                  <label>ATR Normalization<input type="number" min={5} max={200} value={marketSentimentSettings.atrLength} onChange={(event) => updateMarketSentimentSetting("atrLength", Number(event.target.value))} /></label>
                  <label>Macro Regime Length<input type="number" min={20} max={500} value={marketSentimentSettings.regimeLength} onChange={(event) => updateMarketSentimentSetting("regimeLength", Number(event.target.value))} /></label>
                  <label>Regime Slope Length<input type="number" min={2} max={100} value={marketSentimentSettings.regimeSlopeLength} onChange={(event) => updateMarketSentimentSetting("regimeSlopeLength", Number(event.target.value))} /></label>
                  <label>Regime Threshold<input type="number" min={0.05} max={2.5} step={0.05} value={marketSentimentSettings.regimeThreshold} onChange={(event) => updateMarketSentimentSetting("regimeThreshold", Number(event.target.value))} /></label>
                  <label>Minimum Tail Dwell<input type="number" min={1} max={8} value={marketSentimentSettings.minimumTailDwell} onChange={(event) => updateMarketSentimentSetting("minimumTailDwell", Number(event.target.value))} /></label>
                  <label>Structure Confirmation<input type="checkbox" checked={marketSentimentSettings.requireStructureConfirmation} onChange={(event) => updateMarketSentimentSetting("requireStructureConfirmation", event.target.checked)} /></label>
                  <label>Structure Length<input type="number" min={2} max={50} disabled={!marketSentimentSettings.requireStructureConfirmation} value={marketSentimentSettings.structureLength} onChange={(event) => updateMarketSentimentSetting("structureLength", Number(event.target.value))} /></label>
                  <label>Signal Cooldown Bars<input type="number" min={0} max={500} value={marketSentimentSettings.signalCooldownBars} onChange={(event) => updateMarketSentimentSetting("signalCooldownBars", Number(event.target.value))} /></label>
                  {marketSentimentSettings.calculationMode === "ADAPTIVE_EVT" && (
                    <>
                      <div className="indicator-settings-section">Extreme Value Tail Model</div>
                      <label>POT Threshold %<input type="number" min={80} max={97.5} step={0.5} value={marketSentimentSettings.evtThresholdPercentile} onChange={(event) => updateMarketSentimentSetting("evtThresholdPercentile", Number(event.target.value))} /></label>
                      <label>Minimum Tail Samples<input type="number" min={12} max={250} value={marketSentimentSettings.evtMinimumTailSamples} onChange={(event) => updateMarketSentimentSetting("evtMinimumTailSamples", Number(event.target.value))} /></label>
                      <div className="vwap-mode-note">Peaks-over-threshold GPD is used only when the selected regime/window contains enough genuine prior observations. Otherwise BC-MSO remains live on its empirical percentile fallback.</div>
                    </>
                  )}
                </>
              )}
              <label>Band Fill<input type="checkbox" checked={marketSentimentSettings.showBandFill} onChange={(event) => updateMarketSentimentSetting("showBandFill", event.target.checked)} /></label>
              <label className="indicator-range-row">Band Intensity<span><input type="range" min={0} max={100} value={marketSentimentSettings.bandIntensity} onChange={(event) => updateMarketSentimentSetting("bandIntensity", Number(event.target.value))} /><b>{marketSentimentSettings.bandIntensity}</b></span></label>
              <label className="indicator-range-row">Fill Intensity<span><input type="range" min={0} max={40} value={marketSentimentSettings.bandFillIntensity} onChange={(event) => updateMarketSentimentSetting("bandFillIntensity", Number(event.target.value))} /><b>{marketSentimentSettings.bandFillIntensity}</b></span></label>
              <div className="indicator-settings-section">Black Terminal Theme</div>
              <label className="indicator-color-setting">Bullish / OS<input type="color" value={marketSentimentSettings.bullishColor} onChange={(event) => updateMarketSentimentSetting("bullishColor", event.target.value)} /></label>
              <label className="indicator-color-setting">Bearish / OB<input type="color" value={marketSentimentSettings.bearishColor} onChange={(event) => updateMarketSentimentSetting("bearishColor", event.target.value)} /></label>
              <label className="indicator-color-setting">Neutral<input type="color" value={marketSentimentSettings.neutralColor} onChange={(event) => updateMarketSentimentSetting("neutralColor", event.target.value)} /></label>
              <label className="indicator-color-setting">Line View<input type="color" value={marketSentimentSettings.lineColor} onChange={(event) => updateMarketSentimentSetting("lineColor", event.target.value)} /></label>
              <label className="indicator-range-row">Candle Intensity<span><input type="range" min={0} max={100} value={marketSentimentSettings.candleIntensity} onChange={(event) => updateMarketSentimentSetting("candleIntensity", Number(event.target.value))} /><b>{marketSentimentSettings.candleIntensity}</b></span></label>
              <label className="indicator-range-row">Line Thickness<span><input type="range" min={0.5} max={5} step={0.25} value={marketSentimentSettings.lineWidth} onChange={(event) => updateMarketSentimentSetting("lineWidth", Number(event.target.value))} /><b>{marketSentimentSettings.lineWidth.toFixed(2)}</b></span></label>
              <label className="indicator-range-row">Line Intensity<span><input type="range" min={0} max={100} value={marketSentimentSettings.lineIntensity} onChange={(event) => updateMarketSentimentSetting("lineIntensity", Number(event.target.value))} /><b>{marketSentimentSettings.lineIntensity}</b></span></label>
              <button type="button" className="tv-defaults" onClick={() => { onIndicatorAdvancedSettingsChange((current) => ({ ...current, marketSentimentOscillator: DEFAULT_MARKET_SENTIMENT_SETTINGS })); onIndicatorPeriodsChange((current) => ({ ...current, marketSentimentOscillator: DEFAULT_MARKET_SENTIMENT_SETTINGS.lookback })); }}>Defaults</button>
            </>
          )}
          {activeIndicator === "ddaProOscillator" && (
            <>
              <div className="indicator-settings-section">BC-RDA Engine</div>
              <div className="bcrda-integrity-warning">
                <strong>{ddaProSettings.signalModelVersion === BC_RDA_LEGACY_REPAINTING ? "REPAINTING RESEARCH VERSION" : "CAUSAL V2 — EXECUTION CONTAINMENT ACTIVE"}</strong>
                <span>{ddaProSettings.signalModelVersion === BC_RDA_LEGACY_REPAINTING ? "Historical signals may move as future data arrives. Alerts, statistics, backtests and automation are invalid and disabled." : "Final signals use confirmation-bar timestamps. Alerts and Strategy Lab remain blocked until the separate headless VPS runtime is certified."}</span>
              </div>
              <label>
                Signal Model
                <select value={ddaProSettings.signalModelVersion} onChange={(event) => updateDDAProSetting("signalModelVersion", event.target.value as DDAProSettings["signalModelVersion"])}>
                  <option value={BC_RDA_CAUSAL_V2}>BC-RDA Causal V2</option>
                  <option value={BC_RDA_LEGACY_REPAINTING}>Legacy Repainting · Research Only</option>
                </select>
              </label>
              <label>
                Preset
                <select value={ddaProSettings.preset} onChange={(event) => selectDDAProPreset(event.target.value as DDAProPreset)}>
                  {(["Custom", "BC-RDA — Original Compatibility", "BC-RDA — Institutional", "BC-RDA — Macro Risk"] as DDAProPreset[]).map((preset) => <option key={preset} value={preset}>{preset}</option>)}
                </select>
              </label>
              <label>
                Calculation Engine
                <select value={ddaProSettings.engineMode} onChange={(event) => updateDDAProSetting("engineMode", event.target.value as DDAProSettings["engineMode"])}>
                  <option value="black-core-native">Black Core Native</option>
                  <option value="pine-compatibility">Pine Compatibility</option>
                </select>
              </label>
              <label>
                Realtime Semantics
                <select value={ddaProSettings.realtimeMode} onChange={(event) => updateDDAProSetting("realtimeMode", event.target.value as DDAProSettings["realtimeMode"])}>
                  <option value="confirmed-bars">Confirmed Bars Only</option><option value="developing-preview">Developing Preview</option>
                </select>
              </label>
              <div className="vwap-mode-note">
                {ddaProSettings.engineMode === "pine-compatibility"
                  ? "Reproduces the supplied Pine formula, including its original percentile direction and 252-period assumptions. Exact TradingView parity remains uncertified until golden exports are supplied."
                  : "Corrected positive-depth drawdown, selectable peak reference, duration, tail risk, recovery, VADD and confidence analytics."}
              </div>
              <div className="indicator-settings-section">Advanced Signal Intelligence</div>
              <label>
                Signal Intelligence Mode
                <select value={ddaProSettings.signalIntelligenceMode} onChange={(event) => selectDDAProSignalMode(event.target.value as DDAProSignalIntelligenceMode)}>
                  <option value="RAW">Raw · Original Signals</option>
                  <option value="BALANCED">Balanced · Regime Adaptive</option>
                  <option value="INSTITUTIONAL">Institutional · High Selectivity</option>
                  <option value="CUSTOM">Custom</option>
                </select>
              </label>
              <div className="vwap-mode-note">
                RAW preserves the original BC-RDA dots exactly. Filtered modes use only causal closed-bar distribution coherence, centroid migration, tail asymmetry, expansion, entropy and episode-reset evidence.
              </div>
              <label>Show Raw Signals<input type="checkbox" checked={ddaProSettings.showRawSignals} onChange={(event) => updateDDAProSetting("showRawSignals", event.target.checked)} /></label>
              <label>Show Confirmed Signals<input type="checkbox" checked={ddaProSettings.showConfirmedSignals} onChange={(event) => updateDDAProSetting("showConfirmedSignals", event.target.checked)} /></label>
              <label>Show Provisional Signals<input type="checkbox" checked={ddaProSettings.showProvisionalSignals} onChange={(event) => updateDDAProSetting("showProvisionalSignals", event.target.checked)} /></label>
              <label>Confirmed Alerts Only<input type="checkbox" checked={ddaProSettings.confirmedAlertsOnly} onChange={(event) => updateDDAProSetting("confirmedAlertsOnly", event.target.checked)} /></label>
              <label>Show Signal Confidence<input type="checkbox" checked={ddaProSettings.showSignalConfidence} onChange={(event) => updateDDAProSetting("showSignalConfidence", event.target.checked)} /></label>
              <label>Show Regime Diagnostics<input type="checkbox" checked={ddaProSettings.showRegimeDiagnostics} onChange={(event) => updateDDAProSetting("showRegimeDiagnostics", event.target.checked)} /></label>
              <div className="vwap-mode-note">
                BC-RDA alerts are disabled during causal reconstruction. No visible, raw, provisional or confirmed marker can dispatch an alert.
              </div>
              <button type="button" className="dda-signal-reset" onClick={() => onIndicatorAdvancedSettingsChange((current) => ({ ...current, ddaProOscillator: resetDDAProSignalIntelligence(ddaProSettings) }))}>Reset Signal Intelligence Defaults</button>
              {ddaProSettings.signalIntelligenceMode === "CUSTOM" && (
                <details className="indicator-advanced-details" open>
                  <summary>Advanced Signal Arbitration</summary>
                  <label>Distribution Coherence Filter<input type="checkbox" checked={ddaProSettings.distributionCoherenceFilter} onChange={(event) => updateDDAProSetting("distributionCoherenceFilter", event.target.checked)} /></label>
                  <label>Risk-Centroid Migration<input type="checkbox" checked={ddaProSettings.riskCentroidMigration} onChange={(event) => updateDDAProSetting("riskCentroidMigration", event.target.checked)} /></label>
                  <label>Distribution Expansion<input type="checkbox" checked={ddaProSettings.distributionExpansionConfirmation} onChange={(event) => updateDDAProSetting("distributionExpansionConfirmation", event.target.checked)} /></label>
                  <label>Tail-Asymmetry Confirmation<input type="checkbox" checked={ddaProSettings.tailAsymmetryConfirmation} onChange={(event) => updateDDAProSetting("tailAsymmetryConfirmation", event.target.checked)} /></label>
                  <label>Entropy / Chop Suppression<input type="checkbox" checked={ddaProSettings.entropyChopSuppression} onChange={(event) => updateDDAProSetting("entropyChopSuppression", event.target.checked)} /></label>
                  <label>Excursion Persistence<input type="checkbox" checked={ddaProSettings.excursionPersistence} onChange={(event) => updateDDAProSetting("excursionPersistence", event.target.checked)} /></label>
                  <label>Signal Episode Clustering<input type="checkbox" checked={ddaProSettings.signalEpisodeClustering} onChange={(event) => updateDDAProSetting("signalEpisodeClustering", event.target.checked)} /></label>
                  <label>Distributional Reset Requirement<input type="checkbox" checked={ddaProSettings.distributionalResetRequirement} onChange={(event) => updateDDAProSetting("distributionalResetRequirement", event.target.checked)} /></label>
                  <label>Price-Structure Confirmation<input type="checkbox" checked={ddaProSettings.priceStructureConfirmation} onChange={(event) => updateDDAProSetting("priceStructureConfirmation", event.target.checked)} /></label>
                  <label>Volume Confirmation<input type="checkbox" checked={ddaProSettings.volumeConfirmation} onChange={(event) => updateDDAProSetting("volumeConfirmation", event.target.checked)} /></label>
                  <label>CVD Confirmation · Deferred<input type="checkbox" checked={false} disabled /></label>
                  <label>Higher-Timeframe Confirmation<input type="checkbox" checked={ddaProSettings.higherTimeframeConfirmation} onChange={(event) => updateDDAProSetting("higherTimeframeConfirmation", event.target.checked)} /></label>
                  <label>Minimum Coherence (0–100)<input type="number" min={0} max={100} value={ddaProSettings.minimumCoherence} onChange={(event) => updateDDAProSetting("minimumCoherence", Number(event.target.value))} /></label>
                  <label>Centroid Displacement (distribution widths/bar)<input type="number" min={0} max={5} step={0.005} value={ddaProSettings.minimumCentroidDisplacement} onChange={(event) => updateDDAProSetting("minimumCentroidDisplacement", Number(event.target.value))} /></label>
                  <label>Centroid Persistence (closed bars)<input type="number" min={1} max={20} value={ddaProSettings.minimumCentroidPersistence} onChange={(event) => updateDDAProSetting("minimumCentroidPersistence", Number(event.target.value))} /></label>
                  <label>Minimum Expansion (0–100)<input type="number" min={0} max={100} value={ddaProSettings.minimumExpansionScore} onChange={(event) => updateDDAProSetting("minimumExpansionScore", Number(event.target.value))} /></label>
                  <label>Minimum Tail Asymmetry (0–100)<input type="number" min={0} max={100} value={ddaProSettings.minimumTailAsymmetry} onChange={(event) => updateDDAProSetting("minimumTailAsymmetry", Number(event.target.value))} /></label>
                  <label>Maximum Chop Probability (0–100)<input type="number" min={0} max={100} value={ddaProSettings.maximumChopProbability} onChange={(event) => updateDDAProSetting("maximumChopProbability", Number(event.target.value))} /></label>
                  <label>Maximum Transition Entropy (0–100)<input type="number" min={0} max={100} value={ddaProSettings.maximumTransitionEntropy} onChange={(event) => updateDDAProSetting("maximumTransitionEntropy", Number(event.target.value))} /></label>
                  <label>Minimum Excursion Bars<input type="number" min={1} max={20} value={ddaProSettings.minimumExcursionBars} onChange={(event) => updateDDAProSetting("minimumExcursionBars", Number(event.target.value))} /></label>
                  <label>Minimum Confirmation Score<input type="number" min={0} max={100} value={ddaProSettings.minimumConfirmationScore} onChange={(event) => updateDDAProSetting("minimumConfirmationScore", Number(event.target.value))} /></label>
                  <label>Reset Tail Sensitivity (0–100)<input type="number" min={0} max={100} value={ddaProSettings.resetSensitivity} onChange={(event) => updateDDAProSetting("resetSensitivity", Number(event.target.value))} /></label>
                  <label>Episode Separation (distribution widths)<input type="number" min={0} max={5} step={0.05} value={ddaProSettings.episodeSeparationSensitivity} onChange={(event) => updateDDAProSetting("episodeSeparationSensitivity", Number(event.target.value))} /></label>
                  <label>Safety Cooldown Floor (closed bars)<input type="number" min={0} max={100} value={ddaProSettings.safetyCooldownFloor} onChange={(event) => updateDDAProSetting("safetyCooldownFloor", Number(event.target.value))} /></label>
                  <label>Structure Strength<input type="number" min={0} max={100} value={ddaProSettings.structureConfirmationStrength} onChange={(event) => updateDDAProSetting("structureConfirmationStrength", Number(event.target.value))} /></label>
                  <label>Higher-Timeframe Multiple<select value={ddaProSettings.higherTimeframeMultiplier} onChange={(event) => updateDDAProSetting("higherTimeframeMultiplier", Number(event.target.value) as 4 | 12 | 24)}><option value={4}>4×</option><option value={12}>12×</option><option value={24}>24×</option></select></label>
                  <div className="vwap-mode-note">CVD filtering is paused until the causal base model and its headless runtime pass independent certification.</div>
                </details>
              )}
              <div className="indicator-settings-section">BC-RDA Drawdown Risk Fan</div>
              <div className="vwap-mode-note">The fan remains a one-sided drawdown-distribution and downside-tail-risk visualization. Its white, gray, and red tiers indicate risk severity—not buying or selling activity.</div>
              <label>
                Analysis Source
                <select value={ddaProSettings.equitySource} onChange={(event) => updateDDAProSetting("equitySource", event.target.value as DDAProSettings["equitySource"])}>
                  <option value="price">Market Price</option>
                </select>
              </label>
              <label>
                Price Source
                <select value={ddaProSettings.source} disabled={ddaProSettings.equitySource !== "price"} onChange={(event) => updateDDAProSetting("source", event.target.value as DDAProSettings["source"])}>
                  <option value="close">Close</option><option value="hlc3">HLC3</option><option value="ohlc4">OHLC4</option>
                </select>
              </label>
              <label>
                Lookback Bars
                <select value={ddaProSettings.lookback} onChange={(event) => updateDDAProSetting("lookback", Number(event.target.value))}>
                  {[250, 500, 1000, 2500, 5000, 10000, 20000].map((value) => <option key={value} value={value}>{value.toLocaleString()}</option>)}
                  {!([250, 500, 1000, 2500, 5000, 10000, 20000] as number[]).includes(ddaProSettings.lookback) && <option value={ddaProSettings.lookback}>{ddaProSettings.lookback.toLocaleString()} (Custom)</option>}
                </select>
              </label>
              <label>
                Peak Reference
                <select value={ddaProSettings.peakMode} onChange={(event) => updateDDAProSetting("peakMode", event.target.value as DDAProSettings["peakMode"])}>
                  <option value="all-history">All Loaded History</option><option value="rolling">Rolling Lookback</option>
                </select>
              </label>
              <label>
                Smoothing
                <select value={ddaProSettings.smoothingMethod} onChange={(event) => updateDDAProSetting("smoothingMethod", event.target.value as DDAProSettings["smoothingMethod"])}>
                  <option value="none">None</option><option value="ema">EMA</option><option value="sma">SMA</option><option value="rma">RMA / Wilder</option>
                </select>
              </label>
              <label>Smoothing Length<input type="number" min={1} max={500} value={ddaProSettings.smoothingLength} onChange={(event) => updateDDAProSetting("smoothingLength", Number(event.target.value))} /></label>
              <label>
                Quantiles
                <select value={ddaProSettings.quantileMethod} onChange={(event) => updateDDAProSetting("quantileMethod", event.target.value as DDAProSettings["quantileMethod"])}>
                  <option value="type7">Type 7 (Linear)</option><option value="nearest-rank">Nearest Rank</option>
                </select>
              </label>
              <label>
                Z-Score
                <select value={ddaProSettings.zScoreMethod} onChange={(event) => updateDDAProSetting("zScoreMethod", event.target.value as DDAProSettings["zScoreMethod"])}>
                  <option value="classical">Classical Mean / Sigma</option><option value="robust">Robust Median / MAD</option>
                </select>
              </label>
              <label>Sigma Multiplier<input type="number" min={0.25} max={6} step={0.25} value={ddaProSettings.sigmaMultiplier} onChange={(event) => updateDDAProSetting("sigmaMultiplier", Number(event.target.value))} /></label>
              <label>Downside-Only Sigma<input type="checkbox" checked={ddaProSettings.downsideOnlySigma} onChange={(event) => updateDDAProSetting("downsideOnlySigma", event.target.checked)} /></label>
              <div className="indicator-settings-section">Annualization & Risk</div>
              <label>
                Annualization
                <select value={ddaProSettings.annualizationMode} onChange={(event) => updateDDAProSetting("annualizationMode", event.target.value as DDAProSettings["annualizationMode"])}>
                  <option value="auto">Auto / Crypto 365</option><option value="crypto-365">Crypto 365</option><option value="traditional-252">Traditional 252</option><option value="custom">Custom</option>
                </select>
              </label>
              {ddaProSettings.annualizationMode === "custom" && <label>Periods / Year<input type="number" min={1} max={1000000} value={ddaProSettings.customPeriodsPerYear} onChange={(event) => updateDDAProSetting("customPeriodsPerYear", Number(event.target.value))} /></label>}
              <label>Risk-Free Rate %<input type="number" min={-25} max={100} step={0.1} value={ddaProSettings.riskFreeRatePercent} onChange={(event) => updateDDAProSetting("riskFreeRatePercent", Number(event.target.value))} /></label>
              <label>VADD Volatility Floor %<input type="number" min={0.001} max={100} step={0.01} value={ddaProSettings.vaddVolatilityFloorPercent} onChange={(event) => updateDDAProSetting("vaddVolatilityFloorPercent", Number(event.target.value))} /></label>
              <label>Episode Threshold %<input type="number" min={0} max={50} step={0.1} value={ddaProSettings.drawdownEpisodeThresholdPercent} onChange={(event) => updateDDAProSetting("drawdownEpisodeThresholdPercent", Number(event.target.value))} /></label>
              <label>Risk Hysteresis<input type="number" min={0} max={20} step={0.5} value={ddaProSettings.hysteresisPercent} onChange={(event) => updateDDAProSetting("hysteresisPercent", Number(event.target.value))} /></label>
              <label>Moderate Threshold<input type="number" min={0} max={95} value={ddaProSettings.moderateThreshold} onChange={(event) => updateDDAProSetting("moderateThreshold", Number(event.target.value))} /></label>
              <label>High Threshold<input type="number" min={0} max={99} value={ddaProSettings.highThreshold} onChange={(event) => updateDDAProSetting("highThreshold", Number(event.target.value))} /></label>
              <label>Extreme Threshold<input type="number" min={0} max={100} value={ddaProSettings.extremeThreshold} onChange={(event) => updateDDAProSetting("extremeThreshold", Number(event.target.value))} /></label>
              <div className="indicator-settings-section">Risk Score Weights</div>
              <label>Depth<input type="number" min={0} max={1} step={0.05} value={ddaProSettings.depthWeight} onChange={(event) => updateDDAProSetting("depthWeight", Number(event.target.value))} /></label>
              <label>Duration<input type="number" min={0} max={1} step={0.05} value={ddaProSettings.durationWeight} onChange={(event) => updateDDAProSetting("durationWeight", Number(event.target.value))} /></label>
              <label>Worsening Velocity<input type="number" min={0} max={1} step={0.05} value={ddaProSettings.velocityWeight} onChange={(event) => updateDDAProSetting("velocityWeight", Number(event.target.value))} /></label>
              <label>VADD<input type="number" min={0} max={1} step={0.05} value={ddaProSettings.volatilityWeight} onChange={(event) => updateDDAProSetting("volatilityWeight", Number(event.target.value))} /></label>
              <label>Tail Severity<input type="number" min={0} max={1} step={0.05} value={ddaProSettings.tailWeight} onChange={(event) => updateDDAProSetting("tailWeight", Number(event.target.value))} /></label>
              <div className="vwap-mode-note">Weights are normalized at calculation time. Defaults sum to 1.00.</div>
              <details className="indicator-advanced-details">
                <summary>BC-RDA Flow Pressure · Independent Layer</summary>
                <label>Show Flow Pressure Outline<input type="checkbox" checked={ddaProSettings.showFlowPressure} onChange={(event) => updateDDAProSetting("showFlowPressure", event.target.checked)} /></label>
                <div className="vwap-mode-note">Uses only genuine classified aggressor trades. White means buying pressure, blood red means selling pressure, gray means neutral. It never recolors or changes the Drawdown Risk Fan.</div>
                <label>Pressure Smoothing<input type="number" min={1} max={100} value={ddaProSettings.flowPressureSmoothingLength} onChange={(event) => updateDDAProSetting("flowPressureSmoothingLength", Number(event.target.value))} /></label>
                <label>Robust Normalization Lookback<input type="number" min={20} max={2000} value={ddaProSettings.flowPressureNormalizationLookback} onChange={(event) => updateDDAProSetting("flowPressureNormalizationLookback", Number(event.target.value))} /></label>
                <label>Neutral Zone ±<input type="number" min={0} max={50} step={1} value={ddaProSettings.flowPressureNeutralThreshold} onChange={(event) => updateDDAProSetting("flowPressureNeutralThreshold", Number(event.target.value))} /></label>
                <label>Minimum Classified Coverage %<input type="number" min={50} max={100} step={1} value={ddaProSettings.flowPressureMinimumCoveragePercent} onChange={(event) => updateDDAProSetting("flowPressureMinimumCoveragePercent", Number(event.target.value))} /></label>
                <label>Aggressor Imbalance Weight<input type="number" min={0} max={1} step={0.05} value={ddaProSettings.flowAggressorWeight} onChange={(event) => updateDDAProSetting("flowAggressorWeight", Number(event.target.value))} /></label>
                <label>CVD Momentum Weight<input type="number" min={0} max={1} step={0.05} value={ddaProSettings.flowCvdWeight} onChange={(event) => updateDDAProSetting("flowCvdWeight", Number(event.target.value))} /></label>
                <label className="indicator-color-setting">Bullish Pressure<input type="color" value={ddaProSettings.flowBullishColor} onChange={(event) => updateDDAProSetting("flowBullishColor", event.target.value)} /></label>
                <label className="indicator-color-setting">Bearish Pressure<input type="color" value={ddaProSettings.flowBearishColor} onChange={(event) => updateDDAProSetting("flowBearishColor", event.target.value)} /></label>
                <label className="indicator-color-setting">Neutral Pressure<input type="color" value={ddaProSettings.flowNeutralColor} onChange={(event) => updateDDAProSetting("flowNeutralColor", event.target.value)} /></label>
                <label className="indicator-range-row">Flow Intensity<span><input type="range" min={0} max={100} value={ddaProSettings.flowLineIntensity} onChange={(event) => updateDDAProSetting("flowLineIntensity", Number(event.target.value))} /><b>{ddaProSettings.flowLineIntensity}</b></span></label>
                <label>Flow Line Width<input type="number" min={0.5} max={5} step={0.1} value={ddaProSettings.flowLineWidth} onChange={(event) => updateDDAProSetting("flowLineWidth", Number(event.target.value))} /></label>
                <div className="vwap-mode-note">{ddaProSnapshot ? `${ddaProSnapshot.flowAuthority} · ${ddaProSnapshot.latest.flowState} ${ddaProSnapshot.latest.flowState === "UNAVAILABLE" ? "--" : ddaProSnapshot.latest.flowPressure.toFixed(1)} · coverage ${ddaProSnapshot.latest.flowCoveragePercent.toFixed(0)}%` : "Awaiting live aggressor-flow evidence"}</div>
                {ddaProSnapshot?.flowWarning && <div className="vwap-mode-note">{ddaProSnapshot.flowWarning}</div>}
              </details>
              <div className="indicator-settings-section">Plots & Dashboard</div>
              <div className="vwap-mode-note">Pane camera: drag anywhere inside BC-RDA to pan time and risk depth. Scroll over its right-hand scale to expand or contract the value range; double-click that scale to reset.</div>
              <label>Raw Drawdown<input type="checkbox" checked={ddaProSettings.showRawDrawdown} onChange={(event) => updateDDAProSetting("showRawDrawdown", event.target.checked)} /></label>
              <label>Smoothed Drawdown<input type="checkbox" checked={ddaProSettings.showSmoothedDrawdown} onChange={(event) => updateDDAProSetting("showSmoothedDrawdown", event.target.checked)} /></label>
              <label>Distribution Mean<input type="checkbox" checked={ddaProSettings.showMean} onChange={(event) => updateDDAProSetting("showMean", event.target.checked)} /></label>
              <label>Sigma Bands<input type="checkbox" checked={ddaProSettings.showSigmaBands} onChange={(event) => updateDDAProSetting("showSigmaBands", event.target.checked)} /></label>
              <label>Quantile Bands<input type="checkbox" checked={ddaProSettings.showQuantiles} onChange={(event) => updateDDAProSetting("showQuantiles", event.target.checked)} /></label>
              <label>Risk Score Strip<input type="checkbox" checked={ddaProSettings.showRiskScore} onChange={(event) => updateDDAProSetting("showRiskScore", event.target.checked)} /></label>
              <label>Compact Dashboard<input type="checkbox" checked={ddaProSettings.showDashboard} onChange={(event) => updateDDAProSetting("showDashboard", event.target.checked)} /></label>
              <label>Expanded Metrics Table<input type="checkbox" checked={ddaProSettings.showExpandedDashboard} onChange={(event) => updateDDAProSetting("showExpandedDashboard", event.target.checked)} /></label>
              <label>Episode Markers<input type="checkbox" checked={ddaProSettings.showEpisodeMarkers} onChange={(event) => updateDDAProSetting("showEpisodeMarkers", event.target.checked)} /></label>
              <label>Velocity<input type="checkbox" checked={ddaProSettings.showVelocity} onChange={(event) => updateDDAProSetting("showVelocity", event.target.checked)} /></label>
              <label>Scale<select value={ddaProSettings.scaleMode} onChange={(event) => updateDDAProSetting("scaleMode", event.target.value as DDAProSettings["scaleMode"])}><option value="dynamic-tail">Dynamic Tail</option><option value="auto">Auto</option><option value="fixed-10">0 to -10%</option><option value="fixed-20">0 to -20%</option><option value="fixed-50">0 to -50%</option><option value="custom">Custom</option></select></label>
              {ddaProSettings.scaleMode === "custom" && <label>Custom Depth %<input type="number" min={1} max={100} value={ddaProSettings.customScaleDepthPercent} onChange={(event) => updateDDAProSetting("customScaleDepthPercent", Number(event.target.value))} /></label>}
              <label>Dashboard Position<select value={ddaProSettings.dashboardPosition} onChange={(event) => updateDDAProSetting("dashboardPosition", event.target.value as DDAProSettings["dashboardPosition"])}><option value="top-right">Top Right</option><option value="top-left">Top Left</option><option value="bottom-right">Bottom Right</option><option value="bottom-left">Bottom Left</option></select></label>
              <label>Theme<select value={ddaProSettings.theme} onChange={(event) => updateDDAProSetting("theme", event.target.value as DDAProSettings["theme"])}><option value="black-terminal">Black Terminal Institutional</option><option value="black-terminal-blood">Black Terminal Blood</option><option value="institutional-monochrome">Institutional Monochrome</option><option value="custom">Custom</option><option value="gold">Gold</option><option value="edge-tools">EdgeTools</option><option value="behavioral">Behavioral</option><option value="quant">Quant</option><option value="ocean">Ocean</option><option value="fire">Fire</option><option value="matrix">Matrix</option><option value="arctic">Arctic</option></select></label>
              <label className="indicator-color-setting">Drawdown Line<input type="color" value={ddaProSettings.smoothedColor} onChange={(event) => updateDDAProSetting("smoothedColor", event.target.value)} /></label>
              <label className="indicator-color-setting">Extreme Risk<input type="color" value={ddaProSettings.extremeColor} onChange={(event) => updateDDAProSetting("extremeColor", event.target.value)} /></label>
              <label className="indicator-range-row">Line Intensity<span><input type="range" min={0} max={100} value={ddaProSettings.lineIntensity} onChange={(event) => updateDDAProSetting("lineIntensity", Number(event.target.value))} /><b>{ddaProSettings.lineIntensity}</b></span></label>
              <label className="indicator-range-row">Risk Fill<span><input type="range" min={0} max={60} value={ddaProSettings.fillIntensity} onChange={(event) => updateDDAProSetting("fillIntensity", Number(event.target.value))} /><b>{ddaProSettings.fillIntensity}</b></span></label>
              <div className="vwap-mode-note">{ddaProStatus} · {ddaProSnapshot ? `${ddaProSnapshot.inputSize.toLocaleString()} bars · confidence ${ddaProSnapshot.latest.confidence.toFixed(0)}% · ${ddaProSnapshot.sourceAuthority}` : "Awaiting deterministic worker result"}</div>
              {ddaProSnapshot ? <div className="bcrda-integrity-panel"><strong>BC-RDA SIGNAL INTEGRITY</strong><span>Model {ddaProSnapshot.signalIntegrity.model}</span><span>Current bar {ddaProSnapshot.signalIntegrity.currentBar}</span><span>Finalized signal drift {ddaProSnapshot.signalIntegrity.finalizedSignalDrift}</span><span>Prefix {ddaProSnapshot.signalIntegrity.lastPrefixTest} · Stream/Batch {ddaProSnapshot.signalIntegrity.streamingBatchParity}</span><span>Alerts {ddaProSnapshot.signalIntegrity.alertEligibility} · Strategy {ddaProSnapshot.signalIntegrity.strategyEligibility}</span></div> : null}
              {ddaProSnapshot?.sourceWarning && <div className="vwap-mode-note">{ddaProSnapshot.sourceWarning}</div>}
              <details className="indicator-advanced-details">
                <summary>Advanced / Diagnostics</summary>
                <div className="vwap-mode-note">Engine {ddaProSnapshot?.engineVersion ?? "--"} · Protocol v1 · {ddaProWorkerRef.current?.executionMode() ?? "NOT STARTED"}</div>
                <div className="vwap-mode-note">Valid Samples {ddaProSnapshot ? Math.max(0, ddaProSnapshot.inputSize - ddaProSnapshot.validFromIndex).toLocaleString() : "--"} · Bars / Year {ddaProSnapshot?.barsPerYear.toFixed(2) ?? "--"}</div>
                <div className="vwap-mode-note">Worker Timing {ddaProWorkerRef.current?.lastCalculationTimeMs()?.toFixed(2) ?? "--"} ms · Parity {ddaProSettings.engineMode === "pine-compatibility" ? "TV GOLDEN UNVERIFIED" : "TS/PY CORE PARTIAL"}</div>
              </details>
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
              visible={visibleIndicators.liquidationHeatmap}
              onVisibleChange={(visible) => onVisibleIndicatorsChange((current) => ({ ...current, liquidationHeatmap: visible }))}
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
              className={`position-line ${line.tone}${isEditableNativeProtection(line.protection) ? " draggable" : ""}`}
              style={{ top: Number(line.y) }}
              title={`${activeChartPosition.exchange.toUpperCase()} ${activeChartPosition.symbol} ${line.label} ${formatAlertPrice(line.price)}${line.pnl === null || line.pnl === undefined ? "" : ` | P/L ${formatSignedPositionMoney(line.pnl)} USDT`} | Current P/L ${formatSignedPositionMoney(activeChartPosition.health.currentPnl)}`}
              onMouseDown={dragProtectionLine(line.protection)}
            >
              {line.pnl !== null && line.pnl !== undefined && (
                <em className={`position-line-pnl ${line.pnl >= 0 ? "positive" : "negative"}`}>{formatSignedPositionMoney(line.pnl)} USDT</em>
              )}
              <span>{line.label}</span>
              <b>{formatAlertPrice(line.price)}</b>
            </div>
          ))}
          {chartOrderLines.map(({ order, orderKey, price, y }) => (
            <div
              key={orderKey}
              className={`venue-order-line ${order.side === "sell" ? "sell" : "buy"}${isDraggableLimitOrder(order) ? " draggable" : ""}`}
              style={{ top: Number(y) }}
              title={`${order.exchange.toUpperCase()} ${order.side?.toUpperCase()} ${String(order.type || order.orderType || "ORDER").toUpperCase()} | ${formatAlertPrice(price)} | Remaining ${order.remainingQuantity ?? order.quantity ?? 0} | ${isDraggableLimitOrder(order) ? "Drag to amend" : "View only"}`}
              onMouseDown={dragOrderLine(order, price)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setChartContextMenu(null);
                setOrderContextMenu({ x: event.clientX, y: event.clientY, order });
              }}
            >
              <span>{order.exchange.toUpperCase()} {order.side?.toUpperCase()} {String(order.type || order.orderType || "ORDER").toUpperCase()}</span>
              <b>{formatAlertPrice(price)}</b>
              <em>{order.remainingQuantity ?? order.quantity ?? 0} {order.externallyCreated ? "EXTERNAL" : "BLACK TERMINAL"}</em>
            </div>
          ))}
        </div>
      )}

      {pendingProtectionChange && pendingProtectionChange.phase !== "dragging" && (
        <div className="protection-change-dialog" role="dialog" aria-modal="true" aria-label="Confirm position protection change">
          <div className="protection-change-dialog-head">
            <span>{pendingProtectionChange.type === "take-profit" ? "CHANGE TAKE PROFIT" : "CHANGE STOP LOSS"}</span>
            <b>{pendingProtectionChange.symbol}</b>
          </div>
          <div className="protection-change-prices">
            <span>Current <b>{formatAlertPrice(pendingProtectionChange.originalPrice)}</b></span>
            <span>New <b>{formatAlertPrice(pendingProtectionChange.proposedPrice)}</b></span>
          </div>
          {activeChartPosition?.id === pendingProtectionChange.positionId && (() => {
            const pnl = projectedLinearPositionPnl(activeChartPosition, pendingProtectionChange.proposedPrice);
            return pnl === null ? null : (
              <div className={`protection-change-pnl ${pnl >= 0 ? "positive" : "negative"}`}>
                Projected P/L <b>{formatSignedPositionMoney(pnl)} USDT</b>
              </div>
            );
          })()}
          <p>This submits a real Bybit position-protection update. No order is sent until you confirm.</p>
          {pendingProtectionChange.error && <div className="protection-change-error">{pendingProtectionChange.error}</div>}
          <div className="protection-change-actions">
            <button type="button" onClick={cancelPendingProtectionChange} disabled={pendingProtectionChange.phase === "submitting"}>Cancel</button>
            <button type="button" className="confirm" onClick={() => void confirmPendingProtectionChange()} disabled={pendingProtectionChange.phase === "submitting"}>
              {pendingProtectionChange.phase === "submitting" ? "Submitting…" : "Confirm"}
            </button>
          </div>
        </div>
      )}

      {pendingOrderPriceChange && pendingOrderPriceChange.phase !== "dragging" && (
        <div className="protection-change-dialog order-price-change-dialog" role="dialog" aria-modal="true" aria-label="Confirm limit order price change">
          <div className="protection-change-dialog-head">
            <span>CHANGE LIMIT ORDER</span>
            <b>{pendingOrderPriceChange.order.symbol}</b>
          </div>
          <div className="order-change-summary">
            <span>{pendingOrderPriceChange.order.exchange.toUpperCase()}</span>
            <b className={pendingOrderPriceChange.order.side === "buy" ? "buy" : "sell"}>{pendingOrderPriceChange.order.side?.toUpperCase()}</b>
            <em>{pendingOrderPriceChange.order.remainingQuantity ?? pendingOrderPriceChange.order.quantity ?? 0}</em>
          </div>
          <div className="protection-change-prices">
            <span>Current <b>{formatAlertPrice(pendingOrderPriceChange.originalPrice)}</b></span>
            <span>New <b>{formatAlertPrice(pendingOrderPriceChange.proposedPrice)}</b></span>
          </div>
          <p>This amends the real resting order at the connected venue. Nothing is submitted until you confirm.</p>
          {pendingOrderPriceChange.error && <div className="protection-change-error">{pendingOrderPriceChange.error}</div>}
          <div className="protection-change-actions">
            <button type="button" onClick={cancelPendingOrderPriceChange} disabled={["submitting", "synchronizing"].includes(pendingOrderPriceChange.phase)}>Cancel</button>
            <button type="button" className="confirm order-confirm" onClick={() => void confirmPendingOrderPriceChange()} disabled={pendingOrderPriceChange.phase !== "confirming"}>
              {pendingOrderPriceChange.phase === "submitting" ? "Submitting…" : pendingOrderPriceChange.phase === "synchronizing" ? "Synchronizing…" : "Confirm"}
            </button>
          </div>
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
        style={indicatorsCollapsed ? undefined : { top: 57 + (mountedIndicatorRows.length + activeCustomScripts.length) * 26 + 8 }}
        aria-label={indicatorsCollapsed ? "Show indicator legend" : "Collapse indicator legend"}
        onClick={() => {
          setIndicatorsCollapsed((value) => !value);
          setActiveIndicator(null);
        }}
      >
        {indicatorsCollapsed ? "v" : "^"}
      </button>
      <div ref={hostRef} className="pixi-chart-host" onContextMenu={handleChartContextMenu} onClick={() => setChartContextMenu(null)} />
      <QalcIndicatorOverlay
        active={visibleIndicators.qalc}
        symbol={displaySymbol}
        exchange={marketSymbol.exchange}
        settings={qalcSettings}
        chartEngine={engineRef.current}
        priceTransform={aifPriceTransform}
        onOpenSettings={() => setActiveIndicator("qalc")}
      />
      {oscillatorPaneVisible && oscillatorStack.panes.map((pane) => (
        <div
          key={pane.key}
          className="oscillator-pane-resizer"
          style={{ bottom: `min(${74 + pane.topOffset}px, calc(100% - 110px))` }}
          role="separator"
          aria-label={`Resize ${pane.key === "marketSentimentOscillator" ? "BC-MSO" : pane.key === "cvdOscillator" ? "BC-CVD-OSC" : pane.key === "acvdOscillator" ? "BC-ACVD" : pane.key === "ddaProOscillator" ? "BC-RDA" : pane.key === "zScoreOscillator" ? "Z-Score" : pane.key === "waveTrendOscillator" ? "WaveTrend" : "OI Osc"} pane`}
          aria-orientation="horizontal"
          onPointerDown={(event) => beginOscillatorResize(
            event,
            { kind: "native", key: pane.key },
            oscillatorPaneSettings.paneHeights[pane.key]
          )}
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
      {oscillatorPaneVisible && oscillatorStack.customPanes.map((pane) => {
        const scriptName = activeCustomScripts.find((script) => script.id === pane.scriptId)?.name ?? "custom oscillator";
        const configuredHeight = oscillatorPaneSettings.customPaneHeights[pane.scriptId]
          ?? DEFAULT_CUSTOM_OSCILLATOR_PANE_HEIGHT;
        return (
          <div
            key={`custom:${pane.scriptId}`}
            className="oscillator-pane-resizer custom-oscillator-pane-resizer"
            style={{ bottom: `min(${74 + pane.topOffset}px, calc(100% - 110px))` }}
            role="separator"
            aria-label={`Resize ${scriptName} pane`}
            aria-orientation="horizontal"
            onPointerDown={(event) => beginOscillatorResize(
              event,
              { kind: "custom", scriptId: pane.scriptId },
              configuredHeight
            )}
            onPointerMove={resizeOscillatorPane}
            onPointerUp={finishOscillatorResize}
            onPointerCancel={finishOscillatorResize}
            onDoubleClick={() => updateCustomOscillatorPaneHeight(
              pane.scriptId,
              DEFAULT_CUSTOM_OSCILLATOR_PANE_HEIGHT
            )}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <span />
          </div>
        );
      })}
      {auctionDataRequired && <>
        <AuctionProfileLegend snapshot={auctionProfileSnapshot} settings={normalizedAuctionProfileSettings} chartType={chartType} />
        {normalizedAuctionProfileSettings.diagnosticsVisible && <AuctionProfileDiagnostics snapshot={auctionProfileSnapshot} />}
        {auctionProfileLoading && <div className="auction-profile-loading"><b>BLACK CORE RADAP ENGINE</b><span>Rebuilding deterministic range × price data…</span><i /></div>}
        {auctionProfileError && <div className="auction-profile-error"><b>RADAP DATA UNAVAILABLE</b><span>{auctionProfileError}</span></div>}
      </>}

      <LiquidationFieldOverlays
        rendererMetrics={liquidationFieldRendererMetrics}
        visible={visibleIndicators.liquidationHeatmap}
        onOpenSettings={() => setActiveIndicator("liquidationHeatmap")}
        onShowContext={() => onIndicatorAdvancedSettingsChange((current) => {
          const source = migrateLiquidationFieldSettings(current.liquidationField);
          return {
            ...current,
            liquidationField: {
              ...source,
              historicalContextEnabled: true,
              strictHideBelowEnabled: false,
              contextVisibilityFloor: Math.min(25, source.contextVisibilityFloor)
            }
          };
        })}
        snapshot={liquidationFieldSnapshot}
        settings={liquidationFieldSettings}
        status={liquidationFieldStatus}
        currentPrice={lastPrice}
        priceTransform={aifPriceTransform}
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

function CustomScriptSettingsPanel({
  script,
  oscillatorPaneHeight,
  onClose,
  onApply,
  onOscillatorPaneHeightChange
}: {
  script: CompiledScriptActivation;
  oscillatorPaneHeight?: number;
  onClose: () => void;
  onApply: (values: Record<string, ScriptInputValue>) => { success: boolean; message?: string };
  onOscillatorPaneHeightChange: (height: number) => void;
}) {
  const inputs = useMemo(() => extractScriptInputs(script.source), [script.source]);
  const defaults = useMemo(
    () => Object.fromEntries(inputs.map((input) => [input.key, input.defaultValue])) as Record<string, ScriptInputValue>,
    [inputs]
  );
  const [values, setValues] = useState<Record<string, ScriptInputValue>>(() => ({ ...defaults, ...script.inputValues }));
  const [status, setStatus] = useState("");

  const apply = () => {
    const result = onApply(values);
    if (result.success) onClose();
    else setStatus(result.message || "The custom script settings could not be applied.");
  };

  return (
    <div className="indicator-settings profile-settings custom-script-settings" role="dialog" aria-modal="true" aria-label={`${script.name} settings`}>
      <div className="indicator-settings-title">
        <div>
          <span>USER {script.kind.toUpperCase()}</span>
          <strong>{script.name}</strong>
        </div>
        <button type="button" aria-label="Close custom script settings" onClick={onClose}><X size={14} /></button>
      </div>
      <div className="custom-script-settings-runtime">
        <b>{script.inputFeed === "CAUSAL_RENKO" ? "CAUSAL RENKO" : "SOURCE OHLCV"}</b>
        <span>PRIVATE OWNER RUNTIME · SAVED INPUTS</span>
      </div>
      {oscillatorPaneHeight !== undefined && (
        <div className="indicator-settings-section custom-script-pane-settings">
          <label>
            <span>Oscillator Pane Height</span>
            <input
              type="range"
              min={82}
              max={420}
              value={oscillatorPaneHeight}
              onChange={(event) => onOscillatorPaneHeightChange(Number(event.target.value))}
            />
            <b>{oscillatorPaneHeight}px</b>
          </label>
          <small>Drag the pane divider directly on the chart, or use this control. Double-click the divider to restore the default height.</small>
        </div>
      )}
      <div className="indicator-settings-section custom-script-inputs">
        {inputs.map((input) => (
          <label key={input.key} title={input.tooltip}>
            <span>{input.group ? `${input.group} / ${input.label}` : input.label}</span>
            {input.options?.length ? (
              <select
                value={String(values[input.key] ?? input.defaultValue)}
                onChange={(event) => {
                  const selected = input.options?.find((option) => String(option) === event.target.value) ?? input.defaultValue;
                  setValues((current) => ({ ...current, [input.key]: selected }));
                }}
              >
                {input.options.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
              </select>
            ) : input.type === "bool" ? (
              <input
                type="checkbox"
                checked={Boolean(values[input.key])}
                onChange={(event) => setValues((current) => ({ ...current, [input.key]: event.target.checked }))}
              />
            ) : input.type === "color" ? (
              <input
                type="color"
                value={String(values[input.key] ?? input.defaultValue)}
                onChange={(event) => setValues((current) => ({ ...current, [input.key]: event.target.value }))}
              />
            ) : input.type === "string" ? (
              <input
                type="text"
                value={String(values[input.key] ?? "")}
                onChange={(event) => setValues((current) => ({ ...current, [input.key]: event.target.value }))}
              />
            ) : (
              <input
                type="number"
                min={input.min}
                max={input.max}
                step={input.step ?? (input.type === "int" ? 1 : "any")}
                value={Number(values[input.key] ?? input.defaultValue)}
                onChange={(event) => {
                  const numeric = Number(event.target.value);
                  if (!Number.isFinite(numeric)) return;
                  setValues((current) => ({ ...current, [input.key]: input.type === "int" ? Math.round(numeric) : numeric }));
                }}
              />
            )}
          </label>
        ))}
        {inputs.length === 0 && (
          <div className="custom-script-no-inputs">
            This script has no literal input.int, input.float, input.bool, input.string, or input.color declarations. Its source can still be hidden or removed from the indicator legend.
          </div>
        )}
      </div>
      {status && <div className="custom-script-settings-status" role="alert">{status}</div>}
      <div className="tv-settings-footer">
        <button type="button" className="tv-defaults" disabled={inputs.length === 0} onClick={() => setValues(defaults)}>Defaults</button>
        <span />
        <button type="button" className="tv-cancel" onClick={onClose}>Cancel</button>
        <button type="button" className="tv-ok" onClick={apply}>Apply</button>
      </div>
    </div>
  );
}
