import { buildDepthDeltas, compressDepthSample } from "./compression-engine.js";
import { recordIntegrityEvent, validateNormalizedDepthSample } from "./integrity.js";
import { normalizeDepthSample } from "./normalizer.js";
import { detectWallLifecycle } from "./wall-lifecycle-engine.js";

export class MarketDepthMemoryEngine {
  constructor(options = {}) {
    this.previousSamples = new Map();
    this.wallMemory = new Map();
    this.snapshotThrottleMs = options.snapshotThrottleMs ?? 30_000;
    this.lastSnapshotAt = new Map();
  }

  async ingest(supabase, input, options = {}) {
    const sample = normalizeDepthSample(input);
    const key = memoryKey(sample);
    const previous = this.previousSamples.get(key);
    let integrityReport;
    try {
      integrityReport = validateNormalizedDepthSample(sample, previous);
      if (integrityReport.warnings.length) {
        await recordIntegrityEvent(supabase, sample, integrityReport).catch(() => null);
      }
    } catch (error) {
      await recordIntegrityEvent(supabase, sample, error.report).catch(() => null);
      throw error;
    }
    const compressed = compressDepthSample(sample, options);
    const deltas = buildDepthDeltas(previous, sample);
    const previousWalls = this.wallMemory.get(key) ?? new Map();
    const lifecycle = detectWallLifecycle(sample, compressed, previousWalls);
    this.previousSamples.set(key, sample);
    this.wallMemory.set(key, lifecycle.nextMemory);

    const persisted = await persistDepthMemory(supabase, {
      sample,
      compressed,
      deltas,
      walls: lifecycle.walls,
      events: lifecycle.events,
      shouldPersistSnapshot: shouldPersistSnapshot(this.lastSnapshotAt, key, sample.capturedAt, this.snapshotThrottleMs)
    });

    return {
      venue: sample.venue,
      marketKind: sample.marketKind,
      symbol: sample.symbol,
      capturedAt: new Date(sample.capturedAt).toISOString(),
      integrity: integrityReport,
      snapshotPersisted: persisted.snapshotPersisted,
      rollups: compressed.rollups.length,
      deltas: deltas.length,
      walls: lifecycle.walls.length,
      events: lifecycle.events.length
    };
  }
}

export async function persistDepthMemory(supabase, payload) {
  const { sample, compressed, deltas, walls, events, shouldPersistSnapshot } = payload;
  let snapshotPersisted = false;
  if (shouldPersistSnapshot) {
    await insertRows(supabase, "market_depth_snapshots", [mapSnapshot(compressed.snapshot)]);
    snapshotPersisted = true;
  }
  if (deltas.length) await insertRows(supabase, "market_depth_deltas", deltas.map(mapDelta));
  if (compressed.rollups.length) {
    await upsertRows(
      supabase,
      "market_depth_rollups",
      compressed.rollups.map(mapRollup),
      "venue,market_kind,symbol,resolution,bucket_start,price_bucket"
    );
  }
  if (compressed.statistics.length) {
    await upsertRows(
      supabase,
      "market_depth_statistics",
      compressed.statistics.map(mapStatistic),
      "venue,market_kind,symbol,resolution,bucket_start"
    );
  }
  if (walls.length) {
    await upsertRows(
      supabase,
      "market_liquidity_walls",
      walls.map(mapWall),
      "wall_key"
    );
  }
  if (events.length) await insertRows(supabase, "market_liquidity_events", events.map(mapEvent));
  return { sample, snapshotPersisted };
}

export function memoryKey(sample) {
  return [sample.venue, sample.marketKind, sample.symbol].join(":");
}

async function insertRows(supabase, table, rows) {
  if (!rows.length) return;
  const { error } = await supabase.from(table).insert(rows);
  if (error) throw error;
}

async function upsertRows(supabase, table, rows, onConflict) {
  if (!rows.length) return;
  const { error } = await supabase.from(table).upsert(rows, { onConflict });
  if (error) throw error;
}

