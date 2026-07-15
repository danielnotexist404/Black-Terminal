import { decryptCredentialPayload, getSupabaseAdmin } from "../server/portfolio-api.js";
import { BybitPrivateStreamClient } from "../server/exchanges/bybit-private-stream.js";
import { syncBybitSnapshotAndReconcile } from "../server/exchanges/bybit-reconciliation.js";

const accountId = process.env.BYBIT_STREAM_ACCOUNT_ID;
const symbol = process.env.BYBIT_STREAM_SYMBOL || "BTCUSDT";

if (!accountId) {
  console.error("BYBIT_STREAM_ACCOUNT_ID is required.");
  process.exit(1);
}

const supabase = getSupabaseAdmin();
const { data: account, error: accountError } = await supabase
  .from("exchange_accounts")
  .select("*")
  .eq("id", accountId)
  .single();

if (accountError || !account) {
  console.error(accountError?.message || `Account not found: ${accountId}`);
  process.exit(1);
}

const { data: credential, error: credentialError } = await supabase
  .from("exchange_credentials")
  .select("encrypted_payload")
  .eq("account_id", account.id)
  .single();

if (credentialError || !credential) {
  console.error(credentialError?.message || `Credential not found for account: ${account.id}`);
  process.exit(1);
}

const credentials = decryptCredentialPayload(credential.encrypted_payload);
const client = new BybitPrivateStreamClient(credentials, {
  network: process.env.BYBIT_NETWORK || "mainnet"
});

let syncTimer = null;
let healthTimer = null;
let lastReconnectCount = 0;
const seenEvents = new Map();
const seenEventTtlMs = Number(process.env.BYBIT_STREAM_DEDUPE_TTL_MS || 10 * 60_000);

client.onMessage((event) => {
  if (isDuplicateEvent(event)) return;
  void auditStreamEvent(event);
  if (["order", "execution", "position", "wallet"].includes(event.type)) scheduleReconciliation();
});

client.onError((error) => {
  console.error("Bybit private stream error:", error.message);
  void supabase.from("execution_audit_logs").insert({
    user_id: account.user_id,
    account_id: account.id,
    event_type: "private_stream_error",
    severity: "error",
    message: error.message,
    metadata: { venueId: "bybit", diagnostics: client.diagnostics() }
  }).catch(() => null);
});

await supabase.from("execution_audit_logs").insert({
  user_id: account.user_id,
  account_id: account.id,
  event_type: "private_stream_connect_started",
  severity: "info",
  message: "Bybit private stream worker starting.",
  metadata: { venueId: "bybit", symbol }
}).catch(() => null);

await client.connect();
scheduleReconciliation();
healthTimer = setInterval(() => {
  void writeHealthSnapshot();
}, 15_000);
void writeHealthSnapshot();
console.log(`Bybit private stream worker connected for ${account.id}.`);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function scheduleReconciliation() {
  if (syncTimer) return;
  syncTimer = setTimeout(async () => {
    syncTimer = null;
    try {
      await syncBybitSnapshotAndReconcile(supabase, account.user_id, account, credentials, { symbol });
    } catch (error) {
      console.error("Bybit reconciliation failed:", error);
    }
  }, 750);
}

async function auditStreamEvent(event) {
  const eventType = {
    order: "private_order_update",
    execution: "private_execution_fill",
    position: "private_position_update",
    wallet: "private_wallet_update"
  }[event.type] || "private_stream_update";

  await supabase.from("execution_audit_logs").insert({
    user_id: account.user_id,
    account_id: account.id,
    event_type: eventType,
    severity: "info",
    message: `Bybit private stream ${event.type} event received.`,
    metadata: { venueId: "bybit", event }
  }).catch(() => null);
}

async function writeHealthSnapshot() {
  const diagnostics = client.diagnostics();
  const now = new Date().toISOString();
  if (diagnostics.reconnectCount > lastReconnectCount) {
    lastReconnectCount = diagnostics.reconnectCount;
    scheduleReconciliation();
  }
  await Promise.all([
    supabase.from("connection_health_snapshots").insert({
      user_id: account.user_id,
      account_id: account.id,
      venue_id: "bybit",
      provider: "bybit",
      category: "centralized-exchange",
      network: process.env.BYBIT_NETWORK || "mainnet",
      readiness: diagnostics.status === "connected" ? "synchronizing" : diagnostics.status === "stale" ? "degraded" : "reconnecting",
      execution_mode: "read-only",
      public_stream: "connected",
      private_stream: diagnostics.status,
      authentication: diagnostics.authenticated ? "authenticated" : "unknown",
      synchronization: diagnostics.stale ? "stale" : "syncing",
      latency_ms: 0,
      reconnect_count: diagnostics.reconnectCount,
      last_error: diagnostics.lastError,
      health: diagnostics,
      captured_at: now
    }),
    supabase.from("adapter_certifications").upsert({
      venue_id: "bybit",
      provider: "bybit",
      category: "centralized-exchange",
      execution_mode: "read-only",
      network: process.env.BYBIT_NETWORK || "mainnet",
      readiness: diagnostics.status === "connected" ? "connected-read-only" : "degraded",
      implementation_status: "partial",
      market_data_ready: true,
      auth_ready: diagnostics.authenticated,
      account_read_ready: true,
      balances_ready: true,
      positions_ready: true,
      open_orders_ready: true,
      fills_ready: diagnostics.authenticated && diagnostics.status === "connected",
      private_streams_ready: diagnostics.authenticated && diagnostics.status === "connected",
      supported_products: ["spot", "perpetual"],
      supported_order_types: ["market", "limit", "post-only", "reduce-only", "gtc", "ioc", "fok"],
      capabilities: { privateStreamRuntime: diagnostics },
      limitations: ["Bybit production certification still requires recorded validation evidence."],
      last_validated_at: now,
      updated_at: now
    }, { onConflict: "venue_id,network" })
  ]).catch((error) => {
    console.error("Bybit health persistence failed:", error.message);
  });
}

function isDuplicateEvent(event) {
  const key = [
    event.type,
    event.report?.orderId,
    event.fill?.fillId,
    event.position?.symbol,
    event.wallet?.asset,
    event.time
  ].filter(Boolean).join(":");
  if (!key) return false;

  const now = Date.now();
  for (const [eventKey, seenAt] of seenEvents) {
    if (now - seenAt > seenEventTtlMs) seenEvents.delete(eventKey);
  }
  if (seenEvents.has(key)) return true;
  seenEvents.set(key, now);
  return false;
}

function shutdown() {
  console.log("Stopping Bybit private stream worker...");
  if (healthTimer) clearInterval(healthTimer);
  client.disconnect();
  process.exit(0);
}
