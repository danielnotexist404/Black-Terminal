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

function staleStatus(status, lastHeartbeatAt) {
  const ageMs = Date.now() - Date.parse(lastHeartbeatAt || 0);
  if (!Number.isFinite(ageMs) || ageMs > 120_000) return "stale";
  return status || "unknown";
}
