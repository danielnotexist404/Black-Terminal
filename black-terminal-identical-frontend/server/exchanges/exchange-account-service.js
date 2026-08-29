import crypto from "node:crypto";
import { encryptCredentialPayload, toCamelAccount } from "../portfolio-api.js";
import { getBybitApiKeyInformation, normalizeBybitPermissionReport, resolveBybitExecutionPolicy, syncBybitAccountToSupabase, validateBybitCredentials } from "./bybit.js";
import { describeSupabaseError } from "./bybit-snapshot-store.js";
import { BYBIT_EXECUTION_ENVIRONMENTS, resolveBybitEndpointSet } from "./bybit-endpoints.js";
import { getBrokerAdapterDefinition } from "./broker-adapter-registry.js";
import { settleSupabaseQuery } from "../supabase-query.js";

export async function establishExchangeAccount({
  supabase,
  user,
  input,
  authorization = null,
  executionEnvironment: serverExecutionEnvironment = BYBIT_EXECUTION_ENVIRONMENTS.MAINNET_LIVE
}) {
  const exchange = String(input.exchange || "").trim().toLowerCase();
  const definition = getBrokerAdapterDefinition(exchange);
  if (!definition?.authorization?.apiCredentials) {
    throw typedError("ADAPTER_NOT_CERTIFIED", `${exchange} credential validation is not certified.`, 501);
  }
  const accountName = String(input.accountName || "").trim();
  if (!accountName || !input.apiKey || !input.apiSecret) throw typedError("MISSING_BROKER_CREDENTIALS", "Account name, API key and API secret are required.", 400);
  // Routing is selected by the authenticated server route. Client-provided
  // environment/region fields are ignored so hidden controls can never move a
  // credential between Bybit Demo and real-funds Mainnet.
  const endpointSet = resolveBybitEndpointSet({ executionEnvironment: serverExecutionEnvironment, endpointProfile: "GLOBAL" });
  const executionEnvironment = endpointSet.environment;
  const endpointProfile = endpointSet.region;
  const network = executionEnvironment === BYBIT_EXECUTION_ENVIRONMENTS.DEMO ? "demo" : "mainnet";
  const rawCredentials = {
    exchange,
    apiKey: String(input.apiKey),
    apiSecret: String(input.apiSecret),
    passphrase: input.passphrase ? String(input.passphrase) : undefined,
    createdAt: new Date().toISOString(),
    network,
    executionEnvironment,
    endpointProfile,
    authorization: authorization ? {
      type: "oauth",
      accessToken: authorization.accessToken,
      refreshToken: authorization.refreshToken,
      accessTokenExpiresAt: authorization.accessTokenExpiresAt,
      refreshTokenExpiresAt: authorization.refreshTokenExpiresAt
    } : { type: "api_credentials" }
  };

  await audit(supabase, { userId: user.id, eventType: "broker_connection_requested", severity: "info", message: `${exchange} connection requested.`, metadata: { exchange, executionEnvironment, endpointProfile, authorizationType: rawCredentials.authorization.type } });
  const validation = await validateBybitCredentials(rawCredentials);
  const diagnostics = validation.diagnostics;
  if (diagnostics?.permissions?.withdrawal) throw typedError("DANGEROUS_WITHDRAWAL_PERMISSION", "Withdrawal-enabled API keys are not accepted. Create a read/trade key with withdrawals disabled.", 403);
  if (diagnostics?.permissions?.transfer) throw typedError("DANGEROUS_TRANSFER_PERMISSION", "Wallet-transfer-enabled API keys are not accepted.", 403);
  if (!diagnostics?.accountUid) throw typedError("BROKER_ACCOUNT_UID_UNVERIFIED", "Bybit account UID verification did not complete.", 403);

  const executionPolicy = resolveBybitExecutionPolicy(diagnostics.permissions, { executionEnvironment });
  const fingerprint = crypto.createHash("sha256").update(rawCredentials.apiKey).digest("hex").slice(0, 32);
  const credentialRef = `exchange:${exchange}:${executionEnvironment}:${endpointProfile}:${user.id}:${fingerprint}`;
  const encryptedPayload = encryptCredentialPayload(rawCredentials);
  const accountPayload = {
    user_id: user.id, exchange, account_name: accountName, status: validation.status,
    api_health: validation.apiHealth, latency_ms: validation.latencyMs,
    permissions: executionPolicy.permissions, is_read_only: !executionPolicy.tradingEnabled,
    trading_enabled: executionPolicy.tradingEnabled, credential_ref: credentialRef,
    execution_mode: executionPolicy.tradingEnabled ? (executionEnvironment === BYBIT_EXECUTION_ENVIRONMENTS.DEMO ? "paper" : "live") : "read_only",
    network, execution_environment: executionEnvironment, endpoint_profile: endpointProfile,
    broker_account_uid: diagnostics.accountUid, permission_snapshot: diagnostics.permissionSnapshot || {},
    permission_verified_at: new Date().toISOString()
  };
  const { data: existing, error: existingError } = await supabase.from("exchange_accounts").select("*")
    .eq("user_id", user.id).eq("exchange", exchange).eq("execution_environment", executionEnvironment)
    .eq("endpoint_profile", endpointProfile).eq("credential_ref", credentialRef).maybeSingle();
  if (existingError) throw existingError;
  const accountResult = existing
    ? await supabase.from("exchange_accounts").update(accountPayload).eq("id", existing.id).eq("user_id", user.id).select("*").single()
    : await supabase.from("exchange_accounts").insert(accountPayload).select("*").single();
  if (accountResult.error) throw accountResult.error;
  const account = accountResult.data;
  const createdAccount = !existing;

  const credentialResult = await supabase.from("exchange_credentials").upsert({ account_id: account.id, encrypted_payload: encryptedPayload, key_version: 1 }, { onConflict: "account_id" });
  if (credentialResult.error) {
    if (createdAccount) await supabase.from("exchange_accounts").delete().eq("id", account.id).eq("user_id", user.id);
    throw credentialResult.error;
  }

  const riskResult = await supabase.from("account_risk_controls").upsert({
    account_id: account.id,
    read_only_mode: !executionPolicy.tradingEnabled,
    trading_enabled: executionPolicy.tradingEnabled,
    allowed_symbols: executionPolicy.allowedSymbols,
    max_position_usd: optionalPositive(input.riskPolicy?.maxPositionNotional),
    max_leverage: optionalPositive(input.riskPolicy?.maxLeverage),
    max_daily_loss_usd: optionalPositive(input.riskPolicy?.maxDailyLoss)
  }, { onConflict: "account_id" }).select("*").single();
  if (riskResult.error) {
    if (createdAccount) await supabase.from("exchange_accounts").delete().eq("id", account.id).eq("user_id", user.id);
    throw riskResult.error;
  }

  let snapshotWarning = null;
  try {
    await syncBybitAccountToSupabase(supabase, account, rawCredentials, diagnostics);
  } catch (error) {
    snapshotWarning = `Authenticated successfully, but initial account synchronization is degraded: ${describeSupabaseError(error)}`;
    await supabase.from("exchange_accounts").update({ status: "degraded", api_health: "warning", last_sync_error: snapshotWarning }).eq("id", account.id).eq("user_id", user.id);
  }
  await persistInitialConnectionHealth(supabase, user.id, account, diagnostics, snapshotWarning);
  const connectionResult = buildConnectionResult(diagnostics, snapshotWarning, executionPolicy, rawCredentials.authorization.type);
  await audit(supabase, {
    userId: user.id, accountId: account.id, eventType: "broker_connected", severity: snapshotWarning ? "warning" : "info",
    message: `${exchange} account authenticated and persisted.`,
    metadata: { exchange, executionEnvironment, endpointProfile, credentialRef, authorizationType: rawCredentials.authorization.type, connectionResult }
  });
  return {
    account: toCamelAccount({ ...account, status: snapshotWarning ? "degraded" : validation.status, api_health: snapshotWarning ? "warning" : validation.apiHealth, latency_ms: validation.latencyMs }, riskResult.data),
    connectionResult
  };
}

