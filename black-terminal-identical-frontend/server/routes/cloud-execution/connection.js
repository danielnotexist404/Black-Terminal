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
import { hashCanonicalPayload, signCanonicalPayload } from "../../cloud-execution/canonical.js";
import { BYBIT_EXECUTION_ENVIRONMENTS, normalizeBybitExecutionEnvironment, resolveBybitEndpointSet } from "../../exchanges/bybit-endpoints.js";

const CONFIRMATION = "ENABLE OFFLINE CLOUD EXECUTION";
const LIVE_CONFIRMATION = "ENABLE LIVE BYBIT EXECUTION";

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
    const executionEnvironment = normalizeBybitExecutionEnvironment(account.execution_environment || account.network);
    const endpointSet = resolveBybitEndpointSet({ executionEnvironment, endpointProfile: account.endpoint_profile || "GLOBAL" });
    if (executionEnvironment === BYBIT_EXECUTION_ENVIRONMENTS.MAINNET_LIVE && req.body.liveConfirmation !== LIVE_CONFIRMATION) {
      throw Object.assign(new Error(`Mainnet Live activation requires explicit confirmation: ${LIVE_CONFIRMATION}`), { statusCode: 400 });
    }
    const { data: legacyCredential, error: credentialError } = await supabase
      .from("exchange_credentials")
      .select("encrypted_payload")
      .eq("account_id", account.id)
      .single();
    if (credentialError || !legacyCredential) throw credentialError || new Error("The existing broker credential could not be migrated.");
    const credentials = decryptCredentialPayload(legacyCredential.encrypted_payload);
    credentials.network = executionEnvironment === BYBIT_EXECUTION_ENVIRONMENTS.DEMO ? "demo" : "mainnet";
    credentials.executionEnvironment = executionEnvironment;
    credentials.endpointProfile = endpointSet.region;
    const validation = await validateBybitCredentials(credentials);
    const permissionReport = normalizeBybitPermissionReport(validation.diagnostics?.apiKeyInfo || {});
    if (permissionReport.withdrawal) {
      const error = new Error("Withdrawal-enabled Bybit credentials cannot be activated for Black Cloud execution.");
      error.statusCode = 403;
      throw error;
    }
    if (permissionReport.transfer) {
      const error = new Error("Wallet-transfer-enabled Bybit credentials cannot be activated for Black Cloud execution.");
      error.statusCode = 403;
      throw error;
    }
    if (!permissionReport.trading) {
      const error = new Error("The Bybit credential does not have trading permission.");
      error.statusCode = 403;
      throw error;
    }

    if (!permissionReport.accountUid || String(account.broker_account_uid || permissionReport.accountUid) !== permissionReport.accountUid) {
      const error = new Error("Bybit account UID verification failed or changed since the account was connected.");
      error.statusCode = 403;
      throw error;
    }

    const connectionKey = `cloud:bybit:${executionEnvironment}:${account.id}`;
    const connectionPayload = {
      user_id: user.id,
      connection_key: connectionKey,
      category: "centralized-exchange",
      provider: "bybit",
      label: account.account_name || "Bybit Cloud",
      // REST credential verification is not persistent-stream readiness. The
      // supervisor promotes the connection only after authentication and sync.
      status: "degraded",
      account_id: account.id,
      account_reference: maskAccountReference(account.account_name),
      account_type: "unified",
      market_scope: ["spot", "perpetual"],
      connection_mode: "CLOUD_DELEGATED",
      execution_capability: "CLOUD_EXECUTION",
      authorization_type: "trade_only_api_credential",
      health_status: "RECONCILING",
      lifecycle_status: "VALIDATING",
      credential_state: "VERIFYING",
      worker_state: "OFFLINE",
      synchronization_state: "NOT_SYNCHRONIZED",
      execution_readiness: "BLOCKED",
      control_state: "ACTIVE",
      last_authenticated_at: new Date().toISOString(),
      capabilities: ["read-balances", "read-positions", "read-orders", "market-orders", "limit-orders", "offline-execution", "group-orders"],
      permissions: { trading: true, withdrawal: false },
      execution_environment: executionEnvironment,
      endpoint_profile: endpointSet.region,
      broker_account_uid: permissionReport.accountUid,
      permission_snapshot: permissionReport.snapshot,
      certification_state: "PERMISSIONS_VERIFIED",
      metadata: {
        network: account.network,
        executionEnvironment,
        endpointProfile: endpointSet.region,
        websocketOrderEntrySupported: endpointSet.websocketOrderEntrySupported,
        activation: "explicit-user-consent"
      }
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
      executionEnvironment,
      secret: credentials,
      publicIdentifier: credentials.apiKey,
      authorizationType: "trade_only_api_credential",
      permissionScope: { ...permissionReport.snapshot, trading: true, withdrawal: false, walletTransfer: false, products: ["spot", "perpetual"] },
      permissionSnapshot: permissionReport.snapshot,
      transferEnabled: false,
      withdrawalEnabled: false
    });
    const automationMandate = await createAutomationMandate(supabase, user.id, account, connection, {
      ...(req.body.automation || {}),
      executionEnvironment,
      liveConfirmation: req.body.liveConfirmation
    });

    const { error: auditError } = await supabase.from("execution_audit_events").insert({
      user_id: user.id, connection_id: connection.id, event_type: "CONNECTION_CREATED", severity: "INFO",
      operation_purpose: "broker_connection_activation", message: "A trade-only broker connection was delegated to Black Cloud.",
      safe_metadata: { provider: "bybit", executionEnvironment, endpointProfile: endpointSet.region, withdrawalPermission: false, transferPermission: false, connectionMode: connection.connection_mode }
    });
    if (auditError) throw auditError;

    const { error: syncQueueError } = await supabase.from("execution_commands").upsert({
      command_type: "SYNC_ACCOUNT",
      user_id: user.id,
      connection_id: connection.id,
      idempotency_key: crypto.createHash("sha256").update(`activate:${connection.id}:${secretReference.credentialVersion}`).digest("hex"),
      payload: { symbol: "BTCUSDT", marketKind: "perpetual", executionEnvironment, reason: "cloud-activation" },
      status: "QUEUED",
      priority: 10
    }, { onConflict: "idempotency_key", ignoreDuplicates: true });
    if (syncQueueError) throw syncQueueError;

    return res.status(200).json({
      connection: safeConnection(connection),
      secretReference,
      automationMandate: safeAutomationMandate(automationMandate),
      offlineExecution: "PENDING_RECONCILIATION",
      withdrawalPermission: "NONE",
      transferPermission: "NONE",
      executionEnvironment,
      environmentTruth: executionEnvironment === BYBIT_EXECUTION_ENVIRONMENTS.DEMO
        ? ["BYBIT DEMO", "SIMULATED FUNDS", "MAINNET PUBLIC MARKET DATA", "SIMULATED EXECUTION"]
        : ["BYBIT MAINNET LIVE", "REAL FUNDS", "REAL EXECUTION"],
      readinessReason: "Automation is authorized; Black Cloud must complete its first account reconciliation before execution becomes ready."
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
    credentialState: row.credential_state || "VERIFYING",
    workerState: row.worker_state || "OFFLINE",
    synchronizationState: row.synchronization_state || "NOT_SYNCHRONIZED",
    executionReadiness: row.execution_readiness || "BLOCKED",
    executionEnvironment: row.execution_environment,
    endpointProfile: row.endpoint_profile,
    certificationState: row.certification_state,
    accountUidVerified: Boolean(row.broker_account_uid),
    accountReference: row.account_reference,
    lastAuthenticatedAt: row.last_authenticated_at
  };
}

