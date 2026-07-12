import {
  applyCors,
  decryptCredentialPayload,
  getOwnedAccount,
  requireFields,
  requireMethod,
  requireUser,
  sendError
} from "../../portfolio-api.js";
import { settleSupabaseQuery } from "../../supabase-query.js";
import { modifyBybitOrder, validateBybitManagementGate } from "../../exchanges/bybit.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");
    requireFields(req.body, ["accountId", "symbol"]);

    const { supabase, user } = await requireUser(req);
    const account = await getOwnedAccount(supabase, user.id, req.body.accountId);
    if (account.exchange !== "bybit") {
      const unsupported = new Error(`${account.exchange} modify is not certified yet.`);
      unsupported.statusCode = 501;
      throw unsupported;
    }

    const gate = validateBybitManagementGate({ account, body: req.body, symbol: req.body.symbol });
    if (!gate.ok) {
      const blocked = new Error(gate.reasons.join(" "));
      blocked.statusCode = 403;
      throw blocked;
    }

    const existingOrder = req.body.localOrderId ? await loadLocalOrder(supabase, user.id, req.body.localOrderId) : null;
    const { data: credential, error: credentialError } = await supabase
      .from("exchange_credentials")
      .select("encrypted_payload")
      .eq("account_id", account.id)
      .single();

    if (credentialError || !credential) throw credentialError || new Error("Missing encrypted credentials for venue modify.");
    const credentials = decryptCredentialPayload(credential.encrypted_payload);
    const report = await modifyBybitOrder(credentials, {
      marketKind: req.body.marketKind || existingOrder?.market_kind || "perpetual",
      symbol: String(req.body.symbol || existingOrder?.symbol).toUpperCase(),
      orderId: req.body.exchangeOrderId || req.body.orderId || existingOrder?.exchange_order_id,
      clientOrderId: req.body.clientOrderId || existingOrder?.client_order_id,
      quantity: req.body.quantity,
      limitPrice: req.body.limitPrice,
      stopPrice: req.body.stopPrice,
      takeProfit: req.body.takeProfit,
      stopLoss: req.body.stopLoss
    });

    if (existingOrder?.id) {
      await supabase
        .from("execution_orders")
        .update({
          status: report.status,
          quantity: req.body.quantity ?? existingOrder.quantity,
          limit_price: req.body.limitPrice ?? existingOrder.limit_price,
          stop_price: req.body.stopPrice ?? existingOrder.stop_price,
          take_profit: req.body.takeProfit ?? existingOrder.take_profit,
          stop_loss: req.body.stopLoss ?? existingOrder.stop_loss
        })
        .eq("id", existingOrder.id)
        .eq("user_id", user.id);
    }

    await settleSupabaseQuery(supabase.from("execution_audit_logs").insert({
      user_id: user.id,
      account_id: account.id,
      order_id: existingOrder?.id || null,
      event_type: "modify_submitted",
      severity: "info",
      message: "Bybit modify submitted through certified adapter path.",
      metadata: { report, symbol: req.body.symbol }
    }));

    return res.status(200).json({ report });
  } catch (error) {
    return sendError(res, error);
  }
}

async function loadLocalOrder(supabase, userId, localOrderId) {
  const { data, error } = await supabase
    .from("execution_orders")
    .select("*")
    .eq("id", localOrderId)
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    const notFound = new Error("Order not found.");
    notFound.statusCode = 404;
    throw notFound;
  }
  return data;
}
