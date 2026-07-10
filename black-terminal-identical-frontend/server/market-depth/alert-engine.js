import { normalizeMarketKind, normalizeSymbol, normalizeVenue } from "./types.js";

export async function getMarketDepthAlerts(supabase, query = {}) {
  const venue = normalizeVenue(query.venue || query.exchange);
  const marketKind = query.marketKind ? normalizeMarketKind(query.marketKind) : "";
  const symbol = normalizeSymbol(query.symbol);
  const limit = Math.min(250, Math.max(10, Number(query.limit) || 80));
  const since = new Date(Date.now() - horizonToMs(query.horizon || "24h")).toISOString();

  const [events, walls, stats] = await Promise.all([
    readEvents(supabase, { venue, marketKind, symbol, since, limit }),
    readWalls(supabase, { venue, marketKind, symbol, limit }),
    readStats(supabase, { venue, marketKind, symbol, since, limit })
  ]);

  const alerts = [
    ...events.flatMap(eventToAlerts),
    ...walls.flatMap(wallToAlerts),
    ...stats.flatMap(statToAlerts)
  ]
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
    .slice(0, limit);

  return {
    status: "ok",
    source: "black-core-market-depth-memory",
    venue: venue || "all",
    marketKind: marketKind || "all",
    symbol: symbol || "all",
    alerts
  };
}

async function readEvents(supabase, query) {
  let builder = supabase
    .from("market_liquidity_events")
    .select("id,venue,market_kind,symbol,event_type,side,price,price_bucket,size,confidence,wall_key,occurred_at,metadata")
    .gte("occurred_at", query.since)
    .order("occurred_at", { ascending: false })
    .limit(query.limit);
  if (query.venue) builder = builder.eq("venue", query.venue);
  if (query.marketKind) builder = builder.eq("market_kind", query.marketKind);
  if (query.symbol) builder = builder.eq("symbol", query.symbol);
  const { data, error } = await builder;
  if (error) throw error;
  return data || [];
}

async function readWalls(supabase, query) {
  let builder = supabase
    .from("market_liquidity_walls")
    .select("wall_key,venue,market_kind,symbol,side,status,first_seen_at,last_seen_at,current_price,peak_size,current_size,touches,confidence,spoof_probability,reliability_score,gravity_score,metadata")
    .in("status", ["ACTIVE", "GROWING", "WEAKENING", "MIGRATING", "SPOOF_SUSPECTED"])
    .order("last_seen_at", { ascending: false })
    .limit(query.limit);
  if (query.venue) builder = builder.eq("venue", query.venue);
  if (query.marketKind) builder = builder.eq("market_kind", query.marketKind);
  if (query.symbol) builder = builder.eq("symbol", query.symbol);
  const { data, error } = await builder;
  if (error) throw error;
  return data || [];
}

async function readStats(supabase, query) {
  let builder = supabase
    .from("market_depth_statistics")
    .select("venue,market_kind,symbol,resolution,bucket_start,best_bid,best_ask,mid_price,total_bid_size,total_ask_size,imbalance,liquidity_score,packet_loss_count,reconnect_count,latency_ms")
    .gte("bucket_start", query.since)
    .order("bucket_start", { ascending: false })
    .limit(query.limit);
  if (query.venue) builder = builder.eq("venue", query.venue);
  if (query.marketKind) builder = builder.eq("market_kind", query.marketKind);
  if (query.symbol) builder = builder.eq("symbol", query.symbol);
  const { data, error } = await builder;
  if (error) throw error;
  return data || [];
}

function eventToAlerts(event) {
  const severity = event.confidence >= 0.78 ? "high" : event.confidence >= 0.55 ? "medium" : "low";
  const typeMap = {
    WALL_APPEARED: "large_wall_appeared",
    WALL_STRENGTHENED: "wall_strengthened",
    WALL_WEAKENED: "wall_weakening",
    WALL_MIGRATED: "wall_migrated",
    WALL_PULLED: "wall_pulled",
    WALL_ABSORBED: "wall_absorbed",
    LIQUIDITY_VACUUM: "liquidity_vacuum",
    POC_MIGRATED: "poc_migrated",
    ICEBERG_DETECTED: "iceberg_detected",
    STACKING_DETECTED: "stacking_detected",
    PULLING_DETECTED: "pulling_detected"
  };
  return [{
    id: `event:${event.id}`,
    type: typeMap[event.event_type] || "market_memory_event",
    severity,
    venue: event.venue,
    marketKind: event.market_kind,
    symbol: event.symbol,
    side: event.side,
    price: Number(event.price_bucket ?? event.price),
    title: titleFromEvent(event),
    body: bodyFromEvent(event),
    confidence: Number(event.confidence) || 0,
    occurredAt: event.occurred_at,
    metadata: {
      wallKey: event.wall_key,
      eventType: event.event_type,
      size: Number(event.size) || 0,
      ...event.metadata
    }
  }];
}

