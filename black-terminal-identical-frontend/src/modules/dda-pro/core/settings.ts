import { DDA_PRO_SETTINGS_VERSION, type DDAProPreset, type DDAProSettings, type DDAProTheme } from "./types.ts";

export const DEFAULT_DDA_PRO_SETTINGS: DDAProSettings = {
  settingsVersion: DDA_PRO_SETTINGS_VERSION,
  engineMode: "black-core-native",
  preset: "BC-RDA — Institutional",
  source: "close",
  peakMode: "all-history",
  equitySource: "price",
  realtimeMode: "confirmed-bars",
  lookback: 500,
  smoothingMethod: "ema",
  smoothingLength: 14,
  quantileMethod: "type7",
  zScoreMethod: "robust",
  sigmaMultiplier: 2,
  downsideOnlySigma: true,
  annualizationMode: "auto",
  customPeriodsPerYear: 365,
  riskFreeRatePercent: 4,
  vaddVolatilityFloorPercent: 0.10,
  drawdownEpisodeThresholdPercent: 0.10,
  hysteresisPercent: 2,
  moderateThreshold: 50,
  highThreshold: 75,
  extremeThreshold: 90,
  depthWeight: 0.45,
  durationWeight: 0.20,
  velocityWeight: 0.15,
  volatilityWeight: 0.10,
  tailWeight: 0.10,
  showRawDrawdown: false,
  showSmoothedDrawdown: true,
  showMean: true,
  showSigmaBands: true,
  showQuantiles: true,
  showZScore: false,
  showDuration: false,
  showVelocity: false,
  showRiskScore: true,
  showDashboard: true,
  showExpandedDashboard: false,
  showEpisodeMarkers: true,
  theme: "black-terminal",
  scaleMode: "dynamic-tail",
  customScaleDepthPercent: 20,
  dashboardPosition: "top-right",
  rawColor: "#777b83",
  smoothedColor: "#f2f2f4",
  meanColor: "#9699a0",
  moderateColor: "#7f111b",
  highColor: "#c50020",
  extremeColor: "#ff1838",
  lineIntensity: 92,
  fillIntensity: 16,
  lineWidth: 1.5
};

const PRESETS: Record<Exclude<DDAProPreset, "Custom">, Partial<DDAProSettings>> = {
  "BC-RDA — Original Compatibility": {
    engineMode: "pine-compatibility", lookback: 500, peakMode: "all-history", smoothingMethod: "ema",
    smoothingLength: 14, quantileMethod: "nearest-rank", zScoreMethod: "classical",
    annualizationMode: "traditional-252", downsideOnlySigma: false, theme: "edge-tools"
  },
  "BC-RDA — Institutional": {
    engineMode: "black-core-native", lookback: 500, peakMode: "all-history", smoothingMethod: "ema",
    smoothingLength: 14, quantileMethod: "type7", zScoreMethod: "robust", downsideOnlySigma: true,
    sigmaMultiplier: 2, theme: "black-terminal"
  },
  "BC-RDA — Macro Risk": {
    engineMode: "black-core-native", lookback: 5_000, peakMode: "all-history", smoothingMethod: "ema",
    smoothingLength: 21, quantileMethod: "type7", zScoreMethod: "robust", sigmaMultiplier: 3,
    showRawDrawdown: true, showDuration: true, showVelocity: true, showEpisodeMarkers: true,
    theme: "institutional-monochrome"
  }
};

const PRESET_MIGRATIONS: Record<string, DDAProPreset> = {
  "Pine Exact": "BC-RDA — Original Compatibility",
  Institutional: "BC-RDA — Institutional",
  "Tail Risk": "BC-RDA — Macro Risk",
  "DDA Pro — Original": "BC-RDA — Original Compatibility",
  "BC-DDA — Institutional": "BC-RDA — Institutional",
  "BC-DDA — Macro Risk": "BC-RDA — Macro Risk",
  "Fast Risk": "Custom"
};

const THEMES = new Set<DDAProTheme>(["black-terminal", "black-terminal-blood", "institutional-monochrome", "custom", "gold", "edge-tools", "behavioral", "quant", "ocean", "fire", "matrix", "arctic"]);
const finite = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;

