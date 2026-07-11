import {
  applyCors,
  getOwnedAccount,
  requireFields,
  requireMethod,
  requireUser,
  sendError
} from "../../portfolio-api.js";

const ENABLE_CONFIRMATION = "ENABLE BYBIT LIVE VALIDATION";
const DISABLE_CONFIRMATION = "DISABLE BYBIT LIVE VALIDATION";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");
    requireFields(req.body, ["accountId", "action", "confirmation"]);

    const { supabase, user } = await requireUser(req);
    requireValidationAdmin(user);

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

    await supabase.from("execution_audit_logs").insert({
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
    }).catch(() => null);

    return res.status(200).json({
      status: enable ? "enabled" : "disabled",
      accountId: account.id,
      liveBadge: enable ? "BYBIT MAINNET VALIDATION" : null
    });
  } catch (error) {
    return sendError(res, error);
  }
}

function requireValidationAdmin(user) {
  const allowedEmails = splitCsv(process.env.BYBIT_MAINNET_VALIDATION_ADMIN_EMAILS || process.env.MAINNET_VALIDATION_ADMIN_EMAILS).map((item) => item.toLowerCase());
  const userEmail = String(user.email || "").toLowerCase();
  const role = String(user.app_metadata?.role || user.user_metadata?.role || "").toLowerCase();
  if (role === "admin" || role === "owner" || allowedEmails.includes(userEmail)) return;

  const error = new Error("Mainnet validation mode is admin-only. Add this user to BYBIT_MAINNET_VALIDATION_ADMIN_EMAILS.");
  error.statusCode = 403;
  throw error;
}

function validateAllowlists(accountId) {
  const allowedConnections = splitCsv(process.env.BYBIT_MAINNET_ALLOWED_CONNECTIONS);
  const allowedSymbols = splitCsv(process.env.BYBIT_MAINNET_ALLOWED_SYMBOLS);
  const maxNotional = Number(process.env.BYBIT_MAINNET_MAX_NOTIONAL_USD || 0);
  const reasons = [];

  if (!allowedConnections.includes(accountId)) reasons.push("Account id is not in BYBIT_MAINNET_ALLOWED_CONNECTIONS.");
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
