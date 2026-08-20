import { DDA_PRO_SETTINGS_VERSION, type DDAProPreset, type DDAProSettings, type DDAProSignalIntelligenceMode, type DDAProTheme } from "./types.ts";

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
  showFlowPressure: true,
  flowPressureSmoothingLength: 5,
  flowPressureNormalizationLookback: 100,
  flowPressureNeutralThreshold: 12,
  flowPressureMinimumCoveragePercent: 95,
  flowAggressorWeight: 0.65,
  flowCvdWeight: 0.35,
  flowBullishColor: "#f2f2f4",
  flowBearishColor: "#ff1838",
  flowNeutralColor: "#777b83",
  flowLineIntensity: 92,
  flowLineWidth: 1.8,
  signalIntelligenceMode: "RAW",
  showRawSignals: true,
  showConfirmedSignals: true,
  showProvisionalSignals: false,
  confirmedAlertsOnly: true,
  showSignalConfidence: false,
  showRegimeDiagnostics: false,
  distributionCoherenceFilter: true,
  riskCentroidMigration: true,
  distributionExpansionConfirmation: true,
  tailAsymmetryConfirmation: true,
  entropyChopSuppression: true,
  excursionPersistence: true,
  signalEpisodeClustering: true,
  distributionalResetRequirement: true,
  priceStructureConfirmation: false,
  volumeConfirmation: false,
  cvdConfirmation: false,
  higherTimeframeConfirmation: false,
  minimumCoherence: 54,
  minimumCentroidDisplacement: 0.075,
  minimumCentroidPersistence: 2,
  minimumExpansionScore: 44,
  minimumTailAsymmetry: 28,
  maximumChopProbability: 62,
  maximumTransitionEntropy: 68,
  minimumExcursionBars: 2,
  minimumConfirmationScore: 58,
  resetSensitivity: 38,
  episodeSeparationSensitivity: 0.65,
  safetyCooldownFloor: 3,
  higherTimeframeMultiplier: 4,
  structureConfirmationStrength: 45,
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
const SIGNAL_MODES = new Set(["RAW", "BALANCED", "INSTITUTIONAL", "CUSTOM"]);
const finite = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const boolean = (value: unknown, fallback: boolean) => typeof value === "boolean" ? value : fallback;

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
    showFlowPressure: boolean(merged.showFlowPressure, true),
    flowPressureSmoothingLength: Math.max(1, Math.min(100, Math.round(finite(merged.flowPressureSmoothingLength, 5)))),
    flowPressureNormalizationLookback: Math.max(20, Math.min(2_000, Math.round(finite(merged.flowPressureNormalizationLookback, 100)))),
    flowPressureNeutralThreshold: Math.max(0, Math.min(50, finite(merged.flowPressureNeutralThreshold, 12))),
    flowPressureMinimumCoveragePercent: Math.max(50, Math.min(100, finite(merged.flowPressureMinimumCoveragePercent, 95))),
    flowAggressorWeight: Math.max(0, Math.min(1, finite(merged.flowAggressorWeight, 0.65))),
    flowCvdWeight: Math.max(0, Math.min(1, finite(merged.flowCvdWeight, 0.35))),
    flowBullishColor: typeof merged.flowBullishColor === "string" ? merged.flowBullishColor : "#f2f2f4",
    flowBearishColor: typeof merged.flowBearishColor === "string" ? merged.flowBearishColor : "#ff1838",
    flowNeutralColor: typeof merged.flowNeutralColor === "string" ? merged.flowNeutralColor : "#777b83",
    flowLineIntensity: Math.max(0, Math.min(100, Math.round(finite(merged.flowLineIntensity, 92)))),
    flowLineWidth: Math.max(0.5, Math.min(5, finite(merged.flowLineWidth, 1.8))),
    signalIntelligenceMode: SIGNAL_MODES.has(merged.signalIntelligenceMode) ? merged.signalIntelligenceMode : "RAW",
    showRawSignals: boolean(merged.showRawSignals, true),
    showConfirmedSignals: boolean(merged.showConfirmedSignals, true),
    showProvisionalSignals: boolean(merged.showProvisionalSignals, false),
    confirmedAlertsOnly: boolean(merged.confirmedAlertsOnly, true),
    showSignalConfidence: boolean(merged.showSignalConfidence, false),
    showRegimeDiagnostics: boolean(merged.showRegimeDiagnostics, false),
    distributionCoherenceFilter: boolean(merged.distributionCoherenceFilter, true),
    riskCentroidMigration: boolean(merged.riskCentroidMigration, true),
    distributionExpansionConfirmation: boolean(merged.distributionExpansionConfirmation, true),
    tailAsymmetryConfirmation: boolean(merged.tailAsymmetryConfirmation, true),
    entropyChopSuppression: boolean(merged.entropyChopSuppression, true),
    excursionPersistence: boolean(merged.excursionPersistence, true),
    signalEpisodeClustering: boolean(merged.signalEpisodeClustering, true),
    distributionalResetRequirement: boolean(merged.distributionalResetRequirement, true),
    priceStructureConfirmation: boolean(merged.priceStructureConfirmation, false),
    volumeConfirmation: boolean(merged.volumeConfirmation, false),
    cvdConfirmation: boolean(merged.cvdConfirmation, false),
    higherTimeframeConfirmation: boolean(merged.higherTimeframeConfirmation, false),
    minimumCoherence: Math.max(0, Math.min(100, finite(merged.minimumCoherence, 54))),
    minimumCentroidDisplacement: Math.max(0, Math.min(5, finite(merged.minimumCentroidDisplacement, 0.075))),
    minimumCentroidPersistence: Math.max(1, Math.min(20, Math.round(finite(merged.minimumCentroidPersistence, 2)))),
    minimumExpansionScore: Math.max(0, Math.min(100, finite(merged.minimumExpansionScore, 44))),
    minimumTailAsymmetry: Math.max(0, Math.min(100, finite(merged.minimumTailAsymmetry, 28))),
    maximumChopProbability: Math.max(0, Math.min(100, finite(merged.maximumChopProbability, 62))),
    maximumTransitionEntropy: Math.max(0, Math.min(100, finite(merged.maximumTransitionEntropy, 68))),
    minimumExcursionBars: Math.max(1, Math.min(20, Math.round(finite(merged.minimumExcursionBars, 2)))),
    minimumConfirmationScore: Math.max(0, Math.min(100, finite(merged.minimumConfirmationScore, 58))),
    resetSensitivity: Math.max(0, Math.min(100, finite(merged.resetSensitivity, 38))),
    episodeSeparationSensitivity: Math.max(0, Math.min(5, finite(merged.episodeSeparationSensitivity, 0.65))),
    safetyCooldownFloor: Math.max(0, Math.min(100, Math.round(finite(merged.safetyCooldownFloor, 3)))),
    higherTimeframeMultiplier: ([4, 12, 24] as number[]).includes(merged.higherTimeframeMultiplier) ? merged.higherTimeframeMultiplier : 4,
    structureConfirmationStrength: Math.max(0, Math.min(100, finite(merged.structureConfirmationStrength, 45))),
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

