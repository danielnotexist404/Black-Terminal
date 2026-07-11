import { applyCors, getOwnedAccount, requireMethod, requireUser, sendError } from "../../portfolio-api.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "DELETE");

    const { supabase, user } = await requireUser(req);
    const accountId = req.query.accountId;
    const account = await getOwnedAccount(supabase, user.id, accountId);

    const { error } = await supabase
      .from("exchange_accounts")
      .delete()
      .eq("id", account.id)
      .eq("user_id", user.id);

    if (error) throw error;

    await supabase.from("execution_audit_logs").insert({
      user_id: user.id,
      account_id: account.id,
      event_type: "exchange_account_deleted",
      severity: "warning",
      message: `Deleted ${account.exchange} account ${account.account_name}.`,
      metadata: { exchange: account.exchange }
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    return sendError(res, error);
  }
}
