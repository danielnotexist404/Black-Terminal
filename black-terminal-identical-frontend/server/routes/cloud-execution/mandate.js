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
  if (!connection.account_id) throw forbidden("The broker connection is not linked to a canonical account.");
  if (connection.connection_mode !== "CLOUD_DELEGATED" && connection.connection_mode !== "HYBRID") throw forbidden("A cloud-delegated or hybrid connection is required.");
  if (connection.health_status !== "CONNECTED_CLOUD" && connection.health_status !== "CONNECTED_HYBRID") throw forbidden("The cloud connection must be healthy and reconciled first.");
  const membership = await activeMembership(supabase, userId, req.body.groupId);
  if (!membership || membership.role !== "member" || membership.participation_method !== "COPY_TRADING" || !["APPROVED", "ACTIVATING", "ACTIVE", "PAUSED_BY_USER", "PAUSED_BY_MANAGER"].includes(membership.membership_state)) {
    throw forbidden("A versioned, approved Copy-Trading membership is required.");
  }
  const [capabilities, automation, acknowledgement, conflict] = await Promise.all([
    ownedCapability(supabase, userId, connection.id),
    activeAutomationMandate(supabase, userId, connection.id),
    currentRiskAcknowledgement(supabase, userId, req.body.groupId),
    conflictingGroupMandate(supabase, userId, connection.id, connection.account_id, req.body.groupId)
  ]);
  if (!acknowledgement) throw forbidden("The active Investment Group risk disclosure must be accepted first.");
  if (capabilities.can_withdraw || capabilities.can_transfer) throw forbidden("Withdrawal- or transfer-capable broker authority is prohibited.");
  if (!capabilities.can_copy_trade || !capabilities.can_receive_group_orders || !capabilities.can_execute_while_offline) throw forbidden("The broker connection lacks certified persistent Copy-Trading capability.");
  if (!automation?.allow_copy_trading || !automation?.allow_investment_group_execution || automation.allow_withdrawals) throw forbidden("An active, withdrawal-prohibited broker automation mandate is required.");
  if (conflict) throw forbidden("This broker account is already assigned to another active Investment Group mandate.");

  const payload = normalizeMandate(req.body, userId, connection.account_id, membership.id);
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
  const membership = await activeMembership(supabase, userId, mandate.group_id);
  if (!membership || !["APPROVED", "ACTIVATING", "ACTIVE"].includes(membership.membership_state)) throw forbidden("Manager approval and an activatable membership are required before mandate activation.");
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

function normalizeMandate(body, userId, brokerAccountId, membershipId) {
  const allowedSymbols = normalizeList(body.allowedSymbols);
  const allowedMarketTypes = normalizeList(body.allowedMarketTypes);
  const allowedOrderTypes = normalizeList(body.allowedOrderTypes);
  if (!allowedSymbols.length || !allowedMarketTypes.length || !allowedOrderTypes.length) throw badRequest("Allowed symbols, market types, and order types cannot be empty.");
  return {
    group_id: body.groupId,
    follower_user_id: userId,
    broker_connection_id: body.connectionId,
    broker_account_id: brokerAccountId,
    membership_id: membershipId,
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
  const { data } = await supabase.from("investment_group_members").select("id,role,participation_method,membership_state,risk_acknowledgement_version").eq("group_id", groupId).eq("user_id", userId).maybeSingle();
  return data;
}

async function ownedCapability(supabase, userId, connectionId) {
  const { data, error } = await supabase.from("broker_connection_capabilities").select("*").eq("connection_id", connectionId).eq("user_id", userId).single();
  if (error || !data) throw forbidden("Broker capability record was not found.");
  return data;
}

async function activeAutomationMandate(supabase, userId, connectionId) {
  const { data, error } = await supabase.from("broker_automation_mandates").select("allow_copy_trading,allow_investment_group_execution,allow_withdrawals").eq("connection_id", connectionId).eq("user_id", userId).eq("status", "ACTIVE").maybeSingle();
  if (error) throw error;
  return data;
}

async function currentRiskAcknowledgement(supabase, userId, groupId) {
  const { data: document, error: documentError } = await supabase.from("group_risk_disclosure_documents").select("version,document_hash").eq("status", "ACTIVE").order("effective_at", { ascending: false }).limit(1).maybeSingle();
  if (documentError) throw documentError;
  if (!document) return null;
  const { data, error } = await supabase.from("group_risk_acknowledgements").select("id").eq("user_id", userId).eq("group_id", groupId).eq("disclosure_version", document.version).eq("document_hash", document.document_hash).maybeSingle();
  if (error) throw error;
  return data;
}

async function conflictingGroupMandate(supabase, userId, connectionId, brokerAccountId, groupId) {
  const [accountResult, connectionResult] = await Promise.all([
    supabase.from("group_execution_mandates").select("id").eq("follower_user_id", userId).eq("broker_account_id", brokerAccountId).neq("group_id", groupId).in("status", ["ACTIVE", "PAUSED", "EXIT_ONLY"]).limit(1).maybeSingle(),
    supabase.from("group_execution_mandates").select("id").eq("follower_user_id", userId).eq("broker_connection_id", connectionId).neq("group_id", groupId).in("status", ["ACTIVE", "PAUSED", "EXIT_ONLY"]).limit(1).maybeSingle()
  ]);
  if (accountResult.error) throw accountResult.error;
  if (connectionResult.error) throw connectionResult.error;
  return accountResult.data || connectionResult.data;
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
