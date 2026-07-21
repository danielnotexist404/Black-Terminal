import type { VisibleIndicators } from "../chart-engine/types";

export type PremiumFeatureKey = "volatilityHeatmap";

const premiumFeatureLabels: Record<PremiumFeatureKey, string> = {
  volatilityHeatmap: "Volatility Heatmap"
};

export function hasPremiumAccess() {
  return import.meta.env.VITE_BLACK_TERMINAL_PREMIUM !== "false";
}

export function isPremiumIndicator(key: keyof VisibleIndicators): key is PremiumFeatureKey {
  return key === "volatilityHeatmap";
}

export function canUseIndicator(key: keyof VisibleIndicators) {
  return !isPremiumIndicator(key) || hasPremiumAccess();
}

export function premiumLabel(key: PremiumFeatureKey) {
  return premiumFeatureLabels[key];
}