const SIGNAL_PRESETS: Record<Exclude<DDAProSignalIntelligenceMode, "CUSTOM">, Partial<DDAProSettings>> = {
  RAW: {
    signalIntelligenceMode: "RAW",
    showRawSignals: true,
    showConfirmedSignals: false,
    showProvisionalSignals: false,
    confirmedAlertsOnly: false
  },
  BALANCED: {
    signalIntelligenceMode: "BALANCED",
    showRawSignals: false, showConfirmedSignals: true, showProvisionalSignals: false, confirmedAlertsOnly: true,
    distributionCoherenceFilter: true, riskCentroidMigration: true, distributionExpansionConfirmation: true,
    tailAsymmetryConfirmation: true, entropyChopSuppression: true, excursionPersistence: true,
    signalEpisodeClustering: true, distributionalResetRequirement: true,
    priceStructureConfirmation: false, volumeConfirmation: false, cvdConfirmation: false, higherTimeframeConfirmation: false,
    minimumCoherence: 54, minimumCentroidDisplacement: 0.075, minimumCentroidPersistence: 2,
    minimumExpansionScore: 44, minimumTailAsymmetry: 28, maximumChopProbability: 62,
    maximumTransitionEntropy: 68, minimumExcursionBars: 2, minimumConfirmationScore: 58,
    resetSensitivity: 38, episodeSeparationSensitivity: 0.65, safetyCooldownFloor: 3
  },
  INSTITUTIONAL: {
    signalIntelligenceMode: "INSTITUTIONAL",
    realtimeMode: "confirmed-bars",
    showRawSignals: false, showConfirmedSignals: true, showProvisionalSignals: false, confirmedAlertsOnly: true,
    distributionCoherenceFilter: true, riskCentroidMigration: true, distributionExpansionConfirmation: true,
    tailAsymmetryConfirmation: true, entropyChopSuppression: true, excursionPersistence: true,
    signalEpisodeClustering: true, distributionalResetRequirement: true,
    priceStructureConfirmation: false, volumeConfirmation: false, cvdConfirmation: false, higherTimeframeConfirmation: false,
    minimumCoherence: 68, minimumCentroidDisplacement: 0.11, minimumCentroidPersistence: 3,
    minimumExpansionScore: 57, minimumTailAsymmetry: 42, maximumChopProbability: 45,
    maximumTransitionEntropy: 50, minimumExcursionBars: 3, minimumConfirmationScore: 70,
    resetSensitivity: 28, episodeSeparationSensitivity: 0.9, safetyCooldownFloor: 5
  }
};