export async function establishDetectedBybitAccount({ supabase, user, input }) {
  const executionEnvironment = await detectBybitMainnetEnvironment(input);
  const accountName = String(input.accountName || "").trim() || publicBybitAccountLabel(input.apiKey, executionEnvironment);
  return establishExchangeAccount({
    supabase,
    user,
    input: { ...input, exchange: "bybit", accountName },
    executionEnvironment
  });
}

export async function rotateDetectedBybitAccount({ supabase, user, account, input }) {
  if (!account || account.user_id !== user.id || String(account.exchange).toLowerCase() !== "bybit") {
    throw typedError("BROKER_ACCOUNT_NOT_FOUND", "The owned Bybit connection is unavailable.", 404);
  }
  const executionEnvironment = await detectBybitMainnetEnvironment(input);
  const currentEnvironment = String(account.execution_environment || "").toUpperCase();
  if (executionEnvironment !== currentEnvironment) {
    throw typedError("BROKER_ENVIRONMENT_ROTATION_FORBIDDEN", "Credential rotation cannot move a connection between Bybit Mainnet and Bybit Mainnet Demo.", 409);
  }
  const endpointSet = resolveBybitEndpointSet({ executionEnvironment, endpointProfile: account.endpoint_profile || "GLOBAL" });
  const rawCredentials = {
    exchange: "bybit",
    apiKey: String(input.apiKey),
    apiSecret: String(input.apiSecret),
    createdAt: new Date().toISOString(),
    network: executionEnvironment === BYBIT_EXECUTION_ENVIRONMENTS.DEMO ? "demo" : "mainnet",
    executionEnvironment,
    endpointProfile: endpointSet.region,
    authorization: { type: "api_credentials" }
  };
  const validation = await validateBybitCredentials(rawCredentials);
  const diagnostics = validation.diagnostics;
  const permissionReport = normalizeBybitPermissionReport(diagnostics?.apiKeyInfo || {});
  if (permissionReport.withdrawal) throw typedError("DANGEROUS_WITHDRAWAL_PERMISSION", "Withdrawal-enabled API keys are not accepted. Create a read/trade key with withdrawals disabled.", 403);
  if (permissionReport.transfer) throw typedError("DANGEROUS_TRANSFER_PERMISSION", "Wallet-transfer-enabled API keys are not accepted.", 403);
  if (!permissionReport.trading) throw typedError("BROKER_TRADING_PERMISSION_REQUIRED", "The Bybit key must include trading permission.", 403);
  if (!permissionReport.accountUid || String(account.broker_account_uid || "") !== permissionReport.accountUid) {
    throw typedError("BROKER_ACCOUNT_UID_MISMATCH", "Credential rotation must authenticate the same Bybit account UID.", 409);
  }

  const executionPolicy = resolveBybitExecutionPolicy(diagnostics.permissions, { executionEnvironment });
  const fingerprint = crypto.createHash("sha256").update(rawCredentials.apiKey).digest("hex").slice(0, 32);
  const credentialRef = `exchange:bybit:${executionEnvironment}:${endpointSet.region}:${user.id}:${fingerprint}`;
  const encryptedPayload = encryptCredentialPayload(rawCredentials);
  const { error: credentialError } = await supabase.from("exchange_credentials").upsert({
    account_id: account.id,
    encrypted_payload: encryptedPayload,
    key_version: 1
  }, { onConflict: "account_id" });
  if (credentialError) throw credentialError;
  const { data: updatedAccount, error: accountError } = await supabase.from("exchange_accounts").update({
    account_name: String(input.accountName || account.account_name || "").trim() || publicBybitAccountLabel(input.apiKey, executionEnvironment),
    status: validation.status,
    api_health: validation.apiHealth,
    latency_ms: validation.latencyMs,
    permissions: executionPolicy.permissions,
    is_read_only: !executionPolicy.tradingEnabled,
    trading_enabled: executionPolicy.tradingEnabled,
    credential_ref: credentialRef,
    permission_snapshot: diagnostics.permissionSnapshot || {},
    permission_verified_at: new Date().toISOString(),
    last_sync_error: null
  }).eq("id", account.id).eq("user_id", user.id).select("*").single();
  if (accountError) throw accountError;
  const { error: riskError } = await supabase.from("account_risk_controls").update({
    read_only_mode: !executionPolicy.tradingEnabled,
    trading_enabled: executionPolicy.tradingEnabled
  }).eq("account_id", account.id);
  if (riskError) throw riskError;

  let snapshotWarning = null;
  try {
    await syncBybitAccountToSupabase(supabase, updatedAccount, rawCredentials, diagnostics);
  } catch (error) {
    snapshotWarning = `Credential rotation succeeded, but account synchronization is degraded: ${describeSupabaseError(error)}`;
    await supabase.from("exchange_accounts").update({ status: "degraded", api_health: "warning", last_sync_error: snapshotWarning }).eq("id", account.id).eq("user_id", user.id);
  }
  await persistInitialConnectionHealth(supabase, user.id, updatedAccount, diagnostics, snapshotWarning);
  await audit(supabase, {
    userId: user.id,
    accountId: account.id,
    eventType: "broker_credentials_rotated",
    severity: snapshotWarning ? "warning" : "info",
    message: "Bybit trade-only credentials were rotated for the existing account identity.",
    metadata: { executionEnvironment, endpointProfile: endpointSet.region, brokerAccountUidVerified: true, withdrawalPermission: false, transferPermission: false }
  });
  return {
    account: toCamelAccount({ ...updatedAccount, status: snapshotWarning ? "degraded" : validation.status, api_health: snapshotWarning ? "warning" : validation.apiHealth }, null),
    connectionResult: buildConnectionResult(diagnostics, snapshotWarning, executionPolicy, "api_credentials")
  };
}

