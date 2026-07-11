import { applyCors, decryptCredentialPayload, getOwnedAccount, requireFields, requireMethod, requireUser, sendError } from "../../portfolio-api.js";
import { cancelBybitOrder, validateBybitManagementGate } from "../../exchanges/bybit.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");

    const { supabase, user } = await requireUser(req);
    requireFields(req.body, ["orderId"]);

    const { data: existingOrder, error: lookupError } = await supabase
      .from("execution_orders")
      .select("*, exchange_accounts(exchange)")
      .eq("id", req.body.orderId)
      .eq("user_id", user.id)
      .single();

    if (lookupError || !existingOrder) {
      const error = new Error("Order not found.");
      error.statusCode = 404;
      throw error;
    }

    let venueCancelResult = null;
    const exchange = existingOrder.exchange_accounts?.exchange || existingOrder.exchange;
    if (exchange === "bybit" && existingOrder.exchange_order_id) {
      const account = await getOwnedAccount(supabase, user.id, existingOrder.account_id);
      const gate = validateBybitManagementGate({
        account,
        body: req.body,
        symbol: existingOrder.symbol
      });
      if (!gate.ok) {
        const blocked = new Error(gate.reasons.join(" "));
        blocked.statusCode = 403;
        throw blocked;
      }
      const { data: credential, error: credentialError } = await supabase
        .from("exchange_credentials")
        .select("encrypted_payload")
        .eq("account_id", existingOrder.account_id)
        .single();

      if (credentialError || !credential) throw credentialError || new Error("Missing encrypted credentials for venue cancel.");
      const credentials = decryptCredentialPayload(credential.encrypted_payload);
      venueCancelResult = await cancelBybitOrder(credentials, {
        marketKind: existingOrder.market_kind || "perpetual",
        symbol: existingOrder.symbol,
        orderId: existingOrder.exchange_order_id,
        clientOrderId: existingOrder.client_order_id
      });
    }

    const { data: order, error } = await supabase
      .from("execution_orders")
      .update({
        status: "cancelled",
        rejection_reason: existingOrder.status === "pending" ? null : existingOrder.rejection_reason
      })
      .eq("id", existingOrder.id)
      .eq("user_id", user.id)
      .select("*")
      .single();

    if (error) throw error;

    await supabase.from("execution_audit_logs").insert({
      user_id: user.id,
      account_id: order.account_id,
      order_id: order.id,
      event_type: "order_cancelled",
      severity: "info",
      message: `Order ${order.id} was cancelled.`,
      metadata: { previousStatus: existingOrder.status, venueCancelResult }
    });

    return res.status(200).json({ order });
  } catch (error) {
    return sendError(res, error);
  }
}
