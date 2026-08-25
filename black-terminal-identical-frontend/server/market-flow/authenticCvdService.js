import crypto from "node:crypto";
import { gunzipSync } from "node:zlib";

const MINUTE_MS = 60_000;
const MAX_BARS = 20_000;
const MAX_CHUNKS = 20_000;
const MAX_CACHE_ROWS = 250_000;
// A healthy high-volume market can publish more than one immutable chunk per
// minute.  Keep enough headroom to cover several hours after an API restart,
// while retaining a hard request-time bound.
const MAX_LAZY_CHUNKS = 512;
const MAX_COMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const EVENT_PATH = /^events\/v[1-9][0-9]*\/BYBIT\/linear_perpetual\/[A-Z0-9_-]{2,40}\/TRADE\/[0-9]{10,16}\/[0-9a-f-]{36}-[0-9a-f]{64}\.events\.gz$/;

export function parseAuthenticCvdQuery(query = {}) {
  const venue = String(query.venue || "BYBIT").trim().toUpperCase();
  const symbol = String(query.symbol || "").trim().toUpperCase();
  const timeframeSeconds = Number(query.timeframeSeconds);
  const start = Number(query.start);
  const end = Number(query.end);
  if (venue !== "BYBIT") throw httpError(400, "Persistent authentic flow is currently available for Bybit only.", "AUTHENTIC_FLOW_VENUE_UNAVAILABLE");
  if (!/^[A-Z0-9_-]{2,40}$/.test(symbol)) throw httpError(400, "Invalid authentic-flow symbol.", "INVALID_SYMBOL");
  if (!(Number.isInteger(timeframeSeconds) && timeframeSeconds >= 60 && timeframeSeconds <= 2_592_000 && timeframeSeconds % 60 === 0)) throw httpError(400, "Unsupported authentic-flow timeframe.", "INVALID_TIMEFRAME");
  if (!(Number.isFinite(start) && Number.isFinite(end) && start > 0 && end > start)) throw httpError(400, "Invalid authentic-flow time range.", "INVALID_TIME_RANGE");
  const alignedStart = Math.floor(start / timeframeSeconds) * timeframeSeconds;
  const alignedEnd = Math.ceil(end / timeframeSeconds) * timeframeSeconds;
  if ((alignedEnd - alignedStart) / timeframeSeconds > MAX_BARS) throw httpError(400, "Authentic-flow request exceeds the 20,000-bar bound.", "FLOW_BAR_BOUND_EXCEEDED");
  return { venue, symbol, timeframeSeconds, start: alignedStart, end: alignedEnd };
}

export async function readAuthenticCvdBars(controlPlane, storageClient, query) {
  const scope = parseAuthenticCvdQuery(query);
  const officialBars = await readOfficialArchiveBars(controlPlane, scope);
  const source = await resolveSource(controlPlane, scope);
  let chunks = [];
  let missing = [];
  let lazy = [];
  let bclifBars = [];
  if (source) {
    const tradeOffset = await resolveTradeOffset(controlPlane, source.id);
    source.trade_continuity_state = tradeOffset?.continuity_state || "MISSING";
    source.trade_cutoff_at = tradeOffset?.last_exchange_timestamp || null;
    chunks = await readChunks(controlPlane, source.id, scope);
    if (chunks.length) {
      let cached = await readCache(controlPlane, source.id, scope);
      const cachedChunks = new Set(cached.map((row) => String(row.chunk_id)));
      missing = chunks.filter((chunk) => !cachedChunks.has(String(chunk.id)));
      lazy = missing.slice(-MAX_LAZY_CHUNKS);
      for (const chunk of lazy) await materializeChunk(controlPlane, storageClient, source, chunk);
      if (lazy.length) cached = await readCache(controlPlane, source.id, scope);
      bclifBars = aggregateCachedFlowBars(cached, scope, source);
    }
  }
  const bars = mergeAuthoritativeFlowBars(officialBars, bclifBars);
  if (!bars.length) return unavailable(scope, "No completed official Bybit archive or verified BCLIF trade chunks overlap the requested chart history.");
  const complete = bars.filter((bar) => bar.deliveryComplete).length;
  const officialComplete = officialBars.filter((bar) => bar.deliveryComplete).length;
  const bclifComplete = bclifBars.filter((bar) => bar.deliveryComplete).length;
  return {
    version: 1,
    authority: complete ? "EXACT_AGGRESSOR_TRADES" : "UNAVAILABLE",
    venue: scope.venue,
    symbol: scope.symbol,
    timeframeSeconds: scope.timeframeSeconds,
    bars,
    coverage: {
      requestedStart: scope.start,
      requestedEnd: scope.end,
      availableStart: bars[0]?.time ?? null,
      availableEnd: bars.at(-1)?.time ?? null,
      completeBars: complete,
      officialArchiveBars: officialComplete,
      liveBclifBars: bclifComplete,
      archivedChunks: chunks.length,
      pendingChunks: Math.max(0, missing.length - lazy.length),
      sourceState: String(source?.state || (officialComplete ? "OFFICIAL_ARCHIVE" : "MISSING")),
      continuity: String(source?.trade_continuity_state || (officialComplete ? "ARCHIVED" : "MISSING"))
    },
    warning: missing.length > lazy.length
      ? "Authentic archive cache is catching up; only checksum-verified completed bars are displayed."
      : complete
        ? "Historical CVD is derived from official Bybit public taker-side archives and checksum-verified live BCLIF aggressor trades. Gaps remain unavailable and are never synthesized."
        : "Verified trade history exists, but no complete causal interval is available yet."
  };
}