export async function detectBybitMainnetEnvironment(input) {
  const apiKey = String(input.apiKey || "").trim();
  const apiSecret = String(input.apiSecret || "").trim();
  if (!apiKey || !apiSecret) throw typedError("MISSING_BROKER_CREDENTIALS", "API key and API secret are required.", 400);
  const mainnetCredentials = { apiKey, apiSecret, executionEnvironment: BYBIT_EXECUTION_ENVIRONMENTS.MAINNET_LIVE, endpointProfile: "GLOBAL" };
  try {
    await getBybitApiKeyInformation(mainnetCredentials);
    return BYBIT_EXECUTION_ENVIRONMENTS.MAINNET_LIVE;
  } catch (error) {
    if (!isEnvironmentMismatch(error)) throw error;
  }
  const demoCredentials = { apiKey, apiSecret, executionEnvironment: BYBIT_EXECUTION_ENVIRONMENTS.DEMO, endpointProfile: "GLOBAL" };
  try {
    await getBybitApiKeyInformation(demoCredentials);
    return BYBIT_EXECUTION_ENVIRONMENTS.DEMO;
  } catch (error) {
    if (!isEnvironmentMismatch(error)) throw error;
    throw typedError("BYBIT_MAINNET_CREDENTIALS_INVALID", "The credentials are not valid on Bybit Mainnet or Bybit Mainnet Demo. Testnet credentials are not accepted.", 401);
  }
}

