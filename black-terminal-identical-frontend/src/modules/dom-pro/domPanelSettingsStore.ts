import type { DomWorkspacePreset } from "./types";

export type DomPanelId =
  | "ladder"
  | "volume-profile"
  | "liquidity-heatmap"
  | "wall-detection"
  | "trade-tape"
  | "dom-metrics"
  | "heuristic-cvd"
  | "depth-chart"
  | "liquidity-flow-delta"
  | "execution";

export type DomPanelSettingValue = string | number | boolean;
export type DomPanelValues = Record<string, DomPanelSettingValue>;

export type DomPanelSettings = {
  panelId: DomPanelId;
  version: number;
  settings: DomPanelValues;
  defaultSettings: DomPanelValues;
  preset: string;
  updatedAt: number;
};

export type DomPanelSettingsRegistry = {
  schemaVersion: number;
  workspaceId: string;
  symbolKey: string;
  workspacePreset: DomWorkspacePreset;
  panels: Record<DomPanelId, DomPanelSettings>;
};

export type DomPanelField = {
  key: string;
  label: string;
  kind: "number" | "select" | "toggle";
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; label: string }>;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const DOM_PANEL_SETTINGS_VERSION = 6;
const storagePrefix = "bt_dom_pro_panel_settings";

const qualityFields = {
  visible: true,
  collapsed: false,
  freezeOnHover: false,
  showDataQuality: true
};

const panelDefaults: Record<DomPanelId, { preset: string; settings: DomPanelValues }> = {
  ladder: { preset: "Smoothed", settings: { ...qualityFields, updateIntervalMs: 500, renderFps: 8, levels: 42, minimumSize: 0, smoothing: 4, cameraMode: "shared", coverageMode: "dim", displayUnits: "base", showCumulativeDepth: false, showNetDepth: false, showLiveCoverage: true, showWallConfluence: true, autoCenter: false } },
  "volume-profile": { preset: "Structural", settings: { ...qualityFields, updateIntervalMs: 2000, renderFps: 4, rowCount: 128, smoothing: 8, valueAreaPct: 70, showPoc: true, showHvnLvn: true, showLabels: true, sharedCameraLock: true } },
  "liquidity-heatmap": { preset: "Institutional", settings: { ...qualityFields, updateIntervalMs: 1000, renderFps: 8, minimumSize: 0, smoothing: 88, persistenceThreshold: 55, decayPct: 92, majorWallsOnly: false, enhancedGraphics: true, showBuyWalls: true, showSellWalls: true, showLabels: true } },
  "wall-detection": { preset: "Institutional", settings: { ...qualityFields, freezeOnHover: true, updateIntervalMs: 3000, renderFps: 2, minimumWallSize: 0, relativeThreshold: 2.2, activationScore: 62, deactivationScore: 44, minimumPersistenceMs: 8000, minimumAgeMs: 5000, minimumObservations: 3, maximumCancellationRatio: 0.7, maximumRows: 8, sortMode: "reliability", majorOnly: false, showPulled: true, showAbsorbed: true, showMigrated: true } },
  "trade-tape": { preset: "Aggregated", settings: { ...qualityFields, freezeOnHover: true, updateIntervalMs: 500, renderFps: 6, minimumTradeSize: 0, displayRows: 22, aggregateSamePrice: true, groupingIntervalMs: 1000, highlightLargeTrades: true, autoScroll: true, decimalPrecision: 3 } },
  "dom-metrics": { preset: "Smoothed", settings: { ...qualityFields, freezeOnHover: true, updateIntervalMs: 2000, renderFps: 2, smoothingLength: 12, stateChangeDelayMs: 5000, hysteresisPct: 5, rawValues: false, highlightSignificantOnly: true, showSparkline: false } },
  "heuristic-cvd": { preset: "Structural", settings: { ...qualityFields, updateIntervalMs: 5000, renderFps: 2, sourceTimeframe: "4h", lookbackBars: 240, cumulationType: "sum", cumulationLength: 14, normalizeMovingAverages: true, scaleFactor: 1, visibleCandles: 120, outlierPercentile: 99, minimumTradeSize: 0, trendThreshold: 0.08, showDeltaBars: true, showBuySellEnvelope: true } },
  "depth-chart": { preset: "Structural", settings: { ...qualityFields, updateIntervalMs: 3000, renderFps: 3, mode: "structural", samplingIntervalMs: 500, smoothingWindow: 12, emaLength: 10, persistenceThreshold: 55, minimumVisibleSize: 0, levels: 180, bucketAggregation: 4, outlierPercentile: 98, curvePower: 0.72, fillOpacity: 42, jointNormalization: true } },
  "liquidity-flow-delta": { preset: "Structural", settings: { ...qualityFields, updateIntervalMs: 2000, renderFps: 3, horizon: "1h", timeBucketSec: 10, smoothingLength: 10, outlierPercentile: 95, minimumEventSize: 0, displayMode: "histogram", showAdded: true, showRemoved: true, showNet: true } },
  execution: { preset: "Desk", settings: { ...qualityFields, updateIntervalMs: 1000, renderFps: 2, defaultOrderType: "limit", defaultSizingMode: "quantity", defaultTif: "gtc", defaultMarginMode: "cross", confirmationPolicy: "venue", privacyMode: false, showAdvancedStrategies: true, compactMode: false, estimateRefreshMs: 1000 } }
};

