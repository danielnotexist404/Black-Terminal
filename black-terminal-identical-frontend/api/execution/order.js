import {
  applyCors,
  checkOrderRisk,
  getOwnedAccount,
  requireFields,
  requireMethod,
  requireUser,
  sendError
} from "../../server/portfolio-api.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");

    const { supabase, user } = await requireUser(req);
    requireFields(req.body, ["accountId", "exchange", "symbol", "side", "orderType", "quantity"]);

    const account = await getOwnedAccount(supabase, user.id, req.body.accountId);

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
    const estimatedFees = risk.notional * 0.0004;
    const estimatedMargin = risk.notional / Math.max(1, Number(riskControls.max_leverage || 1));
    const status = risk.status === "approved" ? "rejected" : "rejected";
    const rejectionReason =
      risk.status === "approved"
        ? "No live exchange execution adapter is configured yet."
        : risk.reasons.join(" ");

    const { data: order, error: orderError } = await supabase
      .from("execution_orders")
      .insert({
        user_id: user.id,
        account_id: account.id,
        exchange: account.exchange,
        symbol: String(req.body.symbol).toUpperCase(),
        side: req.body.side,
        order_type: req.body.orderType,
        quantity: Number(req.body.quantity),
        quantity_mode: req.body.quantityMode || "quantity",
        limit_price: req.body.limitPrice ?? null,
        stop_price: req.body.stopPrice ?? null,
        take_profit: req.body.takeProfit ?? null,
        stop_loss: req.body.stopLoss ?? null,
        post_only: Boolean(req.body.postOnly),
        reduce_only: Boolean(req.body.reduceOnly),
        time_in_force: req.body.timeInForce || "gtc",
        status,
        filled_quantity: 0,
        rejection_reason: rejectionReason,
        estimated_fees: estimatedFees,
        estimated_margin: estimatedMargin,
        estimated_slippage: risk.notional * 0.0003,
        risk_check_status: risk.status,
        risk_check_reasons: risk.reasons
      })
      .select("*")
      .single();

    if (orderError) throw orderError;

    await supabase.from("execution_audit_logs").insert({
      user_id: user.id,
      account_id: account.id,
      order_id: order.id,
      event_type: "order_rejected",
      severity: risk.status === "approved" ? "warning" : "error",
      message: rejectionReason,
      metadata: { riskStatus: risk.status, notional: risk.notional }
    });

    return res.status(200).json({ order });
  } catch (error) {
    return sendError(res, error);
  }
}
