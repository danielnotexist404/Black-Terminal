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

    const externalOrder = lookupError || !existingOrder;
    if (externalOrder) requireFields(req.body, ["accountId", "symbol"]);

    let venueCancelResult = null;
    const accountId = existingOrder?.account_id || req.body.accountId;
    const account = await getOwnedAccount(supabase, user.id, accountId);
    const exchange = existingOrder?.exchange_accounts?.exchange || existingOrder?.exchange || account.exchange;
    const venueOrderId = existingOrder?.exchange_order_id || req.body.venueOrderId || req.body.orderId;
    const symbol = existingOrder?.symbol || String(req.body.symbol).toUpperCase();
    if (externalOrder && exchange !== "bybit") {
      const unsupported = new Error(`External ${exchange} order cancellation is not certified by this route.`);
      unsupported.statusCode = 501;
      throw unsupported;
    }
    if (exchange === "bybit" && venueOrderId) {
      const gate = validateBybitManagementGate({
        account,
        body: req.body,
        symbol
      });
      if (!gate.ok) {
        const blocked = new Error(gate.reasons.join(" "));
        blocked.statusCode = 403;
        throw blocked;
      }
      const { data: credential, error: credentialError } = await supabase
        .from("exchange_credentials")
        .select("encrypted_payload")
        .eq("account_id", accountId)
        .single();

      if (credentialError || !credential) throw credentialError || new Error("Missing encrypted credentials for venue cancel.");
      const credentials = decryptCredentialPayload(credential.encrypted_payload);
      venueCancelResult = await cancelBybitOrder(credentials, {
        marketKind: existingOrder?.market_kind || req.body.marketKind || (req.body.category === "spot" ? "spot" : "perpetual"),
        symbol,
        orderId: venueOrderId,
        clientOrderId: existingOrder?.client_order_id || req.body.clientOrderId
      });
    }

    if (externalOrder) {
      await supabase.from("execution_audit_logs").insert({
        user_id: user.id,
        account_id: accountId,
        event_type: "external_order_cancelled",
        severity: "info",
        message: `External ${exchange} order ${venueOrderId} was cancelled.`,
        metadata: { venueOrderId, symbol, source: "venue", venueCancelResult }
      });
      return res.status(200).json({
        order: {
          accountId,
          exchange,
          orderId: venueOrderId,
          venueOrderId,
          symbol,
          status: "cancelled",
          filledQuantity: 0,
          time: Date.now(),
          source: "venue",
          externallyCreated: true
        }
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