function shouldPersistSnapshot(lastSnapshotAt, key, timestamp, throttleMs) {
  const previous = lastSnapshotAt.get(key) ?? 0;
  if (timestamp - previous < throttleMs) return false;
  lastSnapshotAt.set(key, timestamp);
  return true;
}

function mapSnapshot(row) {
  return {
    venue: row.venue,
    market_kind: row.marketKind,
    symbol: row.symbol,
    exchange_symbol: row.exchangeSymbol,
    captured_at: iso(row.capturedAt),
    source_timestamp: iso(row.sourceTimestamp),
    sequence: row.sequence === null || row.sequence === undefined ? null : String(row.sequence),
    best_bid: row.bestBid,
    best_ask: row.bestAsk,
    mid_price: row.midPrice,
    spread: row.spread,
    depth_levels: row.depthLevels,
    checksum: row.checksum,
    compression_version: row.compressionVersion,
    retention_tier: row.retentionTier,
    metadata: row.metadata
  };
}

function mapDelta(row) {
  return {
    venue: row.venue,
    market_kind: row.marketKind,
    symbol: row.symbol,
    captured_at: iso(row.capturedAt),
    side: row.side,
    price: row.price,
    quantity: row.quantity,
    delta_size: row.deltaSize,
    action: row.action,
    sequence: row.sequence === null || row.sequence === undefined ? null : String(row.sequence),
    resolution: row.resolution,
    compression_version: row.compressionVersion,
    retention_tier: row.retentionTier,
    metadata: row.metadata
  };
}

function mapRollup(row) {
  return {
    venue: row.venue,
    market_kind: row.marketKind,
    symbol: row.symbol,
    bucket_start: iso(row.bucketStart),
    bucket_end: iso(row.bucketEnd),
    resolution: row.resolution,
    price_bucket: row.priceBucket,
    bucket_size: row.bucketSize,
    bid_size: row.bidSize,
    ask_size: row.askSize,
    bid_peak_size: row.bidPeakSize,
    ask_peak_size: row.askPeakSize,
    observations: row.observations,
    liquidity_score: row.liquidityScore,
    gravity_score: row.gravityScore,
    compression_version: row.compressionVersion,
    retention_tier: row.retentionTier,
    metadata: row.metadata
  };
}

function mapStatistic(row) {
  return {
    venue: row.venue,
    market_kind: row.marketKind,
    symbol: row.symbol,
    resolution: row.resolution,
    bucket_start: iso(row.bucketStart),
    bucket_end: iso(row.bucketEnd),
    best_bid: row.bestBid,
    best_ask: row.bestAsk,
    mid_price: row.midPrice,
    spread: row.spread,
    total_bid_size: row.totalBidSize,
    total_ask_size: row.totalAskSize,
    imbalance: row.imbalance,
    liquidity_score: row.liquidityScore,
    update_count: row.updateCount,
    packet_loss_count: row.packetLossCount,
    reconnect_count: row.reconnectCount,
    latency_ms: row.latencyMs,
    metadata: row.metadata
  };
}

function mapWall(row) {
  return {
    wall_key: row.wallKey,
    venue: row.venue,
    market_kind: row.marketKind,
    symbol: row.symbol,
    side: row.side,
    status: row.status,
    first_seen_at: iso(row.firstSeenAt),
    last_seen_at: iso(row.lastSeenAt),
    current_price: row.currentPrice,
    peak_size: row.peakSize,
    current_size: row.currentSize,
    touches: row.touches,
    executed_volume: row.executedVolume,
    confidence: row.confidence,
    spoof_probability: row.spoofProbability,
    reliability_score: row.reliabilityScore,
    gravity_score: row.gravityScore,
    compression_version: row.compressionVersion,
    metadata: row.metadata
  };
}

function mapEvent(row) {
  return {
    venue: row.venue,
    market_kind: row.marketKind,
    symbol: row.symbol,
    event_type: row.eventType,
    side: row.side,
    price: row.price,
    price_bucket: row.priceBucket,
    size: row.size,
    confidence: row.confidence,
    wall_key: row.wallKey,
    occurred_at: iso(row.occurredAt),
    resolution: row.resolution,
    metadata: row.metadata
  };
}

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}
