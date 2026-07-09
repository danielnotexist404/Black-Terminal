import {
  applyCors,
  checkOrderRisk,
  getOwnedAccount,
  requireFields,
  requireMethod,
  requireUser,
  sendError
} from "../../portfolio-api.js";
import {
  loadHyperliquidCredential,
  mapHyperliquidOrderToDb,
  submitHyperliquidOrder,
  toHyperliquidExecutionReport,
  unsupportedHyperliquidOrderReason,
  writeHyperliquidRelayEvent
} from "../hyperliquid.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");
    const { supabase, user } = await requireUser(req);
    requireFields(req.body, ["accountId", "symbol", "side", "orderType", "quantity"]);

    const account = await getOwnedAccount(supabase, user.id, req.body.accountId);
    if (account.exchange !== "hyperliquid") {
      const error = new Error("This protocol route only accepts Hyperliquid accounts.");
      error.statusCode = 400;
      throw error;
    }

    const { data: riskControls, error: riskError } = await supabase
      .from("account_risk_controls")
      .select("*")
      .eq("account_id", account.id)
      .single();
    if (riskError) throw riskError;

    const { data: positions, error: positionsError } = await supabase
      .from("account_positions")
      .select("margin,unrealized_pnl")
      .eq("account_id", account.id);
    if (positionsError) throw positionsError;

    const accountExposureUsd = positions.reduce((sum, row) => sum + Number(row.margin || 0), 0);
    const dailyPnl = positions.reduce((sum, row) => sum + Number(row.unrealized_pnl || 0), 0);
    const risk = checkOrderRisk({
      account,
      riskControls,
      order: req.body,
      accountExposureUsd,
      dailyPnl
    });
    const unsupportedReason = unsupportedHyperliquidOrderReason(req.body);
    let update = null;

    if (risk.status === "blocked") {
      update = rejectedUpdate(req.body, risk.reasons.join(" "));
    } else if (unsupportedReason) {
      update = rejectedUpdate(req.body, unsupportedReason);
    } else {
      const credential = await loadHyperliquidCredential(supabase, user.id, { accountId: account.id });
      await writeHyperliquidRelayEvent(supabase, {
        userId: user.id,
        accountId: account.id,
        connectionId: credential.connection_id,
        credentialId: credential.id,
        eventType: "order_validation_passed",
        severity: "info",
        symbol: req.body.symbol,
        clientOrderId: req.body.clientOrderId || req.body.internalOrderId,
        message: "Hyperliquid order passed server-side risk and metadata validation.",
        metadata: { source: req.body.source || "order-ticket", destinations: req.body.destinations || [] }
      });

      try {
        update = await submitHyperliquidOrder(supabase, user.id, credential, {
          ...req.body,
          accountId: account.id,
          exchange: "hyperliquid",
          clientOrderId: req.body.clientOrderId || req.body.internalOrderId
        });
      } catch (relayError) {
        update = rejectedUpdate(req.body, relayError instanceof Error ? relayError.message : String(relayError));
      }

      await writeHyperliquidRelayEvent(supabase, {
        userId: user.id,
        accountId: account.id,
        connectionId: credential.connection_id,
        credentialId: credential.id,
        eventType: update.status === "rejected" ? "order_rejected" : "order_submitted",
        severity: update.status === "rejected" ? "warning" : "info",
        symbol: req.body.symbol,
        orderId: update.orderId,
        clientOrderId: update.clientOrderId,
        exchangeOrderId: update.exchangeOrderId,
        latencyMs: update.latencyMs,
        message: update.reason || "Hyperliquid order submitted through server relay.",
        metadata: { rawResponse: update.rawResponse }
      });
    }

    const { data: order, error: orderError } = await supabase
      .from("execution_orders")
      .insert(mapHyperliquidOrderToDb(user.id, account, req.body, update, risk))
      .select("*")
      .single();

    if (orderError) throw orderError;

    await supabase.from("execution_audit_logs").insert({
      user_id: user.id,
      account_id: account.id,
      order_id: order.id,
      event_type: update.status === "rejected" ? "order_rejected" : "order_accepted",
      severity: update.status === "rejected" ? "warning" : "info",
      message: update.reason || "Hyperliquid order accepted by protocol relay.",
      metadata: {
        protocol: "hyperliquid",
        riskStatus: risk.status,
        latencyMs: update.latencyMs,
        source: req.body.source || "order-ticket",
        destinations: req.body.destinations || ["personal-portfolio"]
      }
    });

    return res.status(200).json({ order, report: toHyperliquidExecutionReport(update, req.body) });
  } catch (error) {
    return sendError(res, error);
  }
}

function rejectedUpdate(draft, reason) {
  return {
    accountId: draft.accountId,
    exchange: "hyperliquid",
    orderId: draft.internalOrderId || draft.clientOrderId || `hl-rejected-${Date.now()}`,
    clientOrderId: draft.clientOrderId || draft.internalOrderId,
    symbol: draft.symbol,
    status: "rejected",
    filledQuantity: 0,
    reason,
    time: Date.now(),
    latencyMs: 0
  };
}
