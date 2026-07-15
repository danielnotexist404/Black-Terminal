import crypto from "node:crypto";
import { applyCors, decryptCredentialPayload, getOwnedAccount, requireMethod, requireUser, sendError } from "../../portfolio-api.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "DELETE");

    const { supabase, user } = await requireUser(req);
    const accountId = req.query.accountId;
    const account = await getOwnedAccount(supabase, user.id, accountId);
    const duplicateAccountIds = await findCredentialDuplicateAccountIds(supabase, user.id, account);
    const accountIdsToDelete = duplicateAccountIds.length > 0 ? duplicateAccountIds : [account.id];

    const { error } = await supabase
      .from("exchange_accounts")
      .delete()
      .in("id", accountIdsToDelete)
      .eq("user_id", user.id);

    if (error) throw error;

    await supabase.from("execution_audit_logs").insert({
      user_id: user.id,
      account_id: null,
      event_type: "exchange_account_deleted",
      severity: "warning",
      message: `Deleted ${account.exchange} account ${account.account_name}.`,
      metadata: { exchange: account.exchange, removedAccountIds: accountIdsToDelete }
    });

    return res.status(200).json({ ok: true, removedAccountIds: accountIdsToDelete });
  } catch (error) {
    return sendError(res, error);
  }
}

async function findCredentialDuplicateAccountIds(supabase, userId, account) {
  const { data: accounts, error: accountError } = await supabase
    .from("exchange_accounts")
    .select("id")
    .eq("user_id", userId)
    .eq("exchange", account.exchange);
  if (accountError || !accounts?.length) return [account.id];

  const accountIds = accounts.map((candidate) => candidate.id);
  const { data: credentials, error: credentialError } = await supabase
    .from("exchange_credentials")
    .select("account_id, encrypted_payload")
    .in("account_id", accountIds);
  if (credentialError || !credentials?.length) return [account.id];

  const target = credentials.find((credential) => credential.account_id === account.id);
  const targetFingerprint = credentialFingerprint(target?.encrypted_payload);
  if (!targetFingerprint) return [account.id];
  return credentials
    .filter((credential) => credentialFingerprint(credential.encrypted_payload) === targetFingerprint)
    .map((credential) => credential.account_id);
}

function credentialFingerprint(encryptedPayload) {
  try {
    const credential = decryptCredentialPayload(encryptedPayload);
    const apiKey = String(credential?.apiKey || "");
    return apiKey ? crypto.createHash("sha256").update(apiKey).digest("hex") : null;
  } catch {
    return null;
  }
}
