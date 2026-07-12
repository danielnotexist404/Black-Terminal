import {
  applyCors,
  decryptCredentialPayload,
  getOwnedAccount,
  requireFields,
  requireMethod,
  requireUser,
  sendError
} from "../../portfolio-api.js";
import { stopBybitStrategy, validateBybitManagementGate } from "../../exchanges/bybit.js";
import { settleSupabaseQuery } from "../../supabase-query.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");
    requireFields(req.body, ["accountId", "strategyId", "symbol"]);
    const { supabase, user } = await requireUser(req);
    const account = await getOwnedAccount(supabase, user.id, req.body.accountId);
    if (account.exchange !== "bybit") {
      const unsupported = new Error("Strategy management is currently available for Bybit only.");
      unsupported.statusCode = 400;
      throw unsupported;
    }

    const gate = validateBybitManagementGate({ account, body: req.body, symbol: req.body.symbol });
    if (!gate.ok) {
      const blocked = new Error(gate.reasons.join(" "));
      blocked.statusCode = 403;
      throw blocked;
    }

    const { data: credential, error } = await supabase
      .from("exchange_credentials")
      .select("encrypted_payload")
      .eq("account_id", account.id)
      .single();
    if (error || !credential) throw error || new Error("Missing encrypted credentials.");

    const report = await stopBybitStrategy(decryptCredentialPayload(credential.encrypted_payload), req.body.strategyId);
    await settleSupabaseQuery(supabase.from("execution_audit_logs").insert({
      user_id: user.id,
      account_id: account.id,
      event_type: "strategy_stop_submitted",
      severity: "warning",
      message: `Bybit strategy ${req.body.strategyId} stop submitted.`,
      metadata: { report, symbol: String(req.body.symbol).toUpperCase() }
    }));

    return res.status(200).json({ report });
  } catch (error) {
    return sendError(res, error);
  }
}
