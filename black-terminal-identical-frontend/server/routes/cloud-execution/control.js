import crypto from "node:crypto";
import { applyCors, requireFields, requireMethod, requireUser, sendError } from "../../portfolio-api.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    requireMethod(req, "POST");
    const { supabase, user } = await requireUser(req);
    requireFields(req.body, ["connectionId", "action"]);
    const connection = await ownedConnection(supabase, user.id, req.body.connectionId);
    const action = canonicalAction(req.body.action);
    const now = new Date().toISOString();
    let outcome = { monitoring: "ACTIVE", reconciliation: "ACTIVE", protectiveOrders: "PRESERVED", queuedCommands: 0 };

    if (action === "PAUSE_NEW_ENTRIES") {
      await updateConnection(supabase, connection.id, { control_state: "PAUSED", paused_at: now, execution_readiness: "PAUSED" });
      await requireResult(supabase.from("strategy_deployments").update({ status: "PAUSED" }).eq("connection_id", connection.id).in("status", ["DEPLOYED", "RUNNING", "DEGRADED"]));
    } else if (action === "RESUME") {
      await requireActiveMandate(supabase, connection.id);
      await updateConnection(supabase, connection.id, { control_state: "ACTIVE", paused_at: null, emergency_stopped_at: null, emergency_stop_reason: null, execution_readiness: "BLOCKED" });
    } else if (action === "STOP_STRATEGY") {
      if (!req.body.strategyDeploymentId) throw badRequest("strategyDeploymentId is required to stop a strategy.");
      const { data, error } = await supabase.from("strategy_deployments").update({ status: "STOPPED" })
        .eq("id", req.body.strategyDeploymentId).eq("connection_id", connection.id).eq("user_id", user.id).select("id").single();
      if (error || !data) throw forbidden("The strategy deployment was not found.");
    } else if (action === "CANCEL_ENTRY_ORDERS") {
      outcome.queuedCommands = await queueWorkingOrderCancellations(supabase, user.id, connection, false);
    } else if (action === "CANCEL_ALL") {
      if (req.body.cancelProtectiveOrders === true) {
        await queueCommand(supabase, {
          command_type: "CANCEL_ALL", user_id: user.id, connection_id: connection.id,
          idempotency_key: `cancel-all:${connection.id}:${Date.now()}`,
          payload: { request: {}, cancelProtectiveOrders: true, requestedBy: "connection-control" }, priority: 1
        });
        outcome.queuedCommands = 1;
        outcome.protectiveOrders = "CANCELLATION_REQUESTED";
      } else {
        outcome.queuedCommands = await queueWorkingOrderCancellations(supabase, user.id, connection, false);
      }
    } else if (action === "CLOSE_STRATEGY_POSITIONS") {
      throw conflict("Strategy-position attribution is not complete; Black Cloud refused to close unrelated account positions.", "STRATEGY_POSITION_ATTRIBUTION_REQUIRED");
    } else if (action === "REVOKE_MANDATE") {
      await requireResult(supabase.from("broker_automation_mandates").update({ status: "REVOKED", revoked_at: now })
        .eq("connection_id", connection.id).eq("user_id", user.id).eq("status", "ACTIVE"));
      await requireResult(supabase.from("group_execution_mandates").update({ status: "REVOKED", revoked_at: now })
        .eq("broker_connection_id", connection.id).eq("follower_user_id", user.id).in("status", ["ACTIVE", "PAUSED"]));
      await updateConnection(supabase, connection.id, { control_state: "PAUSED", execution_readiness: "REVOKED" });
      outcome.monitoring = "STOPPING";
    } else if (action === "DISCONNECT_BROKER") {
      await updateConnection(supabase, connection.id, {
        connection_mode: "DISABLED", execution_capability: "NONE", control_state: "PAUSED",
        health_status: "OFFLINE", worker_state: "OFFLINE", execution_readiness: "BLOCKED", disabled_at: now
      });
      outcome.monitoring = "STOPPING";
      outcome.reconciliation = "STOPPING";
    } else if (action === "EMERGENCY_ACCOUNT_LOCK") {
      await updateConnection(supabase, connection.id, {
        control_state: "EMERGENCY_STOP", emergency_stopped_at: now,
        emergency_stop_reason: req.body.reason || "user_requested", execution_readiness: "BLOCKED"
      });
      if (connection.account_id) await requireResult(supabase.from("exchange_accounts").update({ trading_enabled: false }).eq("id", connection.account_id).eq("user_id", user.id));
      await requireResult(supabase.from("broker_automation_mandates").update({ status: "PAUSED", paused_at: now }).eq("connection_id", connection.id).eq("status", "ACTIVE"));
      await requireResult(supabase.from("group_execution_mandates").update({ status: "PAUSED", paused_at: now }).eq("broker_connection_id", connection.id).eq("status", "ACTIVE"));
      await requireResult(supabase.from("strategy_deployments").update({ status: "PAUSED" }).eq("connection_id", connection.id).in("status", ["DEPLOYED", "RUNNING", "DEGRADED"]));
    }

    const eventType = `${action}_REQUESTED`;
    const message = controlMessage(action, outcome);
    const auditResults = await Promise.all([
      supabase.from("execution_audit_events").insert({
        user_id: user.id, connection_id: connection.id, event_type: eventType,
        severity: action === "EMERGENCY_ACCOUNT_LOCK" ? "CRITICAL" : action.includes("REVOKE") || action.includes("DISCONNECT") ? "WARNING" : "INFO",
        operation_purpose: "connection_control", message,
        safe_metadata: { action, queuedCommands: outcome.queuedCommands, protectiveOrders: outcome.protectiveOrders }
      }),
      supabase.from("connection_audit_events").insert({
        user_id: user.id, connection_id: connection.id, event_type: eventType,
        severity: action === "EMERGENCY_ACCOUNT_LOCK" ? "CRITICAL" : "INFO", message,
        safe_metadata: { queuedCommands: outcome.queuedCommands, protectiveOrders: outcome.protectiveOrders }
      })
    ]);
    for (const result of auditResults) if (result?.error) throw result.error;
    const current = await ownedConnection(supabase, user.id, connection.id);
    return res.status(200).json({ connection: current, action, ...outcome, newOrders: current.control_state === "ACTIVE" ? "ENABLED_AFTER_RECONCILIATION" : "BLOCKED" });
  } catch (error) {
    return sendError(res, error);
  }
}

