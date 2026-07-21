import crypto from "node:crypto";
import {
  applyCors,
  decryptCredentialPayload,
  getOwnedAccount,
  requireFields,
  requireMethod,
  requireUser,
  sendError
} from "../../portfolio-api.js";
import { normalizeBybitPermissionReport, validateBybitCredentials } from "../../exchanges/bybit.js";
import { storeBrokerCredential } from "../../cloud-execution/secret-vault.js";

const CONFIRMATION = "ENABLE OFFLINE CLOUD EXECUTION";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    requireMethod(req, "POST");
    const { supabase, user } = await requireUser(req);
    requireFields(req.body, ["accountId", "confirmation"]);
    if (req.body.confirmation !== CONFIRMATION) {
      const error = new Error(`Explicit confirmation is required: ${CONFIRMATION}`);
      error.statusCode = 400;
      throw error;
    }
    if (process.env.CLOUD_EXECUTION_CONTROL_PLANE_ENABLED !== "true") {
      const error = new Error("Black Cloud connection activation is disabled by rollout policy.");
      error.statusCode = 403;
      throw error;
    }

    const account = await getOwnedAccount(supabase, user.id, req.body.accountId);
    if (account.exchange !== "bybit") {
      const error = new Error("Only the Bybit cloud adapter is available in the current certification stage.");
      error.statusCode = 501;
      throw error;
    }
    const { data: legacyCredential, error: credentialError } = await supabase
      .from("exchange_credentials")
      .select("encrypted_payload")
      .eq("account_id", account.id)
      .single();
    if (credentialError || !legacyCredential) throw credentialError || new Error("The existing broker credential could not be migrated.");
    const credentials = decryptCredentialPayload(legacyCredential.encrypted_payload);
    credentials.network = account.network || credentials.network || "mainnet";
    const validation = await validateBybitCredentials(credentials);
    const permissionReport = normalizeBybitPermissionReport(validation.diagnostics?.apiKeyInfo || {});
    if (permissionReport.withdrawal) {
      const error = new Error("Withdrawal-enabled Bybit credentials cannot be activated for Black Cloud execution.");
      error.statusCode = 403;
      throw error;
    }
    if (!permissionReport.trading) {
      const error = new Error("The Bybit credential does not have trading permission.");
      error.statusCode = 403;
      throw error;
    }

    const connectionKey = `cloud:bybit:${account.id}`;
    const connectionPayload = {
      user_id: user.id,
      connection_key: connectionKey,
      category: "centralized-exchange",
      provider: "bybit",
      label: account.account_name || "Bybit Cloud",
      status: "connected",
      account_id: account.id,
      account_reference: maskAccountReference(account.account_name),
      account_type: "unified",
      market_scope: ["spot", "perpetual"],
      connection_mode: "CLOUD_DELEGATED",
      execution_capability: "CLOUD_EXECUTION",
      authorization_type: "trade_only_api_credential",
      health_status: "RECONCILING",
      lifecycle_status: "VALIDATING",
      control_state: "ACTIVE",
      last_authenticated_at: new Date().toISOString(),
      capabilities: ["read-balances", "read-positions", "read-orders", "market-orders", "limit-orders", "offline-execution", "group-orders"],
      permissions: { trading: true, withdrawal: false },
      metadata: { network: account.network || "mainnet", activation: "explicit-user-consent" }
    };
    const { data: connection, error: connectionError } = await supabase
      .from("connectivity_connections")
      .upsert(connectionPayload, { onConflict: "user_id,connection_key" })
      .select("*")
      .single();
    if (connectionError) throw connectionError;

    const supportedOrderTypes = ["MARKET", "LIMIT", "CONDITIONAL"];
    const { error: capabilityError } = await supabase.from("broker_connection_capabilities").upsert({
      connection_id: connection.id,
      user_id: user.id,
      can_read_balances: true,
      can_read_positions: true,
      can_read_orders: true,
      can_place_market_orders: true,
      can_place_limit_orders: true,
      can_modify_orders: true,
      can_cancel_orders: true,
      can_place_stop_orders: true,
      can_manage_leverage: true,
      can_manage_margin_mode: true,
      can_execute_while_offline: true,
      can_copy_trade: true,
      can_receive_group_orders: true,
      can_withdraw: false,
      can_transfer: false,
      supported_order_types: supportedOrderTypes,
      supported_market_types: ["SPOT", "PERPETUAL"]
    }, { onConflict: "connection_id" });
    if (capabilityError) throw capabilityError;

    const secretReference = await storeBrokerCredential(supabase, {
      userId: user.id,
      connectionId: connection.id,
      provider: "bybit",
      secret: credentials,
      publicIdentifier: credentials.apiKey,
      authorizationType: "trade_only_api_credential",
      permissionScope: { trading: true, withdrawal: false, products: ["spot", "perpetual"], network: credentials.network },
      withdrawalEnabled: false
    });

    const { error: auditError } = await supabase.from("execution_audit_events").insert({
      user_id: user.id, connection_id: connection.id, event_type: "CONNECTION_CREATED", severity: "INFO",
      operation_purpose: "broker_connection_activation", message: "A trade-only broker connection was delegated to Black Cloud.",
      safe_metadata: { provider: "bybit", withdrawalPermission: false, connectionMode: connection.connection_mode }
    });
    if (auditError) throw auditError;

    await supabase.from("execution_commands").upsert({
      command_type: "SYNC_ACCOUNT",
      user_id: user.id,
      connection_id: connection.id,
      idempotency_key: crypto.createHash("sha256").update(`activate:${connection.id}:${secretReference.credentialVersion}`).digest("hex"),
      payload: { symbol: "BTCUSDT", marketKind: "perpetual", reason: "cloud-activation" },
      status: "QUEUED",
      priority: 10
    }, { onConflict: "idempotency_key", ignoreDuplicates: true });

    return res.status(200).json({
      connection: safeConnection(connection),
      secretReference,
      offlineExecution: "PENDING_RECONCILIATION",
      withdrawalPermission: "NONE",
      readinessReason: "Black Cloud must complete the first account reconciliation before mandates can activate."
    });
  } catch (error) {
    return sendError(res, error);
  }
}

function safeConnection(row) {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    connectionMode: row.connection_mode,
    executionCapability: row.execution_capability,
    healthStatus: row.health_status,
    accountReference: row.account_reference,
    lastAuthenticatedAt: row.last_authenticated_at
  };
}

function maskAccountReference(value) {
  const text = String(value || "Bybit account");
  return text.length <= 6 ? text : `${text.slice(0, 3)}...${text.slice(-3)}`;
}
