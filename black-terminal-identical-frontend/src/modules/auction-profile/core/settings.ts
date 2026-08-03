import type {
  AuctionCalculationEngine,
  AuctionCvdMetric,
  AuctionDataSource,
  AuctionDisplayStyle,
  AuctionImplementationMode,
  AuctionPalette,
  AuctionProfileSettings,
  AuctionScopeMode
} from "./types.ts";
import { stableHash } from "./canonical.ts";

export const AUCTION_PROFILE_LOOKBACK_OPTIONS = [500, 1500, 5000, 10000, 20000] as const;

export const AUCTION_PROFILE_DEFAULT_SETTINGS: AuctionProfileSettings = {
  schemaVersion: 1,
  implementationMode: "BLACK_CORE_NATIVE",
  scopeMode: "ROLLING",
  calculationEngine: "CVD_REAL_TRADES",
  cvdMetric: "NET_CVD",
  dataSource: "HYBRID",
  fallbackSource: "CHART_BARS",
  priceAllocation: "BODY_WICK_WEIGHTED",
  lookbackBars: 5000,
  blockResolution: "CHART_TIMEFRAME",
  customBlockMinutes: 60,
  updateDevelopingBlock: true,
  compositeLocked: false,
  periodicity: "WEEKLY",
  periodicBars: 500,
  periodicHours: 168,
  sessionTemplate: "UTC_DAY",
  sessionTimezone: "UTC",
  customSessionStartMinute: 0,
  customSessionEndMinute: 1440,
  initialBalanceMinutes: 60,
  lowerTimeframe: "1m",
  rowSizingMode: "AUTO",
  ticksPerRow: 8,
  rowSizePrice: 1,
  basisPointsPerRow: 4,
  atrFraction: 0.2,
  targetRows: 180,
  maximumRows: 1200,
  maximumTimeBlocks: 5000,
  gridAnchor: "INSTRUMENT_TICK_ORIGIN",
  valueAreaFraction: 0.7,
  valueAreaBasis: "ABSOLUTE_VALUE",
  pocBasis: "MAXIMUM_ABSOLUTE_METRIC",
  tpoBracketMinutes: 30,
  volatilityAnnualization: "CRYPTO_365",
  annualizationPeriods: 365,
  unknownSideHandling: "SEPARATE",
  nodeDetection: {
    source: "ABSOLUTE_CVD",
    method: "HYBRID",
    sensitivityPercentile: 20,
    neighborhood: 3,
    prominence: 0.16,
    minimumWidthRows: 1,
    maximumGapRows: 1,
    mergeContiguousRows: true,
    showLvns: false,
    showHvns: false
  },
  hybridWeights: {
    volume: 0.18,
    cvd: 0.24,
    cvdEfficiency: 0.13,
    tpo: 0.08,
    realizedVolatility: 0.08,
    parkinsonVolatility: 0.08,
    tradeCount: 0.08,
    notional: 0.13
  },
  rendering: {
    displayStyle: "COMBINED",
    presentationMode: "DYNAMIC_KEY_LEVELS",
    palette: "BLACK_TERMINAL_INSTITUTIONAL",
    widthPercent: 32,
    opacity: 0.72,
    brightness: 100,
    showText: true,
    showKeyLevels: true,
    showNodeLabels: false,
    showValueArea: true,
    showInitialBalance: true,
    showMidpoint: false,
    showStructuralSr: false,
    showHistoricalExtensions: false,
    showOffChart: false,
    cellTextMode: "AUTO",
    cellTextSize: "AUTO",
    cellBorder: "SUBTLE",
    normalizationMode: "ROBUST_PERCENTILE",
    colorScalingLifecycle: "FROZEN_ON_BLOCK_CLOSE",
    robustLowerPercentile: 2,
    robustUpperPercentile: 98,
    absoluteFixedScale: 1000,
    maximumVisibleColumns: 500,
    maximumVisibleRows: 300,
    maximumVisibleLabels: 2000,
    structuralDetail: "MINIMAL",
    maximumVisibleLvns: 3,
    maximumVisibleHvns: 3,
    maximumVisibleStructuralZones: 4,
    zoneExtensionMode: "PROFILE_ONLY",
    fixedExtensionBars: 100,
    positiveColor: "#e2e3e5",
    negativeColor: "#ec182a",
    balancedColor: "#333333",
    valueAreaColor: "#d8dce2",
    pocColor: "#ffffff",
    lvnColor: "#4f555d",
    hvnColor: "#8e0014"
  },
  offChartMetrics: ["CVD_DELTA", "CVD_ACCELERATION", "CVD_EFFICIENCY", "CVD_PERSISTENCE"],
  diagnosticsVisible: false,
  settingsVersion: "auction-profile-default-v1"
};

