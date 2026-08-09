import type { BclifPresentationPreset, LiquidationFieldHorizon, LiquidationFieldSettings } from "./types.ts";

export const LIQUIDATION_FIELD_SETTINGS_VERSION = 9 as const;
export const BCLIF_MAX_REQUEST_HOURS = 90 * 24;
export const BCLIF_BROWSER_OI_INTERVAL = "5min" as const;

export const DEFAULT_LIQUIDATION_FIELD_SETTINGS: LiquidationFieldSettings = {
  schemaVersion: LIQUIDATION_FIELD_SETTINGS_VERSION,
  preset: "TRADE_FOCUS",
  viewMode: "COMBINED_THERMAL",
  horizon: "3W",
  customHours: 72,
  venue: "BYBIT",
  modelPreset: "REGIME_ADAPTIVE",
  scale: "CONFIDENCE_WEIGHTED_LOG",
  palette: "REFERENCE_THERMAL",
  opacity: 100,
  gamma: 0.9,
  lowQuantile: 0.55,
  highQuantile: 0.997,
  smoothing: "BALANCED",
  priceSigmaRows: 1.15,
  timeSigmaColumns: 0.55,
  sharpness: 74,
  candlePalette: "BLACK_TERMINAL_HIGH_CONTRAST",
  legendVisible: false,
  diagnosticsVisible: false,
  confirmedMarkersVisible: false,
  cascadePathsVisible: false,
  contextVisibilityFloor: 25,
  clusterLabelFloor: 60,
  highAuthorityColorFloor: 75,
  strictHideBelowEnabled: false,
  strictHideBelowConfidence: 60,
  historicalContextEnabled: true,
  liveCalibratedEnabled: true,
  minimumNotionalUsd: 0,
  sideFilter: "BOTH",
  leverageMinimum: 2,
  leverageMaximum: 125,
  priceRows: 384,
  timeColumns: 512,
  liveUpdateCadenceMs: 2_000,
  visualFixture: false,
  priceDisplay: "CHART_SCALE",
  customPriceMinimum: 50_000,
  customPriceMaximum: 80_000,
  autoFocusMarginPercent: 3,
  visualChannel: "COMBINED",
  thermalNormalization: "HYBRID",
  confidenceWeightEnabled: false,
  backgroundFloor: 18,
  plasmaBackgroundOpacity: 94,
  shelfContrast: 88,
  residualShelfVisibility: 32,
  yellowTailPercent: 0.3,
  historicalContextOpacity: 100,
  liveCalibratedOpacity: 100,
  requireMultipleEvidenceChannels: false,
  uncertaintyEnvelopesVisible: false,
  adaptiveResolution: "AUTO",
  focusBand: "PERCENT_5",
  customFocusBandPercent: 5,
  candleContrast: "HIGH",
  maximumClusterLabels: 4,
  operationalSummaryVisible: false,
  collectionStartMarkerVisible: true,
  cohortProvenanceVisible: false,
  cohortBirthMarkersVisible: false,
  oiNoiseMethod: "HYBRID_ROBUST",
  oiNoiseAbsoluteNotionalUsd: 100_000,
  oiNoisePercent: 0.000075,
  oiNoiseMadMultiplier: 3.5,
  isolatedContributionCap: 0.82,
  crossContributionCap: 0.12,
  unknownContributionCap: 0.06,
  oiEventWindowMs: 15 * 60 * 1_000,
  oiEventContinuationRatio: 0.35,
  oiEventTerminationRatio: 0.25,
  oiEventHysteresisIntervals: 2,
  rawCohortShelvesVisible: false
};

const horizons = new Set<LiquidationFieldHorizon>(["6H", "12H", "1D", "3D", "1W", "3W", "1M", "CUSTOM"]);

function clamp(value: unknown, fallback: number, minimum: number, maximum: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(minimum, Math.min(maximum, numeric)) : fallback;
}

