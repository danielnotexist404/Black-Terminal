import {
  applyCors,
  decryptCredentialPayload,
  requireMethod,
  requireUser,
  sendError
} from "../../portfolio-api.js";
import { getBybitDiagnostics } from "../../exchanges/bybit.js";
import { evaluateBybitCertification } from "../../exchanges/bybit-certification.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "GET");
    const { supabase, user } = await requireUser(req);
    const accountId = String(req.query.accountId || "").trim();
    const symbol = String(req.query.symbol || firstCsv(process.env.BYBIT_MAINNET_ALLOWED_SYMBOLS) || "BTCUSDT").toUpperCase();
    const admin = isValidationAdmin(user);

    const account = await loadBybitAccount(supabase, user.id, accountId);
    const credentialStatus = await loadCredentialStatus(supabase, account);
    const latestHealth = await loadLatestHealth(supabase, account.id);
    const latestCertification = await loadLatestCertification(supabase);
    const latestValidationRows = await loadLatestValidationRows(supabase, account.id);
    const envStatus = buildEnvStatus(account.id, symbol);
    const diagnostics = credentialStatus.credentials
      ? await safeDiagnostics(credentialStatus.credentials, symbol)
      : { ok: false, error: credentialStatus.error || "Encrypted credential is not available." };
    const streamStatus = evaluateStreamHealth(latestHealth);
    const blockers = buildReadinessBlockers({ envStatus, credentialStatus, diagnostics, streamStatus });
    const certificationDecision = evaluateBybitCertification({
      rows: mapValidationRowsToCertificationRows(latestValidationRows),
      blockers
    });

    return res.status(200).json({
      venueId: "bybit",
      network: "mainnet",
      account: {
        found: true,
        id: account.id,
        label: account.account_name,
        maskedIdentifier: mask(account.id),
        status: account.status,
        accountMode: account.metadata?.accountMode || "unified",
        permissions: account.permissions || [],
        tradingEnabled: account.trading_enabled === true,
        readOnly: account.is_read_only === true
      },
      runtime: {
        credentialsDecryptable: credentialStatus.ok,
        serverTimeReachable: diagnostics.ok,
        clockSkewMs: diagnostics.data?.time?.clockSkewMs ?? null,
        metadataLoaded: (diagnostics.data?.metadata?.length || 0) > 0,
        publicApiReachable: diagnostics.ok,
        privateStreamRunning: streamStatus.running,
        privateStreamAuthenticated: streamStatus.authenticated,
        lastPrivateEventAt: streamStatus.lastPrivateEventAt,
        privateStreamAgeMs: streamStatus.ageMs,
        balanceSyncHealthy: diagnostics.ok && Array.isArray(diagnostics.data?.balances),
        positionSyncHealthy: diagnostics.ok && Array.isArray(diagnostics.data?.positions),
        orderSyncHealthy: diagnostics.ok && Array.isArray(diagnostics.data?.openOrders),
        executionEndpointAvailable: diagnostics.data?.endpoints?.order === "available-gated",
        reconnectCount: latestHealth?.reconnect_count ?? 0,
        lastError: latestHealth?.last_error || diagnostics.error || null
      },
      safety: {
        validationModeEnabled: envStatus.validationModeEnabled,
        accountAllowlisted: envStatus.accountAllowlisted,
        symbolAllowlisted: envStatus.symbolAllowlisted,
        maxNotionalConfigured: envStatus.maxNotionalConfigured,
        maxNotionalUsd: envStatus.maxNotionalUsd,
        withdrawalPermissionAbsent: diagnostics.data?.permissions?.withdrawal === false,
        readPermissionPresent: diagnostics.data?.permissions?.read === true,
        tradePermissionPresent: diagnostics.data?.permissions?.trading === true
      },
      readiness: {
        executionReady: blockers.length === 0,
        readinessReason: blockers.length === 0 ? "Bybit controlled mainnet validation runtime is ready." : blockers.join(" "),
        blockers
      },
      certification: {
        latestStatus: latestCertification?.implementation_status || "partial",
        latestReadiness: latestCertification?.readiness || "unknown",
        mainnetValidated: latestCertification?.mainnet_validated === true,
        decision: certificationDecision.outcome,
        missingMandatory: certificationDecision.missingMandatory,
        failed: certificationDecision.failed.map((item) => item.operation),
        evidenceRows: latestValidationRows.length
      },
      diagnostics: admin ? sanitize({
        envStatus,
        latestHealth,
        latestCertification,
        latestValidationRows,
        bybit: diagnostics.data
      }) : undefined
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function loadBybitAccount(supabase, userId, accountId) {
  let query = supabase
    .from("exchange_accounts")
    .select("*")
    .eq("user_id", userId)
    .eq("exchange", "bybit")
    .order("created_at", { ascending: false })
    .limit(1);

  if (accountId) query = query.eq("id", accountId);
  const { data, error } = await query.maybeSingle();
  if (error || !data) {
    const notFound = new Error(error?.message || "No Bybit account connection found for this user.");
    notFound.statusCode = 404;
    throw notFound;
  }
  return data;
}

async function loadCredentialStatus(supabase, account) {
  const { data, error } = await supabase
    .from("exchange_credentials")
    .select("encrypted_payload,key_version,created_at")
    .eq("account_id", account.id)
    .maybeSingle();
  if (error || !data) return { ok: false, error: error?.message || "Encrypted credential record is missing." };

  try {
    return {
      ok: true,
      credentials: decryptCredentialPayload(data.encrypted_payload),
      keyVersion: data.key_version,
      createdAt: data.created_at
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function loadLatestHealth(supabase, accountId) {
  const { data } = await supabase
    .from("connection_health_snapshots")
    .select("*")
    .eq("account_id", accountId)
    .eq("venue_id", "bybit")
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function loadLatestCertification(supabase) {
  const { data } = await supabase
    .from("adapter_certifications")
    .select("*")
    .eq("venue_id", "bybit")
    .eq("network", "mainnet")
    .maybeSingle();
  return data || null;
}

async function loadLatestValidationRows(supabase, accountId) {
  const { data } = await supabase
    .from("mainnet_validation_records")
    .select("validation_stage,status,failure_reason,metadata,created_at,completed_at")
    .eq("account_id", accountId)
    .eq("venue_id", "bybit")
    .order("created_at", { ascending: false })
    .limit(50);
  return data || [];
}

async function safeDiagnostics(credentials, symbol) {
  try {
    return { ok: true, data: await getBybitDiagnostics(credentials, { symbol }) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function buildEnvStatus(accountId, symbol) {
  const allowedConnections = csv(process.env.BYBIT_MAINNET_ALLOWED_CONNECTIONS);
  const allowedSymbols = csv(process.env.BYBIT_MAINNET_ALLOWED_SYMBOLS).map((item) => item.toUpperCase());
  const maxNotionalUsd = Number(process.env.BYBIT_MAINNET_MAX_NOTIONAL_USD || 0);
  return {
    validationModeEnabled: process.env.BYBIT_MAINNET_VALIDATION_ENABLED === "true",
    accountAllowlisted: allowedConnections.length === 0 || allowedConnections.includes("*") || allowedConnections.includes(accountId),
    symbolAllowlisted: allowedSymbols.includes("*") || allowedSymbols.includes(symbol),
    maxNotionalConfigured: Number.isFinite(maxNotionalUsd) && maxNotionalUsd > 0,
    maxNotionalUsd,
    allowedSymbols
  };
}

function evaluateStreamHealth(latestHealth) {
  if (!latestHealth) {
    return { running: false, authenticated: false, ageMs: null, lastPrivateEventAt: null };
  }
  const health = latestHealth.health || {};
  const lastPrivateEventAt = health.lastExecutionAt || health.lastOrderAt || health.lastPositionAt || health.lastWalletAt || health.lastMessageAt || null;
  return {
    running: latestHealth.private_stream === "connected",
    authenticated: latestHealth.authentication === "authenticated",
    ageMs: Date.now() - new Date(latestHealth.captured_at).getTime(),
    lastPrivateEventAt
  };
}

function buildReadinessBlockers({ envStatus, credentialStatus, diagnostics, streamStatus }) {
  const blockers = [];
  if (!envStatus.validationModeEnabled) blockers.push("BYBIT_MAINNET_VALIDATION_ENABLED is not true.");
  if (!envStatus.accountAllowlisted) blockers.push("Bybit account is not in BYBIT_MAINNET_ALLOWED_CONNECTIONS.");
  if (!envStatus.symbolAllowlisted) blockers.push("Bybit symbol is not in BYBIT_MAINNET_ALLOWED_SYMBOLS.");
  if (!envStatus.maxNotionalConfigured) blockers.push("BYBIT_MAINNET_MAX_NOTIONAL_USD must be configured.");
  if (!credentialStatus.ok) blockers.push(credentialStatus.error || "Encrypted credential cannot be decrypted.");
  if (!diagnostics.ok) blockers.push(diagnostics.error || "Bybit diagnostics failed.");
  if (diagnostics.data?.permissions?.withdrawal) blockers.push("Bybit API key has withdrawal permission. Use a trading-only key.");
  if (diagnostics.data && !diagnostics.data.permissions?.trading) blockers.push("Bybit API key lacks trading permission.");
  if (!streamStatus.running || !streamStatus.authenticated) blockers.push("Bybit private-stream worker is not connected and authenticated.");
  return blockers;
}

function mapValidationRowsToCertificationRows(rows) {
  return rows.map((row) => ({
    operation: row.validation_stage,
    status: row.status === "passed" ? "passed" : row.status === "blocked" ? "blocked" : row.status === "failed" ? "failed" : "pending",
    message: row.failure_reason || ""
  }));
}

function isValidationAdmin(user) {
  const allowedEmails = csv(process.env.BYBIT_MAINNET_VALIDATION_ADMIN_EMAILS || process.env.MAINNET_VALIDATION_ADMIN_EMAILS).map((item) => item.toLowerCase());
  const email = String(user.email || "").toLowerCase();
  const role = String(user.app_metadata?.role || user.user_metadata?.role || "").toLowerCase();
  return allowedEmails.includes(email) || ["admin", "owner"].includes(role);
}

function sanitize(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (/secret|credential|token|key|authorization/i.test(key)) return "[redacted]";
    if (typeof item === "string" && item.length > 80) return `${item.slice(0, 12)}...${item.slice(-6)}`;
    return item;
  }));
}

function mask(value) {
  const text = String(value || "");
  if (text.length <= 10) return text ? "***" : "";
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function firstCsv(value) {
  return csv(value)[0];
}

function csv(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}
