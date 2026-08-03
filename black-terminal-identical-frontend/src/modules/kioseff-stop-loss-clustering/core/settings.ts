import {
  stableValueHash,
  type KioseffEngineMode,
  type KioseffGranularity,
  type KioseffModel
} from "./canonical.ts";
import type { Timeframe } from "../../../market-data/types.ts";
import { kioseffTimeframeSeconds } from "../data/timeframes.ts";

export type KioseffHistoryLookbackBars = 5000 | 11000 | 22000;

export const KIOSEFF_BLACK_TERMINAL_PALETTE = {
  buyWall: "#f4f6f7",
  sellWall: "#b00018",
  weakWall: "#7d838a",
  oscillatorBuy: "#cfd3da"
} as const;

export type KioseffSettingsV1 = {
  version: 1;
  engineMode: KioseffEngineMode;
  model: KioseffModel;
  historyLookbackBars: KioseffHistoryLookbackBars;
  absorbtion: {
    showXRay: boolean;
    intensityBySize: boolean;
    stopClusterBuys: number;
    stopClusterSells: number;
    oldStopClusterSells: number;
    oldStopClusterBuys: number;
    lowerTimeframe: string;
    clusterColor: string;
    oldClusterColor: string;
  };
  volatilityAtEntry: {
    granularity: KioseffGranularity;
    timeScaledVolatilityTimeframe: string;
    strongClusterColor: string;
    weakClusterColor: string;
    showHistoricalTriggers: boolean;
    showActiveClusterSize: boolean;
  };
  forceTypicalMove: boolean;
  showClusterRatioMeter: boolean;
  style: {
    chartBackgroundColor: string;
    heatmapBrightness: number;
    activeLineWidth: number;
    hotLineWidth: number;
    labelFontSize: number;
    showSummaryTable: boolean;
    showOscillator: boolean;
    buyWallColor: string;
    oscillatorBuyColor: string;
    oscillatorSellColor: string;
    activityDashboardWidth: number;
  };
  visibility: {
    ticks: boolean;
    seconds: boolean;
    minutes: boolean;
    hours: boolean;
    days: boolean;
    weeks: boolean;
    months: boolean;
    priceScalePolicy:
      | "candles-only"
      | "candles-active-clusters"
      | "candles-visible-geometry"
      | "fixed-manual";
  };
};

export const KIOSEFF_DEFAULT_SETTINGS: KioseffSettingsV1 = {
  version: 1,
  engineMode: "pine-compatibility",
  model: "absorbtion-extremes",
  historyLookbackBars: 11000,
  absorbtion: {
    showXRay: true,
    intensityBySize: false,
    stopClusterBuys: 2,
    stopClusterSells: 2,
    oldStopClusterSells: 2,
    oldStopClusterBuys: 2,
    lowerTimeframe: "1",
    clusterColor: KIOSEFF_BLACK_TERMINAL_PALETTE.buyWall,
    oldClusterColor: KIOSEFF_BLACK_TERMINAL_PALETTE.sellWall
  },
  volatilityAtEntry: {
    granularity: "lower",
    timeScaledVolatilityTimeframe: "1",
    strongClusterColor: KIOSEFF_BLACK_TERMINAL_PALETTE.sellWall,
    weakClusterColor: KIOSEFF_BLACK_TERMINAL_PALETTE.weakWall,
    showHistoricalTriggers: false,
    showActiveClusterSize: false
  },
  forceTypicalMove: false,
  showClusterRatioMeter: true,
  style: {
    chartBackgroundColor: "#05070b",
    heatmapBrightness: 100,
    activeLineWidth: 1,
    hotLineWidth: 5,
    labelFontSize: 9,
    showSummaryTable: true,
    showOscillator: false,
    buyWallColor: KIOSEFF_BLACK_TERMINAL_PALETTE.buyWall,
    oscillatorBuyColor: KIOSEFF_BLACK_TERMINAL_PALETTE.oscillatorBuy,
    oscillatorSellColor: KIOSEFF_BLACK_TERMINAL_PALETTE.sellWall,
    activityDashboardWidth: 560
  },
  visibility: {
    ticks: true,
    seconds: true,
    minutes: true,
    hours: true,
    days: true,
    weeks: true,
    months: true,
    priceScalePolicy: "candles-visible-geometry"
  }
};

