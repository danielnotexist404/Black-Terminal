import type { DomMode, DomSettings } from "./types";

const storagePrefix = "bt_dom_pro_settings";

export const modeBucketDefaults: Record<DomMode, DomSettings["bucketMultiplier"]> = {
  micro: 1,
  scalper: 10,
  standard: 50,
  swing: 250,
  macro: 500,
  custom: "custom"
};

export function defaultDomSettings(workspaceId: string, symbolKey: string): DomSettings {
  return {
    workspaceId,
    symbolKey,
    mode: "standard",
    bucketMultiplier: 50,
    customBucketSize: 50,
    visibleRange: "auto",
    customVisibleRangePct: 1,
    fpsCap: 15,
    showVolumeProfile: true,
    showHeatmap: true,
    showWallDetection: true,
    showCvd: true,
    showExecutionPanel: true,
    showDiagnostics: true,
    colorIntensity: 82,
    liquidityThreshold: 2.2,
    maxVisibleBuckets: 90,
    maxHeatmapHistory: 90,
    updateThrottleMs: 66,
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
  return {
    ...settings,
    mode,
    bucketMultiplier,
    fpsCap: mode === "scalper" ? 30 : mode === "macro" ? 8 : mode === "micro" ? 15 : 15,
    visibleRange: mode === "macro" ? "5" : mode === "swing" ? "2" : mode === "micro" ? "0.25" : settings.visibleRange
  };
}
