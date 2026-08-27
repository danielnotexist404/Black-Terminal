import type { VisibleIndicators } from "../chart-engine/types";

export type PremiumFeatureKey = "volatilityHeatmap";

export type IndicatorAccessSubject = {
  role?: "admin" | "user";
  allowedIndicators?: readonly string[];
} | null | undefined;

export const MARKET_MAKER_HEATMAP_KEY: PremiumFeatureKey = "volatilityHeatmap";
export const BCLIF_INDICATOR_KEY = "liquidationHeatmap" as const;

export const DEFAULT_ALLOWED_INDICATORS = [
  "qalc",
  "liquidationHeatmap",
  "auctionProfile",
  "adaptiveSwingStrategy",
  "vwap",
  "ema20",
  "ema50",
  "ema200",
  "sma20",
  "sma50",
  "bollinger",
  "ddaProOscillator",
  "acvdOscillator",
  "cvdOscillator",
  "marketSentimentOscillator",
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
  if (subject?.role === "admin") return true;
  // BCLIF is revocable even though it remains in the default grant set for
  // existing accounts. Removing it in Admin Panel must take effect instantly.
  if (key === BCLIF_INDICATOR_KEY) return Boolean(subject?.allowedIndicators?.includes(BCLIF_INDICATOR_KEY));
  return DEFAULT_ALLOWED_INDICATORS.includes(key as (typeof DEFAULT_ALLOWED_INDICATORS)[number]) ||
    Boolean(subject?.allowedIndicators?.includes(key));
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
