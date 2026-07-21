import type { MarketSymbol } from "../../market-data/types";
import { supabase } from "../../lib/supabase";
import type { DomHeatmapHorizon, MacroLiquidityRange } from "./types";

async function authenticatedHeaders() {
  const session = supabase ? await supabase.auth.getSession() : null;
  const token = session?.data.session?.access_token;
  if (!token) throw new Error("Sign in again to access Institutional Market Memory.");
  return { Accept: "application/json", Authorization: `Bearer ${token}` };
}

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

export type BlackCoreDepthTileCell = {
  time: string;
  bucketEnd?: string | null;
  price: number;
  bucketSize: number;
  bidSize: number;
  askSize: number;
  bidPeakSize: number;
  askPeakSize: number;
  observations: number;
  liquidityScore: number;
  gravityScore: number;
  venues?: Record<string, unknown>;
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

export type BlackCoreDepthTiles = {
  status: "ok" | "unavailable";
  source: string;
  mode: "single-venue" | "combined-with-venue-breakdown";
  venues: string[];
  marketKind: string;
  symbol: string;
  horizon: string;
  resolution: string;
  from: string;
  to: string;
  cells: BlackCoreDepthTileCell[];
  stats?: {
    rawRows: number;
    cells: number;
    maxCells: number;
    venueCount: number;
    minPrice: number | null;
    maxPrice: number | null;
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
    headers: await authenticatedHeaders()
  });
  if (!response.ok) return null;
  const data = await response.json() as BlackCoreDepthReplay;
  return Array.isArray(data.points) ? data : null;
}

export async function fetchBlackCoreDepthTiles(
  symbol: MarketSymbol,
  range: MacroLiquidityRange,
  horizon: DomHeatmapHorizon,
  maxCells = 1800
): Promise<BlackCoreDepthTiles | null> {
  const params = new URLSearchParams({
    venue: symbol.exchange,
    marketKind: symbol.marketKind,
    symbol: symbol.rawSymbol.toUpperCase(),
    horizon,
    resolution: "auto",
    maxCells: String(maxCells)
  });
  if (Number.isFinite(range.min) && range.min > 0) params.set("minPrice", String(range.min));
  if (Number.isFinite(range.max) && range.max > 0) params.set("maxPrice", String(range.max));

  const response = await fetch(`/api/market-depth/tiles?${params.toString()}`, {
    headers: await authenticatedHeaders()
  });
  if (!response.ok) return null;
  const data = await response.json() as BlackCoreDepthTiles;
  return Array.isArray(data.cells) ? data : null;
}
