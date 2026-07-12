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
import { setBybitPositionProtection, validateBybitManagementGate } from "../../exchanges/bybit.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");
    requireFields(req.body, ["accountId", "symbol"]);

    const { supabase, user } = await requireUser(req);
    const account = await getOwnedAccount(supabase, user.id, req.body.accountId);
    if (account.exchange !== "bybit") {
      const unsupported = new Error(`${account.exchange} position protection is not certified yet.`);
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

    if (credentialError || !credential) throw credentialError || new Error("Missing encrypted credentials for position protection.");
    const credentials = decryptCredentialPayload(credential.encrypted_payload);
    const report = await setBybitPositionProtection(credentials, {
      marketKind: req.body.marketKind || "perpetual",
      symbol: String(req.body.symbol).toUpperCase(),
      positionIdx: req.body.positionIdx,
      takeProfit: valueOrZero(req.body.takeProfit, req.body.cancelTakeProfit),
      stopLoss: valueOrZero(req.body.stopLoss, req.body.cancelStopLoss),
      trailingStop: valueOrZero(req.body.trailingStop, req.body.cancelTrailingStop),
      trailingActivationPrice: req.body.trailingActivationPrice,
      tpslMode: req.body.tpslMode,
      tpTriggerBy: req.body.tpTriggerBy,
      slTriggerBy: req.body.slTriggerBy
    });

    await settleSupabaseQuery(supabase.from("execution_audit_logs").insert({
      user_id: user.id,
      account_id: account.id,
      event_type: "position_protection_submitted",
      severity: "info",
      message: `Bybit native TP/SL protection submitted for ${req.body.symbol}.`,
      metadata: { report, mode: "native" }
    }));

    return res.status(200).json({ report });
  } catch (error) {
    return sendError(res, error);
  }
}

function valueOrZero(value, cancel) {
  if (cancel === true) return 0;
  return value === undefined || value === null || value === "" ? undefined : Number(value);
}
