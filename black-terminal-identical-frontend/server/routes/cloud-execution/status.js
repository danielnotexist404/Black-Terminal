import { applyCors, requireMethod, requireUser, sendError } from "../../portfolio-api.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    requireMethod(req, "GET");
    const { supabase, user } = await requireUser(req);
    const [connections, mandates, plans, incidents] = await Promise.all([
      supabase.from("connectivity_connections").select("id,account_id,provider,label,account_reference,connection_mode,execution_capability,health_status,lifecycle_status,control_state,last_private_event_at,last_reconciled_at,last_error_code,paused_at,emergency_stopped_at,revoked_at").eq("user_id", user.id),
      supabase.from("group_execution_mandates").select("id,group_id,broker_connection_id,status,execution_mode,allocation_method,allocation_value,max_leverage,allowed_symbols,mandate_version,accepted_at,expires_at").eq("follower_user_id", user.id),
      supabase.from("follower_execution_plans").select("id,group_intent_id,mandate_id,broker_connection_id,target_notional,rounded_quantity,risk_result,rejection_reason,execution_status,created_at,updated_at").eq("follower_user_id", user.id).order("created_at", { ascending: false }).limit(100),
      supabase.from("execution_incidents").select("id,severity,incident_type,connection_id,status,title,created_at,resolved_at").eq("user_id", user.id).neq("status", "RESOLVED")
    ]);
    for (const result of [connections, mandates, plans, incidents]) if (result.error) throw result.error;
    return res.status(200).json({
      connections: connections.data,
      mandates: mandates.data,
      recentPlans: plans.data,
      openIncidents: incidents.data,
      capabilityLabels: {
        CLOUD_DELEGATED: "Orders may execute while Black Terminal and this device are offline.",
        LOCAL_INTERACTIVE: "Orders execute only while this device and wallet session remain available."
      }
    });
  } catch (error) {
    return sendError(res, error);
  }
}
