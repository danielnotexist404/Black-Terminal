import { readCollectorStatus, readIMMWorkerHeartbeats } from "../market-depth/collector-status.js";

const STATUS_SCHEMA_VERSION = 1;
const STALE_MS = 120_000;

export async function getIMMSystemStatus(supabase, options = {}) {
  const started = Date.now();
  const [heartbeats, collectors, marketStats, walls, events, integrityEvents, persistenceProbe] = await Promise.all([
    readIMMWorkerHeartbeats(supabase).catch(() => []),
    readCollectorStatus(supabase).catch(() => []),
    readLatestMarketStats(supabase).catch((error) => ({ error })),
    readActiveWalls(supabase).catch((error) => ({ error })),
    readRecentEvents(supabase).catch((error) => ({ error })),
    readRecentIntegrityEvents(supabase).catch(() => []),
    probeSupabase(supabase).catch((error) => ({ error }))
  ]);

  const heartbeat = heartbeats[0] || null;
  const stat = Array.isArray(marketStats) ? marketStats[0] || null : null;
  const activeWalls = Array.isArray(walls) ? walls : [];
  const recentEvents = Array.isArray(events) ? events : [];
  const statsRows = Array.isArray(marketStats) ? marketStats : [];
  const errors = collectErrors({ marketStats, walls, events, persistenceProbe });
  const warnings = [];
  const lastMessageAt = latestTime(heartbeat?.lastMessageAt, collectorLast(collectors, "lastMessageAt"));
  const lastPersistAt = latestTime(heartbeat?.lastPersistAt, stat?.bucket_start);
  const lastSnapshotAt = latestTime(heartbeat?.metadata?.lastSnapshotAt);
  const staleForMs = lastMessageAt ? Math.max(0, Date.now() - Date.parse(lastMessageAt)) : null;
  const activeBuyWalls = activeWalls.filter((wall) => wall.side === "buy").length;
  const activeSellWalls = activeWalls.filter((wall) => wall.side === "sell").length;
  const sequenceGapCount = Number(heartbeat?.sequenceGapCount ?? stat?.packet_loss_count ?? 0);
  const reconnectCount = Number(heartbeat?.reconnectCount ?? stat?.reconnect_count ?? 0);
  const invalidBooks = Number(heartbeat?.metadata?.invalidBookCount || 0) + integrityEvents.filter((event) => event.severity === "error").length;

  if (!heartbeat && !collectors.length) warnings.push("no_worker_heartbeat");
  if (staleForMs !== null && staleForMs > STALE_MS) warnings.push("feed_stale");
  if (!lastPersistAt) warnings.push("no_recent_persistence_evidence");
  if (sequenceGapCount > 0) warnings.push("sequence_gaps_detected");
  if (invalidBooks > 0) warnings.push("integrity_failures_detected");
  if (activeBuyWalls === 0 || activeSellWalls === 0) warnings.push("wall_detection_not_symmetric_yet");

  const workerStatus = mapStatus(heartbeat?.status || collectors[0]?.status || "unavailable");
  const ingestionStatus = staleForMs === null ? "unavailable" : staleForMs > STALE_MS ? "stale" : errors.length ? "degraded" : "healthy";
  const persistenceStatus = persistenceProbe?.error ? "error" : lastPersistAt ? "healthy" : "degraded";
  const replayStatus = stat ? "healthy" : "degraded";
  const wallEngineStatus = activeWalls.length ? "healthy" : "degraded";
  const websocketStatus = mapStatus(heartbeat?.status || "unavailable");
  const overallStatus = reduceStatus([workerStatus, ingestionStatus, persistenceStatus, replayStatus, wallEngineStatus, websocketStatus], errors, warnings);

  const status = {
    status: "ok",
    source: "black-core-imm-operational-status",
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    overallStatus,
    workerStatus,
    ingestionStatus,
    persistenceStatus,
    replayStatus,
    wallEngineStatus,
    websocketStatus,
    currentVenue: heartbeat?.venue || stat?.venue || null,
    currentMarketKind: heartbeat?.marketKind || stat?.market_kind || null,
    currentSymbol: heartbeat?.symbol || stat?.symbol || null,
    workerInstanceId: heartbeat?.workerInstanceId || collectors[0]?.collectorId || null,
    workerUptimeMs: heartbeat?.startedAt ? Math.max(0, Date.now() - Date.parse(heartbeat.startedAt)) : null,
    lastMessageAt,
    lastPersistAt,
    lastSnapshotAt,
    lastReplayQueryAt: null,
    currentSequence: heartbeat?.metadata?.lastSequence ?? null,
    lastSequenceGapAt: sequenceGapCount > 0 ? heartbeat?.heartbeatAt || null : null,
    reconnectCount,
    rawBidLevels: null,
    rawAskLevels: null,
    aggregatedBidBuckets: statsRows.filter((row) => Number(row.total_bid_size) > 0).length,
    aggregatedAskBuckets: statsRows.filter((row) => Number(row.total_ask_size) > 0).length,
    activeBuyWalls,
    activeSellWalls,
    eventsLastMinute: recentEvents.length,
    storageLatencyMs: persistenceProbe?.latencyMs ?? null,
    ingestionLatencyMs: stat?.latency_ms ?? null,
    staleForMs,
    sequenceGapCount,
    invalidBookCount: invalidBooks,
    rejectedUpdateCount: Number(heartbeat?.metadata?.rejectedUpdateCount || 0),
    duplicateUpdateCount: Number(heartbeat?.metadata?.duplicateUpdateCount || 0),
    snapshotRecoveryCount: Number(heartbeat?.metadata?.snapshotRecoveryCount || 0),
    snapshotRebuildCount: Number(heartbeat?.metadata?.snapshotRebuildCount || 0),
    ingestionVersion: heartbeat?.version || 1,
    schemaVersionLabel: `imm-status-v${STATUS_SCHEMA_VERSION}`,
    errors,
    warnings,
    quality: computeQuality({ staleForMs, sequenceGapCount, invalidBooks, activeBuyWalls, activeSellWalls, lastPersistAt }),
    responseLatencyMs: Date.now() - started
  };

  if (options.verbose) {
    status.verbose = {
      heartbeats,
      collectors,
      latestMarketStats: Array.isArray(marketStats) ? marketStats : [],
      recentIntegrityEvents: integrityEvents,
      activeWalls,
      recentEvents
    };
  }

  return status;
}

