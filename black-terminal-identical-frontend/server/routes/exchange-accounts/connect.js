import {
  applyCors,
  encryptCredentialPayload,
  requireFields,
  requireMethod,
  requireUser,
  sendError,
  toCamelAccount
} from "../../portfolio-api.js";
import { syncBybitAccountToSupabase, validateBybitCredentials } from "../../exchanges/bybit.js";

const certifiedCredentialAdapters = {
  bybit: {
    executionMode: "read-only",
    reason: "Bybit credential validation and account snapshot sync are certified read-only. Live trading remains disabled until adapter certification is complete."
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
        permissions: ["read-account", "read-orders", "read-positions"],
        is_read_only: true,
        trading_enabled: false,
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

    const { data: riskControls, error: riskError } = await supabase
      .from("account_risk_controls")
      .insert({
        account_id: account.id,
        read_only_mode: true,
        trading_enabled: false,
        allowed_symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
      })
      .select("*")
      .single();

    if (riskError) {
      await supabase.from("exchange_accounts").delete().eq("id", account.id);
      throw riskError;
    }

    if (exchange === "bybit") {
      try {
        await syncBybitAccountToSupabase(supabase, account, rawCredentials, bybitDiagnostics);
      } catch (syncError) {
        await supabase.from("exchange_accounts").delete().eq("id", account.id);
        const error = new Error(`Bybit account snapshot sync failed after credential validation: ${syncError instanceof Error ? syncError.message : String(syncError)}`);
        error.statusCode = syncError?.statusCode || 502;
        error.code = "BYBIT_ACCOUNT_SYNC_FAILED";
        throw error;
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
        connectionResult: buildConnectionResult(exchange, bybitDiagnostics)
      }
    });

    return res.status(200).json({
      account: toCamelAccount({
        ...account,
        status: validation.status,
        api_health: validation.apiHealth,
        latency_ms: validation.latencyMs
      }, riskControls),
      connectionResult: buildConnectionResult(exchange, bybitDiagnostics)
    });
  } catch (error) {
    return sendError(res, error);
  }
}

function buildConnectionResult(exchange, diagnostics) {
  if (exchange !== "bybit" || !diagnostics) return null;
  const executionReady = diagnostics.certification?.executionReady === true;
  return {
    headline: "BYBIT MAINNET ACCOUNT CONNECTED",
    readAccess: diagnostics.permissions?.read === true,
    tradingAccess: diagnostics.permissions?.trading === true,
    withdrawalAccess: diagnostics.permissions?.withdrawal === true,
    derivativesAccess: diagnostics.metadata?.some((item) => item.marketType === "perpetual") === true,
    executionReady,
    blocker: executionReady ? null : diagnostics.readinessReason || diagnostics.permissions?.warnings?.[0] || "Bybit account is connected read-only until controlled validation is enabled."
  };
}
