import { horizonToMs, normalizeMarketKind, normalizeSymbol, normalizeVenue, selectResolutionForReplay } from "../market-depth/types.js";
import { decodeHistoricalFrameChunk } from "./frame-chunk-store.js";

const RESPONSE_RESOLUTIONS = new Set(["1s", "5s", "15s", "1m"]);

export async function getHistoricalBookHeatmapTiles(supabase, query = {}) {
  const venue = normalizeVenue(query.venue || query.exchange);
  const marketKind = normalizeMarketKind(query.marketKind);
  const symbol = normalizeSymbol(query.symbol);
  if (!venue || !symbol) throw httpError(400, "Historical heatmap requires venue and symbol.");

  const now = Date.now();
  const horizon = String(query.horizon || "24h").toLowerCase();
  const requestedHorizonMs = horizonToMs(horizon);
  const fromMs = optionalTimestamp(query.from, now - requestedHorizonMs);
  const toMs = optionalTimestamp(query.to, now);
  const minPrice = optionalNumber(query.minPrice);
  const maxPrice = optionalNumber(query.maxPrice);
  const resolution = chooseResolution(query.resolution, horizon, minPrice, maxPrice);
  const maxCells = Math.min(40_000, Math.max(2_000, Number(query.maxCells) || 40_000));
  const chunks = await readFrameChunks(supabase, { venue, marketKind, symbol, fromMs, toMs });
  const frames = chunks.flatMap((chunk) => decodeHistoricalFrameChunk(chunk.payload))
    .filter((frame) => frame.timestamp >= fromMs && frame.timestamp <= toMs);
  let cells;
  let frameTimes;
  let rawRows = 0;
  if (frames.length) {
    cells = buildFrameTopology(frames, { venue, minPrice, maxPrice, maxCells, stepMs: resolutionMs(resolution) });
    frameTimes = frames.map((frame) => frame.timestamp);
  } else {
    const storageResolution = resolution === "5s" || resolution === "15s" ? "1s" : resolution;
    const rows = await readRollups(supabase, {
    venue, marketKind, symbol, fromMs, toMs, minPrice, maxPrice,
    resolution: storageResolution, maxRows: Math.min(60_000, maxCells * 2)
    });
    cells = buildHistoricalTopology(rows, maxCells, resolutionMs(resolution));
    frameTimes = rows.map((row) => Date.parse(row.bucket_start));
    rawRows = rows.length;
  }
  const coverage = await readCoverage(supabase, {
    venue, marketKind, symbol, requestedHorizonMs, resolution, frameTimes
  });

  return {
    status: "ok",
    source: "black-core-book-heatmap-history",
    venue, marketKind, symbol, horizon, resolution,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    coverage,
    cells,
    stats: { chunks: chunks.length, frames: frames.length, rawRows, cells: cells.length, maxCells }
  };
}

async function readFrameChunks(supabase, query) {
  const { data, error } = await supabase.from("book_heatmap_depth_chunks")
    .select("chunk_start,chunk_end,frame_count,payload")
    .eq("venue", query.venue).eq("market_kind", query.marketKind).eq("symbol", query.symbol).eq("resolution_ms", 1_000)
    .lte("chunk_start", new Date(query.toMs).toISOString()).gte("chunk_end", new Date(query.fromMs).toISOString())
    .order("chunk_start", { ascending: true }).limit(1_000);
  if (error) {
    // Before the migration is applied, retain a truthful legacy-rollup read path.
    if (String(error.code) === "42P01" || /does not exist|schema cache/i.test(error.message || "")) return [];
    throw error;
  }
  return data || [];
}

