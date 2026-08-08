import type { LiquidationFieldHorizon, LiquidationFieldSettings } from "./types.ts";

export const LIQUIDATION_FIELD_SETTINGS_VERSION = 1 as const;
export const BCLIF_MAX_REQUEST_HOURS = 90 * 24;

export const DEFAULT_LIQUIDATION_FIELD_SETTINGS: LiquidationFieldSettings = {
  schemaVersion: LIQUIDATION_FIELD_SETTINGS_VERSION,
  preset: "EVENT_HORIZON_3W",
  viewMode: "COMBINED_THERMAL",
  horizon: "3W",
  customHours: 72,
  venue: "BYBIT",
  modelPreset: "REGIME_ADAPTIVE",
  scale: "CONFIDENCE_WEIGHTED_LOG",
  palette: "REFERENCE_THERMAL",
  opacity: 82,
  gamma: 0.8,
  lowQuantile: 0.05,
  highQuantile: 0.995,
  smoothing: "BALANCED",
  priceSigmaRows: 1.15,
  timeSigmaColumns: 0.55,
  sharpness: 58,
  candlePalette: "BLACK_TERMINAL_HIGH_CONTRAST",
  legendVisible: true,
  diagnosticsVisible: true,
  confirmedMarkersVisible: false,
  cascadePathsVisible: false,
  minimumConfidence: 40,
  minimumNotionalUsd: 0,
  sideFilter: "BOTH",
  leverageMinimum: 2,
  leverageMaximum: 125,
  priceRows: 384,
  timeColumns: 512,
  liveUpdateCadenceMs: 2_000,
  visualFixture: false
};

const horizons = new Set<LiquidationFieldHorizon>(["6H", "12H", "1D", "3D", "1W", "3W", "1M", "CUSTOM"]);

function clamp(value: unknown, fallback: number, minimum: number, maximum: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(minimum, Math.min(maximum, numeric)) : fallback;
}

export function migrateLiquidationFieldSettings(value?: Partial<LiquidationFieldSettings> | null): LiquidationFieldSettings {
  const merged = { ...DEFAULT_LIQUIDATION_FIELD_SETTINGS, ...(value ?? {}) } as LiquidationFieldSettings;
  return {
    ...merged,
    schemaVersion: LIQUIDATION_FIELD_SETTINGS_VERSION,
    horizon: horizons.has(merged.horizon) ? merged.horizon : DEFAULT_LIQUIDATION_FIELD_SETTINGS.horizon,
    // The protected manifest API accepts one bounded window of at most 90 days.
    // Keep persisted settings inside that contract instead of allowing a value
    // that can only produce a permanent HTTP 400 response.
    customHours: clamp(merged.customHours, 72, 1, BCLIF_MAX_REQUEST_HOURS),
    opacity: clamp(merged.opacity, 82, 0, 100),
    gamma: clamp(merged.gamma, 0.8, 0.35, 2.5),
    lowQuantile: clamp(merged.lowQuantile, 0.05, 0, 0.5),
    highQuantile: Math.max(
      clamp(merged.lowQuantile, 0.05, 0, 0.5) + 0.05,
      clamp(merged.highQuantile, 0.995, 0.5, 1)
    ),
    priceSigmaRows: clamp(merged.priceSigmaRows, 1.15, 0, 4),
    timeSigmaColumns: clamp(merged.timeSigmaColumns, 0.55, 0, 3),
    sharpness: clamp(merged.sharpness, 58, 0, 100),
    minimumConfidence: clamp(merged.minimumConfidence, 40, 0, 100),
    minimumNotionalUsd: clamp(merged.minimumNotionalUsd, 0, 0, 100_000_000_000),
    leverageMinimum: clamp(merged.leverageMinimum, 2, 1, 125),
    leverageMaximum: Math.max(
      clamp(merged.leverageMinimum, 2, 1, 125),
      clamp(merged.leverageMaximum, 125, 1, 125)
    ),
    priceRows: Math.round(clamp(merged.priceRows, 384, 128, 1024)),
    timeColumns: Math.round(clamp(merged.timeColumns, 512, 128, 1024)),
    liveUpdateCadenceMs: Math.round(clamp(merged.liveUpdateCadenceMs, 2_000, 500, 15_000))
  };
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

export function bybitOiIntervalForHorizon(horizon: LiquidationFieldHorizon) {
  if (horizon === "6H" || horizon === "12H" || horizon === "1D") return "5min";
  if (horizon === "3D") return "30min";
  if (horizon === "1W") return "1h";
  if (horizon === "3W" || horizon === "1M") return "4h";
  return "1h";
}
