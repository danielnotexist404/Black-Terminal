import {
  applyCors,
  decryptCredentialPayload,
  getOwnedAccount,
  requireFields,
  requireMethod,
  requireUser,
  sendError
} from "../../portfolio-api.js";
import { createCloudExchangeAdapter } from "../../cloud-execution/adapters/registry.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");
    requireFields(req.body, ["accountId"]);

    const { supabase, user } = await requireUser(req);
    const account = await getOwnedAccount(supabase, user.id, req.body.accountId);
    const { data: credential, error: credentialError } = await supabase
      .from("exchange_credentials")
      .select("encrypted_payload")
      .eq("account_id", account.id)
      .single();

    if (credentialError || !credential) throw credentialError || new Error("Missing encrypted credentials for account sync.");
    const credentials = decryptCredentialPayload(credential.encrypted_payload);
    const adapter = createCloudExchangeAdapter(account.exchange, {
      credentials,
      network: account.network,
      executionEnvironment: account.execution_environment,
      endpointProfile: account.endpoint_profile,
      connectionId: account.id
    });
    const sync = await adapter.synchronizeAccount({
      supabase,
      userId: user.id,
      account,
      symbol: req.body.symbol || "BTCUSDT",
      marketKind: req.body.marketKind || "perpetual"
    });

    return res.status(200).json({ sync });
  } catch (error) {
    return sendError(res, error);
  }
}
