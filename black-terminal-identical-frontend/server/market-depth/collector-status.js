import os from "node:os";

const HEARTBEAT_VERSION = 1;

export async function upsertCollectorHeartbeat(supabase, collectorId, diagnostics) {
  const now = new Date().toISOString();
  const symbols = diagnostics.map((item) => ({
    venue: item.venue,
    marketKind: item.marketKind,
    symbol: item.symbol,
    status: item.status,
    lastMessageAt: item.lastMessageAt,
    packetLossCount: item.packetLossCount,
    reconnects: item.reconnects
  }));
  const healthy = diagnostics.length > 0 && diagnostics.every((item) => item.status === "open" || item.lastMessageAt);
  const { error } = await supabase
    .from("market_depth_collector_status")
    .upsert({
      collector_id: collectorId,
      status: healthy ? "online" : "degraded",
      symbols,
      diagnostics,
      last_heartbeat_at: now,
      updated_at: now
    }, { onConflict: "collector_id" });
  if (error) throw error;
  await upsertIMMWorkerHeartbeats(supabase, collectorId, diagnostics, now).catch(() => null);
  return { collectorId, status: healthy ? "online" : "degraded", lastHeartbeatAt: now };
}

export async function readCollectorStatus(supabase) {
  const { data, error } = await supabase
    .from("market_depth_collector_status")
    .select("collector_id,status,symbols,diagnostics,last_heartbeat_at,started_at,updated_at")
    .order("last_heartbeat_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data || []).map((row) => ({
    collectorId: row.collector_id,
    status: staleStatus(row.status, row.last_heartbeat_at),
    symbols: row.symbols || [],
    diagnostics: row.diagnostics || [],
    lastHeartbeatAt: row.last_heartbeat_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at
  }));
}

export async function readIMMWorkerHeartbeats(supabase) {
  const { data, error } = await supabase
    .from("imm_worker_heartbeats")
    .select("id,worker_instance_id,hostname,process_id,version,venue,market_kind,symbol,status,started_at,heartbeat_at,last_message_at,last_persist_at,reconnect_count,sequence_gap_count,metadata")
    .order("heartbeat_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data || []).map((row) => ({
    id: row.id,
    workerInstanceId: row.worker_instance_id,
    hostname: row.hostname,
    processId: row.process_id,
    version: row.version,
    venue: row.venue,
    marketKind: row.market_kind,
    symbol: row.symbol,
    status: staleStatus(row.status, row.heartbeat_at),
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    lastMessageAt: row.last_message_at,
    lastPersistAt: row.last_persist_at,
    reconnectCount: row.reconnect_count,
    sequenceGapCount: row.sequence_gap_count,
    metadata: row.metadata || {}
  }));
}

function staleStatus(status, lastHeartbeatAt) {
  const ageMs = Date.now() - Date.parse(lastHeartbeatAt || 0);
  if (!Number.isFinite(ageMs) || ageMs > 120_000) return "stale";
  return status || "unknown";
}

async function upsertIMMWorkerHeartbeats(supabase, collectorId, diagnostics, heartbeatAt) {
  if (!diagnostics.length) return;
  const hostname = os.hostname();
  const rows = diagnostics.map((item) => ({
    id: `${collectorId}:${item.venue}:${item.marketKind}:${item.symbol}`,
    worker_instance_id: collectorId,
    hostname,
    process_id: process.pid,
    version: HEARTBEAT_VERSION,
    venue: item.venue,
    market_kind: item.marketKind,
    symbol: item.symbol,
    status: statusForDiagnostic(item),
    heartbeat_at: heartbeatAt,
    last_message_at: item.lastMessageAt ? new Date(item.lastMessageAt).toISOString() : null,
    last_persist_at: item.lastPersistAt ? new Date(item.lastPersistAt).toISOString() : null,
    reconnect_count: Number(item.reconnects) || 0,
    sequence_gap_count: Number(item.packetLossCount) || 0,
    metadata: {
      source: "black-core-depth-worker",
      sampleCount: item.sampleCount || 0,
      ingestCount: item.ingestCount || 0,
      snapshotRecoveryCount: item.snapshotRecoveryCount || 0,
      snapshotRebuildCount: item.snapshotRebuildCount || 0,
      invalidBookCount: item.invalidBookCount || 0,
      rejectedUpdateCount: item.rejectedUpdateCount || 0,
      duplicateUpdateCount: item.duplicateUpdateCount || 0,
      lastSnapshotAt: item.lastSnapshotAt || null,
      lastIntegrityFailureAt: item.lastIntegrityFailureAt || null,
      lastSequence: item.lastSequence ?? null,
      reconstructionState: item.reconstructionState || null,
      lastError: item.lastError || null
    }
  }));
  const { error } = await supabase
    .from("imm_worker_heartbeats")
    .upsert(rows, { onConflict: "id" });
  if (error) throw error;
}

function statusForDiagnostic(item) {
  if (item.status === "open" && item.lastMessageAt) return "healthy";
  if (item.status === "connecting") return "reconnecting";
  if (item.status === "closed") return "stale";
  if (item.status === "error") return "error";
  return "degraded";
}
