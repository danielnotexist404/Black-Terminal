import { applyCors, requireFields, requireMethod, requireUser, sendError } from "../../portfolio-api.js";
import { hashCanonicalPayload } from "../../cloud-execution/canonical.js";

const CONSENT = "AUTHORIZE OFFLINE GROUP EXECUTION";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    requireMethod(req, "POST");
    const { supabase, user } = await requireUser(req);
    requireFields(req.body, ["action"]);
    if (req.body.action === "create") return createMandate(supabase, user.id, req, res);
    if (req.body.action === "accept") return acceptMandate(supabase, user.id, req, res);
    if (req.body.action === "pause") return changeStatus(supabase, user.id, req, res, "PAUSED");
    if (req.body.action === "revoke") return changeStatus(supabase, user.id, req, res, "REVOKED");
    const error = new Error("Unsupported mandate action.");
    error.statusCode = 400;
    throw error;
  } catch (error) {
    return sendError(res, error);
  }
}

async function createMandate(supabase, userId, req, res) {
  requireFields(req.body, ["groupId", "connectionId", "allocationMethod", "allocationValue", "maxOrderNotional", "maxTotalExposure", "maxDailyLoss", "maxDrawdown", "maxLeverage"]);
  const connection = await ownedConnection(supabase, userId, req.body.connectionId);
  if (connection.connection_mode !== "CLOUD_DELEGATED" && connection.connection_mode !== "HYBRID") throw forbidden("A cloud-delegated or hybrid connection is required.");
  if (connection.health_status !== "CONNECTED_CLOUD" && connection.health_status !== "CONNECTED_HYBRID") throw forbidden("The cloud connection must be healthy and reconciled first.");
  const membership = await activeMembership(supabase, userId, req.body.groupId);
  if (!membership) throw forbidden("Active Investment Group membership is required.");

  const payload = normalizeMandate(req.body, userId);
  const { data, error } = await supabase.from("group_execution_mandates").upsert(payload, {
    onConflict: "group_id,follower_user_id,broker_connection_id"
  }).select("*").single();
  if (error) throw error;
  await auditMandate(supabase, userId, data, "MANDATE_CREATED", "An investor execution mandate was created pending explicit consent.");
  return res.status(200).json({ mandate: safeMandate(data), requiredConfirmation: CONSENT });
}

async function acceptMandate(supabase, userId, req, res) {
  requireFields(req.body, ["mandateId", "confirmation"]);
  if (req.body.confirmation !== CONSENT) throw forbidden(`Explicit confirmation is required: ${CONSENT}`);
  const mandate = await ownedMandate(supabase, userId, req.body.mandateId);
  const consentSnapshot = { ...mandate, status: "ACTIVE", acceptedAt: new Date().toISOString(), withdrawalPermission: "NONE" };
  const consentHash = hashCanonicalPayload(consentSnapshot);
  const { data, error } = await supabase.from("group_execution_mandates").update({
    status: "ACTIVE",
    accepted_at: consentSnapshot.acceptedAt,
    consent_hash: consentHash,
    paused_at: null,
    revoked_at: null
  }).eq("id", mandate.id).eq("follower_user_id", userId).select("*").single();
  if (error) throw error;
  const snapshot = { ...data, withdrawalPermission: "NONE" };
  await supabase.from("group_execution_mandate_versions").upsert({
    mandate_id: data.id,
    version: data.mandate_version,
    follower_user_id: userId,
    policy_snapshot: snapshot,
    canonical_hash: hashCanonicalPayload(snapshot),
    consent_evidence: { consentHash, confirmation: CONSENT, acceptedAt: data.accepted_at }
  }, { onConflict: "mandate_id,version" });
  await auditMandate(supabase, userId, data, "MANDATE_GRANTED", "The investor granted bounded offline group execution authority.");
  return res.status(200).json({ mandate: safeMandate(data), offlineExecution: "ENABLED", withdrawalPermission: "NONE" });
}

async function changeStatus(supabase, userId, req, res, status) {
  requireFields(req.body, ["mandateId"]);
  const patch = status === "PAUSED"
    ? { status, paused_at: new Date().toISOString() }
    : { status, revoked_at: new Date().toISOString() };
  const { data, error } = await supabase.from("group_execution_mandates").update(patch)
    .eq("id", req.body.mandateId).eq("follower_user_id", userId).select("*").single();
  if (error) throw error;
  await auditMandate(supabase, userId, data, status === "PAUSED" ? "MANDATE_PAUSED" : "MANDATE_REVOKED", status === "PAUSED" ? "The investor paused group execution authority." : "The investor revoked group execution authority.");
  return res.status(200).json({ mandate: safeMandate(data), offlineExecution: "DISABLED" });
}