async function readOfficialArchiveBars(supabase, scope) {
  if (typeof supabase?.rpc !== "function") return [];
  const result = await supabase.rpc("acvd_read_bybit_public_trade_bars", {
    p_symbol: scope.symbol,
    p_timeframe_seconds: scope.timeframeSeconds,
    p_start_epoch: scope.start,
    p_end_epoch: scope.end
  });
  if (result.error) {
    if (["42883", "PGRST202"].includes(String(result.error.code || ""))) throw httpError(503, "Official Bybit archive migration is not deployed.", "OFFICIAL_FLOW_ARCHIVE_NOT_DEPLOYED");
    throw result.error;
  }
  return (result.data || []).map((row) => ({
    time: Number(row.time),
    buyVolume: numeric(row, "buyVolume", "buy_volume"),
    sellVolume: numeric(row, "sellVolume", "sell_volume"),
    unknownVolume: 0,
    buyNotional: numeric(row, "buyNotional", "buy_notional"),
    sellNotional: numeric(row, "sellNotional", "sell_notional"),
    unknownNotional: 0,
    exactTradeCount: numeric(row, "exactTradeCount", "exact_trade_count"),
    totalTradeCount: numeric(row, "totalTradeCount", "total_trade_count"),
    deliveryComplete: Boolean(row.deliveryComplete ?? row.delivery_complete),
    authority: "BYBIT_OFFICIAL_PUBLIC_ARCHIVE"
  })).filter((bar) => Number.isFinite(bar.time));
}

export function mergeAuthoritativeFlowBars(officialBars = [], bclifBars = []) {
  const merged = new Map();
  for (const bar of officialBars) merged.set(Number(bar.time), bar);
  for (const bar of bclifBars) {
    const time = Number(bar.time);
    const existing = merged.get(time);
    if (!existing || (!existing.deliveryComplete && bar.deliveryComplete)) merged.set(time, { ...bar, authority: "BCLIF_CANONICAL_TRADE_CHUNKS" });
  }
  return [...merged.values()].sort((left, right) => Number(left.time) - Number(right.time));
}

export async function backfillAuthenticCvdCache(controlPlane, storageClient, options = {}) {
  const symbol = String(options.symbol || "BTCUSDT").toUpperCase();
  const source = await resolveSource(controlPlane, { venue: "BYBIT", symbol });
  if (!source) return { source: null, chunks: 0, materialized: 0 };
  const end = Math.floor((Number(options.end) || Date.now() / 1000));
  const start = Math.max(1, Math.floor(Number(options.start) || end - 31 * 86_400));
  const scope = { venue: "BYBIT", symbol, timeframeSeconds: 60, start, end };
  const chunks = await readChunks(controlPlane, source.id, scope);
  const cached = await readCache(controlPlane, source.id, scope);
  const known = new Set(cached.map((row) => String(row.chunk_id)));
  const maximum = Math.max(1, Math.min(MAX_CHUNKS, Number(options.maximumChunks) || MAX_CHUNKS));
  let materialized = 0;
  for (const chunk of chunks) {
    if (known.has(String(chunk.id))) continue;
    await materializeChunk(controlPlane, storageClient, source, chunk);
    materialized += 1;
    options.onProgress?.({ materialized, total: chunks.length });
    if (materialized >= maximum) break;
  }
  return { source: source.id, chunks: chunks.length, materialized };
}

async function resolveSource(supabase, scope) {
  const result = await supabase.from("bclif_sources")
    .select("id,venue,symbol,state,continuity_state,source_cutoff_at,updated_at")
    .eq("venue", scope.venue).eq("symbol", scope.symbol).eq("market_kind", "linear_perpetual")
    .order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (result.error) throw result.error;
  return result.data || null;
}

async function resolveTradeOffset(supabase, sourceId) {
  const result = await supabase.from("bclif_source_offsets")
    .select("continuity_state,last_exchange_timestamp,gap_count,reconnect_count,updated_at")
    .eq("source_id", sourceId).eq("source_name", "TRADE").eq("source_partition", "default")
    .maybeSingle();
  if (result.error) throw result.error;
  return result.data || null;
}