const IMPLEMENTATION_MODES: AuctionImplementationMode[] = ["PINE_COMPATIBILITY", "BLACK_CORE_NATIVE"];
const SCOPES: AuctionScopeMode[] = ["SESSION", "ROLLING", "FIXED_START", "VISIBLE_RANGE", "COMPOSITE", "PERIODIC_COMPOSITE", "MACRO_COMPOSITE", "MANUAL_RANGE"];
const ENGINES: AuctionCalculationEngine[] = ["CVD_REAL_TRADES", "CVD_PINE_COMPATIBLE", "VOLUME", "BUY_VOLUME", "SELL_VOLUME", "DELTA_VOLUME", "IMBALANCE_RATIO", "TPO", "ACTIVITY", "USD_VOLUME", "REALIZED_VOLATILITY", "PARKINSON_VOLATILITY", "GARMAN_KLASS_VOLATILITY", "RANGE_EXPANSION", "TRADE_COUNT", "AVERAGE_TRADE_SIZE", "LIQUIDITY_WEIGHTED_ACTIVITY", "HYBRID_AUCTION_SCORE"];
const CVD_METRICS: AuctionCvdMetric[] = ["NET_CVD", "ABSOLUTE_CVD", "POSITIVE_CVD", "NEGATIVE_CVD", "CVD_IMBALANCE_RATIO", "CVD_EFFICIENCY", "CVD_ACCELERATION", "CVD_PERSISTENCE", "CVD_DIVERGENCE"];
const DATA_SOURCES: AuctionDataSource[] = ["LIVE_TRADE_STREAM", "HISTORICAL_TRADE_ARCHIVE", "LOWER_TIMEFRAME_BARS", "CHART_BARS", "HYBRID"];
const DISPLAY_STYLES: AuctionDisplayStyle[] = ["HEATMAP_BLOCKS", "HORIZONTAL_HISTOGRAM", "PROFILE_COLUMNS", "LETTERS_TPO", "CONTOUR", "NODES_ONLY", "STRUCTURAL_ZONES", "COMBINED"];
const PALETTES: AuctionPalette[] = ["ORIGINAL", "BLACK_TERMINAL_INSTITUTIONAL", "THERMAL", "BLOOD_RED", "CVD_DIRECTIONAL", "MONOCHROME", "CUSTOM"];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function finite(value: unknown, fallback: number, minimum = -Infinity, maximum = Infinity) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number) {
  return Math.round(finite(value, fallback, minimum, maximum));
}

function choice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return typeof value === "string" && choices.includes(value as T) ? value as T : fallback;
}