export const domPanelFields: Record<DomPanelId, DomPanelField[]> = {
  ladder: [selectField("cameraMode", "Camera", ["shared", "follow-current", "independent"]), selectField("coverageMode", "Uncovered Prices", ["show", "dim", "hide"]), selectField("displayUnits", "Formatting", ["base", "contracts", "notional"]), numberField("updateIntervalMs", "Update Interval", 100, 5000, 100), numberField("levels", "Shared Visible Rows", 12, 120, 1), numberField("minimumSize", "Minimum Size", 0, 10000, 0.01), numberField("smoothing", "Smoothing", 1, 30, 1), toggleField("showLiveCoverage", "Live Coverage"), toggleField("showNetDepth", "Net Depth"), toggleField("showWallConfluence", "Wall Confluence"), toggleField("showCumulativeDepth", "Cumulative Depth")],
  "volume-profile": [numberField("updateIntervalMs", "Update Interval", 250, 15000, 250), numberField("rowCount", "Profile Rows", 64, 256, 1), numberField("smoothing", "Smoothing", 1, 30, 1), numberField("valueAreaPct", "Value Area %", 50, 95, 1), toggleField("showPoc", "Show POC"), toggleField("showHvnLvn", "Show HVN/LVN"), toggleField("showLabels", "Show Labels"), toggleField("sharedCameraLock", "Shared Camera Lock")],
  "liquidity-heatmap": [numberField("updateIntervalMs", "Refresh Cadence", 100, 10000, 100), numberField("minimumSize", "Minimum Size", 0, 10000, 0.01), numberField("smoothing", "Smoothing", 40, 98, 1), numberField("persistenceThreshold", "Persistence %", 0, 100, 1), numberField("decayPct", "Decay %", 50, 99, 1), toggleField("enhancedGraphics", "Enhanced Liquidity Graphics"), toggleField("majorWallsOnly", "Major Walls Only"), toggleField("showBuyWalls", "Show Buy Walls"), toggleField("showSellWalls", "Show Sell Walls"), toggleField("showLabels", "Show Level Details")],
  "wall-detection": [numberField("updateIntervalMs", "Refresh Cadence", 250, 15000, 250), numberField("minimumWallSize", "Minimum Wall Size", 0, 10000, 0.01), numberField("relativeThreshold", "Relative Threshold", 1, 8, 0.1), numberField("minimumPersistenceMs", "Minimum Persistence", 0, 120000, 1000), numberField("minimumObservations", "Minimum Observations", 1, 100, 1), numberField("maximumRows", "Maximum Rows", 1, 20, 1), selectField("sortMode", "Sort", ["reliability", "strength", "persistence", "age", "size", "distance"]), toggleField("majorOnly", "Major Only"), toggleField("showPulled", "Show Pulled Walls"), toggleField("freezeOnHover", "Freeze On Hover")],
  "trade-tape": [numberField("updateIntervalMs", "Update Cadence", 100, 5000, 100), numberField("minimumTradeSize", "Minimum Trade Size", 0, 10000, 0.001), numberField("displayRows", "Display Rows", 5, 60, 1), numberField("groupingIntervalMs", "Grouping Interval", 0, 10000, 100), toggleField("aggregateSamePrice", "Aggregate Same Price"), toggleField("highlightLargeTrades", "Highlight Large Trades"), toggleField("freezeOnHover", "Pause On Hover"), toggleField("autoScroll", "Auto Scroll")],
  "dom-metrics": [numberField("updateIntervalMs", "Update Interval", 250, 15000, 250), numberField("smoothingLength", "EMA Length", 1, 100, 1), numberField("stateChangeDelayMs", "State Confirmation", 0, 30000, 500), numberField("hysteresisPct", "Hysteresis %", 0, 30, 1), toggleField("rawValues", "Raw Values"), toggleField("highlightSignificantOnly", "Significant Changes Only"), toggleField("freezeOnHover", "Freeze On Hover"), toggleField("showDataQuality", "Data Quality")],
  "heuristic-cvd": [selectField("sourceTimeframe", "Structure Timeframe", ["15m", "1h", "4h", "1d"]), numberField("lookbackBars", "Historical Bars", 48, 1000, 1), selectField("cumulationType", "Cumulation", ["sum", "ema", "sma"]), numberField("cumulationLength", "Cumulation Length", 2, 100, 1), toggleField("normalizeMovingAverages", "Normalize EMA / SMA"), numberField("scaleFactor", "Cumulative Scale", 0.125, 8, 0.125), numberField("visibleCandles", "Visible Structure Bars", 24, 500, 1), numberField("outlierPercentile", "Delta Outlier Percentile", 80, 100, 1), numberField("updateIntervalMs", "Panel Cadence", 1000, 15000, 500), toggleField("showDeltaBars", "Show Delta Histogram"), toggleField("showBuySellEnvelope", "Show Buy / Sell Structure")],
  "depth-chart": [selectField("mode", "Depth Mode", ["raw", "smoothed", "structural", "macro"]), numberField("updateIntervalMs", "Update Interval", 100, 15000, 100), numberField("samplingIntervalMs", "Sampling Interval", 100, 5000, 100), numberField("smoothingWindow", "Snapshot Window", 1, 100, 1), numberField("emaLength", "EMA Length", 1, 100, 1), numberField("persistenceThreshold", "Persistence %", 0, 100, 1), numberField("minimumVisibleSize", "Minimum Size", 0, 10000, 0.01), numberField("levels", "Display Levels", 20, 420, 1), numberField("bucketAggregation", "Bucket Aggregation", 1, 40, 1), numberField("outlierPercentile", "Outlier Percentile", 80, 100, 1), numberField("curvePower", "Curve", 0.45, 1.4, 0.05)],
  "liquidity-flow-delta": [selectField("horizon", "Horizon", ["1m", "5m", "15m", "1h", "structural"]), numberField("timeBucketSec", "Time Bucket", 1, 3600, 1), numberField("updateIntervalMs", "Sampling Cadence", 100, 15000, 100), numberField("smoothingLength", "Smoothing", 1, 100, 1), numberField("outlierPercentile", "Outlier Percentile", 80, 100, 1), numberField("minimumEventSize", "Minimum Event Size", 0, 10000, 0.01), selectField("displayMode", "Display", ["histogram", "line"]), toggleField("showNet", "Show Net Flow")],
  execution: [selectField("defaultOrderType", "Default Order Type", ["limit", "market", "twap", "iceberg"]), selectField("defaultSizingMode", "Default Sizing", ["quantity", "notional", "percent"]), selectField("defaultTif", "Default TIF", ["gtc", "ioc", "fok"]), selectField("defaultMarginMode", "Default Margin", ["cross", "isolated"]), selectField("confirmationPolicy", "Confirmation", ["venue", "always", "never"]), numberField("estimateRefreshMs", "Estimate Refresh", 250, 10000, 250), toggleField("privacyMode", "Privacy Mode"), toggleField("showAdvancedStrategies", "Advanced Strategies"), toggleField("compactMode", "Compact Mode")]
};

