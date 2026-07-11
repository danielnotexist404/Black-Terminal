import {
  applyCors,
  decryptCredentialPayload,
  getOwnedAccount,
  requireFields,
  requireMethod,
  requireUser,
  sendError
} from "../../portfolio-api.js";
import {
  switchBybitMarginMode,
  switchBybitPositionMode,
  validateBybitManagementGate
} from "../../exchanges/bybit.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");
    requireFields(req.body, ["accountId", "action"]);

    const { supabase, user } = await requireUser(req);
    const account = await getOwnedAccount(supabase, user.id, req.body.accountId);
    if (account.exchange !== "bybit") {
      const unsupported = new Error(`${account.exchange} account-mode control is not certified yet.`);
      unsupported.statusCode = 501;
      throw unsupported;
    }

    const symbol = req.body.symbol || req.body.settleCoin || "BTCUSDT";
    const gate = validateBybitManagementGate({ account, body: req.body, symbol });
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

    if (credentialError || !credential) throw credentialError || new Error("Missing encrypted credentials for account-mode action.");
    const credentials = decryptCredentialPayload(credential.encrypted_payload);
    const action = String(req.body.action);
    const report = action === "switch-position-mode"
      ? await switchBybitPositionMode(credentials, {
          category: req.body.category || "linear",
          symbol: req.body.symbol,
          settleCoin: req.body.settleCoin,
          positionMode: req.body.positionMode
        })
      : await switchBybitMarginMode(credentials, {
          category: req.body.category || "linear",
          symbol: req.body.symbol,
          marginMode: req.body.marginMode,
          leverage: req.body.leverage,
          buyLeverage: req.body.buyLeverage,
          sellLeverage: req.body.sellLeverage
        });

    await supabase.from("execution_audit_logs").insert({
      user_id: user.id,
      account_id: account.id,
      event_type: action === "switch-position-mode" ? "position_mode_switch_submitted" : "margin_mode_switch_submitted",
      severity: "warning",
      message: `Bybit ${action} submitted explicitly.`,
      metadata: report
    }).catch(() => null);

    return res.status(200).json({ report });
  } catch (error) {
    return sendError(res, error);
  }
}
