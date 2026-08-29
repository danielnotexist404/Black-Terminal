import { activateBlackCloudConnection } from "./cloud-execution/connection.js";
import { removeOwnedExchangeAccount } from "./exchange-accounts/account.js";
import { establishDetectedBybitAccount, rotateDetectedBybitAccount } from "../exchanges/exchange-account-service.js";
import { decryptCredentialPayload, getOwnedAccount } from "../portfolio-api.js";

export async function handleStrategyConnectionRequest(req, res, security, path) {
  const clean = path.map(String).filter(Boolean);
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  if (clean.length === 0 && req.method === "GET") {
    return res.status(200).json(await listOwnedStrategyConnections(security.supabase, security.user.id));
  }
  if (clean.length === 1 && clean[0] === "connect" && req.method === "POST") {
    await assertConnectionCapacity(security.supabase, security.user.id);
    const established = await establishDetectedBybitAccount({ supabase: security.supabase, user: security.user, input: req.body });
    const account = await getOwnedAccount(security.supabase, security.user.id, established.account.id);
    const cloud = await activateBlackCloudConnection({ supabase: security.supabase, user: security.user, account });
    return res.status(201).json({
      account: established.account,
      cloud,
      publicApiKey: String(req.body.apiKey),
      apiSecretDisplay: "••••••••••••",
      persistence: "VPS_MANAGED"
    });
  }
  if (clean.length === 1 && isUuid(clean[0]) && req.method === "PATCH") {
    const connection = await ownedConnection(security.supabase, security.user.id, clean[0]);
    const account = await getOwnedAccount(security.supabase, security.user.id, connection.account_id);
    const rotated = await rotateDetectedBybitAccount({ supabase: security.supabase, user: security.user, account, input: req.body });
    const refreshedAccount = await getOwnedAccount(security.supabase, security.user.id, connection.account_id);
    const cloud = await activateBlackCloudConnection({ supabase: security.supabase, user: security.user, account: refreshedAccount });
    return res.status(200).json({
      account: rotated.account,
      cloud,
      publicApiKey: String(req.body.apiKey),
      apiSecretDisplay: "••••••••••••",
      persistence: "VPS_MANAGED"
    });
  }
  if (clean.length === 1 && isUuid(clean[0]) && req.method === "DELETE") {
    const connection = await ownedConnection(security.supabase, security.user.id, clean[0]);
    return res.status(200).json(await removeOwnedExchangeAccount({ supabase: security.supabase, user: security.user, accountId: connection.account_id }));
  }
  const error = new Error("Strategy connection route not found.");
  error.statusCode = 404;
  error.code = "STRATEGY_CONNECTION_ROUTE_NOT_FOUND";
  throw error;
}

async function assertConnectionCapacity(supabase, userId) {
  const { count, error } = await supabase.from("connectivity_connections")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("revoked_at", null)
    .is("disabled_at", null);
  if (error) throw error;
  if (Number(count || 0) < 9) return;
  const limit = new Error("The maximum of 9 persistent Strategy Lab broker connections is active. Modify or remove one before adding another.");
  limit.statusCode = 409;
  limit.code = "STRATEGY_CONNECTION_LIMIT_REACHED";
  throw limit;
}

async function listOwnedStrategyConnections(supabase, userId) {
  const { data: connections, error } = await supabase.from("connectivity_connections")
    .select("id,account_id,provider,label,health_status,lifecycle_status,credential_state,worker_state,synchronization_state,execution_readiness,execution_environment,endpoint_profile,last_authenticated_at,revoked_at,disabled_at")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .is("disabled_at", null)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const accountIds = (connections || []).map((item) => item.account_id).filter(Boolean);
  const credentials = accountIds.length
    ? await supabase.from("exchange_credentials").select("account_id,encrypted_payload").in("account_id", accountIds)
    : { data: [], error: null };
  if (credentials.error) throw credentials.error;
  const credentialMap = new Map((credentials.data || []).map((item) => [item.account_id, item.encrypted_payload]));
  const rows = [];
  for (const connection of connections || []) {
    let publicApiKey = "";
    let credentialStatus = "AVAILABLE";
    try {
      const payload = decryptCredentialPayload(credentialMap.get(connection.account_id));
      publicApiKey = String(payload?.apiKey || "");
    } catch {
      credentialStatus = "RECONNECT_REQUIRED";
    }
    rows.push({
      id: connection.id,
      accountId: connection.account_id,
      provider: String(connection.provider || "bybit").toUpperCase(),
      label: connection.label,
      publicApiKey,
      apiSecretDisplay: "••••••••••••",
      credentialStatus,
      healthStatus: connection.health_status,
      lifecycleStatus: connection.lifecycle_status,
      credentialState: connection.credential_state,
      workerState: connection.worker_state,
      synchronizationState: connection.synchronization_state,
      executionReadiness: connection.execution_readiness,
      executionEnvironment: connection.execution_environment,
      endpointProfile: connection.endpoint_profile,
      lastAuthenticatedAt: connection.last_authenticated_at,
      persistence: "VPS_MANAGED"
    });
  }
  return { connections: rows, limit: 9, testnetAccepted: false };
}

async function ownedConnection(supabase, userId, connectionId) {
  const { data, error } = await supabase.from("connectivity_connections").select("*").eq("id", connectionId).eq("user_id", userId).is("revoked_at", null).is("disabled_at", null).maybeSingle();
  if (error) throw error;
  if (!data) {
    const missing = new Error("The owned broker connection is unavailable.");
    missing.statusCode = 404;
    missing.code = "BROKER_CONNECTION_NOT_FOUND";
    throw missing;
  }
  return data;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value));
}
