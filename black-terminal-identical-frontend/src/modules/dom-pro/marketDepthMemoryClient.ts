import type { MarketSymbol } from "../../market-data/types";
import type { DomHeatmapHorizon, MacroLiquidityRange } from "./types";

export type BlackCoreDepthReplayPoint = {
  id: string;
  side: "bid" | "ask";
  price: number;
  bucketSize: number;
  firstSeen: number;
  lastSeen: number;
  observations: number;
  peakSize: number;
  lastSize: number;
  strength: number;
  source?: string;
};

export type BlackCoreDepthReplay = {
  status: "ok" | "unavailable";
  source: string;
  venue: string;
  marketKind: string;
  symbol: string;
  horizon: string;
  resolution: string;
  from: string;
  to: string;
  points: BlackCoreDepthReplayPoint[];
  walls?: unknown[];
  events?: unknown[];
  statistics?: unknown[];
  stats?: {
    totalPoints: number;
    bidPoints: number;
    askPoints: number;
    firstSeen: number | null;
    lastSeen: number | null;
  };
};

export async function fetchBlackCoreDepthReplay(
  symbol: MarketSymbol,
  range: MacroLiquidityRange,
  horizon: DomHeatmapHorizon
): Promise<BlackCoreDepthReplay | null> {
  const params = new URLSearchParams({
    venue: symbol.exchange,
    marketKind: symbol.marketKind,
    symbol: symbol.rawSymbol.toUpperCase(),
    horizon,
    resolution: "auto"
  });
  if (Number.isFinite(range.min) && range.min > 0) params.set("minPrice", String(range.min));
  if (Number.isFinite(range.max) && range.max > 0) params.set("maxPrice", String(range.max));

  const response = await fetch(`/api/market-depth/replay?${params.toString()}`, {
    headers: { Accept: "application/json" }
  });
  if (!response.ok) return null;
  const data = await response.json() as BlackCoreDepthReplay;
  return Array.isArray(data.points) ? data : null;
}
