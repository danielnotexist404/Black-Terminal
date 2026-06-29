import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, SVGProps } from "react";
import { listen } from "@tauri-apps/api/event";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bell,
  BookOpen,
  ChartCandlestick,
  ChevronDown,
  CircleStop,
  Code2,
  Columns3,
  Crosshair,
  Eraser,
  Eye,
  EyeOff,
  LayoutDashboard,
  LineChart,
  Lock,
  Maximize2,
  Minus,
  MousePointer2,
  PanelLeft,
  PanelRight,
  Pause,
  Pencil,
  Play,
  Radar,
  Rewind,
  RotateCcw,
  Ruler,
  Save,
  Search,
  Rows3,
  Settings,
  Square,
  Trash2,
  TrendingUp,
  Type,
  Unlock
} from "lucide-react";
import { MarketStats } from "./components/MarketStats";
import { AlertCenter } from "./components/AlertCenter";
import { IndicatorLibrary } from "./components/IndicatorLibrary";
import { OrderBook } from "./components/OrderBook";
import { PixiBlackChart } from "./components/PixiBlackChart";
import { ScriptEditor } from "./components/ScriptEditor";
import { TradesTape } from "./components/TradesTape";
import LandingPage from "./components/LandingPage";
import AdminPanel from "./components/AdminPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { LogOut, Shield } from "lucide-react";
import type { IndicatorAlertDefinition } from "./automation/alerts";
import { ScannerPage } from "./modules/scanner/components/ScannerPage";
import type { ScannerResult } from "./modules/scanner/types/scanner.types";
import { StrategyLabPage } from "./modules/strategy-lab/components/StrategyLabPage";
import type { StrategyRuntimeKind } from "./modules/strategy-lab/types/strategy.types";
import type {
  ChartDisplayType,
  DrawingToolId,
  IndicatorAdvancedSettings,
  IndicatorPeriods,
  IndicatorVisualSettings,
  ReplayCommand,
  ReplayControls,
  ReplaySelection,
  ReplayStatus,
  VisibleIndicators
} from "./chart-engine/types";
import { defaultIndicatorAdvancedSettings } from "./chart-engine/profile/volumeProfileDefaults";
import { dbGetUsers, dbUpdateUser, dbAddAuditLog } from "./lib/supabase";
import { getPublicMarketDataAdapter } from "./market-data/exchangeRegistry";
import { ExchangeOption, MarketSymbolOption, marketCatalog } from "./market-data/marketCatalog";
import type { MarketSymbol, Timeframe } from "./market-data/types";

const nav = [
  { label: "WATCHLIST", icon: BookOpen },
  { label: "CHART", icon: ChartCandlestick },
  { label: "INDICATORS", icon: Activity },
  { label: "SCANNER", icon: Radar },
  { label: "ALERTS", icon: Bell },
  { label: "SCRIPT EDITOR", icon: Code2 },
  { label: "STRATEGY LAB", icon: StrategyLabIcon },
  { label: "MARKET OVERVIEW", icon: LayoutDashboard },
  { label: "SETTINGS", icon: Settings }
] as const;

function StrategyLabIcon({ size = 19, ...props }: SVGProps<SVGSVGElement> & { size?: number | string }) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="10.1" cy="3.9" r="1.05" fill="var(--red-hot)" stroke="currentColor" strokeWidth="1.35" />
      <circle cx="15.4" cy="2.8" r="0.9" fill="var(--red-hot)" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="14.1" cy="6.1" r="0.72" fill="var(--red-hot)" stroke="currentColor" strokeWidth="1.05" />
      <path d="M8 7.7h8" strokeWidth="1.75" />
      <path d="M9.25 7.7v3.3L5.85 19.1c-.55 1.32.4 2.75 1.84 2.75h8.62c1.44 0 2.39-1.43 1.84-2.75L14.75 11V7.7" strokeWidth="1.75" />
      <path d="M8.15 18.95 10.55 13h2.9l2.4 5.95c.19.48-.16 1-.67 1H8.82c-.51 0-.86-.52-.67-1Z" fill="rgba(255, 0, 0, 0.82)" stroke="rgba(255, 0, 0, 0.9)" strokeWidth="1.25" />
      <path d="M10.3 10.2h2.15M10.3 12.55h1.35M10.3 14.9h2.05" strokeWidth="1.25" />
      <circle cx="12.15" cy="16.4" r="0.82" fill="#07090b" stroke="currentColor" strokeWidth="0.9" />
      <circle cx="14.35" cy="18.25" r="0.65" fill="#07090b" stroke="currentColor" strokeWidth="0.85" />
      <path d="M7.85 18.1c.28-1.45.86-2.92 1.48-4.34" stroke="rgba(255,255,255,0.82)" strokeWidth="1" />
    </svg>
  );
}

const timeframes: { label: string; value: Timeframe }[] = [
  { label: "1m", value: "1m" },
  { label: "5m", value: "5m" },
  { label: "15m", value: "15m" },
  { label: "30m", value: "30m" },
  { label: "1H", value: "1h" },
  { label: "4H", value: "4h" },
  { label: "12H", value: "12h" },
  { label: "1D", value: "1d" },
  { label: "1W", value: "1w" },
  { label: "1M", value: "1M" }
];

const DEFAULT_ALLOWED = [
  "orderBookHeatmap",
  "liquidationHeatmap",
  "volatilityHeatmap",
  "adaptiveSwingStrategy",
  "vwap",
  "ema20",
  "ema50",
  "ema200",
  "sma20",
  "sma50",
  "bollinger",
  "openInterestOscillator",
  "zScoreOscillator",
  "waveTrendOscillator",
  "volume"
];
const ADMIN_ALLOWED = [...DEFAULT_ALLOWED, "volumeProfile"];

const defaultWorkspaces = ["Quant Desk", "Scalp Layout", "Strategy Lab"] as const;
const workspaceStorageKey = "bt_workspaces_v1";
const workspaceNamesStorageKey = "bt_workspace_names_v1";