function isEnvironmentMismatch(error) {
  return error?.code === "INVALID_API_KEY" || (error?.statusCode === 401 && error?.code !== "INVALID_SIGNATURE");
}

function publicBybitAccountLabel(apiKey, executionEnvironment) {
  const value = String(apiKey || "").trim();
  const suffix = value.slice(-6) || "ACCOUNT";
  return executionEnvironment === BYBIT_EXECUTION_ENVIRONMENTS.DEMO ? `Bybit Demo · ${suffix}` : `Bybit Mainnet · ${suffix}`;
}

function buildConnectionResult(diagnostics, snapshotWarning, executionPolicy, authorizationType) {
  const executionReady = diagnostics?.certification?.executionReady === true && executionPolicy?.tradingEnabled === true && !snapshotWarning;
  return {
    headline: diagnostics.executionEnvironment === BYBIT_EXECUTION_ENVIRONMENTS.DEMO ? "BYBIT DEMO VERIFIED" : "BYBIT MAINNET LIVE VERIFIED",
    authorizationType, executionEnvironment: diagnostics.executionEnvironment, endpointProfile: diagnostics.endpointProfile,
    accountUid: diagnostics.accountUid, permissionSnapshot: diagnostics.permissionSnapshot,
    environmentTruth: diagnostics.environmentTruth, readAccess: diagnostics.permissions?.read === true,
    tradingAccess: diagnostics.permissions?.trading === true, withdrawalAccess: diagnostics.permissions?.withdrawal === true,
    transferAccess: diagnostics.permissions?.transfer === true,
    derivativesAccess: diagnostics.metadata?.some((item) => item.marketType === "perpetual") === true,
    snapshotSynced: !snapshotWarning, snapshotWarning, executionReady,
    lifecycle: executionReady ? "CONNECTED_TRADING" : snapshotWarning ? "DEGRADED" : "CONNECTED_READ_ONLY",
    blocker: executionReady ? null : snapshotWarning || diagnostics?.readinessReason || executionPolicy?.readinessReason || diagnostics.permissions?.warnings?.[0] || "Trading permission is unavailable."
  };
}

async function persistInitialConnectionHealth(supabase, userId, account, diagnostics, snapshotWarning) {
  const now = new Date().toISOString();
  await settleSupabaseQuery(supabase.from("connection_health_snapshots").insert({
    user_id: userId,
    account_id: account.id,
    venue_id: diagnostics.venueId,
    provider: diagnostics.provider,
    category: "centralized-exchange",
    network: diagnostics.network,
    readiness: snapshotWarning ? "degraded" : diagnostics.readiness,
    execution_mode: diagnostics.executionMode,
    public_stream: diagnostics.publicStream,
    private_stream: diagnostics.privateStream,
    authentication: diagnostics.authentication,
    synchronization: snapshotWarning ? "stale" : diagnostics.synchronization,
    latency_ms: diagnostics.latencyMs,
    reconnect_count: Number(diagnostics.privateStreamRuntime?.reconnectCount || 0),
    clock_skew_ms: Number(diagnostics.time?.clockSkewMs || 0),
    rate_limit_usage: diagnostics.rateLimitUsage || "unknown",
    health: { ...diagnostics, snapshotWarning },
    captured_at: now
  }));
}

async function audit(supabase, { userId, accountId = null, eventType, severity, message, metadata }) {
  await supabase.from("execution_audit_logs").insert({ user_id: userId, account_id: accountId, event_type: eventType, severity, message, metadata });
}

function optionalPositive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function typedError(code, message, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}
