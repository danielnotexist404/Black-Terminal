import {
  applyCors,
  decryptCredentialPayload,
  getOwnedAccount,
  requireFields,
  requireMethod,
  requireUser,
  sendError
} from "../../portfolio-api.js";
import { cancelAllBybitOrders, validateBybitManagementGate } from "../../exchanges/bybit.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");
    requireFields(req.body, ["accountId", "symbol"]);

    const { supabase, user } = await requireUser(req);
    const account = await getOwnedAccount(supabase, user.id, req.body.accountId);
    if (account.exchange !== "bybit") {
      const unsupported = new Error(`${account.exchange} cancel-all is not certified yet.`);
      unsupported.statusCode = 501;
      throw unsupported;
    }

    const gate = validateBybitManagementGate({ account, body: req.body, symbol: req.body.symbol });
    if (!gate.ok) {
      const blocked = new Error(gate.reasons.join(" "));
      blocked.statusCode = 403;
      throw blocked;
    }

    const { data: credential, error: credentialError } = await supabase
      .from("exchange_credentials")
      .select("encrypted_payload")
      .eq("account_id", account.id)
      .single();

    if (credentialError || !credential) throw credentialError || new Error("Missing encrypted credentials for venue cancel-all.");
    const credentials = decryptCredentialPayload(credential.encrypted_payload);
    const result = await cancelAllBybitOrders(credentials, {
      marketKind: req.body.marketKind || "perpetual",
      symbol: String(req.body.symbol).toUpperCase()
    });

    await supabase
      .from("execution_orders")
      .update({ status: "cancelled" })
      .eq("user_id", user.id)
      .eq("account_id", account.id)
      .eq("symbol", String(req.body.symbol).toUpperCase())
      .in("status", ["pending", "accepted", "working", "partially-filled"]);

    await supabase.from("execution_audit_logs").insert({
      user_id: user.id,
      account_id: account.id,
      event_type: "cancel_all_submitted",
      severity: "warning",
      message: `Bybit cancel-all submitted for ${req.body.symbol}.`,
      metadata: result
    }).catch(() => null);

    return res.status(200).json({ result });
  } catch (error) {
    return sendError(res, error);
  }
}
