import type { DomMode, DomSettings } from "./types";

const storagePrefix = "bt_dom_pro_settings";

export const modeBucketDefaults: Record<DomMode, DomSettings["bucketMultiplier"]> = {
  micro: 1,
  scalper: 10,
  standard: 100,
  intraday: 100,
  institutional: 250,
  swing: 250,
  macro: 500,
  custom: "custom"
};

export function defaultDomSettings(workspaceId: string, symbolKey: string): DomSettings {
  return {
    workspaceId,
    symbolKey,
    mode: "institutional",
    bucketMultiplier: 250,
    customBucketSize: 50,
    visibleRange: "2",
    customVisibleRangePct: 2,
    fpsCap: 12,
    showVolumeProfile: true,
    showHeatmap: true,
    showWallDetection: true,
    showCvd: true,
    showExecutionPanel: true,
    showDiagnostics: true,
    showMacroRadar: true,
    colorIntensity: 82,
    liquidityThreshold: 2.8,
    maxVisibleBuckets: 120,
    maxHeatmapHistory: 360,
    heatmapHorizon: "24h",
    macroLookbackDays: 365,
    macroBandCount: 10,
    persistenceSmoothing: 88,
    updateThrottleMs: 90,
    profileSource: "visible-range",
    profileWidth: 42,
    showPoc: true,
    showHvnLvn: true,
    showValueArea: false
  };
}

export function domSettingsKey(workspaceId: string, symbolKey: string) {
  return `${storagePrefix}:${workspaceId}:${symbolKey}`;
}

export function readDomSettings(workspaceId: string, symbolKey: string): DomSettings {
  const fallback = defaultDomSettings(workspaceId, symbolKey);
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(domSettingsKey(workspaceId, symbolKey));
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw), workspaceId, symbolKey };
  } catch {
    return fallback;
  }
}

export function writeDomSettings(settings: DomSettings) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(domSettingsKey(settings.workspaceId, settings.symbolKey), JSON.stringify(settings));
}

export function updateModeSettings(settings: DomSettings, mode: DomMode): DomSettings {
  const bucketMultiplier = modeBucketDefaults[mode];
  const nextMode = mode === "micro" ? "scalper" : mode === "swing" ? "institutional" : mode;
  return {
    ...settings,
    mode: nextMode,
    bucketMultiplier,
    fpsCap: nextMode === "scalper" ? 24 : nextMode === "macro" ? 7 : nextMode === "institutional" ? 12 : 15,
    visibleRange: nextMode === "macro" ? "5" : nextMode === "institutional" || nextMode === "standard" ? "2" : nextMode === "scalper" ? "0.25" : "1",
    heatmapHorizon: nextMode === "macro" ? "1w" : nextMode === "institutional" || nextMode === "standard" ? "24h" : nextMode === "intraday" ? "12h" : "2h",
    maxHeatmapHistory: nextMode === "macro" ? 520 : nextMode === "institutional" ? 360 : nextMode === "intraday" ? 240 : 120,
    macroLookbackDays: nextMode === "macro" ? 720 : 365,
    persistenceSmoothing: nextMode === "scalper" ? 68 : nextMode === "macro" ? 94 : 88
  };
}
