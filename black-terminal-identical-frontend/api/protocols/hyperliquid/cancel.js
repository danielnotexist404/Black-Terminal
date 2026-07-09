import {
  applyCors,
  getOwnedAccount,
  requireFields,
  requireMethod,
  requireUser,
  sendError
} from "../../../server/portfolio-api.js";
import {
  buildRejectedHyperliquidUpdate,
  cancelHyperliquidOrder,
  loadHyperliquidCredential,
  toHyperliquidExecutionReport,
  writeHyperliquidRelayEvent
} from "../../../server/protocols/hyperliquid.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");
    const { supabase, user } = await requireUser(req);
    requireFields(req.body, ["accountId", "symbol"]);

    if (!req.body.orderId && !req.body.clientOrderId) {
      const error = new Error("Missing required field: orderId or clientOrderId");
      error.statusCode = 400;
      throw error;
    }

    const account = await getOwnedAccount(supabase, user.id, req.body.accountId);
    assertHyperliquidAccount(account);
    const credential = await loadHyperliquidCredential(supabase, user.id, { accountId: account.id });
    let update;

    try {
      update = await cancelHyperliquidOrder(supabase, user.id, credential, {
        ...req.body,
        accountId: account.id
      });
    } catch (relayError) {
      update = buildRejectedHyperliquidUpdate(req.body, relayError instanceof Error ? relayError.message : String(relayError));
    }

    await writeHyperliquidRelayEvent(supabase, {
      userId: user.id,
      accountId: account.id,
      connectionId: credential.connection_id,
      credentialId: credential.id,
      eventType: update.status === "cancelled" ? "cancel_submitted" : "order_rejected",
      severity: update.status === "cancelled" ? "info" : "warning",
      symbol: req.body.symbol,
      orderId: update.orderId,
      clientOrderId: update.clientOrderId,
      latencyMs: update.latencyMs,
      message: update.reason || "Hyperliquid cancel submitted through server relay.",
      metadata: { rawResponse: update.rawResponse }
    });

    await supabase.from("execution_audit_logs").insert({
      user_id: user.id,
      account_id: account.id,
      event_type: update.status === "cancelled" ? "order_cancelled" : "order_rejected",
      severity: update.status === "cancelled" ? "info" : "warning",
      message: update.reason || "Hyperliquid cancel accepted by protocol relay.",
      metadata: { protocol: "hyperliquid", orderId: update.orderId, clientOrderId: update.clientOrderId }
    });

    return res.status(200).json({
      report: toHyperliquidExecutionReport(update, req.body)
    });
  } catch (error) {
    return sendError(res, error);
  }
}

function assertHyperliquidAccount(account) {
  if (account.exchange !== "hyperliquid") {
    const error = new Error("This protocol route only accepts Hyperliquid accounts.");
    error.statusCode = 400;
    throw error;
  }
}
