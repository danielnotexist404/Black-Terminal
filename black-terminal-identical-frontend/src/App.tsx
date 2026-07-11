import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, SVGProps } from "react";
import { listen } from "@tauri-apps/api/event";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bell,
  BookOpen,
  Building2,
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
  Unlock,
  Bot,
  Type,
  UserRound
} from "lucide-react";
import { MarketStats } from "./components/MarketStats";
import { AlertCenter } from "./components/AlertCenter";
import { IndicatorLibrary } from "./components/IndicatorLibrary";
import { OrderBook } from "./components/OrderBook";
import { PixiBlackChart } from "./components/PixiBlackChart";
import { ScriptEditor } from "./components/ScriptEditor";
import { TradesTape } from "./components/TradesTape";
import LandingPage from "./components/LandingPage";
import { MarketOverview } from "./components/MarketOverview";
import type { CompiledPlot } from "./components/ScriptCompiler";
import AdminPanel from "./components/AdminPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import UpgradePanel from "./components/UpgradePanel";
import BlackGPT from "./components/BlackGPT";
import { LogOut, Shield } from "lucide-react";
import type { IndicatorAlertDefinition } from "./automation/alerts";
import { ScannerPage } from "./modules/scanner/components/ScannerPage";
import type { ScannerResult } from "./modules/scanner/types/scanner.types";
import { StrategyLabPage } from "./modules/strategy-lab/components/StrategyLabPage";
import PortfolioManagerPage, { PositionsWorkspace } from "./modules/portfolio-manager/components/PortfolioManagerPage";
import { ProfilePage } from "./modules/profile/components/ProfilePage";
import { InvestmentGroupsPage } from "./modules/investment-groups/components/InvestmentGroupsPage";
import { DomProWindow } from "./modules/dom-pro";
import { getPortfolioSnapshot } from "./portfolio/portfolioStore";
import type { PortfolioPosition } from "./positions/types";
import type { PortfolioSnapshot } from "./portfolio/types";
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
import { clearSupabaseAuthSession, dbGetUsers, dbUpdateUser, dbAddAuditLog } from "./lib/supabase";
import { getMarketDataEngineAdapter } from "./market-data/engine/marketDataEngine";
import { ExchangeOption, MarketSymbolOption, getExchangeOption, marketCatalog } from "./market-data/marketCatalog";
import type { ExchangeId, MarketSymbol, Timeframe } from "./market-data/types";
import { blackCoreConnectionManager } from "./connectivity/connectionManager";
import { readActiveExecutionVenueId, subscribeActiveExecutionVenue } from "./connectivity/activeExecutionVenue";
import type { ConnectionDiagnostics } from "./connectivity/types";
import type { CapabilityUser, ProductTier, TerminalCapability } from "./core/permissions/capabilities";
import { blackCoreWindowDockManager } from "./core/windows/windowDockManager";
import type { BlackCoreModuleMode } from "./core/modules/moduleRegistry";
import { PerformanceHud } from "./performance/PerformanceHud";

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
  { label: "10s", value: "10s" },
  { label: "30s", value: "30s" },
  { label: "1m", value: "1m" },
  { label: "5m", value: "5m" },
  { label: "15m", value: "15m" },
  { label: "30m", value: "30m" },
  { label: "1H", value: "1h" },
  { label: "4H", value: "4h" },
  { label: "12H", value: "12h" },
  { label: "1D", value: "1d" },
  { label: "1W", value: "1w" },
  { label: "1M", value: "1M" },
  { label: "10t", value: "10t" },
  { label: "100t", value: "100t" }
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

function isCatalogExchange(provider: string): provider is ExchangeId {
  return marketCatalog.some((exchange) => exchange.id === provider);
}