const defaultVisibleIndicators: VisibleIndicators = {
  orderBookHeatmap: false,
  liquidationHeatmap: false,
  volatilityHeatmap: false,
  volumeProfile: false,
  adaptiveSwingStrategy: false,
  vwap: true,
  ema20: true,
  ema50: true,
  ema200: true,
  sma20: false,
  sma50: false,
  bollinger: false,
  openInterestOscillator: false,
  zScoreOscillator: false,
  waveTrendOscillator: false,
  volume: true
};

const defaultIndicatorPeriods: IndicatorPeriods = {
  volatilityHeatmap: 34,
  volumeProfile: 5000,
  ema20: 20,
  ema50: 50,
  ema200: 200,
  sma20: 20,
  sma50: 50,
  bollinger: 20,
  openInterestOscillator: 34,
  zScoreOscillator: 50,
  waveTrendOscillator: 10
};

const defaultIndicatorVisualSettings: IndicatorVisualSettings = {
  orderBookHeatmap: { color: "orange", intensity: 72 },
  liquidationHeatmap: { color: "red", intensity: 78 },
  volatilityHeatmap: { color: "green", intensity: 86 },
  volumeProfile: { color: "red", intensity: 72 },
  adaptiveSwingStrategy: { color: "green", intensity: 86 },
  vwap: { color: "gray", intensity: 58 },
  ema20: { color: "white", intensity: 62 },
  ema50: { color: "silver", intensity: 48 },
  ema200: { color: "red", intensity: 76 },
  sma20: { color: "silver", intensity: 56 },
  sma50: { color: "gray", intensity: 46 },
  bollinger: { color: "silver", intensity: 54 },
  openInterestOscillator: { color: "red", intensity: 82 },
  zScoreOscillator: { color: "white", intensity: 74 },
  waveTrendOscillator: { color: "silver", intensity: 78 },
  volume: { color: "red", intensity: 62 }
};

const chartTypes: { label: string; value: ChartDisplayType; description: string }[] = [
  { label: "Candlesticks", value: "candlesticks", description: "OHLC candles" },
  { label: "Heikin Ashi", value: "heikinAshi", description: "Smoothed OHLC transform" },
  { label: "Volume Footprint", value: "volumeFootprint", description: "Bid/ask volume profile candles" },
  { label: "Renko", value: "renko", description: "ATR-sized price bricks" },
  { label: "Hollow Candles", value: "hollow", description: "Hollow up, filled down" },
  { label: "Line", value: "line", description: "Close-price line" }
];

const drawingTools: { id: DrawingToolId; label: string; icon: LucideIcon }[] = [
  { id: "cursor", label: "Cursor / pan", icon: MousePointer2 },
  { id: "trendLine", label: "Trend line", icon: TrendingUp },
  { id: "horizontalLine", label: "Horizontal line", icon: Minus },
  { id: "verticalLine", label: "Vertical line", icon: Columns3 },
  { id: "fibonacci", label: "Fibonacci retracement", icon: Rows3 },
  { id: "rectangle", label: "Rectangle", icon: Square },
  { id: "brush", label: "Brush", icon: Pencil },
  { id: "eraser", label: "Eraser", icon: Eraser },
  { id: "text", label: "Text", icon: Type },
  { id: "measure", label: "Measure", icon: Ruler }
];

const replaySpeeds = [0.5, 1, 2, 5, 10] as const;

const defaultReplayControls: ReplayControls = {
  enabled: false,
  playing: false,
  selecting: false,
  speed: 1,
  startPercent: 70,
  commandId: 0
};

const defaultReplayStatus: ReplayStatus = {
  active: false,
  playing: false,
  selecting: false,
  index: 0,
  total: 0,
  progress: 0
};

const alertStorageKey = "bt_indicator_alerts_v1";

type MenuId = "symbol" | "exchange" | "workspace" | "timeframes" | "chartType" | null;
type ResizeTarget = "right" | "bottom" | "rightTop" | "rightSplit";
type LayoutVars = CSSProperties & {
  "--right-panel-width": string;
  "--bottom-panel-height": string;
  "--right-top-height": string;
  "--right-stats-width": string;
};

