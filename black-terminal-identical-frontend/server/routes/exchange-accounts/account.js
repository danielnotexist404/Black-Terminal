import { applyCors, getOwnedAccount, requireMethod, requireUser, sendError } from "../../portfolio-api.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "DELETE");

    const { supabase, user } = await requireUser(req);
    const accountId = req.query.accountId;
    const account = await getOwnedAccount(supabase, user.id, accountId);
    const accountIdsToDelete = [account.id];
    const now = new Date().toISOString();
    const { data: cloudConnections } = await supabase.from("connectivity_connections").select("id").eq("user_id", user.id).eq("account_id", account.id);
    const connectionIds = (cloudConnections || []).map((connection) => connection.id);
    if (connectionIds.length > 0) {
      await Promise.allSettled([
        supabase.from("broker_automation_mandates").update({ status: "REVOKED", revoked_at: now, updated_at: now }).eq("user_id", user.id).in("connection_id", connectionIds),
        supabase.from("group_execution_mandates").update({ status: "REVOKED", revoked_at: now, updated_at: now }).eq("follower_user_id", user.id).in("broker_connection_id", connectionIds),
        supabase.from("strategy_deployments").update({ status: "STOPPED", updated_at: now }).eq("user_id", user.id).in("connection_id", connectionIds),
        supabase.from("broker_secret_references").update({ status: "REVOKED", revoked_at: now }).eq("user_id", user.id).in("connection_id", connectionIds),
        supabase.from("broker_secret_vault").update({ rotation_status: "REVOKED", revoked_at: now }).eq("user_id", user.id).in("connection_id", connectionIds),
        supabase.from("connectivity_connections").update({ lifecycle_status: "REVOKED", health_status: "REVOKED", credential_state: "REVOKED", execution_readiness: "BLOCKED", revoked_at: now, disabled_at: now, last_error_code: "USER_DISCONNECTED" }).eq("user_id", user.id).in("id", connectionIds)
      ]);
    }

    const { error } = await supabase
      .from("exchange_accounts")
      .delete()
      .in("id", accountIdsToDelete)
      .eq("user_id", user.id);

    if (error) throw error;

    await supabase.from("execution_audit_logs").insert({
      user_id: user.id,
      account_id: null,
      event_type: "exchange_account_deleted",
      severity: "warning",
      message: `Disconnected ${account.exchange} account ${account.account_name} and revoked stored execution authorization.`,
      metadata: { exchange: account.exchange, removedAccountIds: accountIdsToDelete, revokedConnectionIds: connectionIds, brokerNativeOrdersPreserved: true }
    });

    return res.status(200).json({ ok: true, removedAccountIds: accountIdsToDelete });
  } catch (error) {
    return sendError(res, error);
  }
}
