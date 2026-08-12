import { applyCors, decryptCredentialPayload, getOwnedAccount, requireFields, requireMethod, requireUser, sendError } from "../../portfolio-api.js";
import { createCloudExchangeAdapter } from "../../cloud-execution/adapters/registry.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  const startedAt = Date.now();
  try {
    requireMethod(req, "POST");
    requireFields(req.body, ["accountId"]);
    const { supabase, user } = await requireUser(req);
    const account = await getOwnedAccount(supabase, user.id, req.body.accountId);
    const { data: credential, error } = await supabase.from("exchange_credentials").select("encrypted_payload").eq("account_id", account.id).single();
    if (error || !credential) throw Object.assign(new Error("Encrypted broker credentials are unavailable."), { statusCode: 404, code: "BROKER_CREDENTIAL_MISSING" });
    const credentials = decryptCredentialPayload(credential.encrypted_payload);

    const adapter = createCloudExchangeAdapter(account.exchange, {
      credentials,
      network: account.network,
      executionEnvironment: account.execution_environment,
      endpointProfile: account.endpoint_profile,
      connectionId: account.id
    });
    const [probe, healthResult, cloudResult] = await Promise.all([
      adapter.healthCheck(),
      supabase.from("connection_health_snapshots").select("*").eq("user_id", user.id).eq("account_id", account.id).order("captured_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("connectivity_connections").select("*").eq("user_id", user.id).eq("account_id", account.id).order("created_at", { ascending: false }).limit(1).maybeSingle()
    ]);
    const permissions = probe.permissions;
    const execution = probe.executionPolicy;
    const latestHealth = healthResult.data || null;
    const cloud = cloudResult.data || null;
    const heartbeatAt = cloud?.last_heartbeat_at ? Date.parse(cloud.last_heartbeat_at) : 0;
    const cloudFresh = !cloud || heartbeatAt > 0 && Date.now() - heartbeatAt < 90_000;
    const privateStream = cloud
      ? cloud.worker_state === "LIVE" && cloudFresh ? "connected" : cloud.worker_state === "RECONNECTING" ? "disconnected" : "disconnected"
      : latestHealth?.private_stream || "unknown";
    const synchronization = cloud
      ? cloud.synchronization_state === "SYNCHRONIZED" ? "synced" : cloud.synchronization_state === "STALE" ? "stale" : "syncing"
      : account.last_synced_at ? "synced" : "unknown";
    const executionReady = Boolean(execution.tradingEnabled && synchronization === "synced" && privateStream === "connected" && (!cloud || cloud.execution_readiness === "READY"));
    const lifecycle = executionReady
      ? "CONNECTED_TRADING"
      : !permissions.trading ? "CONNECTED_READ_ONLY"
      : synchronization === "stale" ? "DEGRADED"
      : "EXECUTION_BLOCKED";
    const readinessReason = executionReady ? null : [
      execution.readinessReason,
      synchronization !== "synced" ? "Authoritative account synchronization is not current." : "",
      privateStream !== "connected" ? "The authenticated private stream is not connected." : "",
      cloud && cloud.execution_readiness !== "READY" ? `Black Cloud execution readiness is ${cloud.execution_readiness}.` : ""
    ].filter(Boolean).join(" ");
    const latencyMs = Date.now() - startedAt;

    await supabase.from("exchange_accounts").update({
      status: "connected", api_health: "healthy", latency_ms: latencyMs,
      permissions: execution.permissions, trading_enabled: execution.tradingEnabled,
      is_read_only: execution.readOnly, permission_snapshot: permissions.snapshot,
      permission_verified_at: new Date().toISOString()
    }).eq("id", account.id).eq("user_id", user.id);

    return res.status(200).json({
      lifecycle,
      latencyMs,
      authentication: "authenticated",
      synchronization,
      privateStream,
      publicStream: latestHealth?.public_stream || "connected",
      permissions: { read: permissions.read, trading: permissions.trading, withdrawal: permissions.withdrawal, warnings: permissions.warnings || [] },
      clockSkewMs: probe.clockSkewMs,
      lastSuccessfulHeartbeat: Date.now(),
      executionReady,
      readinessReason
    });
  } catch (error) {
    if (!error.code) error.code = classifyHealthError(error);
    return sendError(res, error);
  }
}

function classifyHealthError(error) {
  const code = Number(error?.bybit?.retCode);
  if (code === 10003) return "INVALID_API_KEY";
  if (code === 10004) return "INVALID_SIGNATURE";
  if (code === 10005) return "INSUFFICIENT_PERMISSIONS";
  if (code === 10006) return "RATE_LIMITED";
  if (code === 10010) return "IP_RESTRICTION";
  if (error?.statusCode === 504) return "NETWORK_TIMEOUT";
  return "BROKER_UNAVAILABLE";
}