export function applyDDAProSignalIntelligenceMode(settings: DDAProSettings, mode: DDAProSignalIntelligenceMode) {
  if (mode === "CUSTOM") return migrateDDAProSettings({ ...settings, signalIntelligenceMode: mode });
  return migrateDDAProSettings({ ...settings, ...SIGNAL_PRESETS[mode] });
}

export function resetDDAProSignalIntelligence(settings: DDAProSettings) {
  const defaults = DEFAULT_DDA_PRO_SETTINGS;
  const reset = migrateDDAProSettings({
    ...settings,
    signalIntelligenceMode: settings.signalIntelligenceMode,
    showRawSignals: defaults.showRawSignals,
    showConfirmedSignals: defaults.showConfirmedSignals,
    showProvisionalSignals: defaults.showProvisionalSignals,
    confirmedAlertsOnly: defaults.confirmedAlertsOnly,
    showSignalConfidence: defaults.showSignalConfidence,
    showRegimeDiagnostics: defaults.showRegimeDiagnostics,
    distributionCoherenceFilter: defaults.distributionCoherenceFilter,
    riskCentroidMigration: defaults.riskCentroidMigration,
    distributionExpansionConfirmation: defaults.distributionExpansionConfirmation,
    tailAsymmetryConfirmation: defaults.tailAsymmetryConfirmation,
    entropyChopSuppression: defaults.entropyChopSuppression,
    excursionPersistence: defaults.excursionPersistence,
    signalEpisodeClustering: defaults.signalEpisodeClustering,
    distributionalResetRequirement: defaults.distributionalResetRequirement,
    priceStructureConfirmation: defaults.priceStructureConfirmation,
    volumeConfirmation: defaults.volumeConfirmation,
    cvdConfirmation: defaults.cvdConfirmation,
    higherTimeframeConfirmation: defaults.higherTimeframeConfirmation,
    minimumCoherence: defaults.minimumCoherence,
    minimumCentroidDisplacement: defaults.minimumCentroidDisplacement,
    minimumCentroidPersistence: defaults.minimumCentroidPersistence,
    minimumExpansionScore: defaults.minimumExpansionScore,
    minimumTailAsymmetry: defaults.minimumTailAsymmetry,
    maximumChopProbability: defaults.maximumChopProbability,
    maximumTransitionEntropy: defaults.maximumTransitionEntropy,
    minimumExcursionBars: defaults.minimumExcursionBars,
    minimumConfirmationScore: defaults.minimumConfirmationScore,
    resetSensitivity: defaults.resetSensitivity,
    episodeSeparationSensitivity: defaults.episodeSeparationSensitivity,
    safetyCooldownFloor: defaults.safetyCooldownFloor,
    higherTimeframeMultiplier: defaults.higherTimeframeMultiplier,
    structureConfirmationStrength: defaults.structureConfirmationStrength
  });
  return settings.signalIntelligenceMode === "CUSTOM" ? reset : applyDDAProSignalIntelligenceMode(reset, settings.signalIntelligenceMode);
}

export function resolveDDAProBarsPerYear(settings: DDAProSettings, timeframeSeconds = 86_400) {
  if (settings.annualizationMode === "custom") return settings.customPeriodsPerYear;
  const days = settings.annualizationMode === "traditional-252" ? 252 : 365.25;
  return Math.max(1, days * 86_400 / Math.max(1, timeframeSeconds));
}

export function ddaProCalculationSettingsHash(settings: DDAProSettings) {
  const value = { ...migrateDDAProSettings(settings) } as Record<string, unknown>;
  for (const key of ["preset", "theme", "scaleMode", "customScaleDepthPercent", "dashboardPosition", "rawColor", "smoothedColor", "meanColor", "moderateColor", "highColor", "extremeColor", "lineIntensity", "fillIntensity", "lineWidth", "showFlowPressure", "flowBullishColor", "flowBearishColor", "flowNeutralColor", "flowLineIntensity", "flowLineWidth", "showRawDrawdown", "showSmoothedDrawdown", "showMean", "showSigmaBands", "showQuantiles", "showZScore", "showDuration", "showVelocity", "showRiskScore", "showDashboard", "showExpandedDashboard", "showEpisodeMarkers", "showRawSignals", "showConfirmedSignals", "showProvisionalSignals", "confirmedAlertsOnly", "showSignalConfidence", "showRegimeDiagnostics"]) delete value[key];
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