function canonicalAction(value) {
  return ({
    pause: "PAUSE_NEW_ENTRIES", "pause-new-entries": "PAUSE_NEW_ENTRIES", resume: "RESUME",
    "stop-strategy": "STOP_STRATEGY", "cancel-entry-orders": "CANCEL_ENTRY_ORDERS", "cancel-all": "CANCEL_ALL",
    "close-strategy-positions": "CLOSE_STRATEGY_POSITIONS", "revoke-mandate": "REVOKE_MANDATE",
    "disconnect-broker": "DISCONNECT_BROKER", "emergency-stop": "EMERGENCY_ACCOUNT_LOCK",
    "emergency-account-lock": "EMERGENCY_ACCOUNT_LOCK"
  })[value] || String(value).toUpperCase();
}

async function queueWorkingOrderCancellations(supabase, userId, connection) {
  if (!connection.account_id) return 0;
  const { data, error } = await supabase.from("execution_orders")
    .select("id,symbol,exchange_order_id,client_order_id,order_type,origin")
    .eq("user_id", userId).eq("account_id", connection.account_id)
    .in("status", ["accepted", "working", "partially-filled"])
    .neq("origin", "PROTECTIVE");
  if (error) throw error;
  let queued = 0;
  for (const order of data || []) {
    await queueCommand(supabase, {
      command_type: "CANCEL_ORDER", user_id: userId, connection_id: connection.id, execution_order_id: order.id,
      idempotency_key: `cancel-entry:${order.id}:${crypto.createHash("sha256").update(String(order.exchange_order_id || order.client_order_id)).digest("hex").slice(0, 12)}`,
      payload: { request: { symbol: order.symbol, orderId: order.exchange_order_id, clientOrderId: order.client_order_id } }, priority: 1
    });
    queued += 1;
  }
  return queued;
}

async function queueCommand(supabase, command) {
  const { error } = await supabase.from("execution_commands").upsert({ ...command, status: "QUEUED" }, { onConflict: "idempotency_key", ignoreDuplicates: true });
  if (error) throw error;
}

async function requireActiveMandate(supabase, connectionId) {
  const { data } = await supabase.from("broker_automation_mandates").select("id,expires_at").eq("connection_id", connectionId).eq("status", "ACTIVE").maybeSingle();
  if (!data || (data.expires_at && Date.parse(data.expires_at) <= Date.now())) throw forbidden("An active, unexpired automation mandate is required before resuming.");
}

async function ownedConnection(supabase, userId, id) {
  const { data, error } = await supabase.from("connectivity_connections").select("*").eq("id", id).eq("user_id", userId).single();
  if (error || !data) throw forbidden("Broker connection was not found.");
  return data;
}

async function updateConnection(supabase, id, patch) {
  const { error } = await supabase.from("connectivity_connections").update(patch).eq("id", id);
  if (error) throw error;
}

function controlMessage(action, outcome) {
  const labels = {
    PAUSE_NEW_ENTRIES: "New entries were paused; account monitoring and protective orders remain active.",
    RESUME: "Execution resume was authorized; reconciliation must be healthy before new entries.",
    STOP_STRATEGY: "The selected strategy deployment was stopped.",
    CANCEL_ENTRY_ORDERS: "Working entry-order cancellations were queued; protective orders were preserved.",
    CANCEL_ALL: outcome.protectiveOrders === "CANCELLATION_REQUESTED" ? "Cancellation of all broker orders, including protection, was explicitly requested." : "Working entry-order cancellations were queued; protective orders were preserved.",
    REVOKE_MANDATE: "Persistent automation authority was revoked.",
    DISCONNECT_BROKER: "The persistent broker session was disabled.",
    EMERGENCY_ACCOUNT_LOCK: "The account was locked against new execution; protective orders were preserved."
  };
  return labels[action] || "A connection control action was recorded.";
}

function badRequest(message) { return Object.assign(new Error(message), { statusCode: 400 }); }
function forbidden(message) { return Object.assign(new Error(message), { statusCode: 403 }); }
function conflict(message, code) { return Object.assign(new Error(message), { statusCode: 409, code }); }
async function requireResult(query) { const result = await query; if (result?.error) throw result.error; return result; }
