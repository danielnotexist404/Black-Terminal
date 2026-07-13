import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from "react";
import { Bell, Brush, Columns3, Copy, Eye, EyeOff, Minus, Play, Plus, SlidersHorizontal, Square, TrendingUp, Type, X } from "lucide-react";
import { BlackChartEngine } from "../chart-engine/BlackChartEngine";
import type { ChartPoint, IndicatorAlertLevel, IndicatorAlertLine } from "../chart-engine/BlackChartEngine";
import {
  AdaptiveSwingStrategySettings,
  Candle,
  ChartDisplayType,
  DrawingToolId,
  FeedEvent,
  IndicatorAdvancedSettings,
  IndicatorColorKey,
  IndicatorPeriods,
  IndicatorVisualSettings,
  ReplayControls,
  ReplaySelection,
  ReplayStatus,
  VisibleIndicators,
  VolumeProfileSettings
} from "../chart-engine/types";
import { defaultAdaptiveSwingStrategySettings, defaultVolumeProfileSettings } from "../chart-engine/profile/volumeProfileDefaults";
import { createMockCandles } from "../data/mockMarket";
import type { AlertCondition, AlertIndicatorTarget, IndicatorAlertDefinition } from "../automation/alerts";
import { canUseIndicator } from "../features/premium";
import { sendIndicatorAlert, sendWebhook } from "../lib/tauri";
import type { CompiledPlot } from "./ScriptCompiler";
import { getMarketDataEngineAdapter } from "../market-data/engine/marketDataEngine";
import { ExchangeId, MarketDataAdapter, MarketDataSubscription, MarketSymbol, OrderBookSnapshot, Timeframe } from "../market-data/types";
import { UnifiedExecutionTicket, type UnifiedExecutionTicketPreset } from "../execution/components/UnifiedExecutionTicket";
import type { ExecutionSource, OrderSide, OrderType } from "../execution/types";
import { blackCorePositionManager } from "../positions/positionManager";
import type { ManagedPosition, PositionProtectionOrder, PositionProtectionType } from "../positions/types";
import { AifIndicatorOverlay } from "../modules/aif/components/AifIndicatorOverlay";

type PixiBlackChartProps = {
  workspaceId: string;
  marketSymbol: MarketSymbol;
  displaySymbol: string;
  exchangeLabel: string;
  timeframe: Timeframe;
  timeframeLabel: string;
  chartType: ChartDisplayType;
  activeDrawingTool: DrawingToolId;
  drawingsVisible: boolean;
  drawingsLocked: boolean;
  drawingClearSignal: number;
  replayControls: ReplayControls;
  visibleIndicators: VisibleIndicators;
  indicatorPeriods: IndicatorPeriods;
  indicatorVisualSettings: IndicatorVisualSettings;
  indicatorAdvancedSettings: IndicatorAdvancedSettings;
  alertDefinitions: IndicatorAlertDefinition[];
  onVisibleIndicatorsChange: Dispatch<SetStateAction<VisibleIndicators>>;
  onIndicatorPeriodsChange: Dispatch<SetStateAction<IndicatorPeriods>>;
  onIndicatorVisualSettingsChange: Dispatch<SetStateAction<IndicatorVisualSettings>>;
  onIndicatorAdvancedSettingsChange: Dispatch<SetStateAction<IndicatorAdvancedSettings>>;
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
};

