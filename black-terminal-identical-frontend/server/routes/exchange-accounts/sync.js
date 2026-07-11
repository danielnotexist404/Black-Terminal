import {
  applyCors,
  decryptCredentialPayload,
  getOwnedAccount,
  requireFields,
  requireMethod,
  requireUser,
  sendError
} from "../../portfolio-api.js";
import { syncBybitSnapshotAndReconcile } from "../../exchanges/bybit-reconciliation.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");
    requireFields(req.body, ["accountId"]);

    const { supabase, user } = await requireUser(req);
    const account = await getOwnedAccount(supabase, user.id, req.body.accountId);
    if (account.exchange !== "bybit") {
      const unsupported = new Error(`${account.exchange} snapshot reconciliation is not certified in this route yet.`);
      unsupported.statusCode = 501;
      throw unsupported;
    }

    const { data: credential, error: credentialError } = await supabase
      .from("exchange_credentials")
      .select("encrypted_payload")
      .eq("account_id", account.id)
      .single();

    if (credentialError || !credential) throw credentialError || new Error("Missing encrypted credentials for account sync.");
    const credentials = decryptCredentialPayload(credential.encrypted_payload);
    const sync = await syncBybitSnapshotAndReconcile(supabase, user.id, account, credentials, {
      symbol: req.body.symbol || "BTCUSDT",
      marketKind: req.body.marketKind || "perpetual"
    });

    return res.status(200).json({ sync });
  } catch (error) {
    return sendError(res, error);
  }
}
