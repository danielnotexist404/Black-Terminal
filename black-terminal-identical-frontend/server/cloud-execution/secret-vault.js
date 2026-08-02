import crypto from "node:crypto";

const ENVELOPE_VERSION = 2;

export async function storeBrokerCredential(supabase, input) {
  if (input.withdrawalEnabled || input.permissionScope?.withdrawal) {
    throw forbidden("Withdrawal-enabled credentials cannot be stored for Black Cloud execution.");
  }
  assertIdentity(input);
  const masterKeyVersion = positiveInteger(input.masterKeyVersion || process.env.BLACK_CLOUD_MASTER_KEY_VERSION || 1, "master key version");
  const masterKey = credentialMasterKey(masterKeyVersion);
  const dataKey = crypto.randomBytes(32);
  const secretBytes = Buffer.from(JSON.stringify(input.secret), "utf8");
  const aad = associatedData(input);
  const wrapAad = wrappingAssociatedData(aad, masterKeyVersion);
  try {
    const secretEnvelope = encryptAesGcm(secretBytes, dataKey, aad);
    const keyEnvelope = encryptAesGcm(dataKey, masterKey, wrapAad);
    const fingerprint = crypto.createHash("sha256").update(String(input.publicIdentifier || "")).digest("hex").slice(0, 32);
    const { data: reference, error } = await supabase.rpc("black_cloud_store_encrypted_broker_secret_v2", {
      p_user_id: input.userId,
      p_connection_id: input.connectionId,
      p_provider: normalizedProvider(input.provider),
      p_encrypted_secret: toBytea(secretEnvelope.ciphertext),
      p_encryption_iv: toBytea(secretEnvelope.iv),
      p_authentication_tag: toBytea(secretEnvelope.tag),
      p_wrapped_data_key: toBytea(keyEnvelope.ciphertext),
      p_wrapping_iv: toBytea(keyEnvelope.iv),
      p_wrapping_authentication_tag: toBytea(keyEnvelope.tag),
      p_associated_data_hash: hash(aad),
      p_master_key_version: masterKeyVersion,
      p_credential_fingerprint: fingerprint,
      p_authorization_type: input.authorizationType,
      p_permission_scope: { ...(input.permissionScope || {}), withdrawal: false },
      p_withdrawal_enabled: false
    });
    if (error) throw error;
    return toSafeSecretReference(reference);
  } finally {
    masterKey.fill(0);
    dataKey.fill(0);
    secretBytes.fill(0);
  }
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

export async function decryptBrokerCredential(supabase, secretReferenceId, expected = {}) {
  const { data: reference, error: referenceError } = await supabase.from("broker_secret_references")
    .select("vault_secret_id,user_id,connection_id,provider,credential_version,status")
    .eq("id", secretReferenceId)
    .single();
  if (referenceError || reference?.status !== "ACTIVE") throw forbidden("Broker credential is not active.");
  assertExpectedIdentity(reference, expected);
  const { data: row, error } = await supabase.from("broker_secret_vault")
    .select("user_id,connection_id,provider,encrypted_secret,encryption_iv,authentication_tag,encryption_version,rotation_status,wrapped_data_key,wrapping_iv,wrapping_authentication_tag,associated_data_hash,master_key_version")
    .eq("id", reference.vault_secret_id)
    .single();
  if (error || row?.rotation_status !== "ACTIVE") throw forbidden("Broker credential vault entry is unavailable.");
  assertRowIdentity(row, reference);
  return Number(row.encryption_version) === ENVELOPE_VERSION
    ? decryptV2(row, reference)
    : decryptLegacyV1(row);
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

function decryptV2(row, reference) {
  const identity = {
    userId: reference.user_id,
    connectionId: reference.connection_id,
    provider: reference.provider
  };
  const aad = associatedData(identity);
  if (!safeEqualHex(hash(aad), row.associated_data_hash)) throw forbidden("Broker credential associated-data verification failed.");
  const masterKeyVersion = positiveInteger(row.master_key_version, "master key version");
  const masterKey = credentialMasterKey(masterKeyVersion);
  let dataKey;
  let plaintext;
  try {
    dataKey = decryptAesGcm({
      ciphertext: decodeBytea(row.wrapped_data_key),
      iv: decodeBytea(row.wrapping_iv),
      tag: decodeBytea(row.wrapping_authentication_tag)
    }, masterKey, wrappingAssociatedData(aad, masterKeyVersion));
    if (dataKey.length !== 32) throw forbidden("Broker credential data key is invalid.");
    plaintext = decryptAesGcm({
      ciphertext: decodeBytea(row.encrypted_secret),
      iv: decodeBytea(row.encryption_iv),
      tag: decodeBytea(row.authentication_tag)
    }, dataKey, aad);
    return JSON.parse(plaintext.toString("utf8"));
  } catch (error) {
    if (error?.statusCode) throw error;
    throw forbidden("Broker credential envelope authentication failed.");
  } finally {
    masterKey.fill(0);
    dataKey?.fill(0);
    plaintext?.fill(0);
  }
}

function decryptLegacyV1(row) {
  const masterKey = credentialMasterKey(1);
  let plaintext;
  try {
    plaintext = decryptAesGcm({
      ciphertext: decodeBytea(row.encrypted_secret),
      iv: decodeBytea(row.encryption_iv),
      tag: decodeBytea(row.authentication_tag)
    }, masterKey);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw forbidden("Legacy broker credential authentication failed; rotate this credential into a v2 envelope.");
  } finally {
    masterKey.fill(0);
    plaintext?.fill(0);
  }
}

function encryptAesGcm(plaintext, key, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decryptAesGcm(envelope, key, aad) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, envelope.iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(envelope.tag);
  return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
}

function associatedData(input) {
  return Buffer.from(JSON.stringify({
    scope: "black-cloud-broker-credential",
    userId: String(input.userId),
    connectionId: String(input.connectionId),
    provider: normalizedProvider(input.provider),
    envelopeVersion: ENVELOPE_VERSION
  }), "utf8");
}

function wrappingAssociatedData(aad, keyVersion) {
  return Buffer.concat([aad, Buffer.from(`|wrapped-dek|${keyVersion}`, "utf8")]);
}

function assertIdentity(input) {
  if (!input?.userId || !input?.connectionId || !input?.provider) throw forbidden("Broker credential ownership context is required.");
}

function assertExpectedIdentity(reference, expected) {
  if (expected.userId && String(expected.userId) !== String(reference.user_id)) throw forbidden("Broker credential user binding mismatch.");
  if (expected.connectionId && String(expected.connectionId) !== String(reference.connection_id)) throw forbidden("Broker credential connection binding mismatch.");
  if (expected.provider && normalizedProvider(expected.provider) !== normalizedProvider(reference.provider)) throw forbidden("Broker credential provider binding mismatch.");
}

function assertRowIdentity(row, reference) {
  if (String(row.user_id) !== String(reference.user_id) || String(row.connection_id) !== String(reference.connection_id) || normalizedProvider(row.provider) !== normalizedProvider(reference.provider)) {
    throw forbidden("Broker credential vault ownership mismatch.");
  }
}

function credentialMasterKey(version) {
  const encoded = process.env[`BLACK_CLOUD_SECRET_MASTER_KEY_V${version}`]
    || (version === 1 ? process.env.BLACK_CLOUD_SECRET_MASTER_KEY || process.env.EXCHANGE_CREDENTIAL_MASTER_KEY : null);
  if (!encoded) throw Object.assign(new Error(`Black Cloud credential wrapping key v${version} is unavailable.`), { statusCode: 503 });
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    key.fill(0);
    throw Object.assign(new Error(`Black Cloud credential wrapping key v${version} is invalid.`), { statusCode: 503 });
  }
  return key;
}

function decodeBytea(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (typeof value === "string" && value.startsWith("\\x")) return Buffer.from(value.slice(2), "hex");
  if (typeof value === "string") return Buffer.from(value, "base64");
  if (value && Array.isArray(value.data)) return Buffer.from(value.data);
  throw Object.assign(new Error("Broker credential vault payload is invalid."), { statusCode: 503 });
}

function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function toBytea(value) { return `\\x${Buffer.from(value).toString("hex")}`; }
function normalizedProvider(value) { return String(value || "").trim().toLowerCase(); }
function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw forbidden(`Broker credential ${label} is invalid.`);
  return parsed;
}
function safeEqualHex(left, right) {
  const a = Buffer.from(String(left || ""), "hex");
  const b = Buffer.from(String(right || ""), "hex");
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function forbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}
