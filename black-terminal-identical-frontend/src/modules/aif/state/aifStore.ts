import type { AifSettings } from "../core/aifTypes";

export const AIF_SETTINGS_VERSION = 4;

export const AIF_SETTINGS_PRESETS: Record<string, Partial<AifSettings>> = {
  "HDLX-Inspired Structural": { rowCount: 150, valueAreaPercent: 68, profileWidth: 31, nodeMethod: "neighbor-contrast", lvnNeighborWindow: 4, lvnMinimumContrast: 1.45, showSupportResistance: true, showMinorNodes: false, futureLvnMaxTotal: 6 },
  "A.I.F. Institutional": { lookbackBars: 20000, rowCount: 300, nodeMethod: "hybrid-structural", multiLookbackStability: "major", futureLvnPolicy: "untested-first-test", futureLvnMaxTotal: 7, calculationMode: "balanced" },
  "A.I.F. Macro": { lookbackBars: 50000, rowCount: 300, nodeMethod: "hybrid-structural", futureLvnMinimumStability: 60, futureLvnMaxTotal: 5, labelDensity: "low", calculationMode: "performance" },
  "A.I.F. Research": { rowCount: 500, showMinorNodes: true, futureLvnPolicy: "all-qualified", futureLvnMaxTotal: 12, labelDensity: "high", multiLookbackStability: "all", resolutionStability: "off", calculationMode: "maximum-detail" },
  Minimal: { secondaryProfile: "off", showNodes: false, showSupportResistance: false, showTimeline: false, showStatisticsCard: false, futureLvnMaxTotal: 4, labelDensity: "low" }
};

export function defaultAifSettings(): AifSettings {
  return {
    version: AIF_SETTINGS_VERSION,
    primaryProfile: "volume",
    secondaryProfile: "off",
    profilePlacement: "right",
    profileHorizontalOffset: 0,
    profileNormalization: "percent-max",
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
    valueAreaPercent: 70,
    pocMode: "fixed",
    showVah: true,
    showVal: true,
    valueAreaColor: "#ff1738",
    valueAreaOpacity: 18,
    showNodes: true,
    showFutureLvns: true,
    showSupportResistance: true,
    extendLevels: true,
    nodeSensitivity: 62,
    nodeMethod: "hybrid-structural",
    lvnPercentileThreshold: 24,
    lvnRelativePocThreshold: 0.22,
    lvnRobustZThreshold: -0.8,
    lvnNeighborWindow: 4,
    lvnMinimumContiguousRows: 2,
    lvnInternalGapRows: 1,
    lvnMinimumWidthRows: 2,
    lvnMaximumWidthRows: 18,
    lvnMergeDistanceRows: 1,
    lvnMinimumContrast: 1.35,
    lvnMinimumStrength: 55,
    lvnEdgeExclusionRows: 3,
    showHvns: true,
    showLvns: true,
    showMinorNodes: false,
    futureLvnPolicy: "untested-first-test",
    futureLvnMinimumStability: 40,
    futureLvnMinimumContrast: 1.35,
    futureLvnMinimumConfidence: 58,
    futureLvnMaxAbove: 4,
    futureLvnMaxBelow: 4,
    futureLvnMaxTotal: 7,
    futureLvnMinimumScore: 56,
    futureLvnZoneOpacity: 14,
    futureLvnBoundaryOpacity: 52,
    futureLvnShowCenter: true,
    futureLvnShowMinimumActivity: false,
    futureLvnShowScore: true,
    futureLvnShowLookback: true,
    futureLvnShowState: true,
    futureLvnKeepTested: true,
    futureLvnKeepInvalidated: "off",
    showTimeline: true,
    timelineHeight: 46,
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
    showStatisticsCard: true,
    showLabels: true,
    calculationMode: "balanced",
    maximumVisibleNodes: 18,
    maximumTimelineEvents: 200,
    multiLookbackStability: "major",
    resolutionStability: "off",
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
  try { localStorage.setItem(aifSettingsKey(workspaceId, symbolKey), JSON.stringify(settings)); } catch { /* Storage pressure must never disable calculation or in-memory settings. */ }
}

export function migrateAifSettings(input: unknown): AifSettings {
  const fallback = defaultAifSettings();
  if (!input || typeof input !== "object") return fallback;
  const source = input as Partial<AifSettings>;
  const merged = { ...fallback, ...source, version: AIF_SETTINGS_VERSION };
  if (!["volume", "delta", "tpo", "volatility", "pressure"].includes(merged.primaryProfile)) merged.primaryProfile = "volume";
  if (merged.secondaryProfile !== "off" && !["volume", "delta", "tpo", "volatility", "pressure"].includes(merged.secondaryProfile)) merged.secondaryProfile = "off";
  if (merged.secondaryProfile === merged.primaryProfile) merged.secondaryProfile = "off";
  merged.rangeMode = "lookback";
  merged.anchorTime = null;
  merged.sourceResolution = "best";
  merged.pocMode = "fixed";
  merged.resolutionStability = "off";
  if (!/^#[0-9a-f]{6}$/i.test(merged.valueAreaColor)) merged.valueAreaColor = fallback.valueAreaColor;
  merged.lookbackBars = clampInteger(merged.lookbackBars, 100, 100_000);
  merged.rowCount = clampInteger(merged.rowCount, 50, 2_000);
  merged.lvnNeighborWindow = clampInteger(merged.lvnNeighborWindow, 1, 30);
  merged.lvnMinimumContiguousRows = clampInteger(merged.lvnMinimumContiguousRows, 1, 20);
  merged.lvnInternalGapRows = clampInteger(merged.lvnInternalGapRows, 0, 5);
  merged.lvnMinimumWidthRows = clampInteger(merged.lvnMinimumWidthRows, 1, 100);
  merged.lvnMaximumWidthRows = clampInteger(merged.lvnMaximumWidthRows, merged.lvnMinimumWidthRows, 100);
  merged.lvnMergeDistanceRows = clampInteger(merged.lvnMergeDistanceRows, 0, 20);
  merged.lvnEdgeExclusionRows = clampInteger(merged.lvnEdgeExclusionRows, 0, Math.max(0, Math.floor(merged.rowCount / 4)));
  merged.futureLvnMaxAbove = clampInteger(merged.futureLvnMaxAbove, 0, 20);
  merged.futureLvnMaxBelow = clampInteger(merged.futureLvnMaxBelow, 0, 20);
  merged.futureLvnMaxTotal = clampInteger(merged.futureLvnMaxTotal, 1, Math.max(1, merged.futureLvnMaxAbove + merged.futureLvnMaxBelow));
  merged.maximumVisibleNodes = clampInteger(merged.maximumVisibleNodes, 4, 80);
  merged.maximumTimelineEvents = clampInteger(merged.maximumTimelineEvents, 20, 500);
  return merged;
}

function clampInteger(value: number, min: number, max: number) { return Math.max(min, Math.min(max, Math.round(Number.isFinite(value) ? value : min))); }
