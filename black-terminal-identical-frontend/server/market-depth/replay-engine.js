import { horizonToMs, normalizeMarketKind, normalizeSymbol, normalizeVenue, selectResolutionForReplay } from "./types.js";

export async function getMarketDepthReplay(supabase, query) {
  const venue = normalizeVenue(query.venue || query.exchange);
  const marketKind = normalizeMarketKind(query.marketKind);
  const symbol = normalizeSymbol(query.symbol);
  if (!venue || !symbol) {
    const error = new Error("Replay requires venue and symbol.");
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
  const preferredResolution = query.resolution && query.resolution !== "auto"
    ? String(query.resolution)
    : selectResolutionForReplay({ horizon, rangePct });

  const rollups = await readRollups(supabase, {
    venue,
    marketKind,
    symbol,
    fromMs,
    toMs,
    minPrice,
    maxPrice,
    resolution: preferredResolution
  });
  const rows = rollups.length ? rollups : await readRollups(supabase, {
    venue,
    marketKind,
    symbol,
    fromMs,
    toMs,
    minPrice,
    maxPrice,
    resolution: null
  });
  const walls = await readWalls(supabase, { venue, marketKind, symbol, minPrice, maxPrice });
  const events = await readEvents(supabase, { venue, marketKind, symbol, fromMs, toMs, minPrice, maxPrice });
  const stats = await readStatistics(supabase, { venue, marketKind, symbol, fromMs, toMs, resolution: preferredResolution });

  return normalizeReplayPayload({
    venue,
    marketKind,
    symbol,
    horizon,
    resolution: rows[0]?.resolution || preferredResolution,
    fromMs,
    toMs,
    rollups: rows,
    walls,
    events,
    stats
  });
}

async function readRollups(supabase, query) {
  let builder = supabase
    .from("market_depth_rollups")
    .select("venue,market_kind,symbol,bucket_start,bucket_end,resolution,price_bucket,bucket_size,bid_size,ask_size,bid_peak_size,ask_peak_size,observations,liquidity_score,gravity_score,retention_tier,metadata")
    .eq("venue", query.venue)
    .eq("market_kind", query.marketKind)
    .eq("symbol", query.symbol)
    .gte("bucket_start", new Date(query.fromMs).toISOString())
    .lte("bucket_start", new Date(query.toMs).toISOString())
    .order("bucket_start", { ascending: false })
    .limit(2500);
  if (query.resolution) builder = builder.eq("resolution", query.resolution);
  if (Number.isFinite(query.minPrice)) builder = builder.gte("price_bucket", query.minPrice);
  if (Number.isFinite(query.maxPrice)) builder = builder.lte("price_bucket", query.maxPrice);
  const { data, error } = await builder;
  if (error) throw error;
  return data || [];
}

async function readWalls(supabase, query) {
  let builder = supabase
    .from("market_liquidity_walls")
    .select("wall_key,venue,market_kind,symbol,side,status,first_seen_at,last_seen_at,current_price,peak_size,current_size,touches,executed_volume,confidence,spoof_probability,reliability_score,gravity_score,metadata")
    .eq("venue", query.venue)
    .eq("market_kind", query.marketKind)
    .eq("symbol", query.symbol)
    .in("status", ["ACTIVE", "GROWING", "WEAKENING", "MIGRATING", "SPOOF_SUSPECTED"])
    .order("last_seen_at", { ascending: false })
    .limit(180);
  if (Number.isFinite(query.minPrice)) builder = builder.gte("current_price", query.minPrice);
  if (Number.isFinite(query.maxPrice)) builder = builder.lte("current_price", query.maxPrice);
  const { data, error } = await builder;
  if (error) throw error;
  return data || [];
}

async function readEvents(supabase, query) {
  let builder = supabase
    .from("market_liquidity_events")
    .select("id,event_type,side,price,price_bucket,size,confidence,wall_key,occurred_at,resolution,metadata")
    .eq("venue", query.venue)
    .eq("market_kind", query.marketKind)
    .eq("symbol", query.symbol)
    .gte("occurred_at", new Date(query.fromMs).toISOString())
    .lte("occurred_at", new Date(query.toMs).toISOString())
    .order("occurred_at", { ascending: false })
    .limit(300);
  if (Number.isFinite(query.minPrice)) builder = builder.gte("price_bucket", query.minPrice);
  if (Number.isFinite(query.maxPrice)) builder = builder.lte("price_bucket", query.maxPrice);
  const { data, error } = await builder;
  if (error) throw error;
  return data || [];
}

async function readStatistics(supabase, query) {
  let builder = supabase
    .from("market_depth_statistics")
    .select("resolution,bucket_start,bucket_end,best_bid,best_ask,mid_price,spread,total_bid_size,total_ask_size,imbalance,liquidity_score,update_count,packet_loss_count,reconnect_count,latency_ms,metadata")
    .eq("venue", query.venue)
    .eq("market_kind", query.marketKind)
    .eq("symbol", query.symbol)
    .gte("bucket_start", new Date(query.fromMs).toISOString())
    .lte("bucket_start", new Date(query.toMs).toISOString())
    .order("bucket_start", { ascending: false })
    .limit(180);
  if (query.resolution) builder = builder.eq("resolution", query.resolution);
  const { data, error } = await builder;
  if (error) throw error;
  return data || [];
}

function normalizeReplayPayload(payload) {
  const pointMap = new Map();
  for (const row of payload.rollups) {
    addPoint(pointMap, row, "bid");
    addPoint(pointMap, row, "ask");
  }
  for (const wall of payload.walls) {
    const side = wall.side === "sell" ? "ask" : "bid";
    const key = `${side}:${Number(wall.current_price).toFixed(8)}`;
    const current = pointMap.get(key);
    const point = {
      id: key,
      side,
      price: Number(wall.current_price),
      bucketSize: Number(wall.metadata?.bucketSize || current?.bucketSize || Math.max(Number(wall.current_price) * 0.0005, 0.01)),
      firstSeen: Date.parse(wall.first_seen_at),
      lastSeen: Date.parse(wall.last_seen_at),
      observations: Number(wall.metadata?.observationCount || current?.observations || wall.touches || 1),
      peakSize: Math.max(Number(wall.peak_size) || 0, current?.peakSize || 0),
      lastSize: Math.max(Number(wall.current_size) || 0, current?.lastSize || 0),
      strength: Math.max(Number(wall.reliability_score) || 0, current?.strength || 0),
      source: "black-core-wall"
    };
    pointMap.set(key, point);
  }
  const points = Array.from(pointMap.values())
    .filter((point) => Number.isFinite(point.price) && point.price > 0)
    .sort((a, b) => scorePoint(b) - scorePoint(a))
    .slice(0, 360)
    .sort((a, b) => b.price - a.price);

  return {
    status: "ok",
    source: "black-core-market-depth-memory",
    venue: payload.venue,
    marketKind: payload.marketKind,
    symbol: payload.symbol,
    horizon: payload.horizon,
    resolution: payload.resolution,
    from: new Date(payload.fromMs).toISOString(),
    to: new Date(payload.toMs).toISOString(),
    points,
    walls: payload.walls,
    events: payload.events,
    statistics: payload.stats,
    stats: {
      totalPoints: points.length,
      bidPoints: points.filter((point) => point.side === "bid").length,
      askPoints: points.filter((point) => point.side === "ask").length,
      firstSeen: points.length ? Math.min(...points.map((point) => point.firstSeen)) : null,
      lastSeen: points.length ? Math.max(...points.map((point) => point.lastSeen)) : null
    }
  };
}

function addPoint(pointMap, row, side) {
  const size = Number(side === "bid" ? row.bid_size : row.ask_size);
  const peakSize = Number(side === "bid" ? row.bid_peak_size : row.ask_peak_size);
  if (!Number.isFinite(size) || size <= 0) return;
  const price = Number(row.price_bucket);
  const key = `${side}:${price.toFixed(8)}`;
  const existing = pointMap.get(key);
  const firstSeen = Date.parse(row.bucket_start);
  const lastSeen = Date.parse(row.bucket_end || row.bucket_start);
  pointMap.set(key, {
    id: key,
    side,
    price,
    bucketSize: Number(row.bucket_size) || Math.max(price * 0.0005, 0.01),
    firstSeen: existing ? Math.min(existing.firstSeen, firstSeen) : firstSeen,
    lastSeen: existing ? Math.max(existing.lastSeen, lastSeen) : lastSeen,
    observations: (existing?.observations ?? 0) + Number(row.observations || 1),
    peakSize: Math.max(existing?.peakSize ?? 0, peakSize || size),
    lastSize: Math.max(existing?.lastSize ?? 0, size),
    strength: Math.max(existing?.strength ?? 0, Number(row.liquidity_score || 0), Number(row.gravity_score || 0) * 0.92),
    source: "black-core-rollup"
  });
}

function scorePoint(point) {
  const ageHours = Math.max(0, (Date.now() - point.lastSeen) / 3600000);
  return point.strength * (1 + Math.log1p(point.observations) * 0.2) / (1 + ageHours / 72);
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
