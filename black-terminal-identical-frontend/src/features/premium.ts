import type { VisibleIndicators } from "../chart-engine/types";

export type PremiumFeatureKey = "volatilityHeatmap";

export type IndicatorAccessSubject = {
  role?: "admin" | "user";
  allowedIndicators?: readonly string[];
} | null | undefined;

export const MARKET_MAKER_HEATMAP_KEY: PremiumFeatureKey = "volatilityHeatmap";

export const DEFAULT_ALLOWED_INDICATORS = [
  "liquidationHeatmap",
  "adaptiveSwingStrategy",
  "vwap",
  "ema20",
  "ema50",
  "ema200",
  "sma20",
  "sma50",
  "bollinger",
  "openInterestOscillator",
  "zScoreOscillator",
  "waveTrendOscillator",
  "volume"
] as const;

export const ADMIN_ALLOWED_INDICATORS = [
  ...DEFAULT_ALLOWED_INDICATORS,
  MARKET_MAKER_HEATMAP_KEY,
  "volumeProfile",
  "aif"
] as const;

const premiumFeatureLabels: Record<PremiumFeatureKey, string> = {
  volatilityHeatmap: "Market Maker Heatmap"
};

export function isPremiumIndicator(key: keyof VisibleIndicators): key is PremiumFeatureKey {
  return key === MARKET_MAKER_HEATMAP_KEY;
}

export function canUseIndicator(key: keyof VisibleIndicators, subject: IndicatorAccessSubject) {
  return subject?.role === "admin" || Boolean(subject?.allowedIndicators?.includes(key));
}

export function restrictVisibleIndicators(
  indicators: VisibleIndicators,
  subject: IndicatorAccessSubject
): VisibleIndicators {
  const restricted = { ...indicators };
  for (const key of Object.keys(restricted) as Array<keyof VisibleIndicators>) {
    if (!canUseIndicator(key, subject)) restricted[key] = false;
  }
  return restricted;
}

export function premiumLabel(key: PremiumFeatureKey) {
  return premiumFeatureLabels[key];
}