export function migrateLiquidationFieldSettings(value?: Partial<LiquidationFieldSettings> | null): LiquidationFieldSettings {
  const legacy = value as (Partial<LiquidationFieldSettings> & {
    preset?: string;
    schemaVersion?: number;
    minimumConfidence?: number;
  }) | null | undefined;
  const merged = { ...DEFAULT_LIQUIDATION_FIELD_SETTINGS, ...(legacy ?? {}) } as LiquidationFieldSettings;
  const legacySchemaVersion = Number(legacy?.schemaVersion ?? 0);
  // Before renderer V8 the diagnostic shelf switch was an exclusive mode: it
  // hid the thermal texture entirely. Some restored workspaces therefore open
  // as a couple of red/white shelf strokes with no heatmap. Recover only that
  // incompatible presentation state to the production thermal defaults. Model
  // parameters and unrelated workspace settings remain untouched.
  const recoverLegacyShelfOnlyPresentation = legacySchemaVersion < 8
    && Boolean(legacy?.rawCohortShelvesVisible);
  const upgradeReferenceThermalPresentation = legacySchemaVersion < 9
    && (recoverLegacyShelfOnlyPresentation || merged.palette === "REFERENCE_THERMAL");
  const vivid = <T>(current: T, upgraded: T) => upgradeReferenceThermalPresentation ? upgraded : current;

  if ((value as { preset?: string } | null | undefined)?.preset === "EVENT_HORIZON_3W") merged.preset = "TRADE_FOCUS";
  const customMinimum = clamp(merged.customPriceMinimum, 50_000, 1e-8, 10_000_000);
  const customMaximum = Math.max(customMinimum + 1e-8, clamp(merged.customPriceMaximum, 80_000, 1e-8, 10_000_000));
  return {
    ...merged,
    schemaVersion: LIQUIDATION_FIELD_SETTINGS_VERSION,
    horizon: recoverLegacyShelfOnlyPresentation
      ? DEFAULT_LIQUIDATION_FIELD_SETTINGS.horizon
      : horizons.has(merged.horizon) ? merged.horizon : DEFAULT_LIQUIDATION_FIELD_SETTINGS.horizon,
    preset: recoverLegacyShelfOnlyPresentation ? "TRADE_FOCUS" : merged.preset,
    viewMode: recoverLegacyShelfOnlyPresentation ? "COMBINED_THERMAL" : merged.viewMode,
    // The protected manifest API accepts one bounded window of at most 90 days.
    // Keep persisted settings inside that contract instead of allowing a value
    // that can only produce a permanent HTTP 400 response.
    customHours: clamp(merged.customHours, 72, 1, BCLIF_MAX_REQUEST_HOURS),
    opacity: clamp(vivid(merged.opacity, 100), 100, 10, 100),
    gamma: clamp(vivid(merged.gamma, 0.9), 0.9, 0.35, 2.5),
    lowQuantile: clamp(vivid(merged.lowQuantile, 0.55), 0.55, 0, 0.95),
    highQuantile: Math.max(
      clamp(vivid(merged.lowQuantile, 0.55), 0.55, 0, 0.95) + 0.001,
      clamp(vivid(merged.highQuantile, 0.997), 0.997, 0.5, 1)
    ),
    priceSigmaRows: clamp(merged.priceSigmaRows, 1.15, 0, 4),
    timeSigmaColumns: clamp(merged.timeSigmaColumns, 0.55, 0, 3),
    sharpness: clamp(vivid(merged.sharpness, 74), 74, 0, 100),
    // V3 and older used one threshold for visibility, labels, and authority.
    // Preserve it as the label floor only; the V9 context floor stays safe.
    contextVisibilityFloor: clamp(merged.contextVisibilityFloor, 25, 0, 100),
    clusterLabelFloor: clamp(
      legacy && Number(legacy.schemaVersion ?? 0) < 7 && legacy.minimumConfidence !== undefined
        ? legacy.minimumConfidence
        : merged.clusterLabelFloor,
      60,
      0,
      100
    ),
    highAuthorityColorFloor: clamp(merged.highAuthorityColorFloor, 75, 60, 100),
    strictHideBelowEnabled: Boolean(merged.strictHideBelowEnabled),
    strictHideBelowConfidence: clamp(merged.strictHideBelowConfidence, 60, 0, 100),
    historicalContextEnabled: merged.historicalContextEnabled !== false,
    liveCalibratedEnabled: merged.liveCalibratedEnabled !== false,
    minimumNotionalUsd: clamp(merged.minimumNotionalUsd, 0, 0, 100_000_000_000),
    legendVisible: legacySchemaVersion < 7 || recoverLegacyShelfOnlyPresentation
      ? false : Boolean(merged.legendVisible),
    diagnosticsVisible: legacySchemaVersion < 7 || recoverLegacyShelfOnlyPresentation
      ? false : Boolean(merged.diagnosticsVisible),
    operationalSummaryVisible: legacySchemaVersion < 7 || recoverLegacyShelfOnlyPresentation
      ? false : Boolean(merged.operationalSummaryVisible),
    leverageMinimum: clamp(merged.leverageMinimum, 2, 1, 125),
    leverageMaximum: Math.max(
      clamp(merged.leverageMinimum, 2, 1, 125),
      clamp(merged.leverageMaximum, 125, 1, 125)
    ),
    priceRows: Math.round(clamp(merged.priceRows, 384, 128, 1024)),
    timeColumns: Math.round(clamp(merged.timeColumns, 512, 128, 1024)),
    liveUpdateCadenceMs: Math.round(clamp(merged.liveUpdateCadenceMs, 2_000, 500, 15_000)),
    customPriceMinimum: customMinimum,
    customPriceMaximum: customMaximum,
    autoFocusMarginPercent: clamp(merged.autoFocusMarginPercent, 3, 0, 25),
    backgroundFloor: Math.round(clamp(vivid(merged.backgroundFloor, 18), 18, 0, 64)),
    plasmaBackgroundOpacity: clamp(merged.plasmaBackgroundOpacity, 94, 0, 100),
    shelfContrast: clamp(merged.shelfContrast, 88, 0, 100),
    residualShelfVisibility: clamp(merged.residualShelfVisibility, 32, 0, 100),
    yellowTailPercent: clamp(merged.yellowTailPercent, 0.3, 0.1, 0.5),
    historicalContextOpacity: clamp(vivid(merged.historicalContextOpacity, 100), 100, 0, 100),
    liveCalibratedOpacity: clamp(vivid(merged.liveCalibratedOpacity, 100), 100, 0, 100),
    confidenceWeightEnabled: upgradeReferenceThermalPresentation ? false : Boolean(merged.confidenceWeightEnabled),
    requireMultipleEvidenceChannels: upgradeReferenceThermalPresentation
      ? false : Boolean(merged.requireMultipleEvidenceChannels),
    adaptiveResolution: upgradeReferenceThermalPresentation ? "AUTO" : merged.adaptiveResolution,
    customFocusBandPercent: clamp(merged.customFocusBandPercent, 5, 0.25, 50),
    maximumClusterLabels: Math.round(clamp(merged.maximumClusterLabels, 4, 0, 6)),
    oiNoiseAbsoluteNotionalUsd: clamp(merged.oiNoiseAbsoluteNotionalUsd, 100_000, 0, 100_000_000),
    oiNoisePercent: clamp(merged.oiNoisePercent, 0.000075, 0, 0.1),
    oiNoiseMadMultiplier: clamp(merged.oiNoiseMadMultiplier, 3.5, 0, 20),
    isolatedContributionCap: clamp(merged.isolatedContributionCap, 0.82, 0, 1),
    crossContributionCap: clamp(merged.crossContributionCap, 0.12, 0, 1),
    unknownContributionCap: clamp(merged.unknownContributionCap, 0.06, 0, 1),
    oiEventWindowMs: Math.round(clamp(merged.oiEventWindowMs, 15 * 60 * 1_000, 5 * 60 * 1_000, 60 * 60 * 1_000)),
    oiEventContinuationRatio: clamp(merged.oiEventContinuationRatio, 0.35, 0.05, 1),
    oiEventTerminationRatio: clamp(merged.oiEventTerminationRatio, 0.25, 0, 1),
    oiEventHysteresisIntervals: Math.round(clamp(merged.oiEventHysteresisIntervals, 2, 1, 12)),
    rawCohortShelvesVisible: recoverLegacyShelfOnlyPresentation
      ? false : Boolean(merged.rawCohortShelvesVisible),
    priceDisplay: recoverLegacyShelfOnlyPresentation ? "CHART_SCALE" : merged.priceDisplay,
    palette: recoverLegacyShelfOnlyPresentation ? "REFERENCE_THERMAL" : merged.palette
  };
}

