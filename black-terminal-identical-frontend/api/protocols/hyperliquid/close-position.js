import {
  applyCors,
  checkOrderRisk,
  getOwnedAccount,
  requireFields,
  requireMethod,
  requireUser,
  sendError
} from "../../../server/portfolio-api.js";
import {
  buildRejectedHyperliquidUpdate,
  closeHyperliquidPosition,
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

    const account = await getOwnedAccount(supabase, user.id, req.body.accountId);
    assertHyperliquidAccount(account);

    const { data: position, error: positionError } = await supabase
      .from("account_positions")
      .select("*")
      .eq("account_id", account.id)
      .eq("symbol", String(req.body.symbol).toUpperCase())
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (positionError) throw positionError;
    if (!position) {
      const error = new Error("No live Hyperliquid position found for this symbol.");
      error.statusCode = 404;
      throw error;
    }

    const { data: riskControls, error: riskError } = await supabase
      .from("account_risk_controls")
      .select("*")
      .eq("account_id", account.id)
      .single();
    if (riskError) throw riskError;

    const normalizedPosition = {
      symbol: position.symbol,
      direction: position.direction,
      quantity: Number(position.quantity || 0),
      averagePrice: Number(position.average_price || 0),
      currentPrice: Number(position.current_price || position.average_price || 0)
    };
    const draft = {
      ...req.body,
      accountId: account.id,
      symbol: normalizedPosition.symbol,
      side: normalizedPosition.direction === "long" ? "sell" : "buy",
      orderType: req.body.orderType || "market",
      marketKind: "perpetual",
      quantity: Number(req.body.quantity || normalizedPosition.quantity),
      quantityMode: "quantity",
      referencePrice: Number(req.body.referencePrice || normalizedPosition.currentPrice || normalizedPosition.averagePrice),
      reduceOnly: true,
      timeInForce: req.body.timeInForce || "ioc"
    };
    const risk = checkOrderRisk({
      account,
      riskControls,
      order: draft,
      accountExposureUsd: Number(position.margin || 0),
      dailyPnl: Number(position.unrealized_pnl || 0)
    });
    const credential = await loadHyperliquidCredential(supabase, user.id, { accountId: account.id });
    let update;

    if (risk.status === "blocked") {
      update = buildRejectedHyperliquidUpdate(draft, risk.reasons.join(" "));
    } else {
      try {
        update = await closeHyperliquidPosition(supabase, user.id, credential, draft, normalizedPosition);
      } catch (relayError) {
        update = buildRejectedHyperliquidUpdate(draft, relayError instanceof Error ? relayError.message : String(relayError));
      }
    }

    if (update.status !== "rejected") {
      await supabase
        .from("account_positions")
        .update({
          quantity: 0,
          updated_at: new Date().toISOString()
        })
        .eq("id", position.id);
    }

    await writeHyperliquidRelayEvent(supabase, {
      userId: user.id,
      accountId: account.id,
      connectionId: credential.connection_id,
      credentialId: credential.id,
      eventType: update.status === "rejected" ? "order_rejected" : "close_position_submitted",
      severity: update.status === "rejected" ? "warning" : "info",
      symbol: draft.symbol,
      orderId: update.orderId,
      clientOrderId: update.clientOrderId,
      exchangeOrderId: update.exchangeOrderId,
      latencyMs: update.latencyMs,
      message: update.reason || "Hyperliquid close-position order submitted through server relay.",
      metadata: { rawResponse: update.rawResponse, riskStatus: risk.status }
    });

    return res.status(200).json({
      report: toHyperliquidExecutionReport(update, draft)
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
