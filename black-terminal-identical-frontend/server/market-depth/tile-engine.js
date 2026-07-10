import { horizonToMs, normalizeMarketKind, normalizeSymbol, normalizeVenue, selectResolutionForReplay } from "./types.js";

export async function getMarketDepthTiles(supabase, query = {}) {
  const venues = resolveVenues(query);
  const marketKind = normalizeMarketKind(query.marketKind);
  const symbol = normalizeSymbol(query.symbol);
  if (!venues.length || !symbol) {
    const error = new Error("Tiles require venue/venues and symbol.");
    error.statusCode = 400;
    throw error;
  }

  const now = Date.now();
  const horizon = String(query.horizon || "24h").toLowerCase();
  const fromMs = query.from ? Number(query.from) : now - horizonToMs(horizon);
  const toMs = query.to ? Number(query.to) : now;
  const minPrice = optionalNumber(query.minPrice);
  const maxPrice = optionalNumber(query.maxPrice);
  const rangePct = rangePercent(minPrice, maxPrice);
  const resolution = query.resolution && query.resolution !== "auto"
    ? String(query.resolution)
    : selectResolutionForReplay({ horizon, rangePct });
  const maxCells = Math.min(5000, Math.max(300, Number(query.maxCells) || 1800));

  const rows = await readTileRollups(supabase, {
    venues,
    marketKind,
    symbol,
    fromMs,
    toMs,
    minPrice,
    maxPrice,
    resolution,
    maxRows: maxCells * Math.max(1, venues.length)
  });

  const cells = buildCells(rows, maxCells);
  return {
    status: "ok",
    source: "black-core-market-depth-memory",
    mode: venues.length > 1 ? "combined-with-venue-breakdown" : "single-venue",
    venues,
    marketKind,
    symbol,
    horizon,
    resolution,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    cells,
    stats: {
      rawRows: rows.length,
      cells: cells.length,
      maxCells,
      venueCount: venues.length,
      minPrice,
      maxPrice
    }
  };
}

async function readTileRollups(supabase, query) {
  let builder = supabase
    .from("market_depth_rollups")
    .select("venue,market_kind,symbol,bucket_start,bucket_end,resolution,price_bucket,bucket_size,bid_size,ask_size,bid_peak_size,ask_peak_size,observations,liquidity_score,gravity_score")
    .in("venue", query.venues)
    .eq("market_kind", query.marketKind)
    .eq("symbol", query.symbol)
    .eq("resolution", query.resolution)
    .gte("bucket_start", new Date(query.fromMs).toISOString())
    .lte("bucket_start", new Date(query.toMs).toISOString())
    .order("bucket_start", { ascending: false })
    .limit(query.maxRows);
  if (Number.isFinite(query.minPrice)) builder = builder.gte("price_bucket", query.minPrice);
  if (Number.isFinite(query.maxPrice)) builder = builder.lte("price_bucket", query.maxPrice);
  const { data, error } = await builder;
  if (error) throw error;
  return data || [];
}

function buildCells(rows, maxCells) {
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.bucket_start}:${Number(row.price_bucket).toFixed(8)}`;
    const cell = grouped.get(key) ?? {
      time: row.bucket_start,
      bucketEnd: row.bucket_end,
      price: Number(row.price_bucket),
      bucketSize: Number(row.bucket_size),
      bidSize: 0,
      askSize: 0,
      bidPeakSize: 0,
      askPeakSize: 0,
      observations: 0,
      liquidityScore: 0,
      gravityScore: 0,
      venues: {}
    };
    const venueContribution = {
      bidSize: Number(row.bid_size) || 0,
      askSize: Number(row.ask_size) || 0,
      bidPeakSize: Number(row.bid_peak_size) || 0,
      askPeakSize: Number(row.ask_peak_size) || 0,
      liquidityScore: Number(row.liquidity_score) || 0,
      gravityScore: Number(row.gravity_score) || 0
    };
    cell.bidSize += venueContribution.bidSize;
    cell.askSize += venueContribution.askSize;
    cell.bidPeakSize = Math.max(cell.bidPeakSize, venueContribution.bidPeakSize);
    cell.askPeakSize = Math.max(cell.askPeakSize, venueContribution.askPeakSize);
    cell.observations += Number(row.observations) || 0;
    cell.liquidityScore = Math.max(cell.liquidityScore, venueContribution.liquidityScore);
    cell.gravityScore = Math.max(cell.gravityScore, venueContribution.gravityScore);
    cell.venues[row.venue] = venueContribution;
    grouped.set(key, cell);
  }

  return Array.from(grouped.values())
    .sort((a, b) => Math.max(b.liquidityScore, b.gravityScore) - Math.max(a.liquidityScore, a.gravityScore))
    .slice(0, maxCells)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || b.price - a.price);
}

function resolveVenues(query) {
  const raw = query.venues || query.venue || query.exchange || "";
  const values = String(raw)
    .split(",")
    .map((item) => normalizeVenue(item))
    .filter(Boolean)
    .filter((item) => item !== "combined" && item !== "all");
  if (values.length) return Array.from(new Set(values));
  return ["hyperliquid", "binance", "bybit", "okx"];
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function rangePercent(minPrice, maxPrice) {
  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || minPrice <= 0 || maxPrice <= minPrice) return null;
  const mid = (minPrice + maxPrice) / 2;
  return ((maxPrice - minPrice) / mid) * 50;
}