export function applyBclifPresentationPreset(
  source: LiquidationFieldSettings,
  preset: Exclude<BclifPresentationPreset, "CUSTOM">
): LiquidationFieldSettings {
  const common = {
    ...source,
    preset,
    rawCohortShelvesVisible: preset === "RAW_MODEL" ? source.rawCohortShelvesVisible : false
  };
  if (preset === "TRADE_FOCUS") return migrateLiquidationFieldSettings({
    ...common, priceDisplay: "CHART_SCALE", contextVisibilityFloor: 25, clusterLabelFloor: 60,
    highAuthorityColorFloor: 75, strictHideBelowEnabled: false, palette: "REFERENCE_THERMAL",
    thermalNormalization: "HYBRID", opacity: 100, gamma: 0.9, lowQuantile: 0.55, highQuantile: 0.997,
    sharpness: 74, backgroundFloor: 18, plasmaBackgroundOpacity: 94, shelfContrast: 88,
    residualShelfVisibility: 32, visualChannel: "COMBINED", historicalContextOpacity: 100,
    liveCalibratedOpacity: 100, confidenceWeightEnabled: false, requireMultipleEvidenceChannels: false,
    diagnosticsVisible: false, maximumClusterLabels: 4,
    operationalSummaryVisible: false, candleContrast: "HIGH"
  });
  if (preset === "HIGH_CONFIDENCE") return migrateLiquidationFieldSettings({
    ...common, priceDisplay: "CHART_SCALE", contextVisibilityFloor: 25, clusterLabelFloor: 75,
    highAuthorityColorFloor: 85, strictHideBelowEnabled: false, opacity: 52, gamma: 1.65,
    visualChannel: "COMBINED", historicalContextOpacity: 8, liveCalibratedOpacity: 95,
    requireMultipleEvidenceChannels: true, maximumClusterLabels: 6, operationalSummaryVisible: false,
    diagnosticsVisible: false, candleContrast: "MAXIMUM"
  });
  if (preset === "LIVE_CALIBRATED") return migrateLiquidationFieldSettings({
    ...common, priceDisplay: "CHART_SCALE", contextVisibilityFloor: 25, clusterLabelFloor: 60,
    highAuthorityColorFloor: 75, strictHideBelowEnabled: false, opacity: 58,
    visualChannel: "LIVE_CALIBRATED", historicalContextOpacity: 14, liveCalibratedOpacity: 100,
    requireMultipleEvidenceChannels: true, collectionStartMarkerVisible: true, maximumClusterLabels: 4
  });
  if (preset === "FULL_SPECTRUM_RESEARCH") return migrateLiquidationFieldSettings({
    ...common, priceDisplay: "FULL_MODEL_RANGE", contextVisibilityFloor: 0, clusterLabelFloor: 0,
    highAuthorityColorFloor: 75, strictHideBelowEnabled: false, opacity: 75,
    thermalNormalization: "VISIBLE_FOCUS", gamma: 1.25, backgroundFloor: 3,
    visualChannel: "COMBINED", historicalContextOpacity: 58, liveCalibratedOpacity: 92,
    requireMultipleEvidenceChannels: false, diagnosticsVisible: true, maximumClusterLabels: 4,
    candleContrast: "HIGH"
  });
  return migrateLiquidationFieldSettings({
    ...common, priceDisplay: "FULL_MODEL_RANGE", contextVisibilityFloor: 0, clusterLabelFloor: 0,
    highAuthorityColorFloor: 75, strictHideBelowEnabled: false, opacity: 72,
    thermalNormalization: "GLOBAL_MODEL", visualChannel: "COMBINED", historicalContextOpacity: 100,
    liveCalibratedOpacity: 100, confidenceWeightEnabled: false, requireMultipleEvidenceChannels: false,
    maximumClusterLabels: 0, operationalSummaryVisible: false, diagnosticsVisible: true,
    rawCohortShelvesVisible: true, smoothing: "SHARP"
  });
}