function normalizeMandate(body, userId) {
  const allowedSymbols = normalizeList(body.allowedSymbols);
  const allowedMarketTypes = normalizeList(body.allowedMarketTypes);
  const allowedOrderTypes = normalizeList(body.allowedOrderTypes);
  if (!allowedSymbols.length || !allowedMarketTypes.length || !allowedOrderTypes.length) throw badRequest("Allowed symbols, market types, and order types cannot be empty.");
  return {
    group_id: body.groupId,
    follower_user_id: userId,
    broker_connection_id: body.connectionId,
    status: "PENDING_CONSENT",
    execution_mode: body.executionMode === "HYBRID" ? "HYBRID" : "CLOUD_DELEGATED",
    allocation_method: body.allocationMethod,
    allocation_value: positive(body.allocationValue, "allocationValue"),
    max_order_notional: positive(body.maxOrderNotional, "maxOrderNotional"),
    max_total_exposure: positive(body.maxTotalExposure, "maxTotalExposure"),
    max_daily_loss: positive(body.maxDailyLoss, "maxDailyLoss"),
    max_drawdown: positive(body.maxDrawdown, "maxDrawdown"),
    max_leverage: positive(body.maxLeverage, "maxLeverage"),
    allowed_symbols: allowedSymbols,
    allowed_market_types: allowedMarketTypes,
    allowed_order_types: allowedOrderTypes,
    allow_overnight: Boolean(body.allowOvernight),
    allow_weekend: Boolean(body.allowWeekend),
    allow_reduce_only: body.allowReduceOnly !== false,
    allow_position_reversal: Boolean(body.allowPositionReversal),
    allow_open_positions: body.allowOpenPositions !== false,
    allow_close_positions: body.allowClosePositions !== false,
    allow_modify_protection: body.allowModifyProtection !== false,
    allow_withdrawals: false,
    allow_asset_transfers: false,
    protective_orders_required: Boolean(body.protectiveOrdersRequired),
    slippage_limit_bps: Math.max(0, Math.min(10000, Number(body.slippageLimitBps || 50))),
    expires_at: body.expiresAt || null,
    accepted_at: null,
    consent_hash: null
  };
}

async function ownedConnection(supabase, userId, id) {
  const { data, error } = await supabase.from("connectivity_connections").select("*").eq("id", id).eq("user_id", userId).single();
  if (error || !data) throw forbidden("Broker connection was not found.");
  return data;
}

async function activeMembership(supabase, userId, groupId) {
  const { data } = await supabase.from("investment_group_members").select("id").eq("group_id", groupId).eq("user_id", userId).eq("status", "active").maybeSingle();
  if (data) return data;
  const { data: group } = await supabase.from("investment_groups").select("id").eq("id", groupId).eq("owner_user_id", userId).maybeSingle();
  return group;
}

async function ownedMandate(supabase, userId, id) {
  const { data, error } = await supabase.from("group_execution_mandates").select("*").eq("id", id).eq("follower_user_id", userId).single();
  if (error || !data) throw forbidden("Execution mandate was not found.");
  return data;
}

function safeMandate(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    connectionId: row.broker_connection_id,
    status: row.status,
    executionMode: row.execution_mode,
    allocationMethod: row.allocation_method,
    allocationValue: Number(row.allocation_value),
    maxOrderNotional: Number(row.max_order_notional),
    maxTotalExposure: Number(row.max_total_exposure),
    maxDailyLoss: Number(row.max_daily_loss),
    maxDrawdown: Number(row.max_drawdown),
    maxLeverage: Number(row.max_leverage),
    allowedSymbols: row.allowed_symbols,
    allowedMarketTypes: row.allowed_market_types,
    allowedOrderTypes: row.allowed_order_types,
    protectiveOrdersRequired: row.protective_orders_required,
    allowOpenPositions: row.allow_open_positions,
    allowClosePositions: row.allow_close_positions,
    allowModifyProtection: row.allow_modify_protection,
    mandateVersion: row.mandate_version,
    acceptedAt: row.accepted_at,
    expiresAt: row.expires_at,
    withdrawalPermission: "NONE"
  };
}

async function auditMandate(supabase, userId, mandate, eventType, message) {
  const { error } = await supabase.from("execution_audit_events").insert({
    user_id: userId, connection_id: mandate.broker_connection_id, group_id: mandate.group_id,
    event_type: eventType, severity: eventType === "MANDATE_REVOKED" ? "WARNING" : "INFO",
    operation_purpose: "investor_mandate", message,
    safe_metadata: { mandateId: mandate.id, status: mandate.status, version: mandate.mandate_version }
  });
  if (error) throw error;
}

function normalizeList(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item).trim().toUpperCase()).filter(Boolean))];
}

function positive(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw badRequest(`${name} must be greater than zero.`);
  return parsed;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function forbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}