type WorkspaceSnapshot = {
  selectedExchangeId: string;
  symbolRaw: string;
  timeframe: Timeframe;
  chartType: ChartDisplayType;
  visibleIndicators: VisibleIndicators;
  indicatorPeriods: IndicatorPeriods;
  indicatorVisualSettings: IndicatorVisualSettings;
  indicatorAdvancedSettings: IndicatorAdvancedSettings;
  layout: {
    rightPanelWidth: number;
    bottomPanelHeight: number;
    rightTopHeight: number;
    rightStatsWidth: number;
  };
  activeStrategyKind?: StrategyRuntimeKind;
  updatedAt: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function makeAlertId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `alert-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toSymbolOption(symbol: MarketSymbol): MarketSymbolOption {
  return {
    ...symbol,
    label: `${symbol.baseAsset}${symbol.quoteAsset}`,
    token: symbol.baseAsset
  };
}

function loadStoredAlerts(): IndicatorAlertDefinition[] {
  if (typeof window === "undefined") return [];

  try {
    const stored = localStorage.getItem(alertStorageKey);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Failed to load indicator alerts", err);
    return [];
  }
}

function loadWorkspaceNames() {
  if (typeof window === "undefined") return [...defaultWorkspaces];
  try {
    const stored = localStorage.getItem(workspaceNamesStorageKey);
    const parsed = stored ? JSON.parse(stored) : [];
    const userNames = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
    return [...new Set([...defaultWorkspaces, ...userNames])];
  } catch {
    return [...defaultWorkspaces];
  }
}

function loadWorkspaceSnapshots(): Record<string, WorkspaceSnapshot> {
  if (typeof window === "undefined") return {};
  try {
    const stored = localStorage.getItem(workspaceStorageKey);
    const parsed = stored ? JSON.parse(stored) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<{ username: string; role: "admin" | "user"; allowedIndicators: string[] } | null>(null);
  const [activeNav, setActiveNav] = useState("CHART");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [terminalSettings, setTerminalSettings] = useState(() => {
    const stored = localStorage.getItem("bt_terminal_settings");
    if (stored) {
      try { return JSON.parse(stored); } catch (e) {}
    }
    return {
      showDOM: true,
      showOrderBookHeatmap: true,
      enabledTimeframes: ["1m", "5m", "15m", "1h", "4h", "1d"]
    };
  });

  // Bootstrap Database
  useEffect(() => {
    // Database pre-population is done automatically in supabase.ts
  }, []);

  useEffect(() => {
    localStorage.setItem("bt_terminal_settings", JSON.stringify(terminalSettings));
    setVisibleIndicators(current => ({
      ...current,
      orderBookHeatmap: terminalSettings.showOrderBookHeatmap
    }));
  }, [terminalSettings]);

  const visibleNav = useMemo(() => {
    const base = [
      { label: "WATCHLIST", icon: BookOpen },
      { label: "CHART", icon: ChartCandlestick },
      { label: "INDICATORS", icon: Activity },
      { label: "SCANNER", icon: Radar },
      { label: "ALERTS", icon: Bell },
      { label: "SCRIPT EDITOR", icon: Code2 },
      { label: "STRATEGY LAB", icon: StrategyLabIcon },
      { label: "MARKET OVERVIEW", icon: LayoutDashboard },
      { label: "SETTINGS", icon: Settings }
    ];
    if (currentUser?.role === "admin") {
      base.push({ label: "ADMIN PANEL", icon: Shield });
    }
    return base;
  }, [currentUser]);

  const handleSignOut = async () => {
    if (currentUser) {
      await dbUpdateUser(currentUser.username, { status: "offline" });
      await dbAddAuditLog("LOGOUT", `User ${currentUser.username} logged out.`);
    }
    setCurrentUser(null);
    setActiveNav("CHART");
  };
  const [selectedExchange, setSelectedExchange] = useState<ExchangeOption>(marketCatalog[0]);
  const [symbol, setSymbol] = useState<MarketSymbolOption>(marketCatalog[0].symbols[0]);
  const [availableSymbols, setAvailableSymbols] = useState<MarketSymbolOption[]>(marketCatalog[0].symbols);
  const [timeframe, setTimeframe] = useState<Timeframe>("15m");
  const [chartType, setChartType] = useState<ChartDisplayType>("candlesticks");
  const [visibleIndicators, setVisibleIndicators] = useState<VisibleIndicators>(defaultVisibleIndicators);
  const [indicatorPeriods, setIndicatorPeriods] = useState<IndicatorPeriods>(defaultIndicatorPeriods);
  const [indicatorVisualSettings, setIndicatorVisualSettings] = useState<IndicatorVisualSettings>(defaultIndicatorVisualSettings);
  const [indicatorAdvancedSettings, setIndicatorAdvancedSettings] = useState<IndicatorAdvancedSettings>(defaultIndicatorAdvancedSettings);
  const [indicatorAlerts, setIndicatorAlerts] = useState<IndicatorAlertDefinition[]>(loadStoredAlerts);
  const [activeStrategyKind, setActiveStrategyKind] = useState<StrategyRuntimeKind | undefined>();
  const [strategySelectionRevision, setStrategySelectionRevision] = useState(0);
  const [workspaces, setWorkspaces] = useState<string[]>(loadWorkspaceNames);
  const [workspace, setWorkspace] = useState<string>("Quant Desk");
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [lastPrice, setLastPrice] = useState(66678.1);
  const [openMenu, setOpenMenu] = useState<MenuId>(null);
  const [symbolQuery, setSymbolQuery] = useState("");
  const [drawingsEnabled, setDrawingsEnabled] = useState(false);
  const [activeDrawingTool, setActiveDrawingTool] = useState<DrawingToolId>("trendLine");
  const [drawingsVisible, setDrawingsVisible] = useState(true);
  const [drawingsLocked, setDrawingsLocked] = useState(false);
  const [drawingClearSignal, setDrawingClearSignal] = useState(0);
  const [crosshairEnabled, setCrosshairEnabled] = useState(true);
  const [replayControls, setReplayControls] = useState<ReplayControls>(defaultReplayControls);
  const [replayStatus, setReplayStatus] = useState<ReplayStatus>(defaultReplayStatus);
  const [layout, setLayout] = useState({
    rightPanelWidth: 366,
    bottomPanelHeight: 210,
    rightTopHeight: 430,
    rightStatsWidth: 170
  });

  const selectedTimeframe = timeframes.find((item) => item.value === timeframe) ?? timeframes[2];
  const selectedChartType = chartTypes.find((item) => item.value === chartType) ?? chartTypes[0];
  const filteredSymbols = useMemo(() => {
    const needle = symbolQuery.trim().toLowerCase();
    if (!needle) return availableSymbols;

    return availableSymbols.filter((item) =>
      [
        item.label,
        item.rawSymbol,
        item.baseAsset,
        item.quoteAsset,
        item.token,
        selectedExchange.label
      ].some((value) => value.toLowerCase().includes(needle))
    );
  }, [availableSymbols, selectedExchange.label, symbolQuery]);
  const gridStyle = useMemo<LayoutVars>(
    () => ({
      "--right-panel-width": `${layout.rightPanelWidth}px`,
      "--bottom-panel-height": `${layout.bottomPanelHeight}px`,
      "--right-top-height": `${layout.rightTopHeight}px`,
      "--right-stats-width": `${layout.rightStatsWidth}px`
    }),
    [layout]
  );

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    let unlisten: (() => void) | undefined;
    listen("bt-open-settings", () => setActiveNav("SETTINGS"))
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch((err: unknown) => {
        console.error("Failed to attach tray settings listener", err);
      });

    return () => unlisten?.();
  }, []);

  useEffect(() => {
    localStorage.setItem(alertStorageKey, JSON.stringify(indicatorAlerts));
  }, [indicatorAlerts]);

  // Real-time active indicators sync
  useEffect(() => {
    if (!currentUser) return;
    const activeList = Object.entries(visibleIndicators)
      .filter(([_, visible]) => visible === true)
      .map(([key]) => key);

    const syncActive = async () => {
      try {
        const users = await dbGetUsers();
        const userObj = users.find((u) => u.username === currentUser.username);
        if (userObj) {
          if (JSON.stringify(userObj.activeIndicators) !== JSON.stringify(activeList)) {
            await dbUpdateUser(currentUser.username, { activeIndicators: activeList });
          }
        }
      } catch (e) {
        console.error("App.tsx sync active indicators failed:", e);
      }
    };
    syncActive();
  }, [visibleIndicators, currentUser]);

  // Real-time allowed indicators sync (and automatic turn-off of revoked indicators)
  useEffect(() => {
    if (!currentUser) return;
    const interval = setInterval(async () => {
      try {
        const users = await dbGetUsers();
        const record = users.find((u) => u.username === currentUser.username);
        if (record) {
          if (JSON.stringify(record.allowedIndicators) !== JSON.stringify(currentUser.allowedIndicators)) {
            setCurrentUser(prev => prev ? { ...prev, allowedIndicators: record.allowedIndicators } : null);
            
            setVisibleIndicators(current => {
              const next = { ...current };
              let changed = false;
              Object.keys(next).forEach((key) => {
                if (next[key as keyof VisibleIndicators] && !record.allowedIndicators.includes(key)) {
                  next[key as keyof VisibleIndicators] = false;
                  changed = true;
                }
              });
              return changed ? next : current;
            });
          }
        }
      } catch (e) {
        console.error("App.tsx allowed indicators poll failed:", e);
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [currentUser]);

  useEffect(() => {
    let disposed = false;
    const fallbackSymbols = selectedExchange.symbols;
    const adapter = getPublicMarketDataAdapter(selectedExchange.id);
    setAvailableSymbols(fallbackSymbols);

    adapter
      ?.getSymbols?.(fallbackSymbols[0]?.marketKind)
      .then((symbols) => {
        if (disposed) return;
        const nextSymbols = symbols
          .filter((item) => item.quoteAsset === "USDT")
          .map(toSymbolOption)
          .sort((a, b) => a.label.localeCompare(b.label));
        if (nextSymbols.length === 0) return;
        setAvailableSymbols(nextSymbols);
        setSymbol((current) => nextSymbols.find((item) => item.rawSymbol === current.rawSymbol) ?? nextSymbols[0]);
      })
      .catch((err: unknown) => {
        console.error(`${selectedExchange.label} symbol discovery failed`, err);
      });

    return () => {
      disposed = true;
    };
  }, [selectedExchange]);

  useEffect(() => {
    if (!replayControls.enabled || !replayControls.playing || !replayStatus.active) return;
    if (replayStatus.total > 0 && replayStatus.index >= replayStatus.total - 1) {
      setReplayControls((current) => (current.playing ? { ...current, playing: false } : current));
    }
  }, [replayControls.enabled, replayControls.playing, replayStatus]);

  const startLayoutResize = useCallback(
    (target: ResizeTarget, event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      const startLayout = layout;
      const gridElement = event.currentTarget.closest(".terminal-grid") as HTMLElement | null;
      const gridRect = gridElement?.getBoundingClientRect();
      let layoutResizeFrame = 0;
      document.body.classList.add("resizing-layout");

      const notifyLayoutResize = () => {
        if (layoutResizeFrame) window.cancelAnimationFrame(layoutResizeFrame);
        layoutResizeFrame = window.requestAnimationFrame(() => {
          layoutResizeFrame = 0;
          window.dispatchEvent(new Event("black-terminal-layout-resize"));
          window.dispatchEvent(new Event("resize"));
        });
      };

      const onMove = (moveEvent: PointerEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        setLayout((current) => {
          if (target === "right") {
            const maxRight = Math.max(320, (gridRect?.width ?? window.innerWidth) - 360);
            const rightPanelWidth = clamp(startLayout.rightPanelWidth - dx, 320, maxRight);
            return {
              ...current,
              rightPanelWidth,
              rightStatsWidth: clamp(current.rightStatsWidth, 116, rightPanelWidth - 132)
            };
          }

          if (target === "bottom") {
            const maxBottom = Math.max(96, (gridRect?.height ?? window.innerHeight) - 260);
            return { ...current, bottomPanelHeight: clamp(startLayout.bottomPanelHeight - dy, 64, maxBottom) };
          }

          if (target === "rightTop") {
            const maxTop = Math.max(220, (gridRect?.height ?? window.innerHeight) - 150);
            return { ...current, rightTopHeight: clamp(startLayout.rightTopHeight + dy, 190, maxTop) };
          }

          const maxStats = Math.max(116, current.rightPanelWidth - 132);
          return { ...current, rightStatsWidth: clamp(startLayout.rightStatsWidth + dx, 116, maxStats) };
        });
        notifyLayoutResize();
      };

      const onUp = () => {
        document.body.classList.remove("resizing-layout");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        notifyLayoutResize();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp, { once: true });
    },
    [layout]
  );

  const selectExchange = (exchange: ExchangeOption) => {
    if (exchange.status === "NEXT") return;
    setSelectedExchange(exchange);
    setSymbol(exchange.symbols[0]);
    setSymbolQuery("");
    setReplayControls(defaultReplayControls);
    setReplayStatus(defaultReplayStatus);
    setOpenMenu(null);
  };

  const captureWorkspaceSnapshot = (): WorkspaceSnapshot => ({
    selectedExchangeId: selectedExchange.id,
    symbolRaw: symbol.rawSymbol,
    timeframe,
    chartType,
    visibleIndicators,
    indicatorPeriods,
    indicatorVisualSettings,
    indicatorAdvancedSettings,
    layout,
    activeStrategyKind,
    updatedAt: Date.now()
  });

  const saveWorkspace = (name = workspace) => {
    const safeName = name.trim();
    if (!safeName) return;
    const snapshots = loadWorkspaceSnapshots();
    snapshots[safeName] = captureWorkspaceSnapshot();
    localStorage.setItem(workspaceStorageKey, JSON.stringify(snapshots));
    const names = [...new Set([...workspaces, safeName])];
    setWorkspaces(names);
    localStorage.setItem(workspaceNamesStorageKey, JSON.stringify(names.filter((item) => !defaultWorkspaces.includes(item as (typeof defaultWorkspaces)[number]))));
    setWorkspace(safeName);
  };

  const createWorkspace = () => {
    const safeName = newWorkspaceName.trim();
    if (!safeName) return;
    saveWorkspace(safeName);
    setNewWorkspaceName("");
    setOpenMenu(null);
  };

  const openWorkspace = (name: string) => {
    setWorkspace(name);
    const snapshot = loadWorkspaceSnapshots()[name];
    if (snapshot) {
      const exchange = marketCatalog.find((item) => item.id === snapshot.selectedExchangeId);
      const nextSymbol = exchange?.symbols.find((item) => item.rawSymbol === snapshot.symbolRaw);
      if (exchange) setSelectedExchange(exchange);
      if (nextSymbol) setSymbol(nextSymbol);
      setTimeframe(snapshot.timeframe);
      setChartType(snapshot.chartType);
      setVisibleIndicators(snapshot.visibleIndicators);
      setIndicatorPeriods(snapshot.indicatorPeriods);
      setIndicatorVisualSettings(snapshot.indicatorVisualSettings);
      setIndicatorAdvancedSettings(snapshot.indicatorAdvancedSettings);
      setLayout(snapshot.layout);
      setActiveStrategyKind(snapshot.activeStrategyKind);
      setReplayControls(defaultReplayControls);
      setReplayStatus(defaultReplayStatus);
    }
    setOpenMenu(null);
  };

  const issueReplayCommand = (command: ReplayCommand, patch: Partial<ReplayControls> = {}) => {
    setReplayControls((current) => ({
      ...current,
      ...patch,
      command,
      commandId: current.commandId + 1
    }));
  };

  const armReplaySelection = () => {
    setOpenMenu(null);
    issueReplayCommand("select", { enabled: true, playing: false, selecting: true });
  };

  const handleReplayStartSelected = useCallback((selection: ReplaySelection) => {
    setReplayControls((current) => ({
      ...current,
      enabled: true,
      playing: false,
      selecting: false,
      selectedIndex: selection.index,
      command: "start",
      commandId: current.commandId + 1
    }));
  }, []);

  const stopReplay = () => {
    issueReplayCommand("stop", { enabled: false, playing: false, selecting: false });
  };

  const addCommunityStrategy = useCallback((strategyKind: StrategyRuntimeKind) => {
    setActiveStrategyKind(strategyKind);
    setStrategySelectionRevision((value) => value + 1);
    if (strategyKind === "builtin-adaptive-swing") {
      setVisibleIndicators((current) => ({ ...current, adaptiveSwingStrategy: true }));
    }
    setActiveNav("CHART");
  }, []);

  const toggleReplayPlayback = () => {
    setReplayControls((current) => {
      if (!current.enabled || current.selecting || current.selectedIndex === undefined) {
        return {
          ...current,
          enabled: true,
          playing: false,
          selecting: true,
          command: "select",
          commandId: current.commandId + 1
        };
      }

      return { ...current, playing: !current.playing };
    });
  };

  const openScannerResultChart = useCallback((nextSymbol: MarketSymbol, nextTimeframe: Timeframe) => {
    const nextExchange = marketCatalog.find((exchange) => exchange.id === nextSymbol.exchange);
    if (nextExchange?.status === "REST LIVE") {
      setSelectedExchange(nextExchange);
      const catalogSymbol = nextExchange.symbols.find((item) => item.rawSymbol === nextSymbol.rawSymbol) ?? toSymbolOption(nextSymbol);
      setAvailableSymbols(nextExchange.symbols);
      setSymbol(catalogSymbol);
    } else {
      setSymbol(toSymbolOption(nextSymbol));
    }
    setTimeframe(nextTimeframe);
    setReplayControls(defaultReplayControls);
    setReplayStatus(defaultReplayStatus);
    setActiveNav("CHART");
  }, []);

  const createAlertFromScannerResult = useCallback((result: ScannerResult) => {
    if (!result.lastPrice) return;
    const alert: IndicatorAlertDefinition = {
      id: makeAlertId(),
      enabled: true,
      name: `Scanner ${result.symbol} ${result.timeframe}`,
      symbol: result.symbol,
      exchange: result.exchange,
      timeframe: result.timeframe,
      indicator: "price",
      targetPrice: result.lastPrice,
      color: "#ffffff",
      condition: "testing",
      runMode: "perpetual",
      cooldownSeconds: 90,
      webhookUrl: "",
      emailTo: "",
      message: `Scanner match: ${result.symbol} ${result.timeframe} score ${result.score.toFixed(1)}. ${result.matchedConditions.map((item) => item.label).join(", ")}`,
      script: "",
      createdAt: Date.now(),
      fired: false
    };
    setIndicatorAlerts((current) => [alert, ...current]);
    setActiveNav("ALERTS");
  }, []);

  const showModuleOverlay = activeNav !== "CHART" && activeNav !== "SCRIPT EDITOR" && activeNav !== "INDICATORS" && activeNav !== "ALERTS" && activeNav !== "STRATEGY LAB" && activeNav !== "SCANNER";

  if (!currentUser) {
    return (
      <LandingPage
        onLoginSuccess={(username, role) => {
          const isUserAdmin = username === "black_terminal_admin";
          const resolvedRole = isUserAdmin ? "admin" as const : role;
          const stored = localStorage.getItem("bt_users_db");
          const users = stored ? JSON.parse(stored) : [];
          const matched = users.find((u: any) => u.username === username);
          const allowed = matched?.allowedIndicators || (resolvedRole === "admin" ? ADMIN_ALLOWED : DEFAULT_ALLOWED);
          setCurrentUser({ username, role: resolvedRole, allowedIndicators: allowed });
        }}
      />
    );
  }

  return (
    <div className={sidebarCollapsed ? "app-shell collapsed-sidebar" : "app-shell"}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden />
          <div>
            <div className="brand-title">BLACK-TERMINAL</div>
            <div className="brand-sub">BY BLACK TRIANGLE GROUP</div>
          </div>
        </div>

        <div className="menu-wrap">
          <button
            className="symbol-control"
            onClick={() => {
              setSymbolQuery("");
              setOpenMenu(openMenu === "symbol" ? null : "symbol");
            }}
          >
            <span className="coin-token">{symbol.token.slice(0, 3)}</span>
            <span>{symbol.label}</span>
            <ChevronDown size={15} />
          </button>
          {openMenu === "symbol" && (
            <div className="dropdown-menu symbol-menu">
              <label className="dropdown-search">
                <Search size={13} />
                <input
                  autoFocus
                  value={symbolQuery}
                  placeholder={`Search ${selectedExchange.label} markets`}
                  onChange={(event) => setSymbolQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setOpenMenu(null);
                      setSymbolQuery("");
                    }
                    if (event.key === "Enter" && filteredSymbols[0]) {
                      setSymbol(filteredSymbols[0]);
                      setOpenMenu(null);
                      setSymbolQuery("");
                    }
                  }}
                />
              </label>
              <div className="symbol-list">
                {filteredSymbols.map((item) => (
                  <button
                    key={item.rawSymbol}
                    className={item.rawSymbol === symbol.rawSymbol ? "menu-option selected" : "menu-option"}
                    onClick={() => {
                      setSymbol(item);
                      setSymbolQuery("");
                      setOpenMenu(null);
                    }}
                  >
                    <span className="coin-token">{item.token.slice(0, 3)}</span>
                    <span>{item.label}</span>
                    <em>{selectedExchange.label.toUpperCase()}</em>
                  </button>
                ))}
                {filteredSymbols.length === 0 && (
                  <div className="dropdown-empty">No markets found</div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="timeframes">
          {timeframes
            .filter((tf) => terminalSettings.enabledTimeframes.includes(tf.value))
            .map((tf) => (
            <button
              key={tf.value}
              className={tf.value === timeframe ? "active" : ""}
              onClick={() => setTimeframe(tf.value)}
            >
              {tf.label}
            </button>
          ))}
          <button
            className="tf-chevron"
            onClick={() => setOpenMenu(openMenu === "timeframes" ? null : "timeframes")}
          >
            <ChevronDown size={14} />
          </button>
          {openMenu === "timeframes" && (
            <div className="dropdown-menu timeframe-menu">
              {timeframes.map((tf) => (
                <button
                  key={tf.value}
                  className={tf.value === timeframe ? "menu-option selected" : "menu-option"}
                  onClick={() => {
                    setTimeframe(tf.value);
                    setOpenMenu(null);
                  }}
                >
                  <span>{tf.label}</span>
                  <em>{tf.value}</em>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="tool-cluster">
          <button
            className={crosshairEnabled ? "icon-btn active" : "icon-btn"}
            onClick={() => setCrosshairEnabled((value) => !value)}
          >
            <Crosshair size={17} />
          </button>
          <button
            className={drawingsEnabled ? "icon-btn active" : "icon-btn"}
            onClick={() => {
              setDrawingsEnabled((value) => !value);
              setOpenMenu(null);
            }}
          >
            <LineChart size={17} />
          </button>
          <div className="menu-wrap chart-type-wrap">
            <button
              className={openMenu === "chartType" ? "icon-btn active" : "icon-btn"}
              aria-label={`Chart type: ${selectedChartType.label}`}
              title={selectedChartType.label}
              onClick={() => setOpenMenu(openMenu === "chartType" ? null : "chartType")}
            >
              <ChartCandlestick size={17} />
            </button>
            {openMenu === "chartType" && (
              <div className="dropdown-menu chart-type-menu">
                {chartTypes.map((item) => (
                  <button
                    key={item.value}
                    className={item.value === chartType ? "menu-option selected" : "menu-option"}
                    onClick={() => {
                      setChartType(item.value);
                      setOpenMenu(null);
                    }}
                  >
                    <span>{item.label}</span>
                    <em>{item.description}</em>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="menu-wrap">
          <button
            className="exchange-control"
            onClick={() => setOpenMenu(openMenu === "exchange" ? null : "exchange")}
          >
            <span className="exchange-badge">{selectedExchange.label.slice(0, 2).toUpperCase()}</span>
            <span>{selectedExchange.label.toUpperCase()}</span>
            <ChevronDown size={15} />
          </button>
          {openMenu === "exchange" && (
            <div className="dropdown-menu exchange-menu">
              {marketCatalog.map((exchange) => (
                <button
                  className={exchange.id === selectedExchange.id ? "menu-option selected" : "menu-option"}
                  disabled={exchange.status === "NEXT"}
                  key={exchange.id}
                  onClick={() => selectExchange(exchange)}
                >
                  <span className="exchange-badge small">{exchange.label.slice(0, 2).toUpperCase()}</span>
                  <span>{exchange.label}</span>
                  <em>{exchange.status}</em>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="menu-wrap">
          <button
            className="workspace-control"
            onClick={() => setOpenMenu(openMenu === "workspace" ? null : "workspace")}
          >
            <span>Workspace</span>
            <strong>{workspace}</strong>
            <ChevronDown size={15} />
          </button>
          {openMenu === "workspace" && (
            <div className="dropdown-menu workspace-menu">
              {workspaces.map((item) => (
                <button
                  key={item}
                  className={item === workspace ? "menu-option selected" : "menu-option"}
                  onClick={() => openWorkspace(item)}
                >
                  <span>{item}</span>
                  <em>{item === workspace ? "ACTIVE" : "LOCAL"}</em>
                </button>
              ))}
              <div className="workspace-menu-actions">
                <button type="button" onClick={() => saveWorkspace()}>
                  <Save size={13} />
                  Save Current
                </button>
                <div>
                  <input
                    value={newWorkspaceName}
                    placeholder="New workspace"
                    onChange={(event) => setNewWorkspaceName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") createWorkspace();
                    }}
                  />
                  <button type="button" onClick={createWorkspace}>Create</button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="top-spacer" />
        <div className={replayControls.enabled ? "replay-controls active" : "replay-controls"}>
          <button
            className={replayControls.enabled ? "replay-toggle active" : "replay-toggle"}
            onClick={armReplaySelection}
            title="Click, then select a candle on the chart"
          >
            <RotateCcw size={15} />
            <span>{replayControls.selecting ? "SELECT" : "REPLAY"}</span>
          </button>
          {replayControls.enabled && (
            <>
              <button
                className="replay-icon"
                title="Rewind replay"
                onClick={() => issueReplayCommand("rewind", { enabled: true, playing: false, selecting: false })}
              >
                <Rewind size={14} />
              </button>
              <button
                className="replay-icon primary"
                title={replayControls.playing ? "Pause replay" : "Play replay"}
                onClick={toggleReplayPlayback}
              >
                {replayControls.playing ? <Pause size={14} /> : <Play size={14} />}
              </button>
              <button
                className="replay-icon"
                title="Stop replay and return live"
                onClick={stopReplay}
              >
                <CircleStop size={14} />
              </button>
              <select
                className="replay-speed"
                value={replayControls.speed}
                aria-label="Replay speed"
                onChange={(event) =>
                  setReplayControls((current) => ({
                    ...current,
                    speed: Number(event.target.value)
                  }))
                }
              >
                {replaySpeeds.map((speed) => (
                  <option key={speed} value={speed}>
                    {speed}x
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
        <div className={replayControls.enabled ? "live replay-live" : "live"}>
          {replayControls.enabled ? "REPLAY" : "LIVE"} <span />
        </div>
        <div className="latency">UP 23ms</div>
        <div className="top-separator" />
        <button className="icon-btn" onClick={() => setActiveNav("SETTINGS")}>
          <Settings size={17} />
        </button>
        <button className="icon-btn" onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>
          <PanelLeft size={17} />
        </button>
        <button className="icon-btn">
          <Columns3 size={17} />
        </button>
        <button className="icon-btn">
          <PanelRight size={17} />
        </button>
        <button className="icon-btn">
          <Maximize2 size={17} />
        </button>
      </header>

      <aside className={sidebarCollapsed ? "sidebar collapsed" : "sidebar"}>
        <div className="nav-list" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          {visibleNav.map(({ label, icon: Icon }) => (
            <button
              key={label}
              className={label === activeNav ? "nav active" : "nav"}
              onClick={() => setActiveNav(label)}
            >
              <Icon size={19} />
              <span>{label}</span>
            </button>
          ))}
          <button
            className="nav"
            style={{ marginTop: "auto", borderTop: "1px solid var(--line-soft)", paddingTop: "12px", paddingBottom: "12px" }}
            onClick={handleSignOut}
          >
            <LogOut size={19} />
            <span>SIGN OUT</span>
          </button>
        </div>
        <div className="side-watermark" aria-hidden>
          <div className="wm-mark">
            <div className="wm-triangle">
              <i className="wm-facet wm-facet-left" />
              <i className="wm-facet wm-facet-right" />
              <i className="wm-facet wm-facet-base" />
            </div>
            <svg viewBox="0 0 164 132" className="wm-arrow">
              <path
                className="wm-arrow-shaft-shadow"
                d="M12 105 L45 67 L61 80 L94 40 L111 53 L132 30"
              />
              <path
                className="wm-arrow-head-shadow"
                d="M125 25 L151 11 L143 39 L136 32 L131 31 Z"
              />
              <path
                className="wm-arrow-shaft"
                d="M12 105 L45 67 L61 80 L94 40 L111 53 L132 30"
              />
              <path
                className="wm-arrow-head"
                d="M125 25 L151 11 L143 39 L136 32 L131 31 Z"
              />
            </svg>
          </div>
          <div className="wm-wordmark">
            <strong>
              BLACK
              <br />
              TRIANGLE
            </strong>
            <span>GROUP</span>
          </div>
        </div>
      </aside>

      {activeNav === "ADMIN PANEL" ? (
        <div style={{ gridRow: "2/3", gridColumn: "2/3", overflow: "hidden" }}>
          <AdminPanel />
        </div>
      ) : activeNav === "SETTINGS" ? (
        <div style={{ gridRow: "2/3", gridColumn: "2/3", overflow: "hidden" }}>
          <SettingsPanel
            currentUser={currentUser!}
            terminalSettings={terminalSettings}
            onSettingsChange={setTerminalSettings}
            onClose={() => setActiveNav("CHART")}
          />
        </div>
      ) : (
        <main className={terminalSettings.showDOM ? "terminal-grid" : "terminal-grid hide-right-panel"} style={gridStyle}>
        <section className={drawingsEnabled ? "chart-panel drawing-tools-open" : "chart-panel"}>
          <PixiBlackChart
            marketSymbol={symbol}
            displaySymbol={symbol.label}
            exchangeLabel={selectedExchange.label}
            timeframe={timeframe}
            timeframeLabel={selectedTimeframe.label}
            chartType={chartType}
            activeDrawingTool={drawingsEnabled && !drawingsLocked ? activeDrawingTool : "cursor"}
            drawingsVisible={drawingsVisible}
            drawingsLocked={drawingsLocked}
            drawingClearSignal={drawingClearSignal}
            replayControls={replayControls}
            visibleIndicators={visibleIndicators}
            indicatorPeriods={indicatorPeriods}
            indicatorVisualSettings={indicatorVisualSettings}
            indicatorAdvancedSettings={indicatorAdvancedSettings}
            alertDefinitions={indicatorAlerts}
            onVisibleIndicatorsChange={setVisibleIndicators}
            onIndicatorPeriodsChange={setIndicatorPeriods}
            onIndicatorVisualSettingsChange={setIndicatorVisualSettings}
            onIndicatorAdvancedSettingsChange={setIndicatorAdvancedSettings}
            onAlertDefinitionsChange={setIndicatorAlerts}
            onDrawingToolRequest={(tool) => {
              setDrawingsEnabled(true);
              setActiveDrawingTool(tool);
              setActiveNav("CHART");
            }}
            onOpenAlerts={() => setActiveNav("ALERTS")}
            onOpenStrategyLab={() => setActiveNav("STRATEGY LAB")}
            onPriceChange={setLastPrice}
            onReplayStatusChange={setReplayStatus}
            onReplayStartSelected={handleReplayStartSelected}
          />
          {drawingsEnabled && (
            <div className="drawing-toolbar" aria-label="Drawing tools">
              {drawingTools.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  className={activeDrawingTool === id ? "active" : ""}
                  title={label}
                  aria-label={label}
                  onClick={() => setActiveDrawingTool(id)}
                >
                  <Icon size={18} />
                </button>
              ))}
              <span className="drawing-toolbar-separator" />
              <button
                type="button"
                className={drawingsVisible ? "soft active" : "soft"}
                title={drawingsVisible ? "Hide drawings" : "Show drawings"}
                aria-label={drawingsVisible ? "Hide drawings" : "Show drawings"}
                onClick={() => setDrawingsVisible((value) => !value)}
              >
                {drawingsVisible ? <Eye size={18} /> : <EyeOff size={18} />}
              </button>
              <button
                type="button"
                className={drawingsLocked ? "soft active" : "soft"}
                title={drawingsLocked ? "Unlock drawings" : "Lock drawings"}
                aria-label={drawingsLocked ? "Unlock drawings" : "Lock drawings"}
                onClick={() => setDrawingsLocked((value) => !value)}
              >
                {drawingsLocked ? <Lock size={18} /> : <Unlock size={18} />}
              </button>
              <button
                type="button"
                className="danger"
                title="Clear drawings"
                aria-label="Clear drawings"
                onClick={() => setDrawingClearSignal((value) => value + 1)}
              >
                <Trash2 size={18} />
              </button>
            </div>
          )}
          {activeNav === "INDICATORS" && (
            <IndicatorLibrary
              visibleIndicators={visibleIndicators}
              indicatorPeriods={indicatorPeriods}
              activeStrategyKind={activeStrategyKind}
              onVisibleIndicatorsChange={setVisibleIndicators}
              onIndicatorPeriodsChange={setIndicatorPeriods}
              onAddCommunityStrategy={addCommunityStrategy}
              onClose={() => setActiveNav("CHART")}
              onOpenScriptEditor={() => setActiveNav("SCRIPT EDITOR")}
              allowedIndicators={currentUser?.allowedIndicators || []}
            />
          )}
          {activeNav === "STRATEGY LAB" && (
            <StrategyLabPage
              marketSymbol={symbol}
              displaySymbol={symbol.label}
              exchangeLabel={selectedExchange.label}
              timeframe={timeframe}
              selectedStrategyKind={activeStrategyKind ?? "builtin-adaptive-swing"}
              strategySelectionRevision={strategySelectionRevision}
              adaptiveSwingSettings={indicatorAdvancedSettings.adaptiveSwingStrategy}
              onClose={() => setActiveNav("CHART")}
            />
          )}
          {activeNav === "SCANNER" && (
            <ScannerPage
              currentSymbol={symbol}
              selectedExchange={selectedExchange}
              timeframe={timeframe}
              onClose={() => setActiveNav("CHART")}
              onOpenChart={openScannerResultChart}
              onCreateAlert={createAlertFromScannerResult}
            />
          )}
          {showModuleOverlay && (
            <div className="module-focus">
              <span>{activeNav}</span>
              <b>{selectedExchange.label.toUpperCase()}</b>
            </div>
          )}
        </section>
        {terminalSettings.showDOM && (
          <aside className="right-panel">
            <OrderBook marketSymbol={symbol} lastPrice={lastPrice} exchangeLabel={selectedExchange.label} />
            <div className="right-stack-resizer" onPointerDown={(event) => startLayoutResize("rightTop", event)} />
            <div className="right-bottom">
              <MarketStats />
              <div className="right-bottom-resizer" onPointerDown={(event) => startLayoutResize("rightSplit", event)} />
              <TradesTape marketSymbol={symbol} exchangeLabel={selectedExchange.label} />
            </div>
          </aside>
        )}
        <section className={activeNav === "SCRIPT EDITOR" ? "bottom-panel script-mode" : activeNav === "ALERTS" ? "bottom-panel alerts-mode" : "bottom-panel"}>
          {activeNav === "SCRIPT EDITOR" ? (
            <ScriptEditor symbol={symbol.label} exchange={selectedExchange.label} />
          ) : activeNav === "ALERTS" ? (
            <AlertCenter
              alerts={indicatorAlerts}
              onAlertsChange={setIndicatorAlerts}
              symbol={symbol.label}
              exchange={selectedExchange.label}
              timeframe={timeframe}
            />
          ) : (
            <div className="bottom-blank" />
          )}
        </section>
        {terminalSettings.showDOM && (
          <div className="layout-resizer resize-main-x" onPointerDown={(event) => startLayoutResize("right", event)} />
        )}
        <div className="layout-resizer resize-main-y" onPointerDown={(event) => startLayoutResize("bottom", event)} />
      </main>
      )}

      <footer className="statusbar">
        <span className="status-item connected">
          <span className="green-dot" /> CONNECTED
        </span>
        <span>{selectedExchange.label.toUpperCase()} ({symbol.marketKind.toUpperCase()})</span>
        <span>
          SYMBOL <b>{symbol.label}</b>
        </span>
        <span>
          TF <b>{selectedTimeframe.label}</b>
        </span>
        <span>
          WORKSPACE <b>{workspace}</b>
        </span>
        <span>
          DATA <b>{selectedExchange.status}</b>
        </span>
        <span className="footer-right">HELP</span>
        <span>DOCS</span>
        <span>
          API STATUS <span className="green-dot" />
        </span>
      </footer>
    </div>
  );
}
