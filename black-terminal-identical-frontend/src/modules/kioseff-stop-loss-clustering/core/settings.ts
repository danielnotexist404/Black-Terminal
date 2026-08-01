import type { KioseffGranularity, KioseffModel } from "./canonical.ts";
import type { Timeframe } from "../../../market-data/types.ts";
import { kioseffTimeframeSeconds } from "../data/timeframes.ts";

export type KioseffSettingsV1 = {
  version: 1;
  model: KioseffModel;
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
};

export const KIOSEFF_DEFAULT_SETTINGS: KioseffSettingsV1 = {
  version: 1,
  model: "absorbtion-extremes",
  absorbtion: {
    showXRay: true,
    intensityBySize: false,
    stopClusterBuys: 2,
    stopClusterSells: 2,
    oldStopClusterSells: 2,
    oldStopClusterBuys: 2,
    lowerTimeframe: "1",
    clusterColor: "#55ffda",
    oldClusterColor: "#ff65fb"
  },
  volatilityAtEntry: {
    granularity: "lower",
    timeScaledVolatilityTimeframe: "1",
    strongClusterColor: "#ff65fb",
    weakClusterColor: "#6929F2",
    showHistoricalTriggers: false,
    showActiveClusterSize: false
  },
  forceTypicalMove: false,
  showClusterRatioMeter: true
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

export function migrateKioseffSettings(
  value: unknown,
  legacyVisual?: { color?: string; intensity?: number }
): KioseffSettingsV1 {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (source.version !== 1) {
    const migrated = structuredClone(KIOSEFF_DEFAULT_SETTINGS);
    const legacyColor = {
      red: "#ff334f",
      green: "#55ffda",
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
  const defaults = KIOSEFF_DEFAULT_SETTINGS;
  return {
    version: 1,
    model:
      source.model === "volatility-at-entry" || source.model === "absorbtion-extremes"
        ? source.model
        : defaults.model,
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
      clusterColor:
        typeof absorbtion.clusterColor === "string"
          ? absorbtion.clusterColor
          : defaults.absorbtion.clusterColor,
      oldClusterColor:
        typeof absorbtion.oldClusterColor === "string"
          ? absorbtion.oldClusterColor
          : defaults.absorbtion.oldClusterColor
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
      strongClusterColor:
        typeof vae.strongClusterColor === "string"
          ? vae.strongClusterColor
          : defaults.volatilityAtEntry.strongClusterColor,
      weakClusterColor:
        typeof vae.weakClusterColor === "string"
          ? vae.weakClusterColor
          : defaults.volatilityAtEntry.weakClusterColor,
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
        : defaults.showClusterRatioMeter
  };
}

export function kioseffSettingsVersion(settings: KioseffSettingsV1) {
  return JSON.stringify(settings);
}
