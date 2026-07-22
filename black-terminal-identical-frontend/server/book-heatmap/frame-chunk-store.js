import { gunzipSync, gzipSync } from "node:zlib";

const CHUNK_MS = 5 * 60_000;
const FLUSH_MS = 5_000;
const RETENTION_MS = 72 * 60 * 60_000;

export class HistoricalFrameChunkWriter {
  constructor({ supabase, venue = "bybit", marketKind = "perpetual", symbol = "BTCUSDT" } = {}) {
    if (!supabase) throw new Error("HistoricalFrameChunkWriter requires Supabase admin access.");
    this.supabase = supabase;
    this.venue = venue;
    this.marketKind = marketKind;
    this.symbol = symbol;
    this.chunkStart = null;
    this.frames = [];
    this.lastFlushAt = 0;
    this.lastPruneAt = 0;
    this.coverageStartedAt = null;
    this.totalFrames = 0;
    this.coverageInitialized = false;
  }

  async append(frame) {
    await this.initializeCoverage(frame.timestamp);
    const chunkStart = Math.floor(frame.timestamp / CHUNK_MS) * CHUNK_MS;
    if (this.chunkStart !== null && chunkStart !== this.chunkStart) await this.flush();
    if (this.chunkStart === null) this.chunkStart = chunkStart;
    if (this.coverageStartedAt === null) this.coverageStartedAt = frame.timestamp;
    const compact = compactFrame(frame);
    const frameSecond = Math.floor(frame.timestamp / 1_000);
    const last = this.frames[this.frames.length - 1];
    if (last && Math.floor(last[0] / 1_000) === frameSecond) this.frames[this.frames.length - 1] = compact;
    else {
      this.frames.push(compact);
      this.totalFrames += 1;
    }
    if (Date.now() - this.lastFlushAt >= FLUSH_MS) await this.flush(false);
    if (Date.now() - this.lastPruneAt >= 60 * 60_000) await this.prune();
  }

  async flush(finalize = true) {
    if (this.chunkStart === null || this.frames.length === 0) return;
    const payload = gzipSync(Buffer.from(JSON.stringify({ version: 1, frames: this.frames })), { level: 6 });
    const last = this.frames[this.frames.length - 1];
    const row = {
      venue: this.venue,
      market_kind: this.marketKind,
      symbol: this.symbol,
      chunk_start: new Date(this.chunkStart).toISOString(),
      chunk_end: new Date(last[0] + 1_000).toISOString(),
      resolution_ms: 1_000,
      frame_count: this.frames.length,
      sequence_start: String(this.frames[0][1]),
      sequence_end: String(last[1]),
      compression: "gzip-json-v1",
      payload: `\\x${payload.toString("hex")}`,
      compressed_bytes: payload.byteLength,
      uncompressed_bytes: Buffer.byteLength(JSON.stringify({ version: 1, frames: this.frames })),
      metadata: { depth: 1_000, persistedCadenceMs: 1_000, intensity: "notional", finalized: finalize }
    };
    const { error } = await this.supabase
      .from("book_heatmap_depth_chunks")
      .upsert(row, { onConflict: "venue,market_kind,symbol,chunk_start,resolution_ms" });
    if (error) throw error;
    await this.writeCoverage(last[0], last[1]);
    this.lastFlushAt = Date.now();
    if (finalize) {
      this.chunkStart = null;
      this.frames = [];
    }
  }

  async writeCoverage(latestTimestamp, sequence) {
    const { error } = await this.supabase.from("book_heatmap_collector_coverage").upsert({
      venue: this.venue, market_kind: this.marketKind, symbol: this.symbol,
      state: "LIVE", latest_timestamp: new Date(latestTimestamp).toISOString(),
      ...(this.coverageStartedAt === null ? {} : { earliest_timestamp: new Date(this.coverageStartedAt).toISOString() }),
      frame_count: this.totalFrames, last_sequence: String(sequence), last_heartbeat_at: new Date().toISOString(),
      metadata: { chunkStart: this.chunkStart, cadenceMs: 1_000, sequenceVerified: true }
    }, { onConflict: "venue,market_kind,symbol" });
    if (error) throw error;
  }

  async setState(state, diagnostics = {}) {
    const { error } = await this.supabase.from("book_heatmap_collector_coverage").upsert({
      venue: this.venue, market_kind: this.marketKind, symbol: this.symbol, state,
      gap_count: Number(diagnostics.gapCount) || 0, last_sequence: diagnostics.lastUpdateId === null ? null : String(diagnostics.lastUpdateId),
      last_heartbeat_at: new Date().toISOString(), metadata: diagnostics
    }, { onConflict: "venue,market_kind,symbol" });
    if (error) throw error;
  }

  async initializeCoverage(firstTimestamp) {
    if (this.coverageInitialized) return;
    const { data } = await this.supabase.from("book_heatmap_collector_coverage")
      .select("earliest_timestamp,frame_count").eq("venue", this.venue).eq("market_kind", this.marketKind).eq("symbol", this.symbol)
      .maybeSingle();
    this.coverageStartedAt = data?.earliest_timestamp ? Date.parse(data.earliest_timestamp) : firstTimestamp;
    this.totalFrames = Number(data?.frame_count) || 0;
    this.coverageInitialized = true;
  }

  async prune() {
    const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
    const { error } = await this.supabase.from("book_heatmap_depth_chunks")
      .delete().eq("venue", this.venue).eq("market_kind", this.marketKind).eq("symbol", this.symbol).lt("chunk_end", cutoff);
    if (error) throw error;
    this.lastPruneAt = Date.now();
  }
}

export function decodeHistoricalFrameChunk(payload) {
  const bytes = decodeBytea(payload);
  const decoded = JSON.parse(gunzipSync(bytes).toString("utf8"));
  if (decoded?.version !== 1 || !Array.isArray(decoded.frames)) throw new Error("Unsupported historical heatmap chunk.");
  return decoded.frames.map(expandFrame);
}

function compactFrame(frame) {
  return [
    frame.timestamp, frame.sequence, frame.midPrice, frame.bestBid, frame.bestAsk, frame.priceBucketSize,
    frame.bids.map((level) => [level.priceBucket, level.quantity, level.notional]),
    frame.asks.map((level) => [level.priceBucket, level.quantity, level.notional])
  ];
}

function expandFrame(frame) {
  return {
    timestamp: Number(frame[0]), sequence: Number(frame[1]), midPrice: Number(frame[2]),
    bestBid: Number(frame[3]), bestAsk: Number(frame[4]), priceBucketSize: Number(frame[5]),
    bids: (frame[6] || []).map((level) => ({ priceBucket: Number(level[0]), quantity: Number(level[1]), notional: Number(level[2]) })),
    asks: (frame[7] || []).map((level) => ({ priceBucket: Number(level[0]), quantity: Number(level[1]), notional: Number(level[2]) }))
  };
}

function decodeBytea(payload) {
  if (Buffer.isBuffer(payload)) return payload;
  const value = String(payload || "");
  if (value.startsWith("\\x")) return Buffer.from(value.slice(2), "hex");
  return Buffer.from(value, "base64");
}