export function buildFrameTopology(frames, { venue, minPrice, maxPrice, maxCells, stepMs }) {
  const rows = [];
  const byTime = new Map();
  for (const frame of frames) byTime.set(Math.floor(frame.timestamp / stepMs) * stepMs, frame);
  const orderedFrames = [...byTime.values()].sort((left, right) => left.timestamp - right.timestamp);
  const frameStride = Math.max(1, Math.ceil(orderedFrames.length / 1_024));
  for (let frameIndex = 0; frameIndex < orderedFrames.length; frameIndex += frameStride) {
    const frame = orderedFrames[frameIndex];
    const time = Math.floor(frame.timestamp / stepMs) * stepMs;
    for (const side of ["bids", "asks"]) {
      for (const level of frame[side] || []) {
        const price = Number(level.priceBucket);
        if (!Number.isFinite(price) || (Number.isFinite(minPrice) && price < minPrice) || (Number.isFinite(maxPrice) && price > maxPrice)) continue;
        const quantity = Number(level.notional) > 0 ? Number(level.notional) / price : Number(level.quantity) || 0;
        rows.push({
          venue, bucket_start: new Date(time).toISOString(), bucket_end: new Date(time + stepMs).toISOString(),
          price_bucket: price, bucket_size: frame.priceBucketSize, bid_size: side === "bids" ? quantity : 0,
          ask_size: side === "asks" ? quantity : 0, bid_peak_size: side === "bids" ? quantity : 0,
          ask_peak_size: side === "asks" ? quantity : 0, observations: 1, liquidity_score: 0, gravity_score: 0
        });
      }
    }
  }
  return buildHistoricalTopology(rows, maxCells, stepMs);
}