export function migrateDDAProSettings(value?: Partial<DDAProSettings> | null): DDAProSettings {
  const legacyPreset = typeof value?.preset === "string" ? PRESET_MIGRATIONS[value.preset] : undefined;
  const merged = { ...DEFAULT_DDA_PRO_SETTINGS, ...(value ?? {}), ...(legacyPreset ? { preset: legacyPreset } : {}) };
  const moderateThreshold = Math.max(0, Math.min(95, finite(merged.moderateThreshold, 50)));
  const highThreshold = Math.max(moderateThreshold, Math.min(99, finite(merged.highThreshold, 75)));
  const extremeThreshold = Math.max(highThreshold, Math.min(100, finite(merged.extremeThreshold, 90)));
  return {
    ...merged,
    settingsVersion: DDA_PRO_SETTINGS_VERSION,
    theme: THEMES.has(merged.theme) ? merged.theme : "black-terminal",
    lookback: Math.max(100, Math.min(20_000, Math.round(finite(merged.lookback, 500)))),
    smoothingLength: Math.max(1, Math.min(500, Math.round(finite(merged.smoothingLength, 14)))),
    sigmaMultiplier: Math.max(0.25, Math.min(6, finite(merged.sigmaMultiplier, 2))),
    customPeriodsPerYear: Math.max(1, Math.min(1_000_000, Math.round(finite(merged.customPeriodsPerYear, 365)))),
    riskFreeRatePercent: Math.max(-25, Math.min(100, finite(merged.riskFreeRatePercent, 4))),
    vaddVolatilityFloorPercent: Math.max(0.001, Math.min(100, finite(merged.vaddVolatilityFloorPercent, 0.10))),
    drawdownEpisodeThresholdPercent: Math.max(0, Math.min(50, finite(merged.drawdownEpisodeThresholdPercent, 0.10))),
    hysteresisPercent: Math.max(0, Math.min(20, finite(merged.hysteresisPercent, 2))),
    moderateThreshold, highThreshold, extremeThreshold,
    depthWeight: Math.max(0, Math.min(1, finite(merged.depthWeight, 0.45))),
    durationWeight: Math.max(0, Math.min(1, finite(merged.durationWeight, 0.20))),
    velocityWeight: Math.max(0, Math.min(1, finite(merged.velocityWeight, 0.15))),
    volatilityWeight: Math.max(0, Math.min(1, finite(merged.volatilityWeight, 0.10))),
    tailWeight: Math.max(0, Math.min(1, finite(merged.tailWeight, 0.10))),
    customScaleDepthPercent: Math.max(1, Math.min(100, finite(merged.customScaleDepthPercent, 20))),
    lineIntensity: Math.max(0, Math.min(100, Math.round(finite(merged.lineIntensity, 92)))),
    fillIntensity: Math.max(0, Math.min(60, Math.round(finite(merged.fillIntensity, 16)))),
    lineWidth: Math.max(0.5, Math.min(5, finite(merged.lineWidth, 1.5)))
  };
}

export function applyDDAProPreset(settings: DDAProSettings, preset: DDAProPreset): DDAProSettings {
  if (preset === "Custom") return { ...settings, preset };
  return migrateDDAProSettings({ ...settings, ...PRESETS[preset], preset });
}

export function resolveDDAProBarsPerYear(settings: DDAProSettings, timeframeSeconds = 86_400) {
  if (settings.annualizationMode === "custom") return settings.customPeriodsPerYear;
  const days = settings.annualizationMode === "traditional-252" ? 252 : 365.25;
  return Math.max(1, days * 86_400 / Math.max(1, timeframeSeconds));
}

export function ddaProCalculationSettingsHash(settings: DDAProSettings) {
  const value = { ...migrateDDAProSettings(settings) } as Record<string, unknown>;
  for (const key of ["preset", "theme", "scaleMode", "customScaleDepthPercent", "dashboardPosition", "rawColor", "smoothedColor", "meanColor", "moderateColor", "highColor", "extremeColor", "lineIntensity", "fillIntensity", "lineWidth", "showRawDrawdown", "showSmoothedDrawdown", "showMean", "showSigmaBands", "showQuantiles", "showZScore", "showDuration", "showVelocity", "showRiskScore", "showDashboard", "showExpandedDashboard", "showEpisodeMarkers"]) delete value[key];
  const json = JSON.stringify(value, Object.keys(value).sort());
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index++) { hash ^= json.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return "fnv1a-" + hash.toString(16).padStart(8, "0");
}

export function ddaProSettingsHash(settings: DDAProSettings) {
  const json = JSON.stringify(migrateDDAProSettings(settings), Object.keys(DEFAULT_DDA_PRO_SETTINGS).sort());
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index++) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}