type IndicatorKey = keyof VisibleIndicators;
type HistoryDepth = 1000 | 2500 | 5000 | 10000;
type VolumeProfileSettingsTab = "inputs" | "style" | "visibility";
type AdaptiveSwingSettingsTab = "signals" | "engine" | "optimization" | "alerts";
type LineAlertIndicatorKey = "vwap" | "ema20" | "ema50" | "ema200";
type ChartContextMenuState = {
  x: number;
  y: number;
  point: ChartPoint;
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
  { label: "10K bars", value: 10000 }
];

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
  activeDrawingTool,
  drawingsVisible,
  drawingsLocked,
  drawingClearSignal,
  replayControls,
  visibleIndicators,
  indicatorPeriods,
  indicatorVisualSettings,
  indicatorAdvancedSettings,
  alertDefinitions,
  onVisibleIndicatorsChange,
  onIndicatorPeriodsChange,
  onIndicatorVisualSettingsChange,
  onIndicatorAdvancedSettingsChange,
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
  priceLineIntensity
}: PixiBlackChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<BlackChartEngine | null>(null);
  const [lastPrice, setLastPrice] = useState(66678.1);
  const [lastCandle, setLastCandle] = useState<Candle | null>(null);
  const [dataStatus, setDataStatus] = useState("CONNECTING");
  const [activeIndicator, setActiveIndicator] = useState<IndicatorKey | null>(null);
  const [volumeProfileSettingsTab, setVolumeProfileSettingsTab] = useState<VolumeProfileSettingsTab>("inputs");
  const [adaptiveSwingSettingsTab, setAdaptiveSwingSettingsTab] = useState<AdaptiveSwingSettingsTab>("signals");
  const [historyDepth, setHistoryDepth] = useState<HistoryDepth>(2500);
  const [indicatorsCollapsed, setIndicatorsCollapsed] = useState(false);
  const [mountedIndicators, setMountedIndicators] = useState<Record<IndicatorKey, boolean>>(() => ({ ...visibleIndicators }));
  const [alertSettings, setAlertSettings] = useState<IndicatorAlertSettings>(defaultIndicatorAlertSettings);
  const [chartContextMenu, setChartContextMenu] = useState<ChartContextMenuState | null>(null);
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
  const replayAppliedRef = useRef(false);
  const alertSettingsRef = useRef(alertSettings);
  const lastAlertSentAtRef = useRef(new Map<string, number>());
  const configuredAlertRuntimeRef = useRef(new Map<string, { lastFiredAt: number; fired: boolean }>());
  const alertToastTimerRef = useRef<number | undefined>(undefined);

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

  useEffect(() => blackCorePositionManager.subscribe(setManagedPositions), []);

  useEffect(() => {
    if (!activeChartPosition) return;
    const timer = window.setInterval(() => setPositionOverlayTick((tick) => tick + 1), 250);
    return () => window.clearInterval(timer);
  }, [activeChartPosition]);

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
    replaySourceRef.current = uniqueSortedCandles(candles).slice(-12000);
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

    replaySourceRef.current =
      last?.time === candle.time
        ? [...source.slice(0, -1), candle]
        : [...source, candle].slice(-12000);
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
      targetBars: number
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
        beforeTime = Math.min(...newCandles.map((candle) => candle.time));
        if (eligibleCandles.length < Math.min(sourcePageLimit, remaining)) break;
      }

      const history = uniqueSortedCandles(collected).slice(-targetBars);
      if (history.length === 0) {
        throw new Error(`${sourceAdapter.label} returned no historical candles`);
      }
      return history;
    };

    const fetchHistoryWindow = async (targetBars: number) => {
      if (!adapter) return [];
      return fetchHistoryWindowFrom(adapter, marketSymbol.exchange, marketSymbol.rawSymbol, targetBars);
    };

    const fetchFallbackHistoryWindow = async (targetBars: number) => {
      const failures: string[] = [];

      for (const exchange of historyFallbackOrder(marketSymbol.exchange)) {
        const sourceAdapter = getMarketDataEngineAdapter(exchange);
        if (!sourceAdapter) continue;

        try {
          const sourceSymbol = sourceAdapter.normalizeSymbol(`${marketSymbol.baseAsset}${marketSymbol.quoteAsset}`, marketSymbol.marketKind);
          const candles = await fetchHistoryWindowFrom(sourceAdapter, exchange, sourceSymbol, targetBars);
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

          replaySourceRef.current = uniqueSortedCandles([...olderCandles, ...replaySourceRef.current]).slice(-12000);
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

    const ingestTrades = (trades: { tradeId: string; price: number; quantity: number; time: number }[]) => {
      for (const trade of trades) {
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
      visibleIndicators,
      indicatorPeriods,
      indicatorVisualSettings,
      indicatorAdvancedSettings,
      alertDefinitions: scopedChartAlerts,
      customPlots: customPlots || [],
      onAlertFired: (alertId, price) => onAlertFired?.(alertId, price),
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
          else setDataStatus("MARKET DATA UNAVAILABLE - NO ADAPTER");
          return;
        }

        setDataStatus(`${adapter.label.toUpperCase()} HISTORY ${historyDepth.toLocaleString()} BARS`);
        return fetchHistoryWindow(historyDepth)
          .then((candles) => {
            if (disposed) return;
            setReplaySource(candles);
            if (!replayActiveRef.current) {
              engine.setCandles(candles);
              setDataStatus(`${adapter.label.toUpperCase()} LIVE - ${candles.length.toLocaleString()} BARS`);
            }
            startPrimaryLiveFeeds();
          })
          .catch((err: unknown) => {
            console.error(`${adapter.label} market data failed; trying cross-exchange history`, err);
            setDataStatus(`${adapter.label.toUpperCase()} HISTORY FALLBACK`);

            return fetchFallbackHistoryWindow(historyDepth)
              .then(({ candles, adapter: sourceAdapter }) => {
                if (disposed) return;
                synthesizeCandlesFromTrades = !adapter.subscribeCandles;
                historyAdapter = sourceAdapter;
                historyExchange = sourceAdapter.id;
                historySymbol = sourceAdapter.normalizeSymbol(`${marketSymbol.baseAsset}${marketSymbol.quoteAsset}`, marketSymbol.marketKind);
                historyLabel = `${adapter.label} VIA ${sourceAdapter.label}`;
                historyExhausted = false;
                lastHistoryCursor = undefined;
                setReplaySource(candles);
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
                startPrimaryLiveFeeds();
              });
          });
      })
      .catch((err: unknown) => {
        console.error("Chart engine failed to initialize", err);
        setDataStatus("ENGINE ERROR");
      });

    return () => {
      disposed = true;
      liveCandles?.unsubscribe();
      liveTrades?.unsubscribe();
      if (tradePollTimer) window.clearInterval(tradePollTimer);
      if (tickerHeartbeatTimer) window.clearInterval(tickerHeartbeatTimer);
      if (initialized) {
        engine.destroy();
      }
      engineRef.current = null;
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
    onPriceChange
  ]);

  useEffect(() => {
    if (!visibleIndicators.orderBookHeatmap) return;

    let disposed = false;
    let subscription: MarketDataSubscription<OrderBookSnapshot> | undefined;
    let pollTimer: number | undefined;
    const adapter = getMarketDataEngineAdapter(marketSymbol.exchange);
    if (!adapter) return;

    const ingestOrderBook = (book: OrderBookSnapshot) => {
      if (disposed || replayActiveRef.current) return;
      engineRef.current?.ingestOrderBookSnapshot(book);
    };

    const pollOrderBook = () => {
      if (!adapter.getOrderBookSnapshot) return;
      adapter
        .getOrderBookSnapshot(marketSymbol, 1000)
        .then((book) => {
          if (!disposed) ingestOrderBook(book);
        })
        .catch((err: unknown) => {
          console.error(`${adapter.label} order book REST heartbeat failed`, err);
        });
    };

    const startOrderBookPolling = () => {
      if (!adapter.getOrderBookSnapshot || pollTimer || disposed) return;
      pollOrderBook();
      pollTimer = window.setInterval(pollOrderBook, 1000);
    };

    if (adapter.subscribeOrderBook) {
      subscription = adapter.subscribeOrderBook(marketSymbol, ingestOrderBook);
      subscription.onError((err) => {
        console.error(`${adapter.label} order book stream failed`, err);
        subscription?.unsubscribe();
        subscription = undefined;
        startOrderBookPolling();
      });
    } else {
      startOrderBookPolling();
    }

    return () => {
      disposed = true;
      subscription?.unsubscribe();
      if (pollTimer) window.clearInterval(pollTimer);
    };
  }, [
    visibleIndicators.orderBookHeatmap,
    marketSymbol.exchange,
    marketSymbol.rawSymbol,
    marketSymbol.marketKind,
    marketSymbol.baseAsset,
    marketSymbol.quoteAsset
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
    { key: "orderBookHeatmap", label: "Book Heatmap", value: "L2 live" },
    { key: "liquidationHeatmap", label: "Liq Heatmap", value: "model" },
    { key: "volatilityHeatmap", label: "VAE Clusters", value: "top zones" },
    { key: "volumeProfile", label: "HDLX Profile", value: indicatorAdvancedSettings.volumeProfile.rangeMode === "visible" ? "visible" : `lock ${indicatorAdvancedSettings.volumeProfile.fixedRangeLength}` },
    {
      key: "adaptiveSwingStrategy",
      label: "Adaptive Swing Reversal",
      value: `L${indicatorAdvancedSettings.adaptiveSwingStrategy?.swingLookback ?? defaultAdaptiveSwingStrategySettings.swingLookback} / ATR ${indicatorAdvancedSettings.adaptiveSwingStrategy?.atrStopMultiplier ?? defaultAdaptiveSwingStrategySettings.atrStopMultiplier}`
    },
    { key: "vwap", label: "VWAP", value: "session" },
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
    if (!canUseIndicator(key)) return;
    onVisibleIndicatorsChange((current) => ({ ...current, [key]: !current[key] }));
  };

  const removeIndicator = (key: IndicatorKey) => {
    setMountedIndicators((current) => ({ ...current, [key]: false }));
    onVisibleIndicatorsChange((current) => ({ ...current, [key]: false }));
    if (activeIndicator === key) setActiveIndicator(null);
  };

  const updateIndicatorPeriod = (key: keyof IndicatorPeriods, value: number) => {
    const max = key === "volumeProfile" ? 5000 : 500;
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
        <input
          type="number"
          min={10}
          max={5000}
          step={10}
          value={volumeProfileSettings.fixedRangeLength}
          onChange={(event) => {
            const value = clampNumber(Number(event.target.value), 10, 5000);
            updateVolumeProfileSetting("fixedRangeLength", value);
            onIndicatorPeriodsChange((current) => ({ ...current, volumeProfile: value }));
          }}
        />
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
              <b className={indicator.key === "aif" || indicator.key === "ema200" || indicator.key === "volume" || indicator.key === "liquidationHeatmap" || indicator.key === "orderBookHeatmap" || indicator.key === "volatilityHeatmap" || indicator.key === "volumeProfile" || indicator.key === "adaptiveSwingStrategy" ? "red" : ""}>{indicator.value}</b>
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

      {activeIndicator && activeIndicator !== "aif" && activeIndicator !== "volumeProfile" && activeIndicator !== "adaptiveSwingStrategy" && (
        <div className="indicator-settings">
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
          {activeIndicator === "orderBookHeatmap" ? (
            <label>
              Source
              <select value="l2-depth" onChange={() => undefined}>
                <option value="l2-depth">Live L2 order book</option>
              </select>
            </label>
          ) : activeIndicator === "liquidationHeatmap" ? (
            <label>
              Model
              <select value="leverage-volume" onChange={() => undefined}>
                <option value="leverage-volume">Leverage + volume zones</option>
              </select>
            </label>
          ) : activeIndicator === "volatilityHeatmap" ? (
            <label>
              Model
              <select value="volatility-entry" onChange={() => undefined}>
                <option value="volatility-entry">Volatility-At-Entry stop clusters</option>
              </select>
            </label>
          ) : (
            <label>
              Source
              <select value="close" onChange={() => undefined}>
                <option value="close">Close</option>
                <option value="hlc3">HLC3</option>
              </select>
            </label>
          )}
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

      {activeChartPosition && positionLines.length > 0 && (
        <div className="position-protection-overlay" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
          {positionLines.map((line) => (
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
        </div>
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
      <AifIndicatorOverlay
        active={visibleIndicators.aif}
        settingsOpen={activeIndicator === "aif"}
        onCloseSettings={() => setActiveIndicator(null)}
        workspaceId={workspaceId}
        marketSymbol={marketSymbol}
        timeframe={timeframe}
        currentPrice={lastPrice}
        latestCandle={lastCandle}
      />
    </div>
  );
}