async function readRollups(supabase, query) {
  const rows = [];
  const pageSize = 1_000;
  for (let offset = 0; offset < query.maxRows; offset += pageSize) {
    let builder = supabase
      .from("market_depth_rollups")
      .select("venue,market_kind,symbol,bucket_start,bucket_end,resolution,price_bucket,bucket_size,bid_size,ask_size,bid_peak_size,ask_peak_size,observations,liquidity_score,gravity_score")
      .eq("venue", query.venue)
      .eq("market_kind", query.marketKind)
      .eq("symbol", query.symbol)
      .eq("resolution", query.resolution)
      .gte("bucket_start", new Date(query.fromMs).toISOString())
      .lte("bucket_start", new Date(query.toMs).toISOString())
      .order("bucket_start", { ascending: true })
      .range(offset, Math.min(query.maxRows, offset + pageSize) - 1);
    if (Number.isFinite(query.minPrice)) builder = builder.gte("price_bucket", query.minPrice);
    if (Number.isFinite(query.maxPrice)) builder = builder.lte("price_bucket", query.maxPrice);
    const { data, error } = await builder;
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

export function buildHistoricalTopology(rows, maxCells, stepMs) {
  const cells = new Map();
  for (const row of rows) {
    const sourceTime = Date.parse(row.bucket_start);
    const price = Number(row.price_bucket);
    if (!Number.isFinite(sourceTime) || !Number.isFinite(price)) continue;
    const time = Math.floor(sourceTime / stepMs) * stepMs;
    const key = `${time}:${price.toFixed(8)}`;
    const current = cells.get(key) ?? {
      time: new Date(time).toISOString(), bucketEnd: new Date(time + stepMs).toISOString(), price,
      bucketSize: Number(row.bucket_size) || 0, bidSize: 0, askSize: 0, bidPeakSize: 0, askPeakSize: 0,
      observations: 0, liquidityScore: 0, gravityScore: 0, venues: {}
    };
    const bid = Number(row.bid_size) || 0;
    const ask = Number(row.ask_size) || 0;
    current.bidSize = Math.max(current.bidSize, bid);
    current.askSize = Math.max(current.askSize, ask);
    current.bidPeakSize = Math.max(current.bidPeakSize, Number(row.bid_peak_size) || 0);
    current.askPeakSize = Math.max(current.askPeakSize, Number(row.ask_peak_size) || 0);
    current.observations += Number(row.observations) || 0;
    current.liquidityScore = Math.max(current.liquidityScore, Number(row.liquidity_score) || 0);
    current.gravityScore = Math.max(current.gravityScore, Number(row.gravity_score) || 0);
    current.venues[row.venue] = { bidSize: bid, askSize: ask };
    cells.set(key, current);
  }
  const ordered = [...cells.values()].sort((left, right) => Date.parse(left.time) - Date.parse(right.time) || right.price - left.price);
  if (ordered.length <= maxCells) return ordered;
  const times = [...new Set(ordered.map((cell) => Date.parse(cell.time)))];
  const rowsPerFrame = Math.max(1, ordered.length / Math.max(1, times.length));
  const keepEvery = Math.max(1, Math.ceil(times.length / Math.max(1, Math.floor(maxCells / rowsPerFrame))));
  const allowedTimes = new Set(times.filter((_, index) => index % keepEvery === 0));
  return ordered.filter((cell) => allowedTimes.has(Date.parse(cell.time))).slice(0, maxCells);
}

async function readCoverage(supabase, query) {
  return {
    ...buildCoverageFrameStats(query.frameTimes, query.resolution, query.requestedHorizonMs, query.symbol, query.venue),
    collectorStatus: await collectorStatus(supabase, query)
  };
}

export function buildCoverageFrameStats(sourceFrameTimes, resolution, requestedHorizonMs, symbol = "BTCUSDT", venue = "bybit") {
  const stepMs = resolutionMs(resolution);
  const frameTimes = [...new Set(sourceFrameTimes.map((value) => {
    const time = Number(value);
    return Number.isFinite(time) ? Math.floor(time / stepMs) * stepMs : null;
  }).filter(Number.isFinite))].sort((a, b) => a - b);
  const gaps = [];
  for (let index = 1; index < frameTimes.length; index += 1) {
    if (frameTimes[index] - frameTimes[index - 1] > stepMs * 1.6) {
      gaps.push({ from: frameTimes[index - 1] + stepMs, to: frameTimes[index] });
      if (gaps.length >= 200) break;
    }
  }
  const earliestTimestamp = frameTimes[0] ?? null;
  const latestTimestamp = frameTimes.at(-1) ?? null;
  const availableHorizonMs = earliestTimestamp === null || latestTimestamp === null ? 0 : latestTimestamp - earliestTimestamp + stepMs;
  const expectedFrames = availableHorizonMs ? Math.max(1, Math.round(availableHorizonMs / stepMs)) : 0;
  const continuityPercent = expectedFrames ? Math.min(100, frameTimes.length / expectedFrames * 100) : 0;
  return {
    symbol, venue, earliestTimestamp, latestTimestamp,
    requestedHorizonMs, availableHorizonMs, frameCount: frameTimes.length,
    continuityPercent: Number(continuityPercent.toFixed(2)), gaps
  };
}

async function collectorStatus(supabase, query) {
  const { data: coverage } = await supabase.from("book_heatmap_collector_coverage")
    .select("state,last_heartbeat_at").eq("venue", query.venue).eq("market_kind", query.marketKind).eq("symbol", query.symbol).maybeSingle();
  if (coverage && Date.now() - Date.parse(coverage.last_heartbeat_at || 0) <= 120_000) return coverage.state;
  const { data, error } = await supabase
    .from("imm_worker_heartbeats")
    .select("status,heartbeat_at,metadata")
    .eq("venue", query.venue).eq("market_kind", query.marketKind).eq("symbol", query.symbol)
    .order("heartbeat_at", { ascending: false }).limit(1).maybeSingle();
  if (error || !data || Date.now() - Date.parse(data.heartbeat_at || 0) > 120_000) return "OFFLINE";
  return data.status === "healthy" && data.metadata?.reconstructionState === "LIVE" ? "LIVE" : "DEGRADED";
}

function chooseResolution(value, horizon, minPrice, maxPrice) {
  const requested = String(value || "adaptive").toLowerCase();
  if (RESPONSE_RESOLUTIONS.has(requested)) return requested;
  const selected = selectResolutionForReplay({ horizon, rangePct: rangePercent(minPrice, maxPrice) });
  return selected === "10s" ? "15s" : RESPONSE_RESOLUTIONS.has(selected) ? selected : "1m";
}

function resolutionMs(value) { return value === "1s" ? 1_000 : value === "5s" ? 5_000 : value === "15s" ? 15_000 : 60_000; }
function optionalTimestamp(value, fallback) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : fallback; }
function optionalNumber(value) { const number = Number(value); return value === undefined || value === null || value === "" || !Number.isFinite(number) ? null : number; }
function rangePercent(minPrice, maxPrice) { if (!(minPrice > 0) || !(maxPrice > minPrice)) return null; return ((maxPrice - minPrice) / ((minPrice + maxPrice) / 2)) * 50; }
function httpError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