export const KIOSEFF_TIMEFRAME_INPUTS = [
  { value: "1", label: "1 minute", timeframe: "1m" },
  { value: "3", label: "3 minutes", timeframe: "3m" },
  { value: "5", label: "5 minutes", timeframe: "5m" },
  { value: "15", label: "15 minutes", timeframe: "15m" },
  { value: "30", label: "30 minutes", timeframe: "30m" },
  { value: "60", label: "1 hour", timeframe: "1h" },
  { value: "240", label: "4 hours", timeframe: "4h" }
] as const satisfies readonly {
  value: string;
  label: string;
  timeframe: Timeframe;
}[];

export const KIOSEFF_HISTORY_LOOKBACK_OPTIONS = [
  { value: 5000, label: "5,000 bars" },
  { value: 11000, label: "11,000 bars · Default" },
  { value: 22000, label: "22,000 bars · Maximum" }
] as const satisfies readonly {
  value: KioseffHistoryLookbackBars;
  label: string;
}[];

export function normalizeKioseffTimeframeInput(value: string): Timeframe {
  const normalized = KIOSEFF_TIMEFRAME_INPUTS.find(
    (option) => option.value === value || option.timeframe === value
  )?.timeframe;
  return normalized ?? "1m";
}

function migrateTimeframeInput(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const match = KIOSEFF_TIMEFRAME_INPUTS.find(
    (option) => option.value === value || option.timeframe === value
  );
  return match?.value ?? fallback;
}

export function isKioseffLowerTimeframeSupported(
  value: string,
  chartTimeframe: Timeframe
) {
  return (
    kioseffTimeframeSeconds(normalizeKioseffTimeframeInput(value)) <
    kioseffTimeframeSeconds(chartTimeframe)
  );
}

function integerAtLeast(value: unknown, minimum: number, fallback: number) {
  return Number.isInteger(value) && Number(value) >= minimum ? Number(value) : fallback;
}

function migrateLegacyPaletteColor(
  value: unknown,
  fallback: string,
  replacements: Readonly<Record<string, string>>
) {
  if (typeof value !== "string") return fallback;
  return replacements[value.trim().toLowerCase()] ?? value;
}