function bool(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function color(value: unknown, fallback: string) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

export function migrateAuctionProfileSettings(value: unknown): AuctionProfileSettings {
  const d = AUCTION_PROFILE_DEFAULT_SETTINGS;
  const s = record(value);
  const n = record(s.nodeDetection);
  const w = record(s.hybridWeights);
  const r = record(s.rendering);
  const result: AuctionProfileSettings = {
    ...d,
    implementationMode: choice(s.implementationMode, IMPLEMENTATION_MODES, d.implementationMode),
    scopeMode: choice(s.scopeMode, SCOPES, d.scopeMode),
    calculationEngine: choice(s.calculationEngine, ENGINES, d.calculationEngine),
    cvdMetric: choice(s.cvdMetric, CVD_METRICS, d.cvdMetric),
    dataSource: choice(s.dataSource, DATA_SOURCES, d.dataSource),
    fallbackSource: choice(s.fallbackSource, DATA_SOURCES.filter(source => source !== "HYBRID"), d.fallbackSource),
    priceAllocation: choice(s.priceAllocation, ["UNIFORM_BAR_RANGE", "CLOSE_WEIGHTED", "TYPICAL_PRICE_WEIGHTED", "TRADE_AT_PRICE_EXACT", "VOLUME_AT_PRICE_EXACT", "GAUSSIAN_AROUND_VWAP", "BODY_WICK_WEIGHTED", "HYBRID"], d.priceAllocation),
    lookbackBars: integer(s.lookbackBars, d.lookbackBars, 1, 20000),
    blockResolution: choice(s.blockResolution, ["CHART_TIMEFRAME", "1m", "5m", "15m", "30m", "1h", "4h", "1d", "ADAPTIVE", "CUSTOM"], d.blockResolution),
    customBlockMinutes: integer(s.customBlockMinutes, d.customBlockMinutes, 1, 525_600),
    updateDevelopingBlock: bool(s.updateDevelopingBlock, d.updateDevelopingBlock),
    fixedStartTime: typeof s.fixedStartTime === "number" ? s.fixedStartTime : undefined,
    fixedEndTime: typeof s.fixedEndTime === "number" ? s.fixedEndTime : undefined,
    visibleStartTime: typeof s.visibleStartTime === "number" ? s.visibleStartTime : undefined,
    visibleEndTime: typeof s.visibleEndTime === "number" ? s.visibleEndTime : undefined,
    compositeLocked: bool(s.compositeLocked, d.compositeLocked),
    periodicity: choice(s.periodicity, ["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "CUSTOM_BARS", "CUSTOM_HOURS"], d.periodicity),
    periodicBars: integer(s.periodicBars, d.periodicBars, 1, 20000),
    periodicHours: integer(s.periodicHours, d.periodicHours, 1, 24 * 366),
    sessionTemplate: choice(s.sessionTemplate, ["UTC_DAY", "ASIA", "LONDON", "NEW_YORK", "CUSTOM", "EXCHANGE_DAY", "WEEK", "MONTH"], d.sessionTemplate),
    sessionTimezone: typeof s.sessionTimezone === "string" ? s.sessionTimezone : d.sessionTimezone,
    customSessionStartMinute: integer(s.customSessionStartMinute, d.customSessionStartMinute, 0, 1439),
    customSessionEndMinute: integer(s.customSessionEndMinute, d.customSessionEndMinute, 1, 1440),
    initialBalanceMinutes: integer(s.initialBalanceMinutes, d.initialBalanceMinutes, 1, 1440),
    lowerTimeframe: choice(s.lowerTimeframe, ["1s", "10s", "30s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "1w", "1M", "10t", "100t"], d.lowerTimeframe),
    rowSizingMode: choice(s.rowSizingMode, ["AUTO", "TICKS", "PRICE", "BASIS_POINTS", "ATR_FRACTION", "VISIBLE_PIXEL_ADAPTIVE", "FIXED_ROW_COUNT"], d.rowSizingMode),
    ticksPerRow: integer(s.ticksPerRow, d.ticksPerRow, 1, 10000),
    rowSizePrice: finite(s.rowSizePrice, d.rowSizePrice, Number.EPSILON),
    basisPointsPerRow: finite(s.basisPointsPerRow, d.basisPointsPerRow, 0.01, 10000),
    atrFraction: finite(s.atrFraction, d.atrFraction, 0.001, 100),
    targetRows: integer(s.targetRows, d.targetRows, 16, 4096),
    maximumRows: integer(s.maximumRows, d.maximumRows, 16, 4096),
    maximumTimeBlocks: integer(s.maximumTimeBlocks, d.maximumTimeBlocks, 16, 20000),
    gridAnchor: choice(s.gridAnchor, ["PROFILE_OPEN", "ROUND_NUMBER", "FIXED_ORIGIN", "INSTRUMENT_TICK_ORIGIN", "MANUAL_ORIGIN"], d.gridAnchor),
    manualGridOrigin: typeof s.manualGridOrigin === "number" ? s.manualGridOrigin : undefined,
    valueAreaFraction: finite(s.valueAreaFraction, d.valueAreaFraction, 0.01, 1),
    valueAreaBasis: choice(s.valueAreaBasis, ["SELECTED_ENGINE", "TOTAL_VOLUME", "ABSOLUTE_VALUE", "POSITIVE_SIDE", "NEGATIVE_SIDE", "TPO", "HYBRID"], d.valueAreaBasis),
    pocBasis: choice(s.pocBasis, ["MAXIMUM_SELECTED_METRIC", "MAXIMUM_ABSOLUTE_METRIC", "MAXIMUM_POSITIVE_METRIC", "MINIMUM_NEGATIVE_METRIC", "MAXIMUM_TOTAL_VOLUME", "MAXIMUM_TPO", "HYBRID"], d.pocBasis),
    tpoBracketMinutes: integer(s.tpoBracketMinutes, d.tpoBracketMinutes, 1, 1440),
    volatilityAnnualization: choice(s.volatilityAnnualization, ["NONE", "CRYPTO_365", "CALENDAR_365", "CUSTOM"], d.volatilityAnnualization),
    annualizationPeriods: finite(s.annualizationPeriods, d.annualizationPeriods, 1, 1_000_000),
    unknownSideHandling: choice(s.unknownSideHandling, ["SEPARATE", "EXCLUDE_DIRECTIONAL"], d.unknownSideHandling),
    nodeDetection: {
      source: choice(n.source, ["NET_CVD", "ABSOLUTE_CVD", "CVD_EFFICIENCY", "BUY_VOLUME", "SELL_VOLUME", "DELTA_IMBALANCE", "TPO", "VOLUME", "VOLATILITY", "PARKINSON", "HYBRID"], d.nodeDetection.source),
      method: choice(n.method, ["PERCENTILE", "LOCAL_MINIMA", "PROMINENCE", "Z_SCORE", "ADAPTIVE_VALLEY", "KERNEL_SMOOTHED_VALLEY", "HYBRID"], d.nodeDetection.method),
      sensitivityPercentile: finite(n.sensitivityPercentile, d.nodeDetection.sensitivityPercentile, 1, 99),
      neighborhood: integer(n.neighborhood, d.nodeDetection.neighborhood, 1, 50),
      prominence: finite(n.prominence, d.nodeDetection.prominence, 0, 1),
      minimumWidthRows: integer(n.minimumWidthRows, d.nodeDetection.minimumWidthRows, 1, 100),
      maximumGapRows: integer(n.maximumGapRows, d.nodeDetection.maximumGapRows, 0, 50),
      mergeContiguousRows: bool(n.mergeContiguousRows, d.nodeDetection.mergeContiguousRows),
      showLvns: bool(n.showLvns, d.nodeDetection.showLvns),
      showHvns: bool(n.showHvns, d.nodeDetection.showHvns)
    },
    hybridWeights: {
      volume: finite(w.volume, d.hybridWeights.volume, 0, 10),
      cvd: finite(w.cvd, d.hybridWeights.cvd, 0, 10),
      cvdEfficiency: finite(w.cvdEfficiency, d.hybridWeights.cvdEfficiency, 0, 10),
      tpo: finite(w.tpo, d.hybridWeights.tpo, 0, 10),
      realizedVolatility: finite(w.realizedVolatility, d.hybridWeights.realizedVolatility, 0, 10),
      parkinsonVolatility: finite(w.parkinsonVolatility, d.hybridWeights.parkinsonVolatility, 0, 10),
      tradeCount: finite(w.tradeCount, d.hybridWeights.tradeCount, 0, 10),
      notional: finite(w.notional, d.hybridWeights.notional, 0, 10)
    },
    rendering: {
      displayStyle: choice(r.displayStyle, DISPLAY_STYLES, d.rendering.displayStyle),
      presentationMode: choice(r.presentationMode, ["DYNAMIC_BLOCKS", "AGGREGATE_HISTOGRAM", "STRUCTURAL_NODES", "DYNAMIC_KEY_LEVELS", "DYNAMIC_AGGREGATE", "MACRO_STRUCTURE"], d.rendering.presentationMode),
      palette: choice(r.palette, PALETTES, d.rendering.palette),
      widthPercent: finite(r.widthPercent, d.rendering.widthPercent, 5, 100),
      opacity: finite(r.opacity, d.rendering.opacity, 0.02, 1),
      brightness: finite(r.brightness, d.rendering.brightness, 10, 300),
      showText: bool(r.showText, d.rendering.showText),
      showKeyLevels: bool(r.showKeyLevels, d.rendering.showKeyLevels),
      showNodeLabels: bool(r.showNodeLabels, d.rendering.showNodeLabels),
      showValueArea: bool(r.showValueArea, d.rendering.showValueArea),
      showInitialBalance: bool(r.showInitialBalance, d.rendering.showInitialBalance),
      showMidpoint: bool(r.showMidpoint, d.rendering.showMidpoint),
      showStructuralSr: bool(r.showStructuralSr, d.rendering.showStructuralSr),
      showHistoricalExtensions: bool(r.showHistoricalExtensions, d.rendering.showHistoricalExtensions),
      showOffChart: bool(r.showOffChart, d.rendering.showOffChart),
      cellTextMode: choice(r.cellTextMode, ["ALWAYS", "AUTO", "HOVER_ONLY", "STRONG_ONLY", "OFF"], d.rendering.cellTextMode),
      cellTextSize: choice(r.cellTextSize, ["AUTO", "TINY", "SMALL", "NORMAL", "LARGE", "HUGE"], d.rendering.cellTextSize),
      cellBorder: choice(r.cellBorder, ["NONE", "SUBTLE", "STANDARD", "HIGH_CONTRAST"], d.rendering.cellBorder),
      normalizationMode: choice(r.normalizationMode, ["PER_PROFILE", "PER_TIME_BLOCK", "ROLLING", "ABSOLUTE_FIXED", "PERCENTILE", "LOGARITHMIC", "ROBUST_PERCENTILE"], d.rendering.normalizationMode),
      colorScalingLifecycle: choice(r.colorScalingLifecycle, ["DEVELOPING_GLOBAL", "FROZEN_PER_BLOCK", "FROZEN_ON_BLOCK_CLOSE", "FROZEN_ON_PROFILE_LOCK", "ROLLING"], d.rendering.colorScalingLifecycle),
      robustLowerPercentile: finite(r.robustLowerPercentile, d.rendering.robustLowerPercentile, 0, 49),
      robustUpperPercentile: finite(r.robustUpperPercentile, d.rendering.robustUpperPercentile, 51, 100),
      absoluteFixedScale: finite(r.absoluteFixedScale, d.rendering.absoluteFixedScale, Number.EPSILON),
      maximumVisibleColumns: integer(r.maximumVisibleColumns, d.rendering.maximumVisibleColumns, 25, 2000),
      maximumVisibleRows: integer(r.maximumVisibleRows, d.rendering.maximumVisibleRows, 25, 1000),
      maximumVisibleLabels: integer(r.maximumVisibleLabels, d.rendering.maximumVisibleLabels, 0, 10000),
      structuralDetail: choice(r.structuralDetail, ["MINIMAL", "STANDARD", "DETAILED", "RESEARCH"], d.rendering.structuralDetail),
      maximumVisibleLvns: integer(r.maximumVisibleLvns, d.rendering.maximumVisibleLvns, 0, 100),
      maximumVisibleHvns: integer(r.maximumVisibleHvns, d.rendering.maximumVisibleHvns, 0, 100),
      maximumVisibleStructuralZones: integer(r.maximumVisibleStructuralZones, d.rendering.maximumVisibleStructuralZones, 0, 100),
      zoneExtensionMode: choice(r.zoneExtensionMode, ["PROFILE_ONLY", "UNTIL_FIRST_TOUCH", "UNTIL_MITIGATED", "UNTIL_INVALIDATED", "FIXED_N_BARS", "EXTEND_RIGHT", "FULL_CHART"], d.rendering.zoneExtensionMode),
      fixedExtensionBars: integer(r.fixedExtensionBars, d.rendering.fixedExtensionBars, 1, 20000),
      positiveColor: color(r.positiveColor, d.rendering.positiveColor),
      negativeColor: color(r.negativeColor, d.rendering.negativeColor),
      balancedColor: color(r.balancedColor, d.rendering.balancedColor),
      valueAreaColor: color(r.valueAreaColor, d.rendering.valueAreaColor),
      pocColor: color(r.pocColor, d.rendering.pocColor),
      lvnColor: color(r.lvnColor, d.rendering.lvnColor),
      hvnColor: color(r.hvnColor, d.rendering.hvnColor)
    },
    offChartMetrics: Array.isArray(s.offChartMetrics) ? s.offChartMetrics as AuctionProfileSettings["offChartMetrics"] : d.offChartMetrics,
    diagnosticsVisible: bool(s.diagnosticsVisible, d.diagnosticsVisible),
    settingsVersion: typeof s.settingsVersion === "string" ? s.settingsVersion : d.settingsVersion
  };
  const legacyAggregateSettings = typeof r.presentationMode !== "string";
  if (legacyAggregateSettings && ["CVD_REAL_TRADES", "CVD_PINE_COMPATIBLE"].includes(result.calculationEngine) && result.cvdMetric === "ABSOLUTE_CVD") {
    result.cvdMetric = "NET_CVD";
  }
  if (result.implementationMode === "PINE_COMPATIBILITY") {
    if (result.calculationEngine === "CVD_REAL_TRADES") result.calculationEngine = "CVD_PINE_COMPATIBLE";
    if (result.scopeMode !== "FIXED_START") result.scopeMode = "SESSION";
    result.rendering.colorScalingLifecycle = "DEVELOPING_GLOBAL";
  }
  return { ...result, settingsVersion: auctionProfileSettingsHash(result) };
}

export function auctionProfileSettingsHash(settings: AuctionProfileSettings) {
  const copy = { ...settings, settingsVersion: "" };
  return "ap-settings-" + stableHash(copy);
}

export function auctionProfileCalculationSettingsHash(settings: AuctionProfileSettings) {
  const { rendering, diagnosticsVisible: _diagnosticsVisible, settingsVersion: _settingsVersion, ...calculation } = settings;
  return "ap-calc-" + stableHash({
    ...calculation,
    matrixPresentation: {
      normalizationMode: rendering.normalizationMode,
      robustLowerPercentile: rendering.robustLowerPercentile,
      robustUpperPercentile: rendering.robustUpperPercentile,
      absoluteFixedScale: rendering.absoluteFixedScale,
      colorScalingLifecycle: rendering.colorScalingLifecycle
    }
  });
}

export function auctionProfileLookbackWarnings(settings: AuctionProfileSettings, loadedBars: number) {
  const warnings: string[] = [];
  if (settings.lookbackBars > loadedBars) warnings.push("Requested " + settings.lookbackBars.toLocaleString() + " bars; " + loadedBars.toLocaleString() + " are loaded.");
  if (settings.implementationMode === "PINE_COMPATIBILITY" && settings.lookbackBars > 1500) warnings.push("Pine Compatibility retains the source script's practical 1,500-bar history boundary.");
  if (settings.scopeMode === "VISIBLE_RANGE") warnings.push("Visible Range is intentionally viewport-dependent; all other scopes are camera-independent.");
  if (settings.calculationEngine === "CVD_REAL_TRADES" && !["LIVE_TRADE_STREAM", "HISTORICAL_TRADE_ARCHIVE", "HYBRID"].includes(settings.dataSource)) warnings.push("Real CVD requires classified trades; the selected source is an approximation.");
  return warnings;
}
