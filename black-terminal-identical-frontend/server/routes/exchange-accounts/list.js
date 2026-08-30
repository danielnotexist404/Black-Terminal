import { applyCors, requireMethod, requireUser, sendError, toCamelAccount } from "../../portfolio-api.js";
import { derivePersistedConnectionLifecycle } from "../../exchanges/connection-lifecycle.js";
import { listBrokerAdapterDefinitions } from "../../exchanges/broker-adapter-registry.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    requireMethod(req, "GET");
    const { supabase, user } = await requireUser(req);
    const { data: accounts, error } = await supabase
      .from("exchange_accounts")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true });
    if (error) throw error;

    const accountIds = (accounts || []).map((account) => account.id);
    const [riskResult, healthResult, cloudResult] = accountIds.length
      ? await Promise.all([
          supabase.from("account_risk_controls").select("*").in("account_id", accountIds),
          supabase.from("connection_health_snapshots").select("*").eq("user_id", user.id).in("account_id", accountIds).order("captured_at", { ascending: false }).limit(Math.min(500, accountIds.length * 10)),
          supabase.from("connectivity_connections").select("*").eq("user_id", user.id).in("account_id", accountIds).order("created_at", { ascending: false })
        ])
      : [{ data: [] }, { data: [] }, { data: [] }];

    if (riskResult.error) throw riskResult.error;
    // Older deployments may not yet include the optional health/cloud tables.
    const risks = new Map((riskResult.data || []).map((row) => [row.account_id, row]));
    const health = firstByAccount(healthResult.data || []);
    const cloud = firstByAccount(cloudResult.data || []);

    const connections = (accounts || []).map((account) => {
      const latestHealth = health.get(account.id) || null;
      const cloudConnection = cloud.get(account.id) || null;
      return {
        account: toCamelAccount(account, risks.get(account.id) || null),
        workspaceScope: cloudConnection ? "STRATEGY_LAB" : "PERSONAL",
        lifecycle: derivePersistedConnectionLifecycle(account, latestHealth, cloudConnection),
        health: sanitizeHealth(latestHealth),
        cloud: sanitizeCloud(cloudConnection)
      };
    });

    return res.status(200).json({ connections, adapters: listBrokerAdapterDefinitions() });
  } catch (error) {
    return sendError(res, error);
  }
}

function firstByAccount(rows) {
  const map = new Map();
  for (const row of rows) if (row.account_id && !map.has(row.account_id)) map.set(row.account_id, row);
  return map;
}

function sanitizeHealth(row) {
  if (!row) return null;
  return {
    readiness: row.readiness,
    publicStream: row.public_stream,
    privateStream: row.private_stream,
    authentication: row.authentication,
    synchronization: row.synchronization,
    latencyMs: Number(row.latency_ms || 0),
    reconnectCount: Number(row.reconnect_count || 0),
    rateLimitUsage: row.rate_limit_usage || null,
    capturedAt: row.captured_at
  };
}

function sanitizeCloud(row) {
  if (!row) return null;
  return {
    id: row.id,
    lifecycleStatus: row.lifecycle_status,
    credentialState: row.credential_state,
    synchronizationState: row.synchronization_state,
    executionReadiness: row.execution_readiness,
    workerState: row.worker_state,
    lastHeartbeatAt: row.last_heartbeat_at,
    lastErrorCode: row.last_error_code
  };
}