export function migrateKioseffSettings(
  value: unknown,
  legacyVisual?: { color?: string; intensity?: number }
): KioseffSettingsV1 {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (source.version !== 1) {
    const migrated = structuredClone(KIOSEFF_DEFAULT_SETTINGS);
    const legacyColor = {
      red: "#ff334f",
      green: KIOSEFF_BLACK_TERMINAL_PALETTE.buyWall,
      white: "#ffffff",
      silver: "#b8bec9",
      gray: "#7d8491"
    }[legacyVisual?.color ?? ""];
    if (legacyColor) {
      migrated.absorbtion.clusterColor = legacyColor;
      migrated.volatilityAtEntry.strongClusterColor = legacyColor;
    }
    return migrated;
  }
  const absorbtion =
    source.absorbtion && typeof source.absorbtion === "object"
      ? (source.absorbtion as Record<string, unknown>)
      : {};
  const vae =
    source.volatilityAtEntry && typeof source.volatilityAtEntry === "object"
      ? (source.volatilityAtEntry as Record<string, unknown>)
      : {};
  const style =
    source.style && typeof source.style === "object"
      ? (source.style as Record<string, unknown>)
      : {};
  const visibility =
    source.visibility && typeof source.visibility === "object"
      ? (source.visibility as Record<string, unknown>)
      : {};
  const defaults = KIOSEFF_DEFAULT_SETTINGS;
  return {
    version: 1,
    // Enhanced mode remains a separately named but certification-gated path.
    // Persisted attempts to enable it cannot silently bypass the parity gate.
    engineMode: "pine-compatibility",
    model:
      source.model === "volatility-at-entry" || source.model === "absorbtion-extremes"
        ? source.model
        : defaults.model,
    historyLookbackBars:
      source.historyLookbackBars === 5000 ||
      source.historyLookbackBars === 11000 ||
      source.historyLookbackBars === 22000
        ? source.historyLookbackBars
        : defaults.historyLookbackBars,
    absorbtion: {
      showXRay: typeof absorbtion.showXRay === "boolean" ? absorbtion.showXRay : defaults.absorbtion.showXRay,
      intensityBySize:
        typeof absorbtion.intensityBySize === "boolean"
          ? absorbtion.intensityBySize
          : defaults.absorbtion.intensityBySize,
      stopClusterBuys: integerAtLeast(absorbtion.stopClusterBuys, 1, defaults.absorbtion.stopClusterBuys),
      stopClusterSells: integerAtLeast(absorbtion.stopClusterSells, 1, defaults.absorbtion.stopClusterSells),
      oldStopClusterSells: integerAtLeast(
        absorbtion.oldStopClusterSells,
        0,
        defaults.absorbtion.oldStopClusterSells
      ),
      oldStopClusterBuys: integerAtLeast(
        absorbtion.oldStopClusterBuys,
        0,
        defaults.absorbtion.oldStopClusterBuys
      ),
      lowerTimeframe: migrateTimeframeInput(
        absorbtion.lowerTimeframe,
        defaults.absorbtion.lowerTimeframe
      ),
      clusterColor: migrateLegacyPaletteColor(
        absorbtion.clusterColor,
        defaults.absorbtion.clusterColor,
        { "#55ffda": defaults.absorbtion.clusterColor }
      ),
      oldClusterColor: migrateLegacyPaletteColor(
        absorbtion.oldClusterColor,
        defaults.absorbtion.oldClusterColor,
        { "#ff65fb": defaults.absorbtion.oldClusterColor }
      )
    },
    volatilityAtEntry: {
      granularity:
        vae.granularity === "higher" || vae.granularity === "lower"
          ? vae.granularity
          : defaults.volatilityAtEntry.granularity,
      timeScaledVolatilityTimeframe: migrateTimeframeInput(
        vae.timeScaledVolatilityTimeframe,
        defaults.volatilityAtEntry.timeScaledVolatilityTimeframe
      ),
      strongClusterColor: migrateLegacyPaletteColor(
        vae.strongClusterColor,
        defaults.volatilityAtEntry.strongClusterColor,
        { "#ff65fb": defaults.volatilityAtEntry.strongClusterColor }
      ),
      weakClusterColor: migrateLegacyPaletteColor(
        vae.weakClusterColor,
        defaults.volatilityAtEntry.weakClusterColor,
        { "#6929f2": defaults.volatilityAtEntry.weakClusterColor }
      ),
      showHistoricalTriggers:
        typeof vae.showHistoricalTriggers === "boolean"
          ? vae.showHistoricalTriggers
          : defaults.volatilityAtEntry.showHistoricalTriggers,
      showActiveClusterSize:
        typeof vae.showActiveClusterSize === "boolean"
          ? vae.showActiveClusterSize
          : defaults.volatilityAtEntry.showActiveClusterSize
    },
    forceTypicalMove:
      typeof source.forceTypicalMove === "boolean"
        ? source.forceTypicalMove
        : defaults.forceTypicalMove,
    showClusterRatioMeter:
      typeof source.showClusterRatioMeter === "boolean"
        ? source.showClusterRatioMeter
        : defaults.showClusterRatioMeter,
    style: {
      chartBackgroundColor:
        typeof style.chartBackgroundColor === "string"
          ? style.chartBackgroundColor
          : defaults.style.chartBackgroundColor,
      heatmapBrightness:
        typeof style.heatmapBrightness === "number"
          ? Math.max(25, Math.min(300, Math.round(style.heatmapBrightness)))
          : defaults.style.heatmapBrightness,
      activeLineWidth:
        typeof style.activeLineWidth === "number"
          ? Math.max(0.5, Math.min(4, style.activeLineWidth))
          : defaults.style.activeLineWidth,
      hotLineWidth:
        typeof style.hotLineWidth === "number"
          ? Math.max(1, Math.min(10, style.hotLineWidth))
          : defaults.style.hotLineWidth,
      labelFontSize:
        typeof style.labelFontSize === "number"
          ? Math.max(7, Math.min(14, Math.round(style.labelFontSize)))
          : defaults.style.labelFontSize,
      showSummaryTable:
        typeof style.showSummaryTable === "boolean"
          ? style.showSummaryTable
          : defaults.style.showSummaryTable,
      showOscillator:
        typeof style.showOscillator === "boolean"
          ? style.showOscillator
          : defaults.style.showOscillator,
      buyWallColor: migrateLegacyPaletteColor(
        style.buyWallColor,
        defaults.style.buyWallColor,
        { "#55ffda": defaults.style.buyWallColor }
      ),
      oscillatorBuyColor: migrateLegacyPaletteColor(
        style.oscillatorBuyColor,
        defaults.style.oscillatorBuyColor,
        { "#55ffda": defaults.style.oscillatorBuyColor }
      ),
      oscillatorSellColor: migrateLegacyPaletteColor(
        style.oscillatorSellColor,
        defaults.style.oscillatorSellColor,
        { "#ff65fb": defaults.style.oscillatorSellColor }
      ),
      activityDashboardWidth:
        typeof style.activityDashboardWidth === "number"
          ? Math.max(440, Math.min(760, Math.round(style.activityDashboardWidth)))
          : defaults.style.activityDashboardWidth
    },
    visibility: {
      ticks:
        typeof visibility.ticks === "boolean"
          ? visibility.ticks
          : defaults.visibility.ticks,
      seconds:
        typeof visibility.seconds === "boolean"
          ? visibility.seconds
          : defaults.visibility.seconds,
      minutes:
        typeof visibility.minutes === "boolean"
          ? visibility.minutes
          : defaults.visibility.minutes,
      hours:
        typeof visibility.hours === "boolean"
          ? visibility.hours
          : defaults.visibility.hours,
      days:
        typeof visibility.days === "boolean"
          ? visibility.days
          : defaults.visibility.days,
      weeks:
        typeof visibility.weeks === "boolean"
          ? visibility.weeks
          : defaults.visibility.weeks,
      months:
        typeof visibility.months === "boolean"
          ? visibility.months
          : defaults.visibility.months,
      priceScalePolicy:
        visibility.priceScalePolicy === "candles-only" ||
        visibility.priceScalePolicy === "candles-active-clusters" ||
        visibility.priceScalePolicy === "candles-visible-geometry" ||
        visibility.priceScalePolicy === "fixed-manual"
          ? visibility.priceScalePolicy
          : defaults.visibility.priceScalePolicy
    }
  };
}

export function kioseffSettingsVersion(settings: KioseffSettingsV1) {
  return kioseffSettingsHash(settings);
}

export function kioseffSettingsHash(settings: KioseffSettingsV1) {
  return stableValueHash(settings);
}

/**
 * Presentation-only brightness must never restart the expensive intrabar
 * calculation pipeline while the operator is dragging its slider.
 */
export function kioseffCalculationSettingsHash(settings: KioseffSettingsV1) {
  return stableValueHash({
    ...settings,
    style: {
      ...settings.style,
      heatmapBrightness: KIOSEFF_DEFAULT_SETTINGS.style.heatmapBrightness
    }
  });
}

export function isKioseffVisibleOnTimeframe(
  settings: KioseffSettingsV1,
  timeframe: Timeframe | string
) {
  if (timeframe.endsWith("t")) return settings.visibility.ticks;
  if (timeframe.endsWith("s")) return settings.visibility.seconds;
  if (timeframe.endsWith("m")) return settings.visibility.minutes;
  if (timeframe.endsWith("h")) return settings.visibility.hours;
  if (timeframe.endsWith("d")) return settings.visibility.days;
  if (timeframe.endsWith("w")) return settings.visibility.weeks;
  return settings.visibility.months;
}
