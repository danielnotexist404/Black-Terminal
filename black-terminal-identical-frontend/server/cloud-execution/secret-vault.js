import crypto from "node:crypto";

export async function storeBrokerCredential(supabase, input) {
  if (input.withdrawalEnabled) throw forbidden("Withdrawal-enabled credentials cannot be stored for Black Cloud execution.");
  const key = credentialKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(input.secret), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const fingerprint = crypto.createHash("sha256").update(String(input.publicIdentifier || "")).digest("hex").slice(0, 32);
  const { data: reference, error } = await supabase.rpc("black_cloud_store_encrypted_broker_secret", {
    p_user_id: input.userId,
    p_connection_id: input.connectionId,
    p_provider: input.provider,
    p_encrypted_secret: toBytea(ciphertext),
    p_encryption_iv: toBytea(iv),
    p_authentication_tag: toBytea(tag),
    p_credential_fingerprint: fingerprint,
    p_authorization_type: input.authorizationType,
    p_permission_scope: input.permissionScope || {},
    p_withdrawal_enabled: false
  });
  if (error) throw error;
  return toSafeSecretReference(reference);
}

export async function revokeBrokerCredential(supabase, input) {
  const { data: reference, error } = await supabase.from("broker_secret_references")
    .update({ status: "REVOKED", revoked_at: new Date().toISOString() })
    .eq("id", input.secretReferenceId)
    .select("vault_secret_id")
    .single();
  if (error) throw error;
  const { error: vaultError } = await supabase.from("broker_secret_vault")
    .update({ rotation_status: "REVOKED", revoked_at: new Date().toISOString() })
    .eq("id", reference.vault_secret_id);
  if (vaultError) throw vaultError;
}

export async function decryptBrokerCredential(supabase, secretReferenceId) {
  const { data: reference, error: referenceError } = await supabase.from("broker_secret_references")
    .select("vault_secret_id,status")
    .eq("id", secretReferenceId)
    .single();
  if (referenceError || reference?.status !== "ACTIVE") throw forbidden("Broker credential is not active.");
  const { data: row, error } = await supabase.from("broker_secret_vault")
    .select("encrypted_secret,encryption_iv,authentication_tag,encryption_version,rotation_status")
    .eq("id", reference.vault_secret_id)
    .single();
  if (error || row?.rotation_status !== "ACTIVE" || row?.encryption_version !== 1) throw forbidden("Broker credential vault entry is unavailable.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", credentialKey(), decodeBytea(row.encryption_iv));
  decipher.setAuthTag(decodeBytea(row.authentication_tag));
  const plaintext = Buffer.concat([decipher.update(decodeBytea(row.encrypted_secret)), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

export function toSafeSecretReference(row) {
  if (!row) return null;
  return {
    id: row.id,
    connectionId: row.connection_id,
    provider: row.provider,
    credentialVersion: row.credential_version,
    credentialFingerprint: row.credential_fingerprint,
    authorizationType: row.authorization_type,
    permissionScope: row.permission_scope,
    withdrawalEnabled: false,
    status: row.status,
    activatedAt: row.activated_at
  };
}

function credentialKey() {
  const encoded = process.env.BLACK_CLOUD_SECRET_MASTER_KEY || process.env.EXCHANGE_CREDENTIAL_MASTER_KEY;
  if (!encoded) throw Object.assign(new Error("Black Cloud credential encryption is unavailable."), { statusCode: 503 });
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw Object.assign(new Error("Black Cloud credential encryption key is invalid."), { statusCode: 503 });
  return key;
}

function decodeBytea(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string" && value.startsWith("\\x")) return Buffer.from(value.slice(2), "hex");
  if (typeof value === "string") return Buffer.from(value, "base64");
  if (value && Array.isArray(value.data)) return Buffer.from(value.data);
  throw Object.assign(new Error("Broker credential vault payload is invalid."), { statusCode: 503 });
}

function toBytea(value) { return `\\x${Buffer.from(value).toString("hex")}`; }

function forbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}
