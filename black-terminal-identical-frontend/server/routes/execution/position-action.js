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
  closeBybitPosition,
  getBybitPositions,
  reverseBybitPosition,
  validateBybitManagementGate
} from "../../exchanges/bybit.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");
    requireFields(req.body, ["accountId", "symbol", "action"]);

    const { supabase, user } = await requireUser(req);
    const account = await getOwnedAccount(supabase, user.id, req.body.accountId);
    if (account.exchange !== "bybit") {
      const unsupported = new Error(`${account.exchange} position management is not certified yet.`);
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

    if (credentialError || !credential) throw credentialError || new Error("Missing encrypted credentials for position action.");
    const credentials = decryptCredentialPayload(credential.encrypted_payload);
    const symbol = String(req.body.symbol).toUpperCase();
    const currentPosition = await resolvePosition(credentials, symbol, req.body.direction);
    const quantity = Number(req.body.quantity || currentPosition.quantity || 0);
    if (!quantity || quantity <= 0) {
      const invalid = new Error("Position action requires a positive quantity.");
      invalid.statusCode = 400;
      throw invalid;
    }

    const action = String(req.body.action);
    const report = action === "reverse"
      ? await reverseBybitPosition(credentials, {
          marketKind: req.body.marketKind || "perpetual",
          symbol,
          direction: currentPosition.direction,
          quantity,
          clientOrderId: req.body.clientOrderId
        })
      : await closeBybitPosition(credentials, {
          marketKind: req.body.marketKind || "perpetual",
          symbol,
          direction: currentPosition.direction,
          quantity,
          clientOrderId: req.body.clientOrderId
        });

    await supabase.from("execution_audit_logs").insert({
      user_id: user.id,
      account_id: account.id,
      event_type: action === "reverse" ? "position_reverse_submitted" : quantity < currentPosition.quantity ? "partial_close_submitted" : "close_position_submitted",
      severity: "warning",
      message: `Bybit ${action} submitted for ${symbol}.`,
      metadata: { report, currentPosition, quantity }
    }).catch(() => null);

    return res.status(200).json({ report });
  } catch (error) {
    return sendError(res, error);
  }
}

async function resolvePosition(credentials, symbol, direction) {
  const positions = await getBybitPositions(credentials);
  const normalizedDirection = direction ? String(direction).toLowerCase() : null;
  const position = positions.find((item) =>
    item.symbol === symbol &&
    (!normalizedDirection || item.direction === normalizedDirection)
  );

  if (!position) {
    const missing = new Error(`No live Bybit position found for ${symbol}.`);
    missing.statusCode = 404;
    throw missing;
  }

  return position;
}
