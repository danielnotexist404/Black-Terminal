import crypto from "node:crypto";
import { encryptCredentialPayload, toCamelAccount } from "../portfolio-api.js";
import { resolveBybitExecutionPolicy, syncBybitAccountToSupabase, validateBybitCredentials } from "./bybit.js";
import { describeSupabaseError } from "./bybit-snapshot-store.js";
import { BYBIT_EXECUTION_ENVIRONMENTS, resolveBybitEndpointSet } from "./bybit-endpoints.js";
import { getBrokerAdapterDefinition } from "./broker-adapter-registry.js";
import { settleSupabaseQuery } from "../supabase-query.js";

export async function establishExchangeAccount({ supabase, user, input, authorization = null }) {
  const exchange = String(input.exchange || "").trim().toLowerCase();
  const definition = getBrokerAdapterDefinition(exchange);
  if (!definition?.authorization?.apiCredentials) {
    throw typedError("ADAPTER_NOT_CERTIFIED", `${exchange} credential validation is not certified.`, 501);
  }
  const accountName = String(input.accountName || "").trim();
  if (!accountName || !input.apiKey || !input.apiSecret) throw typedError("MISSING_BROKER_CREDENTIALS", "Account name, API key and API secret are required.", 400);
  // This production adapter is intentionally locked. Client-provided legacy
  // environment/region fields are ignored so hidden controls cannot redirect
  // credentials to another Bybit endpoint.
  const endpointSet = resolveBybitEndpointSet({ executionEnvironment: BYBIT_EXECUTION_ENVIRONMENTS.MAINNET_LIVE, endpointProfile: "GLOBAL" });
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
