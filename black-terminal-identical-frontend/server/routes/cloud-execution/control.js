import { applyCors, requireFields, requireMethod, requireUser, sendError } from "../../portfolio-api.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    requireMethod(req, "POST");
    const { supabase, user } = await requireUser(req);
    requireFields(req.body, ["connectionId", "action"]);
    const { data: connection, error: connectionError } = await supabase.from("connectivity_connections")
      .select("id,user_id,provider,connection_mode,control_state,lifecycle_status")
      .eq("id", req.body.connectionId).eq("user_id", user.id).single();
    if (connectionError || !connection) throw forbidden("Broker connection was not found.");

    const now = new Date().toISOString();
    const action = req.body.action;
    const patch = action === "pause"
      ? { control_state: "PAUSED", paused_at: now }
      : action === "resume"
        ? { control_state: "ACTIVE", paused_at: null, emergency_stopped_at: null, emergency_stop_reason: null }
        : { control_state: "EMERGENCY_STOP", emergency_stopped_at: now, emergency_stop_reason: req.body.reason || "user_requested" };
    const { data, error } = await supabase.from("connectivity_connections").update(patch)
      .eq("id", connection.id).eq("user_id", user.id).select("id,provider,connection_mode,control_state,lifecycle_status,paused_at,emergency_stopped_at").single();
    if (error) throw error;

    if (action !== "resume") {
      await supabase.from("group_execution_mandates").update({ status: "PAUSED", paused_at: now })
        .eq("broker_connection_id", connection.id).eq("follower_user_id", user.id).eq("status", "ACTIVE");
    }
    await supabase.from("execution_audit_events").insert({
      user_id: user.id,
      connection_id: connection.id,
      event_type: action === "emergency-stop" ? "EMERGENCY_STOP_ACTIVATED" : action === "pause" ? "CONNECTION_PAUSED" : "CONNECTION_RESUMED",
      severity: action === "emergency-stop" ? "WARNING" : "INFO",
      operation_purpose: "connection_control",
      message: action === "emergency-stop"
        ? "New execution was stopped; monitoring and reconciliation remain active."
        : action === "pause" ? "New execution was paused; monitoring remains active." : "Broker connection execution was resumed.",
      safe_metadata: { action, provider: connection.provider }
    });
    return res.status(200).json({ connection: data, monitoring: "ACTIVE", reconciliation: "ACTIVE", newOrders: data.control_state === "ACTIVE" ? "ENABLED" : "BLOCKED" });
  } catch (error) {
    return sendError(res, error);
  }
}

function forbidden(message) {
  return Object.assign(new Error(message), { statusCode: 403 });
}
