import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS,PATCH,DELETE,POST,PUT",
  "Access-Control-Allow-Headers":
    "Authorization, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
};

export function applyCors(req, res) {
  for (const [key, value] of Object.entries(corsHeaders)) {
    res.setHeader(key, value);
  }

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return true;
  }

  return false;
}

export function getSupabaseAdmin() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

export async function requireUser(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";

  if (!token) {
    const error = new Error("Missing Authorization bearer token.");
    error.statusCode = 401;
    throw error;
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    const authError = new Error("Invalid or expired session.");
    authError.statusCode = 401;
    throw authError;
  }

  return { supabase, user: data.user };
}

export function sendError(res, error) {
  const statusCode = error?.statusCode || 500;
  const rawMessage = String(error?.message || error?.publicMessage || "").trim();
  const message = statusCode === 500
    ? "Server error"
    : rawMessage || "Request failed without a diagnostic message.";
  if (statusCode >= 500) {
    console.error("[black-terminal-api-error]", {
      statusCode,
      code: error?.code || null,
      message: rawMessage || "Request failed without a diagnostic message.",
      details: error?.publicDetails || null
    });
  }
  const payload = { error: message };
  if (error?.code) payload.code = error.code;
  if (error?.publicDetails) payload.details = error.publicDetails;
  return res.status(statusCode).json(payload);
}

export function requireMethod(req, method) {
  if (req.method !== method) {
    const error = new Error("Method Not Allowed");
    error.statusCode = 405;
    throw error;
  }
}

export function requireFields(body, fields) {
  for (const field of fields) {
    if (body?.[field] === undefined || body?.[field] === null || body?.[field] === "") {
      const error = new Error(`Missing required field: ${field}`);
      error.statusCode = 400;
      throw error;
    }
  }
}

export function encryptCredentialPayload(payload) {
  const rawKey = process.env.EXCHANGE_CREDENTIAL_MASTER_KEY;

  if (!rawKey) {
    throw new Error("Missing EXCHANGE_CREDENTIAL_MASTER_KEY.");
  }

  const key = Buffer.from(rawKey, "base64");
  if (key.length !== 32) {
    throw new Error("EXCHANGE_CREDENTIAL_MASTER_KEY must be a base64-encoded 32-byte key.");
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    version: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: encrypted.toString("base64")
  });
}

export function decryptCredentialPayload(encryptedPayload) {
  const rawKey = process.env.EXCHANGE_CREDENTIAL_MASTER_KEY;

  if (!rawKey) {
    throw new Error("Missing EXCHANGE_CREDENTIAL_MASTER_KEY.");
  }

  const key = Buffer.from(rawKey, "base64");
  if (key.length !== 32) {
    throw new Error("EXCHANGE_CREDENTIAL_MASTER_KEY must be a base64-encoded 32-byte key.");
  }

  const payload = JSON.parse(encryptedPayload);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final()
  ]);

  return JSON.parse(decrypted.toString("utf8"));
}

export function toCamelAccount(row, riskControls) {
  return {
    id: row.id,
    exchange: row.exchange,
    accountName: row.account_name,
    status: row.status,
    apiHealth: row.api_health,
    latencyMs: row.latency_ms,
    permissions: row.permissions || [],
    isReadOnly: row.is_read_only,
    tradingEnabled: row.trading_enabled,
    credentialRef: row.credential_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    riskControls: riskControls
      ? {
          maxLeverage: Number(riskControls.max_leverage),
          maxPositionUsd: Number(riskControls.max_position_usd),
          maxDailyLossUsd: Number(riskControls.max_daily_loss_usd),
          maxPortfolioExposureUsd: Number(riskControls.max_portfolio_exposure_usd),
          allowedSymbols: riskControls.allowed_symbols || [],
          readOnlyMode: riskControls.read_only_mode,
          tradingEnabled: riskControls.trading_enabled,
          emergencyStop: riskControls.emergency_stop
        }
      : null
  };
}

export function checkOrderRisk({ account, riskControls, order, accountExposureUsd = 0, dailyPnl = 0 }) {
  const reasons = [];
  const referencePrice = Number(order.referencePrice || order.limitPrice || order.stopPrice || 1);
  const quantity = Number(order.quantity || 0);
  const notional = order.quantityMode === "usd" ? Math.abs(quantity) : Math.abs(quantity * referencePrice);
  const leverage = Math.max(1, Number(order.leverage || 1));
  const requiredMargin = order.marketKind === "spot" ? notional : notional / leverage;
  const maxPositionUsd = Number(riskControls?.max_position_usd || 0);
  const maxPortfolioExposureUsd = Number(riskControls?.max_portfolio_exposure_usd || 0);

  if (!account) reasons.push("Account not found.");
  if (account?.is_read_only) reasons.push("Account is read-only.");
  if (!account?.trading_enabled) reasons.push("Trading is disabled for this account.");
  if (riskControls?.read_only_mode) reasons.push("Risk controls are in read-only mode.");
  if (!riskControls?.trading_enabled) reasons.push("Risk controls disable trading.");
  if (riskControls?.emergency_stop) reasons.push("Emergency stop is active.");
  if (riskControls?.allowed_symbols?.length > 0 && !riskControls.allowed_symbols.includes("*") && !riskControls.allowed_symbols.includes(order.symbol)) {
    reasons.push(`${order.symbol} is not in the allowed symbols list.`);
  }
  if (maxPositionUsd > 0 && notional > maxPositionUsd) {
    reasons.push("Order exceeds maximum position size.");
  }
  if (maxPortfolioExposureUsd > 0 && accountExposureUsd + requiredMargin > maxPortfolioExposureUsd) {
    reasons.push("Order would exceed maximum portfolio exposure.");
  }
  if (riskControls && dailyPnl <= -Math.abs(Number(riskControls.max_daily_loss_usd))) {
    reasons.push("Maximum daily loss has been reached.");
  }

  return {
    status: reasons.length ? "blocked" : "approved",
    reasons,
    notional,
    referencePrice,
    requiredMargin
  };
}

export async function getOwnedAccount(supabase, userId, accountId) {
  const { data, error } = await supabase
    .from("exchange_accounts")
    .select("*")
    .eq("id", accountId)
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    const notFound = new Error("Exchange account not found.");
    notFound.statusCode = 404;
    throw notFound;
  }

  return data;
}
