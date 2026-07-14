import {
  applyCors,
  encryptCredentialPayload,
  requireFields,
  requireMethod,
  requireUser,
  sendError,
  toCamelAccount
} from "../../portfolio-api.js";
import { resolveBybitExecutionPolicy, syncBybitAccountToSupabase, validateBybitCredentials } from "../../exchanges/bybit.js";
import { describeSupabaseError } from "../../exchanges/bybit-snapshot-store.js";

const certifiedCredentialAdapters = {
  bybit: {
    executionMode: "venue-native",
    reason: "Bybit account access and order routing are derived from the connected API key and server execution policy."
  }
};

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");

    const { supabase, user } = await requireUser(req);
    requireFields(req.body, ["exchange", "accountName", "apiKey", "apiSecret"]);

    const exchange = String(req.body.exchange).trim().toLowerCase();
    const certification = certifiedCredentialAdapters[exchange];
    if (!certification) {
      const unsupported = new Error(`${exchange} credential validation is not certified yet. This venue is market-data-only until a production adapter is implemented.`);
      unsupported.statusCode = 501;
      throw unsupported;
    }
    const accountName = String(req.body.accountName).trim();
    const rawCredentials = {
      exchange,
      apiKey: String(req.body.apiKey),
      apiSecret: String(req.body.apiSecret),
      passphrase: req.body.passphrase ? String(req.body.passphrase) : undefined,
      createdAt: new Date().toISOString()
    };
    const validation = exchange === "bybit"
      ? await validateBybitCredentials(rawCredentials)
      : { status: "read-only", apiHealth: "unknown", latencyMs: 0 };
    const bybitDiagnostics = exchange === "bybit" ? validation.diagnostics : null;
    if (bybitDiagnostics?.permissions?.withdrawal) {
      const blocked = new Error("Bybit API key has withdrawal permission. Create a trading/read-only key with withdrawals disabled before connecting.");
      blocked.statusCode = 403;
      throw blocked;
    }
    const executionPolicy = resolveBybitExecutionPolicy(bybitDiagnostics?.permissions);
    const credentialRef = `exchange:${exchange}:${user.id}:${Date.now()}`;
    const encryptedPayload = encryptCredentialPayload(rawCredentials);

    const { data: account, error: accountError } = await supabase
      .from("exchange_accounts")
      .insert({
        user_id: user.id,
        exchange,
        account_name: accountName,
        status: validation.status,
        api_health: validation.apiHealth,
        latency_ms: validation.latencyMs,
        permissions: executionPolicy.permissions,
        is_read_only: !executionPolicy.tradingEnabled,
        trading_enabled: executionPolicy.tradingEnabled,
        credential_ref: credentialRef
      })
      .select("*")
      .single();

    if (accountError) throw accountError;

    const { error: credentialError } = await supabase
      .from("exchange_credentials")
      .insert({
        account_id: account.id,
        encrypted_payload: encryptedPayload,
        key_version: 1
      });

    if (credentialError) {
      await supabase.from("exchange_accounts").delete().eq("id", account.id);
      throw credentialError;
    }

    const riskControlInsert = {
      account_id: account.id,
      read_only_mode: !executionPolicy.tradingEnabled,
      trading_enabled: executionPolicy.tradingEnabled,
      allowed_symbols: executionPolicy.allowedSymbols,
      max_position_usd: executionPolicy.maxNotionalUsd
    };

    const { data: riskControls, error: riskError } = await supabase
      .from("account_risk_controls")
      .insert(riskControlInsert)
      .select("*")
      .single();

    if (riskError) {
      await supabase.from("exchange_accounts").delete().eq("id", account.id);
      throw riskError;
    }

    let snapshotWarning = null;
    if (exchange === "bybit") {
      try {
        await syncBybitAccountToSupabase(supabase, account, rawCredentials, bybitDiagnostics);
      } catch (syncError) {
        snapshotWarning = `Bybit authenticated successfully, but initial snapshot persistence is degraded: ${describeSupabaseError(syncError)}`;
        console.error("[bybit-connect-snapshot-warning]", {
          accountId: account.id,
          code: syncError?.code || null,
          message: snapshotWarning
        });
        await supabase
          .from("exchange_accounts")
          .update({ status: "degraded", api_health: "warning" })
          .eq("id", account.id)
          .eq("user_id", user.id);
      }
    }

    await supabase.from("execution_audit_logs").insert({
      user_id: user.id,
      account_id: account.id,
      event_type: "exchange_account_connected",
      severity: "info",
      message: `Stored secure credential reference for ${exchange}.`,
      metadata: {
        exchange,
        credentialRef,
        connectionResult: buildConnectionResult(exchange, bybitDiagnostics, snapshotWarning, executionPolicy)
      }
    });

    return res.status(200).json({
      account: toCamelAccount({
        ...account,
        status: snapshotWarning ? "degraded" : validation.status,
        api_health: snapshotWarning ? "warning" : validation.apiHealth,
        latency_ms: validation.latencyMs
      }, riskControls),
      connectionResult: buildConnectionResult(exchange, bybitDiagnostics, snapshotWarning, executionPolicy)
    });
  } catch (error) {
    return sendError(res, error);
  }
}

function buildConnectionResult(exchange, diagnostics, snapshotWarning = null, executionPolicy = null) {
  if (exchange !== "bybit" || !diagnostics) return null;
  const executionReady = executionPolicy?.tradingEnabled === true;
  return {
    headline: "BYBIT MAINNET ACCOUNT CONNECTED",
    readAccess: diagnostics.permissions?.read === true,
    tradingAccess: diagnostics.permissions?.trading === true,
    withdrawalAccess: diagnostics.permissions?.withdrawal === true,
    derivativesAccess: diagnostics.metadata?.some((item) => item.marketType === "perpetual") === true,
    snapshotSynced: !snapshotWarning,
    snapshotWarning,
    executionReady,
    blocker: executionReady ? null : executionPolicy?.readinessReason || diagnostics.permissions?.warnings?.[0] || "Bybit trading permission is unavailable."
  };
}
