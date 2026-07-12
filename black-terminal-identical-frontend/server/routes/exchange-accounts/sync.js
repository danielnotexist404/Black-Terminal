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
import { getBybitApiKeyInformation, normalizeBybitPermissionReport, resolveBybitExecutionPolicy } from "../../exchanges/bybit.js";

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
    const executionState = await reconcileBybitExecutionState(supabase, user.id, account, credentials);
    const sync = await syncBybitSnapshotAndReconcile(supabase, user.id, account, credentials, {
      symbol: req.body.symbol || "BTCUSDT",
      marketKind: req.body.marketKind || "perpetual"
    });

    return res.status(200).json({ sync: { ...sync, executionState } });
  } catch (error) {
    return sendError(res, error);
  }
}

async function reconcileBybitExecutionState(supabase, userId, account, credentials) {
  const permissions = normalizeBybitPermissionReport(await getBybitApiKeyInformation(credentials));
  const policy = resolveBybitExecutionPolicy(permissions);
  const accountPatch = {
    is_read_only: policy.readOnly,
    trading_enabled: policy.tradingEnabled,
    permissions: policy.permissions
  };
  const riskPatch = {
    read_only_mode: policy.readOnly,
    trading_enabled: policy.tradingEnabled,
    allowed_symbols: policy.allowedSymbols
  };
  if (policy.maxNotionalUsd > 0) riskPatch.max_position_usd = policy.maxNotionalUsd;

  const [accountUpdate, riskUpdate] = await Promise.all([
    supabase.from("exchange_accounts").update(accountPatch).eq("id", account.id).eq("user_id", userId),
    supabase.from("account_risk_controls").update(riskPatch).eq("account_id", account.id)
  ]);
  if (accountUpdate.error) throw accountUpdate.error;
  if (riskUpdate.error) throw riskUpdate.error;

  Object.assign(account, accountPatch);
  return policy;
}
