import { supabase } from "../../lib/supabase";
import type { ExchangeId, MarketKind } from "../../market-data/types";
import type { HistoricalBookHeatmapCell } from "./OrderBookHeatmapModel";
import { normalizeBookHeatmapHistoryCells, type RawBookHeatmapHistoryCell } from "./bookHeatmapHistoryNormalization";

type TilePayload = {
  status: string;
  source: string;
  resolution: string;
  from: string;
  to: string;
  cells: RawBookHeatmapHistoryCell[];
};

const BASE_QUANTITY_VENUES = new Set<ExchangeId>(["binance", "binance-us", "bybit", "hyperliquid"]);

export type BookHeatmapHistoryResult = {
  cells: HistoricalBookHeatmapCell[];
  source: "black-core-market-depth-memory";
  resolution: string;
  from: number;
  to: number;
  venue: ExchangeId;
};

export async function loadBookHeatmapHistory(input: {
  venue: ExchangeId;
  marketKind: MarketKind;
  symbol: string;
  horizon: string;
  minPrice: number;
  maxPrice: number;
  signal?: AbortSignal;
}): Promise<BookHeatmapHistoryResult> {
  if (!BASE_QUANTITY_VENUES.has(input.venue)) {
    throw new Error(`${input.venue.toUpperCase()} historical depth is unavailable until contract-size normalization is certified.`);
  }
  if (!supabase) throw new Error("Historical depth requires the authenticated Black Core service.");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Historical depth requires an authenticated terminal session.");

  const params = new URLSearchParams({
    venue: input.venue,
    marketKind: input.marketKind,
    symbol: input.symbol.toUpperCase().replace(/[^A-Z0-9]/g, ""),
    horizon: input.horizon,
    minPrice: String(input.minPrice),
    maxPrice: String(input.maxPrice),
    maxCells: "5000"
  });
  const response = await fetch(`/api/market-depth/tiles?${params.toString()}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    signal: input.signal
  });
  if (!response.ok) throw new Error(`Historical depth request failed (${response.status}).`);
  const payload = await response.json() as TilePayload;
  if (payload.status !== "ok" || payload.source !== "black-core-market-depth-memory") {
    throw new Error("Historical depth returned an untrusted source classification.");
  }

  const cells = normalizeBookHeatmapHistoryCells(payload.cells ?? []);

  return {
    cells,
    source: "black-core-market-depth-memory",
    resolution: payload.resolution,
    from: Date.parse(payload.from),
    to: Date.parse(payload.to),
    venue: input.venue
  };
}