export function liquidationFieldModelSettingsKey(settings: LiquidationFieldSettings) {
  return [
    settings.horizon, settings.customHours, settings.venue, settings.modelPreset, settings.scale,
    settings.smoothing, settings.priceSigmaRows, settings.timeSigmaColumns, settings.sideFilter,
    settings.minimumNotionalUsd, settings.leverageMinimum, settings.leverageMaximum,
    settings.priceRows, settings.timeColumns,
    settings.oiNoiseMethod, settings.oiNoiseAbsoluteNotionalUsd, settings.oiNoisePercent,
    settings.oiNoiseMadMultiplier, settings.isolatedContributionCap, settings.crossContributionCap,
    settings.unknownContributionCap, settings.oiEventWindowMs, settings.oiEventContinuationRatio,
    settings.oiEventTerminationRatio, settings.oiEventHysteresisIntervals
  ].join(":");
}

export function liquidationHorizonMs(settings: Pick<LiquidationFieldSettings, "horizon" | "customHours">) {
  const fixed: Record<Exclude<LiquidationFieldHorizon, "CUSTOM">, number> = {
    "6H": 6 * 60 * 60 * 1_000,
    "12H": 12 * 60 * 60 * 1_000,
    "1D": 24 * 60 * 60 * 1_000,
    "3D": 3 * 24 * 60 * 60 * 1_000,
    "1W": 7 * 24 * 60 * 60 * 1_000,
    "3W": 21 * 24 * 60 * 60 * 1_000,
    "1M": 30 * 24 * 60 * 60 * 1_000
  };
  return settings.horizon === "CUSTOM"
    ? settings.customHours * 60 * 60 * 1_000
    : fixed[settings.horizon];
}

export function bybitOiIntervalForHorizon(_horizon: LiquidationFieldHorizon) {
  // Cohort birth is owned by one canonical five-minute OI clock. The selected
  // chart/model horizon changes only the requested history span; it must never
  // change OI interval boundaries or cohort identity.
  return BCLIF_BROWSER_OI_INTERVAL;
}