function exchangeForConnection(connection: ConnectionDiagnostics | null) {
  if (!connection) return null;
  if (isCatalogExchange(connection.provider)) return getExchangeOption(connection.provider);
  if (typeof connection.metadata.venue === "string" && isCatalogExchange(connection.metadata.venue)) {
    return getExchangeOption(connection.metadata.venue);
  }
  if (typeof connection.metadata.protocol === "string" && isCatalogExchange(connection.metadata.protocol)) {
    return getExchangeOption(connection.metadata.protocol);
  }
  return null;
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

type AppUser = CapabilityUser & {
    allowedIndicators: string[];
    displayName?: string;
    email?: string;
    emailVerified?: boolean;
    authSessionReady?: boolean;
    authSessionWarning?: string;
    productTier?: ProductTier;
    permissions?: TerminalCapability[];
    aiMessagesCount?: number;
    aiLastMessageTimestamp?: string;
};

export default function App() {
  const [currentUser, setCurrentUser] = useState<AppUser | null>(() => {
    const stored = localStorage.getItem("bt_current_user");
    if (stored) {
      try { return JSON.parse(stored); } catch (e) {}
    }
    return null;
  });

  useEffect(() => {
    if (currentUser) {
      localStorage.setItem("bt_current_user", JSON.stringify(currentUser));
    } else {
      localStorage.removeItem("bt_current_user");
    }
  }, [currentUser]);
  const [activeNav, setActiveNav] = useState(() => localStorage.getItem("bt_active_nav") || "CHART");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showRevokedPopup, setShowRevokedPopup] = useState(false);

  useEffect(() => {
    localStorage.setItem("bt_active_nav", activeNav);
  }, [activeNav]);
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
  const [domProOpen, setDomProOpen] = useState(false);
  const [domProMode, setDomProMode] = useState<BlackCoreModuleMode>("expanded");
  const [domProSettingsSignal, setDomProSettingsSignal] = useState(0);
  const showCompactDom = terminalSettings.showDOM && !domProOpen;

  useEffect(() => blackCoreWindowDockManager.subscribe((windows) => {
    const domWindow = windows.find((windowState) => windowState.moduleId === "dom-pro" && windowState.isOpen);
    setDomProOpen(Boolean(domWindow));
    if (domWindow) setDomProMode(domWindow.mode);
  }), []);

  const openDomPro = useCallback((mode: BlackCoreModuleMode = "expanded", options?: { openSettings?: boolean }) => {
    blackCoreWindowDockManager.open("dom-pro", "DOM Pro+", mode);
    if (options?.openSettings) setDomProSettingsSignal((value) => value + 1);
  }, []);

  const closeDomPro = useCallback(() => {
    blackCoreWindowDockManager.close("dom-pro");
  }, []);

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
      { label: "CHART", icon: ChartCandlestick },
      { label: "BlackGPT", icon: Bot },
      { label: "INDICATORS", icon: Activity },
      { label: "SCANNER", icon: Radar },
      { label: "POSITIONS", icon: LineChart },
      { label: "PORTFOLIO MANAGER", icon: LayoutDashboard },
      { label: "INVESTMENT GROUPS", icon: Building2 },
      { label: "PROFILE", icon: UserRound },
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
    await clearSupabaseAuthSession();
    setCurrentUser(null);
    setActiveNav("CHART");
  };
  const [selectedExchange, setSelectedExchange] = useState<ExchangeOption>(marketCatalog[0]);
  const [symbol, setSymbol] = useState<MarketSymbolOption>(() => {
    const stored = localStorage.getItem("bt_last_symbol");
    if (stored) {
      try { return JSON.parse(stored); } catch (e) {}
    }
    return marketCatalog[0].symbols[0];
  });
  const [availableSymbols, setAvailableSymbols] = useState<MarketSymbolOption[]>(marketCatalog[0].symbols);
  const [timeframe, setTimeframe] = useState<Timeframe>(() => (localStorage.getItem("bt_last_timeframe") as Timeframe) || "15m");
  const [chartType, setChartType] = useState<ChartDisplayType>(() => (localStorage.getItem("bt_last_chart_type") as ChartDisplayType) || "candlesticks");

  useEffect(() => {
    localStorage.setItem("bt_last_symbol", JSON.stringify(symbol));
  }, [symbol]);

  useEffect(() => {
    localStorage.setItem("bt_last_timeframe", timeframe);
  }, [timeframe]);

  useEffect(() => {
    localStorage.setItem("bt_last_chart_type", chartType);
  }, [chartType]);

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
  const prevPriceRef = useRef(lastPrice);
  const [recentCandles, setRecentCandles] = useState<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>>([]);
  const recentCandlesRef = useRef(recentCandles);

  // Update browser tab title with price + direction like TradingView
  useEffect(() => {
    const arrow = lastPrice >= prevPriceRef.current ? "▲" : "▼";
    const formatted = lastPrice.toLocaleString(undefined, { maximumFractionDigits: 1 });
    document.title = `${symbol.label} ${formatted} ${arrow} · Black Terminal`;
    prevPriceRef.current = lastPrice;
  }, [lastPrice, symbol.label]);

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
    rightPanelWidth: 200,
    bottomPanelHeight: 210,
    rightTopHeight: 430,
    rightStatsWidth: 80
  });

  // Advanced configurations states
  const [ping, setPing] = useState(23);
  const [watchlist, setWatchlist] = useState<string[]>(() => {
    const stored = localStorage.getItem("bt_watchlist");
    return stored ? JSON.parse(stored) : ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  });
  const [alertEventLogs, setAlertEventLogs] = useState<{ timestamp: string; symbol: string; message: string }[]>(() => {
    const stored = localStorage.getItem("bt_alert_event_logs");
    return stored ? JSON.parse(stored) : [];
  });
  const [compiledPlots, setCompiledPlots] = useState<CompiledPlot[]>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; symbol: string } | null>(null);
  const [portfolioPositions, setPortfolioPositions] = useState<PortfolioPosition[]>([]);
  const [portfolioOrders, setPortfolioOrders] = useState<PortfolioSnapshot["orders"]>([]);
  const [connectionDiagnostics, setConnectionDiagnostics] = useState<ConnectionDiagnostics[]>(() => blackCoreConnectionManager.listDiagnostics());
  const [activeExecutionVenueId, setActiveExecutionVenueIdState] = useState<string | null>(() => readActiveExecutionVenueId());

  useEffect(() => blackCoreConnectionManager.subscribe(setConnectionDiagnostics), []);
  useEffect(() => subscribeActiveExecutionVenue(setActiveExecutionVenueIdState), []);

  const activeExecutionConnection = useMemo(() => {
    const activeConnections = connectionDiagnostics.filter((connection) => !["disconnected", "offline", "unsupported"].includes(connection.status));
    return activeConnections.find((connection) => connection.id === activeExecutionVenueId) ?? null;
  }, [activeExecutionVenueId, connectionDiagnostics]);

  const lockedMarketExchange = useMemo(() => exchangeForConnection(activeExecutionConnection), [activeExecutionConnection]);
  const marketScopeLocked = Boolean(activeExecutionConnection && lockedMarketExchange);
  const exchangeMenuOptions = lockedMarketExchange ? [lockedMarketExchange] : marketCatalog;
  const marketScopeLabel = activeExecutionConnection && lockedMarketExchange
    ? `${activeExecutionConnection.label} -> ${lockedMarketExchange.label}`
    : "";

  useEffect(() => {
    if (!lockedMarketExchange) return;
    setSelectedExchange((current) => current.id === lockedMarketExchange.id ? current : lockedMarketExchange);
    setAvailableSymbols(lockedMarketExchange.symbols);
    setSymbol((current) => {
      if (current.exchange === lockedMarketExchange.id) return current;
      return lockedMarketExchange.symbols[0];
    });
    setSymbolQuery("");
    setOpenMenu((current) => current === "exchange" ? null : current);
  }, [lockedMarketExchange]);

  useEffect(() => {
    let mounted = true;

    const loadPortfolioPositions = async () => {
      const snapshot = await getPortfolioSnapshot();
      if (mounted) {
        setPortfolioPositions(snapshot.positions);
        setPortfolioOrders(snapshot.orders);
      }
    };

    void loadPortfolioPositions();
    const timer = window.setInterval(loadPortfolioPositions, 5000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, []);

  // Ping update loop
  useEffect(() => {
    const timer = setInterval(() => {
      setPing(current => {
        const delta = Math.floor(Math.random() * 7) - 3;
        return Math.max(12, Math.min(68, current + delta));
      });
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  // Save watchlist & event logs locally & Supabase
  useEffect(() => {
    localStorage.setItem("bt_watchlist", JSON.stringify(watchlist));
    localStorage.setItem("bt_alert_event_logs", JSON.stringify(alertEventLogs));
    if (currentUser) {
      dbUpdateUser(currentUser.username, { alerts: indicatorAlerts, alertEventLogs });
    }
  }, [watchlist, alertEventLogs, currentUser, indicatorAlerts]);

  // Apply theme settings
  useEffect(() => {
    if (terminalSettings.theme) {
      const newTheme = terminalSettings.theme;
      const THEMES_LIST = [
        { id: "black-terminal", accent: "#ff0000", bg: "#050607" },
        { id: "tradingview", accent: "#2962ff", bg: "#131722" },
        { id: "monochrome", accent: "#ffffff", bg: "#0a0a0a" },
        { id: "emerald", accent: "#00ff88", bg: "#050806" }
      ];
      const t = THEMES_LIST.find(item => item.id === newTheme) || THEMES_LIST[0];
      document.documentElement.style.setProperty("--red-hot", t.accent);
      document.documentElement.style.setProperty("--red", t.accent === "#ffffff" ? "#888888" : t.accent === "#2962ff" ? "#1d4ed8" : t.accent);
      document.documentElement.style.setProperty("--bg", t.bg);
      if (newTheme === "emerald") {
        document.documentElement.style.setProperty("--green", "#00ff88");
      } else {
        document.documentElement.style.setProperty("--green", "#46b866");
      }
    }
  }, [terminalSettings.theme]);

  // Watchlist favorites helper functions
  const addToWatchlist = (symbolRaw: string) => {
    if (!watchlist.includes(symbolRaw)) {
      setWatchlist([...watchlist, symbolRaw]);
    }
    setContextMenu(null);
  };

  const removeFromWatchlist = (symbolRaw: string) => {
    setWatchlist(watchlist.filter(s => s !== symbolRaw));
    setContextMenu(null);
  };

  const handleClearEventLogs = () => {
    setAlertEventLogs([]);
  };

  const handleAlertFired = (symbolVal: string, message: string) => {
    setAlertEventLogs(prev => [
      { timestamp: new Date().toLocaleTimeString(), symbol: symbolVal, message },
      ...prev.slice(0, 99)
    ]);
  };

  // Close context menu handler
  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, []);

  useEffect(() => {
    const blockContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };
    const blockBrowserShortcuts = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const modified = event.ctrlKey || event.metaKey;
      const blocked =
        (modified && ["s", "u", "p"].includes(key)) ||
        (event.ctrlKey && event.shiftKey && ["i", "j", "c"].includes(key)) ||
        event.key === "F12";

      if (blocked) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener("contextmenu", blockContextMenu);
    window.addEventListener("keydown", blockBrowserShortcuts, true);
    return () => {
      window.removeEventListener("contextmenu", blockContextMenu);
      window.removeEventListener("keydown", blockBrowserShortcuts, true);
    };
  }, []);

  const selectedTimeframe = timeframes.find((item) => item.value === timeframe) ?? timeframes[2];
  const selectedChartType = chartTypes.find((item) => item.value === chartType) ?? chartTypes[0];
  const sortedSymbols = useMemo(() => {
    const list = [...availableSymbols];
    const favorited = list.filter(item => watchlist.includes(item.rawSymbol));
    const others = list.filter(item => !watchlist.includes(item.rawSymbol));
    
    favorited.sort((a, b) => {
      return watchlist.indexOf(a.rawSymbol) - watchlist.indexOf(b.rawSymbol);
    });
    
    return [...favorited, ...others];
  }, [availableSymbols, watchlist]);

  const filteredSymbols = useMemo(() => {
    const needle = symbolQuery.trim().toLowerCase();
    if (!needle) return sortedSymbols;

    return sortedSymbols.filter((item) =>
      [
        item.label,
        item.rawSymbol,
        item.baseAsset,
        item.quoteAsset,
        item.token,
        selectedExchange.label
      ].some((value) => value.toLowerCase().includes(needle))
    );
  }, [sortedSymbols, selectedExchange.label, symbolQuery]);
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

  // Load user database configuration on boot/refresh
  useEffect(() => {
    if (!currentUser) return;
    const fetchUserConfig = async () => {
      try {
        const users = await dbGetUsers();
        const record = users.find((u) => u.username === currentUser.username);
        if (record) {
          if (record.workspaces && record.workspaces.length > 0) {
            setWorkspaces(record.workspaces);
            setWorkspace(record.activeWorkspace || "Quant Desk");
            localStorage.setItem(workspaceNamesStorageKey, JSON.stringify(record.workspaces.filter(w => !defaultWorkspaces.includes(w as any))));
            localStorage.setItem(workspaceStorageKey, JSON.stringify(record.workspaceSnapshots || {}));
            
            const activeName = record.activeWorkspace || "Quant Desk";
            const snapshot = (record.workspaceSnapshots || {})[activeName];
            if (snapshot) {
              const exchange = marketCatalog.find((item) => item.id === snapshot.selectedExchangeId);
              const nextSymbol = exchange?.symbols.find((item) => item.rawSymbol === snapshot.symbolRaw);
              if (exchange) setSelectedExchange(exchange);
              if (nextSymbol) setSymbol(nextSymbol);
              setTimeframe(snapshot.timeframe);
              setChartType(snapshot.chartType);
              
              // Sanitize active indicators against allowed list on boot
              const nextVisible = { ...snapshot.visibleIndicators };
              Object.keys(nextVisible).forEach((k) => {
                if (nextVisible[k as keyof VisibleIndicators] && !record.allowedIndicators.includes(k)) {
                  nextVisible[k as keyof VisibleIndicators] = false;
                }
              });
              setVisibleIndicators(nextVisible);
              
              setIndicatorPeriods(snapshot.indicatorPeriods);
              setIndicatorVisualSettings(snapshot.indicatorVisualSettings);
              setIndicatorAdvancedSettings(snapshot.indicatorAdvancedSettings);
              setLayout(snapshot.layout);
              setActiveStrategyKind(snapshot.activeStrategyKind);
            }
          }
          if (record.alerts) {
            setIndicatorAlerts(record.alerts);
            localStorage.setItem("bt_stored_alerts", JSON.stringify(record.alerts));
          }
          if (record.alertEventLogs) {
            setAlertEventLogs(record.alertEventLogs);
            localStorage.setItem("bt_alert_event_logs", JSON.stringify(record.alertEventLogs));
          }
        }
      } catch (e) {
        console.error("Failed to load user config from database:", e);
      }
    };
    fetchUserConfig();
  }, [currentUser?.username]);

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
            
            let wasRevoked = false;
            setVisibleIndicators(current => {
              const next = { ...current };
              let changed = false;
              Object.keys(next).forEach((key) => {
                if (next[key as keyof VisibleIndicators] && !record.allowedIndicators.includes(key)) {
                  next[key as keyof VisibleIndicators] = false;
                  changed = true;
                  wasRevoked = true;
                }
              });
              if (changed) {
                // Update database active indicators immediately
                const nextActiveList = Object.keys(next).filter(k => next[k as keyof VisibleIndicators]);
                dbUpdateUser(currentUser.username, { activeIndicators: nextActiveList });
                return next;
              }
              return current;
            });

            if (wasRevoked) {
              setShowRevokedPopup(true);
            }
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
    const adapter = getMarketDataEngineAdapter(selectedExchange.id);
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
            const maxRight = Math.max(160, (gridRect?.width ?? window.innerWidth) - 200);
            const rightPanelWidth = clamp(startLayout.rightPanelWidth - dx, 160, maxRight);
            return {
              ...current,
              rightPanelWidth,
              rightStatsWidth: clamp(current.rightStatsWidth, 40, rightPanelWidth - 60)
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

          const maxStats = Math.max(40, current.rightPanelWidth - 60);
          return { ...current, rightStatsWidth: clamp(startLayout.rightStatsWidth + dx, 40, maxStats) };
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
    if (lockedMarketExchange && exchange.id !== lockedMarketExchange.id) return;
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

  const saveWorkspace = async (name = workspace) => {
    const safeName = name.trim();
    if (!safeName) return;
    const snapshots = loadWorkspaceSnapshots();
    snapshots[safeName] = captureWorkspaceSnapshot();
    localStorage.setItem(workspaceStorageKey, JSON.stringify(snapshots));
    const names = [...new Set([...workspaces, safeName])];
    setWorkspaces(names);
    localStorage.setItem(workspaceNamesStorageKey, JSON.stringify(names.filter((item) => !defaultWorkspaces.includes(item as (typeof defaultWorkspaces)[number]))));
    setWorkspace(safeName);

    // Backend sync
    if (currentUser) {
      try {
        await dbUpdateUser(currentUser.username, {
          workspaces: names,
          workspaceSnapshots: snapshots,
          activeWorkspace: safeName
        });
      } catch (err) {
        console.error("Failed to sync workspace to backend:", err);
      }
    }
  };

  const deleteWorkspace = async (name = workspace) => {
    if (defaultWorkspaces.includes(name as any)) {
      alert("Cannot delete default workspaces");
      return;
    }
    
    const confirmDelete = window.confirm(`Are you sure you want to delete the selected workspace "${name}"?`);
    if (!confirmDelete) return;

    const nextWorkspaces = workspaces.filter(w => w !== name);
    const snapshots = loadWorkspaceSnapshots();
    delete snapshots[name];

    localStorage.setItem(workspaceStorageKey, JSON.stringify(snapshots));
    localStorage.setItem(workspaceNamesStorageKey, JSON.stringify(nextWorkspaces.filter((item) => !defaultWorkspaces.includes(item as (typeof defaultWorkspaces)[number]))));
    setWorkspaces(nextWatchlist => nextWorkspaces);

    const fallback = defaultWorkspaces[0];
    openWorkspace(fallback);

    // Backend sync
    if (currentUser) {
      try {
        await dbUpdateUser(currentUser.username, {
          workspaces: nextWorkspaces,
          workspaceSnapshots: snapshots,
          activeWorkspace: fallback
        });
      } catch (err) {
        console.error("Failed to delete workspace from backend:", err);
      }
    }
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
    if (lockedMarketExchange && nextExchange?.id !== lockedMarketExchange.id) return;
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
  }, [lockedMarketExchange]);

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

  const showModuleOverlay = activeNav !== "CHART" && activeNav !== "SCRIPT EDITOR" && activeNav !== "INDICATORS" && activeNav !== "ALERTS" && activeNav !== "STRATEGY LAB" && activeNav !== "SCANNER" && activeNav !== "POSITIONS" && activeNav !== "PORTFOLIO MANAGER" && activeNav !== "PROFILE" && activeNav !== "INVESTMENT GROUPS";

  if (!currentUser) {
    return (
      <LandingPage
        onLoginSuccess={async (username, role) => {
          const resolvedRole = role;
          const users = await dbGetUsers();
          const matched = users.find((u: any) => u.username === username);
          const allowed = matched?.allowedIndicators || (resolvedRole === "admin" ? ADMIN_ALLOWED : DEFAULT_ALLOWED);
          
          if (matched) {
            if (matched.workspaces && matched.workspaces.length > 0) {
              setWorkspaces(matched.workspaces);
              setWorkspace(matched.activeWorkspace || "Quant Desk");
              localStorage.setItem(workspaceNamesStorageKey, JSON.stringify(matched.workspaces.filter(w => !defaultWorkspaces.includes(w as any))));
              localStorage.setItem(workspaceStorageKey, JSON.stringify(matched.workspaceSnapshots || {}));
            }
            if (matched.alerts) {
              setIndicatorAlerts(matched.alerts);
              localStorage.setItem("bt_stored_alerts", JSON.stringify(matched.alerts));
            }
            if (matched.alertEventLogs) {
              setAlertEventLogs(matched.alertEventLogs);
              localStorage.setItem("bt_alert_event_logs", JSON.stringify(matched.alertEventLogs));
            }
          }
          
          setCurrentUser({
            username,
            displayName: matched?.displayName,
            email: matched?.email,
            emailVerified: matched?.emailVerified,
            authSessionReady: matched?.emailVerified,
            role: resolvedRole,
            allowedIndicators: allowed,
            productTier: (matched as any)?.productTier,
            permissions: (matched as any)?.permissions
          });
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
            className={marketScopeLocked ? "symbol-control locked" : "symbol-control"}
            title={marketScopeLocked ? `Markets locked to ${marketScopeLabel}` : undefined}
            onClick={() => {
              setSymbolQuery("");
              setOpenMenu(openMenu === "symbol" ? null : "symbol");
            }}
          >
            <span className="coin-token">{symbol.token.slice(0, 3)}</span>
            <span>{symbol.label}</span>
            {marketScopeLocked && <Lock size={12} />}
            <ChevronDown size={15} />
          </button>
          {openMenu === "symbol" && (
            <div className="dropdown-menu symbol-menu">
              {marketScopeLocked && (
                <div className="dropdown-scope-lock">
                  <Lock size={12} />
                  <span>MARKETS LOCKED TO {lockedMarketExchange?.label.toUpperCase()}</span>
                </div>
              )}
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
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenu({
                        x: e.clientX,
                        y: e.clientY,
                        symbol: item.rawSymbol
                      });
                    }}
                    draggable={watchlist.includes(item.rawSymbol)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", item.rawSymbol);
                    }}
                    onDragOver={(e) => {
                      if (watchlist.includes(item.rawSymbol)) {
                        e.preventDefault();
                      }
                    }}
                    onDrop={(e) => {
                      const draggedSymbol = e.dataTransfer.getData("text/plain");
                      const targetSymbol = item.rawSymbol;
                      if (draggedSymbol && draggedSymbol !== targetSymbol && watchlist.includes(targetSymbol)) {
                        const nextWatchlist = [...watchlist];
                        const draggedIndex = nextWatchlist.indexOf(draggedSymbol);
                        const targetIndex = nextWatchlist.indexOf(targetSymbol);
                        if (draggedIndex !== -1 && targetIndex !== -1) {
                          nextWatchlist.splice(draggedIndex, 1);
                          nextWatchlist.splice(targetIndex, 0, draggedSymbol);
                          setWatchlist(nextWatchlist);
                        }
                      }
                    }}
                    style={{ cursor: watchlist.includes(item.rawSymbol) ? "grab" : "pointer" }}
                  >
                    <span className="coin-token">
                      {watchlist.includes(item.rawSymbol) && (
                        <span style={{ color: "var(--red-hot)", marginRight: "6px" }}>★</span>
                      )}
                      {item.token.slice(0, 3)}
                    </span>
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
            className={marketScopeLocked ? "exchange-control locked" : "exchange-control"}
            title={marketScopeLocked ? `Exchange locked by ${marketScopeLabel}` : undefined}
            onClick={() => setOpenMenu(openMenu === "exchange" ? null : "exchange")}
          >
            <span className="exchange-badge">{selectedExchange.label.slice(0, 2).toUpperCase()}</span>
            <span>{selectedExchange.label.toUpperCase()}</span>
            {marketScopeLocked && <Lock size={12} />}
            <ChevronDown size={15} />
          </button>
          {openMenu === "exchange" && (
            <div className="dropdown-menu exchange-menu">
              {marketScopeLocked && (
                <div className="dropdown-scope-lock">
                  <Lock size={12} />
                  <span>LINKED ACCOUNT SCOPE</span>
                </div>
              )}
              {exchangeMenuOptions.map((exchange) => (
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
                {!defaultWorkspaces.includes(workspace as any) && (
                  <button type="button" className="delete-workspace-btn" style={{
                    width: "100%",
                    height: "30px",
                    background: "rgba(255, 0, 0, 0.08)",
                    border: "1px solid rgba(255, 0, 0, 0.25)",
                    color: "var(--red-hot)",
                    fontSize: "10px",
                    fontFamily: "IBM Plex Mono, monospace",
                    fontWeight: 600,
                    borderRadius: "3px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "6px",
                    marginBottom: "8px",
                    transition: "all 0.2s"
                  }} onClick={() => deleteWorkspace()}>
                    <Trash2 size={13} />
                    Delete Workspace
                  </button>
                )}
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
        {replayControls.enabled && (
          <div className="live replay-live">
            REPLAY <span />
          </div>
        )}
        <div className="latency">UP {ping}ms</div>
        {currentUser?.role !== "admin" && (
          <button className="upgrade-btn" onClick={() => setActiveNav("UPGRADE")}>
            UPGRADE
          </button>
        )}
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
              style={{ position: "relative" }}
            >
              <Icon size={19} />
              <span>{label}</span>
              {label === "BlackGPT" && (
                <span style={{
                  position: "absolute",
                  right: "12px",
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "rgba(0, 255, 102, 0.15)",
                  border: "1px solid #00ff66",
                  color: "#00ff66",
                  fontSize: "8px",
                  fontWeight: 800,
                  padding: "1px 4px",
                  borderRadius: "2px",
                  fontFamily: "IBM Plex Mono",
                  letterSpacing: "0.5px",
                  animation: "pulse 1.5s infinite"
                }}>
                  NEW
                </span>
              )}
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
      ) : activeNav === "UPGRADE" ? (
        <div style={{ gridRow: "2/3", gridColumn: "2/3", overflow: "hidden" }}>
          <UpgradePanel
            currentUser={currentUser!}
            onClose={() => setActiveNav("CHART")}
            onUpgradeSuccess={() => {
              // Reload current user details to update roles and indicators in context
              dbGetUsers().then(users => {
                const updated = users.find(u => u.username === currentUser?.username);
                if (updated) setCurrentUser(updated);
              });
            }}
          />
        </div>
      ) : activeNav === "BlackGPT" ? (
        <div style={{ gridRow: "2/3", gridColumn: "2/3", overflow: "hidden" }}>
          <BlackGPT
            currentUser={currentUser!}
            onUserUpdate={setCurrentUser}
            workspace={workspace}
            symbol={symbol.label}
            price={lastPrice}
            timeframe={selectedTimeframe.label}
            exchange={selectedExchange.label}
            activeIndicators={Object.keys(visibleIndicators).filter(k => visibleIndicators[k as keyof typeof visibleIndicators])}
            recentCandles={recentCandles}
          />
        </div>
      ) : activeNav === "PORTFOLIO MANAGER" ? (
        <div style={{ gridRow: "2/3", gridColumn: "2/3", overflow: "hidden" }}>
          <PortfolioManagerPage onClose={() => setActiveNav("CHART")} currentUser={currentUser} />
        </div>
      ) : activeNav === "PROFILE" ? (
        <div style={{ gridRow: "2/3", gridColumn: "2/3", overflow: "hidden" }}>
          <ProfilePage
            currentUser={currentUser}
            onClose={() => setActiveNav("CHART")}
            onOpenInvestmentGroups={() => setActiveNav("INVESTMENT GROUPS")}
          />
        </div>
      ) : activeNav === "INVESTMENT GROUPS" ? (
        <div style={{ gridRow: "2/3", gridColumn: "2/3", overflow: "hidden" }}>
          <InvestmentGroupsPage currentUser={currentUser} onClose={() => setActiveNav("CHART")} />
        </div>
      ) : (
        <main className={showCompactDom ? "terminal-grid" : "terminal-grid hide-right-panel"} style={gridStyle}>
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
            onCandleChange={(candle) => {
              recentCandlesRef.current = [...recentCandlesRef.current.slice(-19), candle];
              setRecentCandles(recentCandlesRef.current);
            }}
            onReplayStatusChange={setReplayStatus}
            onReplayStartSelected={handleReplayStartSelected}
            customPlots={compiledPlots}
            onAlertFired={handleAlertFired}
            priceLineColor={terminalSettings.priceLineColor}
            priceLineIntensity={terminalSettings.priceLineIntensity}
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
          {activeNav === "MARKET OVERVIEW" && (
            <MarketOverview
              onClose={() => setActiveNav("CHART")}
              onSelectSymbol={(symbolToken) => {
                const exchange = selectedExchange;
                const match = exchange.symbols.find(s => s.rawSymbol.includes(symbolToken) || s.token.includes(symbolToken));
                if (match) {
                  setSymbol(match);
                  setActiveNav("CHART");
                }
              }}
            />
          )}
          {showModuleOverlay && (
            <div className="module-focus">
              <span>{activeNav}</span>
              <b>{selectedExchange.label.toUpperCase()}</b>
            </div>
          )}
        </section>
        {showCompactDom && (
          <aside className="right-panel">
            <OrderBook
              marketSymbol={symbol}
              lastPrice={lastPrice}
              exchangeLabel={selectedExchange.label}
              onOpenDomPro={openDomPro}
              onResetDomLayout={() => setLayout((current) => ({ ...current, rightPanelWidth: 366, rightTopHeight: 420, rightStatsWidth: 170 }))}
            />
            <div className="right-stack-resizer" onPointerDown={(event) => startLayoutResize("rightTop", event)} />
            <div className="right-bottom">
              <MarketStats />
              <div className="right-bottom-resizer" onPointerDown={(event) => startLayoutResize("rightSplit", event)} />
              <TradesTape marketSymbol={symbol} exchangeLabel={selectedExchange.label} />
            </div>
          </aside>
        )}
        <section className={activeNav === "SCRIPT EDITOR" ? "bottom-panel script-mode" : activeNav === "ALERTS" ? "bottom-panel alerts-mode" : activeNav === "POSITIONS" ? "bottom-panel positions-mode" : "bottom-panel"}>
          {activeNav === "SCRIPT EDITOR" ? (
            <ScriptEditor
              symbol={symbol.label}
              exchange={selectedExchange.label}
              onCompiledPlots={setCompiledPlots}
              currentUser={currentUser}
            />
          ) : activeNav === "ALERTS" ? (
            <AlertCenter
              alerts={indicatorAlerts}
              onAlertsChange={setIndicatorAlerts}
              symbol={symbol.label}
              exchange={selectedExchange.label}
              timeframe={timeframe}
              eventLogs={alertEventLogs}
              onClearEventLogs={handleClearEventLogs}
            />
          ) : activeNav === "POSITIONS" ? (
            <PositionsWorkspace positions={portfolioPositions} orders={portfolioOrders} />
          ) : (
            <div className="bottom-blank" />
          )}
        </section>
        {domProOpen && (
          <DomProWindow
            marketSymbol={symbol}
            lastPrice={lastPrice}
            exchangeLabel={selectedExchange.label}
            workspaceId={workspace}
            windowMode={domProMode}
            settingsOpenSignal={domProSettingsSignal}
            onClose={closeDomPro}
          />
        )}
        {showCompactDom && (
          <div className="layout-resizer resize-main-x" onPointerDown={(event) => startLayoutResize("right", event)} />
        )}
        <div className="layout-resizer resize-main-y" onPointerDown={(event) => startLayoutResize("bottom", event)} />
        
        {/* Watchlist Context Menu */}
        {contextMenu && (
          <div
            className="custom-context-menu"
            style={{
              position: "fixed",
              top: `${contextMenu.y}px`,
              left: `${contextMenu.x}px`,
              zIndex: 10000,
              background: "rgba(10, 12, 14, 0.98)",
              border: "1px solid var(--red-hot)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.85)",
              borderRadius: "3px",
              padding: "4px 0",
              backdropFilter: "blur(4px)"
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {watchlist.includes(contextMenu.symbol) ? (
              <button
                type="button"
                onClick={() => removeFromWatchlist(contextMenu.symbol)}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "8px 16px",
                  color: "var(--red-hot)",
                  fontSize: "11px",
                  fontFamily: "IBM Plex Mono, monospace",
                  background: "transparent",
                  border: 0,
                  textAlign: "left",
                  cursor: "pointer"
                }}
              >
                ★ Remove from Watchlist
              </button>
            ) : (
              <button
                type="button"
                onClick={() => addToWatchlist(contextMenu.symbol)}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "8px 16px",
                  color: "var(--strong)",
                  fontSize: "11px",
                  fontFamily: "IBM Plex Mono, monospace",
                  background: "transparent",
                  border: 0,
                  textAlign: "left",
                  cursor: "pointer"
                }}
              >
                ☆ Add to Watchlist
              </button>
            )}
          </div>
        )}
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

      {/* Revoked indicator warning popup modal */}
      {showRevokedPopup && (
        <div style={{
          position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh",
          background: "rgba(3, 4, 5, 0.9)", display: "flex", alignItems: "center", justifyContent: "center",
          zIndex: 99999, backdropFilter: "blur(8px)"
        }}>
          <div style={{
            background: "rgba(18, 22, 28, 0.98)",
            border: "1px solid var(--red-hot)",
            boxShadow: "0 0 40px rgba(255, 0, 68, 0.25)",
            borderRadius: "4px", padding: "30px 40px", maxWidth: "450px", textAlign: "center"
          }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: "15px" }}>
              <Lock style={{ color: "var(--red-hot)", animation: "pulse 1.5s infinite" }} size={48} />
            </div>
            <h3 style={{ fontFamily: "IBM Plex Mono", fontSize: "16px", color: "#fff", letterSpacing: "1px", marginBottom: "10px" }}>
              ACCESS REVOKED
            </h3>
            <p style={{ color: "var(--dim)", fontSize: "12px", lineHeight: "1.6", marginBottom: "25px" }}>
              your indicator access was revoked by managment
            </p>
            <button
              onClick={() => setShowRevokedPopup(false)}
              style={{
                background: "linear-gradient(180deg, #ff0000 0%, #aa0000 100%)",
                border: "1px solid #ff0000", color: "#fff",
                padding: "8px 24px", fontFamily: "IBM Plex Mono", fontSize: "11px", fontWeight: 700,
                borderRadius: "2px", cursor: "pointer", width: "100%"
              }}
            >
              ACKNOWLEDGE HANDSHAKE
            </button>
          </div>
        </div>
      )}
      <PerformanceHud />
    </div>
  );
}
