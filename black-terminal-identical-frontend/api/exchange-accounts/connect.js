import {
  applyCors,
  encryptCredentialPayload,
  requireFields,
  requireMethod,
  requireUser,
  sendError,
  toCamelAccount
} from "../../server/portfolio-api.js";
import { syncBybitAccountToSupabase, validateBybitCredentials } from "../../server/exchanges/bybit.js";

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
      await syncBybitAccountToSupabase(supabase, account, rawCredentials);
    }

    await supabase.from("execution_audit_logs").insert({
      user_id: user.id,
      account_id: account.id,
      event_type: "exchange_account_connected",
      severity: "info",
      message: `Stored secure credential reference for ${exchange}.`,
      metadata: { exchange, credentialRef }
    });

    return res.status(200).json({
      account: toCamelAccount({
        ...account,
        status: validation.status,
        api_health: validation.apiHealth,
        latency_ms: validation.latencyMs
      }, riskControls)
    });
  } catch (error) {
    return sendError(res, error);
  }
}