async function createAutomationMandate(supabase, userId, account, connection, requested) {
  const { data: risk, error: riskError } = await supabase.from("account_risk_controls").select("*").eq("account_id", account.id).maybeSingle();
  if (riskError) throw riskError;
  const { data: latest, error: latestError } = await supabase.from("broker_automation_mandates")
    .select("mandate_version")
    .eq("connection_id", connection.id)
    .order("mandate_version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) throw latestError;
  const { data: latestRiskPolicy, error: latestRiskPolicyError } = await supabase.from("broker_risk_policy_versions")
    .select("policy_version")
    .eq("connection_id", connection.id)
    .order("policy_version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestRiskPolicyError) throw latestRiskPolicyError;
  const version = Number(latest?.mandate_version || 0) + 1;
  const riskPolicyVersion = Number(latestRiskPolicy?.policy_version || 0) + 1;
  const acceptedAt = new Date().toISOString();
  const expiresAt = requested.expiresAt || null;
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) throw Object.assign(new Error("Automation mandate expiry must be in the future."), { statusCode: 400 });
  const policy = {
    userId,
    connectionId: connection.id,
    broker: connection.provider,
    accountReference: connection.account_reference || maskAccountReference(account.account_name),
    subaccountReference: null,
    allowRead: true,
    allowTrade: true,
    allowCancel: true,
    allowModify: true,
    allowStrategyExecution: requested.allowStrategyExecution !== false,
    allowCopyTrading: requested.allowCopyTrading === true,
    allowInvestmentGroupExecution: requested.allowInvestmentGroupExecution === true,
    allowWithdrawals: false,
    executionEnvironment: requested.executionEnvironment,
    maxOrderNotional: nullablePositive(requested.maxOrderNotional),
    maxPositionNotional: nullablePositive(requested.maxPositionNotional),
    maxLeverage: nullablePositive(requested.maxLeverage),
    maxDailyLoss: nullablePositive(requested.maxDailyLoss),
    allowedStrategies: requested.allowedStrategies || [],
    allowedSymbols: requested.allowedSymbols || risk?.allowed_symbols || [],
    emergencyPolicy: { preserveProtectiveOrders: requested.preserveProtectiveOrders !== false },
    status: "ACTIVE",
    mandateVersion: version,
    riskPolicyVersion,
    policyVersion: "black-cloud-mandate-v1",
    securityVersion: "security-fortress-v1",
    acceptedAt,
    expiresAt
  };
  const canonicalHash = hashCanonicalPayload(policy);
  const serviceSignature = signCanonicalPayload(policy);
  const consentEvidence = {
    confirmation: CONFIRMATION,
    liveConfirmation: requested.executionEnvironment === BYBIT_EXECUTION_ENVIRONMENTS.MAINNET_LIVE ? requested.liveConfirmation : null,
    executionEnvironment: requested.executionEnvironment,
    acceptedAt,
    persistentAfterLogout: true
  };
  const riskPolicy = {
    maxOrderNotional: policy.maxOrderNotional,
    maxPositionNotional: policy.maxPositionNotional,
    maxLeverage: policy.maxLeverage,
    maxDailyLoss: policy.maxDailyLoss,
    allowedSymbols: policy.allowedSymbols,
    optionalCapsDisabled: ["maxOrderNotional", "maxPositionNotional", "maxLeverage", "maxDailyLoss"].filter((key) => policy[key] === null),
    mandatoryControls: ["NO_WITHDRAWALS", "NO_TRANSFERS", "OMS_EMS", "BROKER_METADATA", "OWNERSHIP", "MANDATE", "FENCING", "IDEMPOTENCY", "RECONCILIATION"]
  };
  const { data, error } = await supabase.rpc("black_cloud_activate_automation_mandate_v2", {
    p_user_id: userId,
    p_connection_id: connection.id,
    p_policy: policy,
    p_canonical_hash: canonicalHash,
    p_service_signature: serviceSignature,
    p_consent_evidence: consentEvidence,
    p_risk_policy: riskPolicy,
    p_risk_canonical_hash: hashCanonicalPayload(riskPolicy),
    p_risk_service_signature: signCanonicalPayload(riskPolicy)
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

function safeAutomationMandate(row) {
  return {
    id: row.id,
    connectionId: row.connection_id,
    status: row.status,
    version: row.mandate_version,
    allowStrategyExecution: row.allow_strategy_execution,
    allowCopyTrading: row.allow_copy_trading,
    allowInvestmentGroupExecution: row.allow_investment_group_execution,
    withdrawalPermission: "NONE",
    executionEnvironment: row.execution_environment,
    maxOrderNotional: nullableNumber(row.max_order_notional),
    maxPositionNotional: nullableNumber(row.max_position_notional),
    maxLeverage: nullableNumber(row.max_leverage),
    maxDailyLoss: nullableNumber(row.max_daily_loss),
    expiresAt: row.expires_at
  };
}

function nullablePositive(value) {
  const candidate = Number(value);
  return Number.isFinite(candidate) && candidate > 0 ? candidate : null;
}

function nullableNumber(value) { return value === null || value === undefined ? null : Number(value); }

function maskAccountReference(value) {
  const text = String(value || "Bybit account");
  return text.length <= 6 ? text : `${text.slice(0, 3)}...${text.slice(-3)}`;
}
