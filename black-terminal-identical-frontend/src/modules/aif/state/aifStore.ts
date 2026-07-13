import type { AifSettings } from "../core/aifTypes";

export const AIF_SETTINGS_VERSION = 1;

export function defaultAifSettings(): AifSettings {
  return {
    version: AIF_SETTINGS_VERSION,
    primaryProfile: "volume",
    secondaryProfile: "off",
    profilePlacement: "right",
    comparisonMode: "shared-domain",
    lookbackBars: 20_000,
    rangeMode: "lookback",
    anchorTime: null,
    bucketMode: "logarithmic",
    rowCount: 300,
    fixedPriceSize: 100,
    percentageBucket: 0.25,
    logarithmic: true,
    sourceResolution: "best",
    showPoc: true,
    showValueArea: true,
    showNodes: true,
    showFutureLvns: true,
    showSupportResistance: true,
    extendLevels: true,
    nodeSensitivity: 62,
    showTimeline: true,
    minimumConfidence: 55,
    timelineHorizon: 120,
    enableImmConfirmation: true,
    minimumWallPersistence: 60,
    showLiquidityConfluence: true,
    opacity: 76,
    labelDensity: "medium",
    profileWidth: 25,
    zoneIntensity: 52,
    showDataQuality: true,
    volatilityEstimator: "composite",
    volatilityAllocation: "body-weighted",
    tpoPeriodMinutes: 30
  };
}

export function aifSettingsKey(workspaceId: string, symbolKey: string) {
  return `bt_aif_settings:${workspaceId}:${symbolKey}`;
}

export function readAifSettings(workspaceId: string, symbolKey: string): AifSettings {
  const fallback = defaultAifSettings();
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(aifSettingsKey(workspaceId, symbolKey));
    if (!raw) return fallback;
    return migrateAifSettings(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

export function writeAifSettings(workspaceId: string, symbolKey: string, settings: AifSettings) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(aifSettingsKey(workspaceId, symbolKey), JSON.stringify(settings));
}

export function migrateAifSettings(input: unknown): AifSettings {
  const fallback = defaultAifSettings();
  if (!input || typeof input !== "object") return fallback;
  const source = input as Partial<AifSettings>;
  return { ...fallback, ...source, version: AIF_SETTINGS_VERSION };
}
