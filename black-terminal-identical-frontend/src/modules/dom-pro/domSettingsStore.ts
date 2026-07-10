import type { DomMode, DomSettings } from "./types";

const storagePrefix = "bt_dom_pro_settings";

export const modeBucketDefaults: Record<DomMode, DomSettings["bucketMultiplier"]> = {
  micro: 1,
  scalper: 25,
  standard: 100,
  intraday: 250,
  institutional: 500,
  swing: 250,
  macro: 1000,
  custom: "custom"
};

export function defaultDomSettings(workspaceId: string, symbolKey: string): DomSettings {
  return {
    workspaceId,
    symbolKey,
    workspacePreset: "institutional",
    mode: "institutional",
    bucketMultiplier: 500,
    customBucketSize: 50,
    visibleRange: "2",
    customVisibleRangePct: 2,
    fpsCap: 12,
    showVolumeProfile: true,
    showHeatmap: true,
    showWallDetection: true,
    showCvd: true,
    showDepthChart: true,
    showExecutionPanel: true,
    showDiagnostics: true,
    showMacroRadar: true,
    colorIntensity: 82,
    liquidityThreshold: 2.8,
    maxVisibleBuckets: 180,
    maxHeatmapHistory: 520,
    heatmapHorizon: "24h",
    cvdHorizon: "4h",
    cvdSampleIntervalSec: 10,
    cvdSmoothingLength: 34,
    macroLookbackDays: 365,
    macroBandCount: 10,
    persistenceSmoothing: 88,
    updateThrottleMs: 90,
    profileSource: "visible-range",
    profileWidth: 42,
    showPoc: true,
    showHvnLvn: true,
    showValueArea: false,
    followMarket: false,
    freeExplore: true
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
  const nextMode = mode === "micro" ? "scalper" : mode === "swing" ? "institutional" : mode;
  const bucketMultiplier = modeBucketDefaults[nextMode];
  return {
    ...settings,
    mode: nextMode,
    workspacePreset: nextMode === "scalper" || nextMode === "intraday" || nextMode === "macro" ? nextMode : "institutional",
    bucketMultiplier,
    fpsCap: nextMode === "scalper" ? 24 : nextMode === "macro" ? 7 : nextMode === "institutional" ? 10 : 15,
    visibleRange: nextMode === "macro" ? "5" : nextMode === "institutional" || nextMode === "standard" ? "2" : nextMode === "scalper" ? "0.25" : "1",
    heatmapHorizon: nextMode === "macro" ? "3d" : nextMode === "institutional" || nextMode === "standard" ? "24h" : nextMode === "intraday" ? "6h" : "15m",
    cvdHorizon: nextMode === "macro" ? "12h" : nextMode === "institutional" || nextMode === "standard" ? "4h" : nextMode === "intraday" ? "1h" : "15m",
    cvdSampleIntervalSec: nextMode === "scalper" ? 5 : nextMode === "macro" ? 30 : 10,
    cvdSmoothingLength: nextMode === "scalper" ? 14 : nextMode === "macro" ? 50 : 34,
    maxVisibleBuckets: nextMode === "macro" ? 220 : nextMode === "institutional" ? 180 : nextMode === "intraday" ? 150 : 90,
    maxHeatmapHistory: nextMode === "macro" ? 720 : nextMode === "institutional" ? 520 : nextMode === "intraday" ? 300 : 120,
    macroLookbackDays: nextMode === "macro" ? 720 : 365,
    persistenceSmoothing: nextMode === "scalper" ? 68 : nextMode === "macro" ? 94 : 88
  };
}