async function readChunks(supabase, sourceId, scope) {
  const rows = [];
  for (let offset = 0; offset < MAX_CHUNKS; offset += 500) {
    const result = await supabase.from("bclif_canonical_event_chunks")
      .select("id,source_id,event_kind,chunk_start,chunk_end,source_cutoff_at,event_count,bucket_id,object_path,checksum,compressed_bytes,uncompressed_bytes")
      .eq("source_id", sourceId).eq("event_kind", "TRADE")
      .lte("chunk_start", new Date(scope.end * 1000).toISOString())
      .gte("chunk_end", new Date(scope.start * 1000).toISOString())
      .order("chunk_start", { ascending: true }).order("id", { ascending: true })
      .range(offset, offset + 499);
    if (result.error) throw result.error;
    const page = result.data || [];
    rows.push(...page);
    if (page.length < 500) return rows;
  }
  throw httpError(503, "Authentic-flow archive exceeds its bounded read window.", "FLOW_ARCHIVE_BOUND_EXCEEDED");
}

async function readCache(supabase, sourceId, scope) {
  const rows = [];
  for (let offset = 0; offset < MAX_CACHE_ROWS; offset += 1_000) {
    const result = await supabase.from("bclif_trade_flow_chunk_bars")
      .select("chunk_id,interval_start,buy_volume,sell_volume,unknown_volume,buy_notional,sell_notional,unknown_notional,exact_trade_count,total_trade_count")
      .eq("source_id", sourceId)
      .gte("interval_start", new Date(scope.start * 1000).toISOString())
      .lt("interval_start", new Date(scope.end * 1000).toISOString())
      .order("interval_start", { ascending: true }).range(offset, offset + 999);
    if (result.error) {
      if (["42P01", "PGRST205"].includes(String(result.error.code || ""))) throw httpError(503, "Authentic-flow cache migration is not deployed.", "FLOW_CACHE_NOT_DEPLOYED");
      throw result.error;
    }
    const page = result.data || [];
    rows.push(...page);
    if (page.length < 1_000) return rows;
  }
  throw httpError(503, "Authentic-flow cache exceeds its bounded read window.", "FLOW_CACHE_BOUND_EXCEEDED");
}

async function materializeChunk(supabase, storageClient, source, chunk) {
  validateChunk(chunk, source);
  const download = await storageClient.storage.from("bclif-field-chunks").download(String(chunk.object_path));
  if (download.error) throw download.error;
  const compressed = new Uint8Array(await download.data.arrayBuffer());
  const rows = decodeVerifiedTradeChunk(compressed, chunk, source);
  const result = await supabase.from("bclif_trade_flow_chunk_bars").upsert(rows, {
    onConflict: "chunk_id,interval_seconds,interval_start",
    ignoreDuplicates: true
  });
  if (result.error) throw result.error;
}

export function decodeVerifiedTradeChunk(compressed, chunk, source) {
  validateChunk(chunk, source);
  if (!compressed.byteLength || compressed.byteLength > MAX_COMPRESSED_BYTES) throw new Error("BCLIF trade chunk violates compressed safety bounds");
  const checksum = `sha256:${crypto.createHash("sha256").update(compressed).digest("hex")}`;
  if (checksum !== String(chunk.checksum)) throw new Error("BCLIF trade chunk checksum mismatch");
  const raw = gunzipSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  const buckets = new Map();
  for (const line of raw.toString("utf8").trim().split("\n").filter(Boolean)) {
    const event = JSON.parse(line);
    validateTradeEvent(event, source.symbol);
    const minute = Math.floor(event.exchangeTimestamp / MINUTE_MS) * MINUTE_MS;
    const row = buckets.get(minute) || emptyChunkBar(chunk, source.id, minute);
    const quantity = Number(event.payload.quantity);
    const notional = Number(event.payload.notional);
    row.total_trade_count += 1;
    if (event.payload.aggressorSide === "BUY") {
      row.buy_volume += quantity; row.buy_notional += notional; row.exact_trade_count += 1;
    } else if (event.payload.aggressorSide === "SELL") {
      row.sell_volume += quantity; row.sell_notional += notional; row.exact_trade_count += 1;
    } else {
      row.unknown_volume += quantity; row.unknown_notional += notional;
    }
    buckets.set(minute, row);
  }
  const rows = [...buckets.values()];
  if (!rows.length) throw new Error("Verified BCLIF TRADE chunk contains no trades");
  return rows;
}

