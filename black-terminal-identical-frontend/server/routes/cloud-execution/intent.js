import crypto from "node:crypto";
import { applyCors, requireFields, requireMethod, requireUser, sendError } from "../../portfolio-api.js";
import { hashCanonicalPayload, intentSigningPayload, signCanonicalPayload } from "../../cloud-execution/canonical.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    requireMethod(req, "POST");
    const { supabase, user } = await requireUser(req);
    requireFields(req.body, ["groupId", "clientIntentId", "symbol", "marketType", "side", "orderType", "quantityModel", "quantityValue", "expiresAt"]);
    if (process.env.INVESTMENT_GROUP_EXECUTION_ENABLED !== "true") throw forbidden("Investment Group execution is disabled by rollout policy.");
    await requireGroupTrader(supabase, user.id, req.body.groupId);
    const intentId = crypto.randomUUID();
    const idempotencyKey = hashCanonicalPayload({ groupId: req.body.groupId, clientIntentId: req.body.clientIntentId });
    const validFrom = new Date(req.body.validFrom || Date.now()).toISOString();
    const expiresAt = new Date(req.body.expiresAt).toISOString();
    if (Date.parse(expiresAt) <= Date.parse(validFrom)) throw badRequest("Intent expiration must be after its activation time.");
    if (Date.parse(expiresAt) - Date.parse(validFrom) > 7 * 24 * 60 * 60 * 1000) throw badRequest("Group intents cannot remain valid for more than seven days.");

    const row = {
      id: intentId,
      group_id: req.body.groupId,
      strategy_id: req.body.strategyId || null,
      created_by: user.id,
      client_intent_id: String(req.body.clientIntentId),
      symbol: String(req.body.symbol).replace(/[^a-zA-Z0-9]/g, "").toUpperCase(),
      market_type: String(req.body.marketType).toUpperCase(),
      side: String(req.body.side).toUpperCase(),
      order_type: String(req.body.orderType).replaceAll("-", "_").toUpperCase(),
      limit_price: nullablePositive(req.body.limitPrice),
      stop_price: nullablePositive(req.body.stopPrice),
      quantity_model: String(req.body.quantityModel).toUpperCase(),
      quantity_value: positive(req.body.quantityValue, "quantityValue"),
      leverage: nullablePositive(req.body.leverage),
      margin_mode: req.body.marginMode ? String(req.body.marginMode).toUpperCase() : null,
      time_in_force: req.body.timeInForce ? String(req.body.timeInForce).replaceAll("-", "_").toUpperCase() : null,
      reduce_only: Boolean(req.body.reduceOnly),
      take_profit: nullablePositive(req.body.takeProfit),
      stop_loss: nullablePositive(req.body.stopLoss),
      trailing_stop: req.body.trailingStop || null,
      valid_from: validFrom,
      expires_at: expiresAt,
      status: "QUEUED",
      intent_version: 1,
      mandate_policy_version: Number(req.body.mandatePolicyVersion || 1),
      idempotency_key: idempotencyKey,
      supersedes_intent_id: req.body.supersedesIntentId || null
    };
    const envelope = intentSigningPayload(row);
    row.canonical_hash = hashCanonicalPayload(envelope);
    row.service_signature = signCanonicalPayload(envelope);

    const { data: intent, error: intentError } = await supabase.from("group_trade_intents").insert(row).select("*").single();
    if (intentError) throw intentError;
    const { error: versionError } = await supabase.from("group_trade_intent_versions").insert({
      group_intent_id: intent.id,
      version: 1,
      canonical_payload: envelope,
      canonical_hash: row.canonical_hash,
      service_signature: row.service_signature,
      created_by: user.id
    });
    if (versionError) throw versionError;
    const { error: commandError } = await supabase.from("execution_commands").insert({
      command_type: "EXPAND_GROUP_INTENT",
      group_intent_id: intent.id,
      idempotency_key: `expand:${idempotencyKey}`,
      payload: { groupIntentId: intent.id },
      status: "QUEUED",
      priority: 20
    });
    if (commandError) throw commandError;
    await supabase.from("execution_audit_events").insert({
      user_id: user.id,
      group_id: intent.group_id,
      group_intent_id: intent.id,
      event_type: "GROUP_INTENT_CREATED",
      severity: "INFO",
      operation_purpose: "investment_group_execution",
      message: "A signed Investment Group intent was accepted by the control plane.",
      safe_metadata: { symbol: intent.symbol, marketType: intent.market_type, orderType: intent.order_type, expiresAt: intent.expires_at }
    });
    return res.status(202).json({
      intent: {
        id: intent.id,
        groupId: intent.group_id,
        symbol: intent.symbol,
        marketType: intent.market_type,
        side: intent.side,
        orderType: intent.order_type,
        status: intent.status,
        expiresAt: intent.expires_at,
        intentVersion: intent.intent_version
      },
      delivery: "QUEUED_FOR_BLACK_CLOUD"
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function requireGroupTrader(supabase, userId, groupId) {
  const { data: group } = await supabase.from("investment_groups").select("owner_user_id").eq("id", groupId).single();
  if (group?.owner_user_id === userId) return;
  const { data: member } = await supabase.from("investment_group_members").select("role,status").eq("group_id", groupId).eq("user_id", userId).maybeSingle();
  if (member?.status === "active" && ["owner", "manager"].includes(member.role)) return;
  throw forbidden("Only the Investment Group owner or an active manager may create trade intents.");
}

function positive(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw badRequest(`${name} must be greater than zero.`);
  return parsed;
}

function nullablePositive(value) {
  if (value === undefined || value === null || value === "") return null;
  return positive(value, "price");
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