export const domPanelPresets: Record<DomPanelId, Record<string, Partial<DomPanelValues>>> = {
  ladder: { Raw: { updateIntervalMs: 100, smoothing: 1 }, Smoothed: { updateIntervalMs: 500, smoothing: 4 }, Structural: { updateIntervalMs: 2000, smoothing: 10 } },
  "volume-profile": { Visible: { updateIntervalMs: 500, rowCount: 128 }, Structural: { updateIntervalMs: 2000, rowCount: 128, smoothing: 8 }, Macro: { updateIntervalMs: 10000, rowCount: 192, smoothing: 16 } },
  "liquidity-heatmap": { Fast: { updateIntervalMs: 250, smoothing: 68, enhancedGraphics: false }, Institutional: { updateIntervalMs: 1000, smoothing: 88, enhancedGraphics: true }, Macro: { updateIntervalMs: 5000, smoothing: 94, enhancedGraphics: true, majorWallsOnly: true } },
  "wall-detection": { "All Walls": { updateIntervalMs: 500, minimumPersistenceMs: 0, minimumObservations: 1, majorOnly: false }, Persistent: { updateIntervalMs: 2000, minimumPersistenceMs: 5000, minimumObservations: 2 }, Institutional: { updateIntervalMs: 3000, minimumPersistenceMs: 8000, minimumObservations: 3 }, "Major Only": { updateIntervalMs: 5000, minimumPersistenceMs: 15000, minimumObservations: 5, majorOnly: true } },
  "trade-tape": { Raw: { updateIntervalMs: 100, aggregateSamePrice: false }, Aggregated: { updateIntervalMs: 500, aggregateSamePrice: true, groupingIntervalMs: 1000 }, Structural: { updateIntervalMs: 2000, aggregateSamePrice: true, groupingIntervalMs: 5000 } },
  "dom-metrics": { Fast: { updateIntervalMs: 250, smoothingLength: 3, stateChangeDelayMs: 500 }, Smoothed: { updateIntervalMs: 2000, smoothingLength: 12, stateChangeDelayMs: 5000 }, Structural: { updateIntervalMs: 5000, smoothingLength: 30, stateChangeDelayMs: 12000 } },
  "heuristic-cvd": { Fast: { updateIntervalMs: 1000, sourceTimeframe: "15m", lookbackBars: 160, cumulationType: "sum", cumulationLength: 10, visibleCandles: 96 }, Intraday: { updateIntervalMs: 3000, sourceTimeframe: "1h", lookbackBars: 240, cumulationType: "sum", cumulationLength: 14, visibleCandles: 120 }, Structural: { updateIntervalMs: 5000, sourceTimeframe: "4h", lookbackBars: 240, cumulationType: "sum", cumulationLength: 14, visibleCandles: 120 }, Macro: { updateIntervalMs: 10000, sourceTimeframe: "1d", lookbackBars: 365, cumulationType: "ema", cumulationLength: 21, visibleCandles: 180 } },
  "depth-chart": { Raw: { mode: "raw", updateIntervalMs: 100, smoothingWindow: 1, bucketAggregation: 1 }, Smoothed: { mode: "smoothed", updateIntervalMs: 750, smoothingWindow: 6, bucketAggregation: 3 }, Structural: { mode: "structural", updateIntervalMs: 3000, smoothingWindow: 12, persistenceThreshold: 55, bucketAggregation: 4 }, Macro: { mode: "macro", updateIntervalMs: 8000, smoothingWindow: 40, persistenceThreshold: 72, bucketAggregation: 12 } },
  "liquidity-flow-delta": { Tick: { horizon: "1m", timeBucketSec: 1, updateIntervalMs: 250 }, "1m": { horizon: "1m", timeBucketSec: 5, updateIntervalMs: 500 }, "5m": { horizon: "5m", timeBucketSec: 10, updateIntervalMs: 1000 }, "15m": { horizon: "15m", timeBucketSec: 30, updateIntervalMs: 2000 }, "1h": { horizon: "1h", timeBucketSec: 60, updateIntervalMs: 3000 }, Structural: { horizon: "structural", timeBucketSec: 60, updateIntervalMs: 5000, smoothingLength: 20 } },
  execution: { Desk: { compactMode: false, confirmationPolicy: "venue" }, Compact: { compactMode: true }, Conservative: { confirmationPolicy: "always", defaultOrderType: "limit" } }
};