async function readLatestMarketStats(supabase) {
  const { data, error } = await supabase
    .from("market_depth_statistics")
    .select("venue,market_kind,symbol,resolution,bucket_start,bucket_end,best_bid,best_ask,mid_price,spread,total_bid_size,total_ask_size,imbalance,liquidity_score,update_count,packet_loss_count,reconnect_count,latency_ms,metadata")
    .order("bucket_start", { ascending: false })
    .limit(12);
  if (error) throw error;
  return data || [];
}

async function readActiveWalls(supabase) {
  const { data, error } = await supabase
    .from("market_liquidity_walls")
    .select("wall_key,venue,market_kind,symbol,side,status,current_price,current_size,last_seen_at,reliability_score,gravity_score")
    .in("status", ["ACTIVE", "GROWING", "WEAKENING", "MIGRATING", "SPOOF_SUSPECTED"])
    .order("last_seen_at", { ascending: false })
    .limit(250);
  if (error) throw error;
  return data || [];
}

async function readRecentEvents(supabase) {
  const since = new Date(Date.now() - 60_000).toISOString();
  const { data, error } = await supabase
    .from("market_liquidity_events")
    .select("id,event_type,side,price,occurred_at,wall_key,metadata")
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(250);
  if (error) throw error;
  return data || [];
}

async function readRecentIntegrityEvents(supabase) {
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data, error } = await supabase
    .from("imm_integrity_events")
    .select("id,venue,market_kind,symbol,severity,reason,sequence,occurred_at,metadata")
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return data || [];
}

async function probeSupabase(supabase) {
  const started = Date.now();
  const { error } = await supabase
    .from("market_depth_statistics")
    .select("bucket_start")
    .limit(1);
  if (error) throw error;
  return { latencyMs: Date.now() - started };
}

function reduceStatus(statuses, errors, warnings) {
  if (errors.length) return "error";
  if (statuses.includes("misconfigured")) return "misconfigured";
  if (statuses.includes("unavailable")) return "unavailable";
  if (statuses.includes("stale")) return "stale";
  if (statuses.includes("reconnecting")) return "reconnecting";
  if (statuses.includes("degraded") || warnings.length) return "degraded";
  return "healthy";
}

function mapStatus(status) {
  const clean = String(status || "").toLowerCase();
  if (["online", "healthy", "open"].includes(clean)) return "healthy";
  if (["degraded", "closed"].includes(clean)) return "degraded";
  if (["connecting", "reconnecting"].includes(clean)) return "reconnecting";
  if (["stale"].includes(clean)) return "stale";
  if (["misconfigured"].includes(clean)) return "misconfigured";
  if (["error"].includes(clean)) return "error";
  return "unavailable";
}

function collectErrors(results) {
  return Object.entries(results)
    .filter(([, result]) => result?.error)
    .map(([name, result]) => `${name}:${result.error.message || String(result.error)}`);
}

function collectorLast(collectors, field) {
  for (const collector of collectors || []) {
    for (const diagnostic of collector.diagnostics || []) {
      if (diagnostic[field]) return diagnostic[field];
    }
  }
  return null;
}

function latestTime(...values) {
  const times = values
    .flat()
    .filter(Boolean)
    .map((value) => typeof value === "number" ? value : Date.parse(value))
    .filter(Number.isFinite);
  if (!times.length) return null;
  return new Date(Math.max(...times)).toISOString();
}

function computeQuality({ staleForMs, sequenceGapCount, invalidBooks, activeBuyWalls, activeSellWalls, lastPersistAt }) {
  let score = 100;
  if (!lastPersistAt) score -= 25;
  if (staleForMs !== null) score -= Math.min(35, staleForMs / STALE_MS * 20);
  score -= Math.min(20, sequenceGapCount * 3);
  score -= Math.min(25, invalidBooks * 5);
  if (activeBuyWalls === 0 || activeSellWalls === 0) score -= 8;
  const coverage = Math.max(0, Math.min(100, score));
  return {
    coverageScore: Number(coverage.toFixed(2)),
    sequenceIntegrityScore: Number(Math.max(0, 100 - sequenceGapCount * 2).toFixed(2)),
    bidAskBalance: activeBuyWalls > 0 && activeSellWalls > 0 ? "healthy" : "partial",
    replayConfidence: coverage >= 90 ? "high" : coverage >= 70 ? "medium" : "low"
  };
}
