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
  buildRejectedHyperliquidUpdate,
  loadHyperliquidCredential,
  modifyHyperliquidOrder,
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

    if (!req.body.orderId && !req.body.clientOrderId) {
      const error = new Error("Missing required field: orderId or clientOrderId");
      error.statusCode = 400;
      throw error;
    }

    const account = await getOwnedAccount(supabase, user.id, req.body.accountId);
    assertHyperliquidAccount(account);

    const [{ data: riskControls, error: riskError }, { data: positions, error: positionsError }] = await Promise.all([
      supabase.from("account_risk_controls").select("*").eq("account_id", account.id).single(),
      supabase.from("account_positions").select("margin,unrealized_pnl").eq("account_id", account.id)
    ]);
    if (riskError) throw riskError;
    if (positionsError) throw positionsError;

    const risk = checkOrderRisk({
      account,
      riskControls,
      order: req.body,
      accountExposureUsd: positions.reduce((sum, row) => sum + Number(row.margin || 0), 0),
      dailyPnl: positions.reduce((sum, row) => sum + Number(row.unrealized_pnl || 0), 0)
    });
    const unsupportedReason = unsupportedHyperliquidOrderReason(req.body);
    const credential = await loadHyperliquidCredential(supabase, user.id, { accountId: account.id });
    let update;

    if (risk.status === "blocked") {
      update = buildRejectedHyperliquidUpdate(req.body, risk.reasons.join(" "));
    } else if (unsupportedReason) {
      update = buildRejectedHyperliquidUpdate(req.body, unsupportedReason);
    } else {
      try {
        update = await modifyHyperliquidOrder(supabase, user.id, credential, {
          ...req.body,
          accountId: account.id,
          exchange: "hyperliquid"
        });
      } catch (relayError) {
        update = buildRejectedHyperliquidUpdate(req.body, relayError instanceof Error ? relayError.message : String(relayError));
      }
    }

    await writeHyperliquidRelayEvent(supabase, {
      userId: user.id,
      accountId: account.id,
      connectionId: credential.connection_id,
      credentialId: credential.id,
      eventType: update.status === "rejected" ? "order_rejected" : "modify_submitted",
      severity: update.status === "rejected" ? "warning" : "info",
      symbol: req.body.symbol,
      orderId: update.orderId,
      clientOrderId: update.clientOrderId,
      latencyMs: update.latencyMs,
      message: update.reason || "Hyperliquid modify submitted through server relay.",
      metadata: { rawResponse: update.rawResponse, riskStatus: risk.status }
    });

    await supabase.from("execution_audit_logs").insert({
      user_id: user.id,
      account_id: account.id,
      event_type: update.status === "rejected" ? "order_rejected" : "order_modified",
      severity: update.status === "rejected" ? "warning" : "info",
      message: update.reason || "Hyperliquid modify accepted by protocol relay.",
      metadata: { protocol: "hyperliquid", riskStatus: risk.status, orderId: update.orderId }
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