function wallToAlerts(wall) {
  const alerts = [];
  const reliability = Number(wall.reliability_score) || 0;
  const gravity = Number(wall.gravity_score) || 0;
  const spoof = Number(wall.spoof_probability) || 0;
  if (reliability >= 0.72 || gravity >= 0.72) {
    alerts.push({
      id: `wall:${wall.wall_key}:gravity`,
      type: "liquidity_gravity_high",
      severity: reliability >= 0.85 || gravity >= 0.85 ? "high" : "medium",
      venue: wall.venue,
      marketKind: wall.market_kind,
      symbol: wall.symbol,
      side: wall.side,
      price: Number(wall.current_price),
      title: `${wall.side === "buy" ? "Buy" : "Sell"} wall gravity high`,
      body: `Reliability ${(reliability * 100).toFixed(0)}%, gravity ${(gravity * 100).toFixed(0)}%.`,
      confidence: Math.max(reliability, gravity),
      occurredAt: wall.last_seen_at,
      metadata: { status: wall.status, touches: wall.touches, peakSize: wall.peak_size, currentSize: wall.current_size }
    });
  }
  if (spoof >= 0.58) {
    alerts.push({
      id: `wall:${wall.wall_key}:spoof`,
      type: "potential_spoof",
      severity: spoof >= 0.75 ? "high" : "medium",
      venue: wall.venue,
      marketKind: wall.market_kind,
      symbol: wall.symbol,
      side: wall.side,
      price: Number(wall.current_price),
      title: "Potential spoof wall",
      body: `Spoof probability ${(spoof * 100).toFixed(0)}%.`,
      confidence: spoof,
      occurredAt: wall.last_seen_at,
      metadata: { status: wall.status, reliabilityScore: reliability }
    });
  }
  return alerts;
}

function statToAlerts(stat) {
  const alerts = [];
  const imbalance = Number(stat.imbalance) || 0;
  const liquidityScore = Number(stat.liquidity_score) || 0;
  const packetLoss = Number(stat.packet_loss_count) || 0;
  if (Math.abs(imbalance) >= 0.72) {
    alerts.push({
      id: `stat:${stat.venue}:${stat.market_kind}:${stat.symbol}:${stat.bucket_start}:imbalance`,
      type: "depth_imbalance",
      severity: Math.abs(imbalance) >= 0.88 ? "high" : "medium",
      venue: stat.venue,
      marketKind: stat.market_kind,
      symbol: stat.symbol,
      side: imbalance > 0 ? "buy" : "sell",
      price: Number(stat.mid_price),
      title: imbalance > 0 ? "Bid depth imbalance" : "Ask depth imbalance",
      body: `${Math.abs(imbalance * 100).toFixed(0)}% visible depth skew.`,
      confidence: Math.min(1, Math.abs(imbalance)),
      occurredAt: stat.bucket_start,
      metadata: { totalBidSize: stat.total_bid_size, totalAskSize: stat.total_ask_size, resolution: stat.resolution }
    });
  }
  if (liquidityScore <= 0.08 && Number(stat.total_bid_size) + Number(stat.total_ask_size) > 0) {
    alerts.push({
      id: `stat:${stat.venue}:${stat.market_kind}:${stat.symbol}:${stat.bucket_start}:vacuum`,
      type: "liquidity_vacuum",
      severity: "medium",
      venue: stat.venue,
      marketKind: stat.market_kind,
      symbol: stat.symbol,
      side: null,
      price: Number(stat.mid_price),
      title: "Liquidity vacuum",
      body: "Visible depth score is unusually low.",
      confidence: 1 - liquidityScore,
      occurredAt: stat.bucket_start,
      metadata: { liquidityScore, resolution: stat.resolution }
    });
  }
  if (packetLoss > 0 || Number(stat.reconnect_count) > 0) {
    alerts.push({
      id: `stat:${stat.venue}:${stat.market_kind}:${stat.symbol}:${stat.bucket_start}:transport`,
      type: "depth_feed_degraded",
      severity: packetLoss > 3 ? "high" : "low",
      venue: stat.venue,
      marketKind: stat.market_kind,
      symbol: stat.symbol,
      side: null,
      price: Number(stat.mid_price),
      title: "Depth feed degraded",
      body: `${packetLoss} sequence gaps, ${Number(stat.reconnect_count) || 0} reconnects.`,
      confidence: Math.min(1, 0.35 + packetLoss * 0.12),
      occurredAt: stat.bucket_start,
      metadata: { packetLossCount: packetLoss, reconnectCount: stat.reconnect_count, latencyMs: stat.latency_ms }
    });
  }
  return alerts;
}

function titleFromEvent(event) {
  const side = event.side === "buy" ? "Buy" : event.side === "sell" ? "Sell" : "Liquidity";
  return `${side} ${event.event_type.toLowerCase().replaceAll("_", " ")}`;
}

function bodyFromEvent(event) {
  const price = Number(event.price_bucket ?? event.price);
  const size = Number(event.size) || 0;
  return `${event.symbol} ${Number.isFinite(price) ? price.toLocaleString() : ""} / size ${size.toLocaleString()}`;
}

function horizonToMs(horizon) {
  switch (String(horizon).toLowerCase()) {
    case "15m": return 15 * 60 * 1000;
    case "1h": return 60 * 60 * 1000;
    case "6h": return 6 * 60 * 60 * 1000;
    case "12h": return 12 * 60 * 60 * 1000;
    case "3d": return 3 * 24 * 60 * 60 * 1000;
    case "1w": return 7 * 24 * 60 * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}
