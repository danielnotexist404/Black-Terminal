import type { KioseffGranularity, KioseffModel } from "./canonical.ts";

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
    lowerTimeframe: "1m",
    clusterColor: "#55ffda",
    oldClusterColor: "#ff65fb"
  },
  volatilityAtEntry: {
    granularity: "lower",
    timeScaledVolatilityTimeframe: "1m",
    strongClusterColor: "#ff65fb",
    weakClusterColor: "#6929F2",
    showHistoricalTriggers: false,
    showActiveClusterSize: false
  },
  forceTypicalMove: false,
  showClusterRatioMeter: true
};

function integerAtLeast(value: unknown, minimum: number, fallback: number) {
  return Number.isInteger(value) && Number(value) >= minimum ? Number(value) : fallback;
}

export function migrateKioseffSettings(value: unknown): KioseffSettingsV1 {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (source.version !== 1) return structuredClone(KIOSEFF_DEFAULT_SETTINGS);
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
      lowerTimeframe:
        typeof absorbtion.lowerTimeframe === "string"
          ? absorbtion.lowerTimeframe
          : defaults.absorbtion.lowerTimeframe,
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
      timeScaledVolatilityTimeframe:
        typeof vae.timeScaledVolatilityTimeframe === "string"
          ? vae.timeScaledVolatilityTimeframe
          : defaults.volatilityAtEntry.timeScaledVolatilityTimeframe,
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
