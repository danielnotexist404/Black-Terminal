import {
  applyCors,
  decryptCredentialPayload,
  getOwnedAccount,
  requireFields,
  requireMethod,
  requireUser,
  sendError
} from "../../portfolio-api.js";
import { settleSupabaseQuery } from "../../supabase-query.js";
import { getBybitApiKeyInformation, normalizeBybitPermissionReport } from "../../exchanges/bybit.js";

const ENABLE_CONFIRMATION = "ENABLE BYBIT LIVE VALIDATION";
const DISABLE_CONFIRMATION = "DISABLE BYBIT LIVE VALIDATION";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");
    requireFields(req.body, ["accountId", "action", "confirmation"]);

    const { supabase, user } = await requireUser(req);
    if (process.env.BYBIT_MAINNET_VALIDATION_ENABLED !== "true") {
      const blocked = new Error("BYBIT_MAINNET_VALIDATION_ENABLED must be true before account validation mode can be changed.");
      blocked.statusCode = 403;
      throw blocked;
    }

    const account = await getOwnedAccount(supabase, user.id, req.body.accountId);
    if (account.exchange !== "bybit") {
      const unsupported = new Error("This validation route is scoped to Bybit only.");
      unsupported.statusCode = 400;
      throw unsupported;
    }

    const enable = req.body.action === "enable";
    const expected = enable ? ENABLE_CONFIRMATION : DISABLE_CONFIRMATION;
    if (req.body.confirmation !== expected) {
      const invalid = new Error(`Confirmation phrase must be: ${expected}`);
      invalid.statusCode = 400;
      throw invalid;
    }

    if (enable) validateAllowlists(account.id);

    if (enable) {
      const { data: credential, error: credentialError } = await supabase
        .from("exchange_credentials")
        .select("encrypted_payload")
        .eq("account_id", account.id)
        .single();
      if (credentialError || !credential) throw credentialError || new Error("Missing encrypted Bybit credentials.");
      const credentials = decryptCredentialPayload(credential.encrypted_payload);
      const permissions = normalizeBybitPermissionReport(await getBybitApiKeyInformation(credentials));
      if (!permissions.trading) {
        const blocked = new Error("Bybit API key does not have order/position trading permission.");
        blocked.statusCode = 403;
        throw blocked;
      }
      if (permissions.withdrawal) {
        const blocked = new Error("Withdrawal permission is not allowed for Black Terminal trading connections.");
        blocked.statusCode = 403;
        throw blocked;
      }
    }

    const riskPatch = {
      read_only_mode: !enable,
      trading_enabled: enable,
      allowed_symbols: splitCsv(process.env.BYBIT_MAINNET_ALLOWED_SYMBOLS).map((item) => item.toUpperCase())
    };
    if (process.env.BYBIT_MAINNET_MAX_NOTIONAL_USD) {
      riskPatch.max_position_usd = Number(process.env.BYBIT_MAINNET_MAX_NOTIONAL_USD);
    }

    const updates = await Promise.all([
      supabase
        .from("exchange_accounts")
        .update({
          is_read_only: !enable,
          trading_enabled: enable,
          permissions: enable
            ? ["read-account", "read-orders", "read-positions", "place-orders", "cancel-orders", "modify-orders", "withdraw-disabled"]
            : ["read-account", "read-orders", "read-positions"]
        })
        .eq("id", account.id)
        .eq("user_id", user.id),
      supabase
        .from("account_risk_controls")
        .update(riskPatch)
        .eq("account_id", account.id)
    ]);

    const failed = updates.find((result) => result.error);
    if (failed?.error) throw failed.error;

    await settleSupabaseQuery(supabase.from("execution_audit_logs").insert({
      user_id: user.id,
      account_id: account.id,
      event_type: enable ? "mainnet_validation_enabled" : "mainnet_validation_disabled",
      severity: "warning",
      message: enable
        ? "Bybit controlled mainnet validation mode enabled for this account."
        : "Bybit controlled mainnet validation mode disabled for this account.",
      metadata: {
        venueId: "bybit",
        accountId: account.id,
        allowedSymbols: splitCsv(process.env.BYBIT_MAINNET_ALLOWED_SYMBOLS).map((item) => item.toUpperCase()),
        maxNotionalUsd: Number(process.env.BYBIT_MAINNET_MAX_NOTIONAL_USD || 0)
      }
    }));

    return res.status(200).json({
      status: enable ? "enabled" : "disabled",
      accountId: account.id,
      liveBadge: enable ? "BYBIT MAINNET VALIDATION" : null
    });
  } catch (error) {
    return sendError(res, error);
  }
}

function validateAllowlists(accountId) {
  const allowedConnections = splitCsv(process.env.BYBIT_MAINNET_ALLOWED_CONNECTIONS);
  const allowedSymbols = splitCsv(process.env.BYBIT_MAINNET_ALLOWED_SYMBOLS);
  const maxNotional = Number(process.env.BYBIT_MAINNET_MAX_NOTIONAL_USD || 0);
  const reasons = [];

  if (allowedConnections.length > 0 && !allowedConnections.includes("*") && !allowedConnections.includes(accountId)) reasons.push("Account id is not in BYBIT_MAINNET_ALLOWED_CONNECTIONS.");
  if (allowedSymbols.length === 0) reasons.push("BYBIT_MAINNET_ALLOWED_SYMBOLS must contain at least one symbol.");
  if (!Number.isFinite(maxNotional) || maxNotional <= 0) reasons.push("BYBIT_MAINNET_MAX_NOTIONAL_USD must be configured.");

  if (reasons.length > 0) {
    const error = new Error(reasons.join(" "));
    error.statusCode = 403;
    throw error;
  }
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