export function aggregateCachedFlowBars(rows, scope, source) {
  const minuteMap = new Map();
  for (const row of rows) {
    const minute = Math.floor(new Date(row.interval_start).getTime() / MINUTE_MS) * MINUTE_MS;
    const aggregate = minuteMap.get(minute) || zeroValues();
    addRow(aggregate, row);
    minuteMap.set(minute, aggregate);
  }
  const output = [];
  const spanMs = scope.timeframeSeconds * 1000;
  const expectedMinutes = Math.max(1, Math.ceil(spanMs / MINUTE_MS));
  const sourceCutoff = new Date(source.source_cutoff_at || 0).getTime();
  const tradeCutoff = new Date(source.trade_cutoff_at || 0).getTime();
  const cutoff = Math.min(sourceCutoff || Number.POSITIVE_INFINITY, tradeCutoff || Number.POSITIVE_INFINITY);
  const continuous = String(source.trade_continuity_state) === "OBSERVED";
  for (let startMs = scope.start * 1000; startMs < scope.end * 1000; startMs += spanMs) {
    const aggregate = zeroValues();
    let presentMinutes = 0;
    for (let minute = startMs; minute < startMs + spanMs; minute += MINUTE_MS) {
      const values = minuteMap.get(minute);
      if (!values) continue;
      presentMinutes += 1;
      addRow(aggregate, values);
    }
    if (!aggregate.totalTradeCount) continue;
    output.push({
      time: startMs / 1000,
      ...aggregate,
      deliveryComplete: continuous && presentMinutes === expectedMinutes && startMs + spanMs <= cutoff
    });
  }
  return output;
}

function validateChunk(chunk, source) {
  if (String(chunk.source_id) !== String(source.id) || chunk.event_kind !== "TRADE" || chunk.bucket_id !== "bclif-field-chunks") throw new Error("BCLIF trade chunk metadata mismatch");
  if (!EVENT_PATH.test(String(chunk.object_path)) || String(chunk.object_path).includes("..")) throw new Error("Invalid BCLIF trade chunk path");
  if (!/^sha256:[a-f0-9]{64}$/.test(String(chunk.checksum))) throw new Error("Invalid BCLIF trade chunk checksum metadata");
}

function validateTradeEvent(event, symbol) {
  const payload = event?.payload;
  if (event?.schemaVersion !== 1 || event?.venue !== "BYBIT" || event?.kind !== "TRADE" || event?.symbol !== symbol) throw new Error("Invalid canonical BCLIF trade event");
  if (!/^sha256:[a-f0-9]{64}$/.test(String(event.dedupKey || ""))) throw new Error("Invalid canonical BCLIF trade identity");
  if (!(Number.isFinite(event.exchangeTimestamp) && Number(payload?.quantity) > 0 && Number(payload?.notional) > 0)) throw new Error("Invalid canonical BCLIF trade values");
  if (!['BUY', 'SELL', 'UNKNOWN'].includes(payload.aggressorSide) || payload.certainty !== "OBSERVED") throw new Error("Untrusted canonical BCLIF aggressor classification");
}

function emptyChunkBar(chunk, sourceId, minute) {
  return { chunk_id: chunk.id, source_id: sourceId, interval_seconds: 60, interval_start: new Date(minute).toISOString(), buy_volume: 0, sell_volume: 0, unknown_volume: 0, buy_notional: 0, sell_notional: 0, unknown_notional: 0, exact_trade_count: 0, total_trade_count: 0 };
}
function zeroValues() { return { buyVolume: 0, sellVolume: 0, unknownVolume: 0, buyNotional: 0, sellNotional: 0, unknownNotional: 0, exactTradeCount: 0, totalTradeCount: 0 }; }
function numeric(row, camel, snake) { return Number(row[camel] ?? row[snake] ?? 0) || 0; }
function addRow(target, row) {
  target.buyVolume += numeric(row, "buyVolume", "buy_volume"); target.sellVolume += numeric(row, "sellVolume", "sell_volume"); target.unknownVolume += numeric(row, "unknownVolume", "unknown_volume");
  target.buyNotional += numeric(row, "buyNotional", "buy_notional"); target.sellNotional += numeric(row, "sellNotional", "sell_notional"); target.unknownNotional += numeric(row, "unknownNotional", "unknown_notional");
  target.exactTradeCount += numeric(row, "exactTradeCount", "exact_trade_count"); target.totalTradeCount += numeric(row, "totalTradeCount", "total_trade_count");
}
function unavailable(scope, warning) { return { version: 1, authority: "UNAVAILABLE", venue: scope.venue, symbol: scope.symbol, timeframeSeconds: scope.timeframeSeconds, bars: [], coverage: { requestedStart: scope.start, requestedEnd: scope.end, availableStart: null, availableEnd: null, completeBars: 0, archivedChunks: 0, pendingChunks: 0, sourceState: "MISSING", continuity: "MISSING" }, warning }; }
function httpError(statusCode, message, code) { return Object.assign(new Error(message), { statusCode, code }); }