const workspacePresetMap: Record<DomWorkspacePreset, Partial<Record<DomPanelId, string>>> = {
  scalper: { ladder: "Raw", "volume-profile": "Visible", "liquidity-heatmap": "Fast", "wall-detection": "All Walls", "trade-tape": "Raw", "dom-metrics": "Fast", "heuristic-cvd": "Fast", "depth-chart": "Raw", "liquidity-flow-delta": "Tick" },
  intraday: { ladder: "Smoothed", "volume-profile": "Structural", "liquidity-heatmap": "Institutional", "wall-detection": "Persistent", "trade-tape": "Aggregated", "dom-metrics": "Smoothed", "heuristic-cvd": "Intraday", "depth-chart": "Smoothed", "liquidity-flow-delta": "15m" },
  institutional: { ladder: "Smoothed", "volume-profile": "Structural", "liquidity-heatmap": "Institutional", "wall-detection": "Institutional", "trade-tape": "Aggregated", "dom-metrics": "Smoothed", "heuristic-cvd": "Structural", "depth-chart": "Structural", "liquidity-flow-delta": "1h" },
  macro: { ladder: "Structural", "volume-profile": "Macro", "liquidity-heatmap": "Macro", "wall-detection": "Major Only", "trade-tape": "Structural", "dom-metrics": "Structural", "heuristic-cvd": "Macro", "depth-chart": "Macro", "liquidity-flow-delta": "Structural" }
};

