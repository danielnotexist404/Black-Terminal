import { ACVD_SETTINGS_VERSION, type AcvdSettings } from "./types.ts";

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
const finite = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;

export const DEFAULT_ACVD_SETTINGS: AcvdSettings = Object.freeze({
  settingsVersion: ACVD_SETTINGS_VERSION,
  lookback: 1000,
  realtimeMode: "CONFIRMED_BARS",
  deltaBasis: "NOTIONAL",
  smoothingMode: "ADAPTIVE_KAMA",
  smoothingLength: 8,
  adaptiveFastLength: 3,
  adaptiveSlowLength: 34,
  normalizationLookback: 120,
  envelopeLookback: 180,
  envelopeDeviation: 1.65,
  minimumEnvelopeWidth: 14,
  minimumCoveragePercent: 92,
  structureLookback: 24,
  atrLength: 14,
  structureToleranceAtr: 0.42,
  minimumRejectionWickRatio: 0.18,
  confirmationBars: 3,
  trendLength: 55,
  trendEfficiencyThreshold: 0.34,
  trendProtection: true,
  divergenceLookback: 34,
  minimumDivergenceScore: 18,
  minimumExtremeScore: 64,
  minimumReversalImpulse: 8,
  minimumSignalConfidence: 78,
  maximumChopProbability: 72,
  cooldownBars: 24,
  resetThreshold: 22,
  showRawCvd: false,
  showAdaptivePressure: true,
  showDynamicEnvelope: true,
  showDeltaHistogram: true,
  showSignals: true,
  showDashboard: true,
  showRegimeDiagnostics: true,
  bullishColor: "#f2f2f4",
  bearishColor: "#d00024",
  neutralColor: "#777b83",
  envelopeColor: "#9b9da3",
  lineIntensity: 92,
  fillIntensity: 18,
  lineWidth: 1.45
});

export function migrateAcvdSettings(value?: Partial<AcvdSettings> | null): AcvdSettings {
  const merged = { ...DEFAULT_ACVD_SETTINGS, ...(value ?? {}) } as AcvdSettings;
  return {
    ...merged,
    settingsVersion: ACVD_SETTINGS_VERSION,
    lookback: Math.round(clamp(finite(merged.lookback, 1000), 100, 20_000)),
    smoothingLength: Math.round(clamp(finite(merged.smoothingLength, 8), 1, 200)),
    adaptiveFastLength: Math.round(clamp(finite(merged.adaptiveFastLength, 3), 1, 50)),
    normalizationLookback: Math.round(clamp(finite(merged.normalizationLookback, 120), 20, 2000)),
    envelopeLookback: Math.round(clamp(finite(merged.envelopeLookback, 180), 30, 3000)),
    envelopeDeviation: clamp(finite(merged.envelopeDeviation, 1.65), 0.5, 5),
    minimumEnvelopeWidth: clamp(finite(merged.minimumEnvelopeWidth, 14), 2, 80),
    minimumCoveragePercent: clamp(finite(merged.minimumCoveragePercent, 92), 50, 100),
    structureLookback: Math.round(clamp(finite(merged.structureLookback, 24), 5, 300)),
    atrLength: Math.round(clamp(finite(merged.atrLength, 14), 3, 200)),
    structureToleranceAtr: clamp(finite(merged.structureToleranceAtr, 0.42), 0.05, 3),
    minimumRejectionWickRatio: clamp(finite(merged.minimumRejectionWickRatio, 0.18), 0, 0.9),
    confirmationBars: Math.round(clamp(finite(merged.confirmationBars, 3), 1, 10)),
    trendLength: Math.round(clamp(finite(merged.trendLength, 55), 10, 500)),
    trendEfficiencyThreshold: clamp(finite(merged.trendEfficiencyThreshold, 0.34), 0.05, 0.95),
    divergenceLookback: Math.round(clamp(finite(merged.divergenceLookback, 34), 8, 500)),
    minimumDivergenceScore: clamp(finite(merged.minimumDivergenceScore, 18), 0, 100),
    minimumExtremeScore: clamp(finite(merged.minimumExtremeScore, 64), 20, 100),
    minimumReversalImpulse: clamp(finite(merged.minimumReversalImpulse, 8), 0, 80),
    minimumSignalConfidence: clamp(finite(merged.minimumSignalConfidence, 78), 40, 100),
    maximumChopProbability: clamp(finite(merged.maximumChopProbability, 72), 0, 100),
    cooldownBars: Math.round(clamp(finite(merged.cooldownBars, 24), 0, 500)),
    resetThreshold: clamp(finite(merged.resetThreshold, 22), 2, 80),
    lineIntensity: clamp(finite(merged.lineIntensity, 92), 0, 100),
    fillIntensity: clamp(finite(merged.fillIntensity, 18), 0, 100),
    lineWidth: clamp(finite(merged.lineWidth, 1.45), 0.5, 5),
    adaptiveSlowLength: Math.max(
      Math.round(clamp(finite(merged.adaptiveFastLength, 3), 1, 50)) + 1,
      Math.round(clamp(finite(merged.adaptiveSlowLength, 34), 2, 300))
    )
  };
}

export function acvdSettingsHash(settings: AcvdSettings) {
  const normalized = migrateAcvdSettings(settings);
  return stableHash(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)));
}

export function stableHash(value: unknown) {
  const source = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
