import type { AifImplementedProfileType, AifReadiness } from "../core/aifTypes";

export type AifProfileDefinition = {
  id: AifImplementedProfileType | "absorption";
  name: string;
  description: string;
  version: string;
  readiness: AifReadiness;
  qualityRule: string;
};

export const AIF_PROFILE_REGISTRY: readonly AifProfileDefinition[] = [
  { id: "volume", name: "Volume", description: "Accepted transaction volume by price", version: "1.0.0", readiness: "implemented", qualityRule: "Volume is conserved across touched price buckets." },
  { id: "delta", name: "Delta", description: "Aggressive buy/sell imbalance by price", version: "1.0.0", readiness: "implemented", qualityRule: "Candle fallback is estimated, never true tick delta." },
  { id: "tpo", name: "TPO", description: "Auction dwell and revisit structure", version: "1.0.0", readiness: "implemented", qualityRule: "Visits are derived from source-period candle ranges." },
  { id: "volatility", name: "Volatility", description: "Realized movement concentration by price", version: "1.0.0", readiness: "implemented", qualityRule: "Estimator and allocation method are disclosed." },
  { id: "pressure", name: "Pressure", description: "Proportional buying and selling pressure", version: "1.0.0", readiness: "implemented", qualityRule: "OHLCV pressure is an estimated composite." },
  { id: "absorption", name: "Absorption", description: "Aggressive flow with limited displacement", version: "0.1.0", readiness: "blocked-data", qualityRule: "Requires classified flow and persistent depth." }
] as const;

export function implementedAifProfiles() {
  return AIF_PROFILE_REGISTRY.filter((definition) => definition.readiness === "implemented");
}
