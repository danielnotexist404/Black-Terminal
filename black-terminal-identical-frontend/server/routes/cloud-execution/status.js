import { applyCors, requireMethod, requireUser, sendError } from "../../portfolio-api.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    requireMethod(req, "GET");
    const { supabase, user } = await requireUser(req);
    const [connections, mandates, automationMandates, deployments, plans, incidents] = await Promise.all([
      supabase.from("connectivity_connections").select("id,account_id,provider,label,account_reference,connection_mode,execution_capability,health_status,lifecycle_status,control_state,credential_state,worker_state,synchronization_state,execution_readiness,last_heartbeat_at,last_account_event_at,last_order_event_at,last_private_event_at,last_position_sync_at,last_reconciled_at,reconnect_attempts,current_lease_generation,degradation_reasons,last_error_code,paused_at,emergency_stopped_at,revoked_at").eq("user_id", user.id),
      supabase.from("group_execution_mandates").select("id,group_id,broker_connection_id,status,execution_mode,allocation_method,allocation_value,max_leverage,allowed_symbols,mandate_version,accepted_at,expires_at").eq("follower_user_id", user.id),
      supabase.from("broker_automation_mandates").select("id,connection_id,broker,account_reference,status,allow_read,allow_trade,allow_cancel,allow_modify,allow_strategy_execution,allow_copy_trading,allow_investment_group_execution,max_order_notional,max_position_notional,max_leverage,max_daily_loss,mandate_version,accepted_at,expires_at,revoked_at").eq("user_id", user.id),
      supabase.from("strategy_deployments").select("id,connection_id,strategy_id,strategy_version,symbol,timeframe,status,deployed_at,last_heartbeat_at").eq("user_id", user.id),
      supabase.from("follower_execution_plans").select("id,group_intent_id,mandate_id,broker_connection_id,target_notional,rounded_quantity,risk_result,rejection_reason,execution_status,created_at,updated_at").eq("follower_user_id", user.id).order("created_at", { ascending: false }).limit(100),
      supabase.from("execution_incidents").select("id,severity,incident_type,connection_id,status,title,created_at,resolved_at").eq("user_id", user.id).neq("status", "RESOLVED")
    ]);
    for (const result of [connections, mandates, automationMandates, deployments, plans, incidents]) if (result.error) throw result.error;
    return res.status(200).json({
      connections: connections.data,
      mandates: mandates.data,
      automationMandates: automationMandates.data,
      strategyDeployments: deployments.data,
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