export function defaultDomPanelRegistry(workspaceId: string, symbolKey: string): DomPanelSettingsRegistry {
  const now = Date.now();
  return {
    schemaVersion: DOM_PANEL_SETTINGS_VERSION,
    workspaceId,
    symbolKey,
    workspacePreset: "institutional",
    panels: Object.fromEntries(Object.entries(panelDefaults).map(([panelId, config]) => [panelId, {
      panelId,
      version: DOM_PANEL_SETTINGS_VERSION,
      settings: { ...config.settings },
      defaultSettings: { ...config.settings },
      preset: config.preset,
      updatedAt: now
    }])) as Record<DomPanelId, DomPanelSettings>
  };
}

export function domPanelSettingsKey(workspaceId: string, symbolKey: string) {
  return `${storagePrefix}:${workspaceId}:${symbolKey}`;
}

export function readDomPanelRegistry(workspaceId: string, symbolKey: string, storage = browserStorage()): DomPanelSettingsRegistry {
  const fallback = defaultDomPanelRegistry(workspaceId, symbolKey);
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(domPanelSettingsKey(workspaceId, symbolKey));
    return raw ? migrateDomPanelRegistry(JSON.parse(raw), workspaceId, symbolKey) : fallback;
  } catch {
    return fallback;
  }
}

export function writeDomPanelRegistry(registry: DomPanelSettingsRegistry, storage = browserStorage()) {
  if (!storage) return;
  try {
    storage.setItem(domPanelSettingsKey(registry.workspaceId, registry.symbolKey), JSON.stringify(registry));
  } catch {
    // Settings persistence must never interrupt the live rendering or execution surfaces.
  }
}

