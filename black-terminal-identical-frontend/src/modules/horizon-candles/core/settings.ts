import type { HorizonCandleMode, HorizonDataQuality } from "./types";

export const BLACK_HORIZON_SETTINGS_KEY = "bt_black_horizon_candles_v1";

export const BLACK_HORIZON_DEFAULTS: HorizonCandleMode = {
  enabled: false,
  sourceResolution: "1s",
  displayHorizonMs: 4 * 60 * 60 * 1000,
  horizonScale: 1,
  lodMode: "auto",
  showMicroCandles: true,
  showWaveEnvelope: true,
  showDirectionalPressure: true,
  showRejectionHeat: true,
  showDataQualityBadge: true,
  dataQuality: "degraded"
};

const supportedHorizons = new Set([15 * 60_000, 60 * 60_000, 4 * 60 * 60_000, 24 * 60 * 60_000]);
const supportedQuality = new Set<HorizonDataQuality>(["native-trades", "native-1s", "synthetic-1s", "degraded"]);

export function migrateHorizonCandleMode(value?: Partial<HorizonCandleMode> | null): HorizonCandleMode {
  const source = value ?? {};
  return {
    ...BLACK_HORIZON_DEFAULTS,
    ...source,
    enabled: Boolean(source.enabled ?? BLACK_HORIZON_DEFAULTS.enabled),
    sourceResolution: "1s",
    displayHorizonMs: supportedHorizons.has(Number(source.displayHorizonMs))
      ? Number(source.displayHorizonMs)
      : BLACK_HORIZON_DEFAULTS.displayHorizonMs,
    horizonScale: Math.max(0.5, Math.min(2, Number(source.horizonScale) || 1)),
    lodMode: ["auto", "candles", "clusters", "wave"].includes(String(source.lodMode))
      ? source.lodMode!
      : "auto",
    showMicroCandles: source.showMicroCandles !== false,
    showWaveEnvelope: source.showWaveEnvelope !== false,
    showDirectionalPressure: source.showDirectionalPressure !== false,
    showRejectionHeat: source.showRejectionHeat !== false,
    showDataQualityBadge: source.showDataQualityBadge !== false,
    dataQuality: supportedQuality.has(source.dataQuality as HorizonDataQuality)
      ? source.dataQuality as HorizonDataQuality
      : "degraded"
  };
}

export function loadHorizonCandleMode(): HorizonCandleMode {
  if (typeof window === "undefined") return migrateHorizonCandleMode();
  try {
    const stored = window.localStorage.getItem(BLACK_HORIZON_SETTINGS_KEY);
    return migrateHorizonCandleMode(stored ? JSON.parse(stored) : undefined);
  } catch {
    return migrateHorizonCandleMode();
  }
}

export function persistHorizonCandleMode(settings: HorizonCandleMode) {
  if (typeof window === "undefined") return;
  const persistent = { ...settings, enabled: false, dataQuality: "degraded" as const };
  window.localStorage.setItem(BLACK_HORIZON_SETTINGS_KEY, JSON.stringify(persistent));
}

export function horizonLabel(milliseconds: number) {
  if (milliseconds === 15 * 60_000) return "15m";
  if (milliseconds === 60 * 60_000) return "1H";
  if (milliseconds === 24 * 60 * 60_000) return "1D";
  return "4H";
}

export function horizonQualityLabel(quality: HorizonDataQuality) {
  if (quality === "native-trades") return "NATIVE TRADES";
  if (quality === "native-1s") return "NATIVE 1S";
  if (quality === "synthetic-1s") return "SYNTHETIC 1S";
  return "DEGRADED";
}

export function blackHorizonCandlesEnabled() {
  return import.meta.env.VITE_BLACK_HORIZON_CANDLES_ENABLED !== "false";
}