export function migrateDomPanelRegistry(input: unknown, workspaceId: string, symbolKey: string): DomPanelSettingsRegistry {
  const fallback = defaultDomPanelRegistry(workspaceId, symbolKey);
  if (!input || typeof input !== "object") return fallback;
  const source = input as Partial<DomPanelSettingsRegistry> & { panels?: Partial<Record<DomPanelId, Partial<DomPanelSettings>>> };
  const sourceVersion = Number(source.schemaVersion ?? 0);
  for (const panelId of Object.keys(fallback.panels) as DomPanelId[]) {
    const panel = source.panels?.[panelId];
    if (!panel || typeof panel.settings !== "object") continue;
    fallback.panels[panelId] = {
      ...fallback.panels[panelId],
      ...panel,
      panelId,
      version: DOM_PANEL_SETTINGS_VERSION,
      settings: { ...fallback.panels[panelId].settings, ...panel.settings },
      defaultSettings: { ...fallback.panels[panelId].defaultSettings }
    };
  }
  if (sourceVersion < 4) {
    const profile = fallback.panels["volume-profile"];
    profile.settings.rowCount = Math.max(128, Number(profile.settings.rowCount) || 0);
    profile.defaultSettings.rowCount = Math.max(128, Number(profile.defaultSettings.rowCount) || 0);
  }
  if (sourceVersion < 6) {
    const cvd = fallback.panels["heuristic-cvd"];
    cvd.settings.sourceTimeframe = "4h";
    cvd.settings.lookbackBars = Math.max(240, Number(cvd.settings.lookbackBars) || 0);
    cvd.settings.cumulationType = "sum";
    cvd.settings.cumulationLength = 14;
    cvd.settings.normalizeMovingAverages = true;
    cvd.settings.scaleFactor = 1;
    cvd.settings.visibleCandles = Math.max(120, Number(cvd.settings.visibleCandles) || 0);
    cvd.settings.showDeltaBars = true;
    cvd.settings.showBuySellEnvelope = true;
  }
  fallback.workspacePreset = source.workspacePreset && workspacePresetMap[source.workspacePreset] ? source.workspacePreset : "institutional";
  return fallback;
}

export function patchDomPanel(registry: DomPanelSettingsRegistry, panelId: DomPanelId, patch: Partial<DomPanelValues>): DomPanelSettingsRegistry {
  return {
    ...registry,
    panels: {
      ...registry.panels,
      [panelId]: { ...registry.panels[panelId], settings: { ...registry.panels[panelId].settings, ...patch }, updatedAt: Date.now() }
    }
  };
}

export function applyDomPanelPreset(registry: DomPanelSettingsRegistry, panelId: DomPanelId, preset: string): DomPanelSettingsRegistry {
  const patch = domPanelPresets[panelId][preset];
  if (!patch) return registry;
  const next = patchDomPanel(registry, panelId, patch);
  next.panels[panelId] = { ...next.panels[panelId], preset };
  return next;
}

export function applyDomWorkspacePreset(registry: DomPanelSettingsRegistry, preset: DomWorkspacePreset): DomPanelSettingsRegistry {
  let next = { ...registry, workspacePreset: preset };
  for (const [panelId, panelPreset] of Object.entries(workspacePresetMap[preset])) {
    if (panelPreset) next = applyDomPanelPreset(next, panelId as DomPanelId, panelPreset);
  }
  return next;
}

export function resetDomPanel(registry: DomPanelSettingsRegistry, panelId: DomPanelId): DomPanelSettingsRegistry {
  const panel = registry.panels[panelId];
  return { ...registry, panels: { ...registry.panels, [panelId]: { ...panel, settings: { ...panel.defaultSettings }, updatedAt: Date.now() } } };
}

export function resetAllDomPanels(registry: DomPanelSettingsRegistry) {
  return defaultDomPanelRegistry(registry.workspaceId, registry.symbolKey);
}

export function exportDomPanelSettings(registry: DomPanelSettingsRegistry) {
  return JSON.stringify(registry, null, 2);
}

export function importDomPanelSettings(raw: string, workspaceId: string, symbolKey: string) {
  return migrateDomPanelRegistry(JSON.parse(raw), workspaceId, symbolKey);
}

function numberField(key: string, label: string, min: number, max: number, step: number): DomPanelField {
  return { key, label, kind: "number", min, max, step };
}

function toggleField(key: string, label: string): DomPanelField {
  return { key, label, kind: "toggle" };
}

function selectField(key: string, label: string, values: string[]): DomPanelField {
  return { key, label, kind: "select", options: values.map((value) => ({ value, label: value.replace(/\b\w/g, (letter) => letter.toUpperCase()) })) };
}

function browserStorage(): StorageLike | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}
