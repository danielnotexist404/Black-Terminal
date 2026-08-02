import crypto from "node:crypto";
import { normalizeBybitExecutionEnvironment } from "../exchanges/bybit-endpoints.js";

const ENVELOPE_VERSION = 3;

export async function storeBrokerCredential(supabase, input) {
  if (input.withdrawalEnabled || input.permissionScope?.withdrawal) {
    throw forbidden("Withdrawal-enabled credentials cannot be stored for Black Cloud execution.");
  }
  if (input.transferEnabled || input.permissionScope?.walletTransfer || input.permissionScope?.transfer) {
    throw forbidden("Wallet-transfer-enabled credentials cannot be stored for Black Cloud execution.");
  }
  assertIdentity(input);
  const masterKeyVersion = positiveInteger(input.masterKeyVersion || process.env.BLACK_CLOUD_MASTER_KEY_VERSION || 1, "master key version");
  const executionEnvironment = normalizeBybitExecutionEnvironment(input.executionEnvironment || input.secret?.executionEnvironment || input.secret?.network);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const credentialVersion = await nextCredentialVersion(supabase, input.connectionId);
    const binding = { ...input, executionEnvironment, credentialVersion };
    const masterKey = credentialMasterKey(masterKeyVersion);
    const dataKey = crypto.randomBytes(32);
    const secretBytes = Buffer.from(JSON.stringify({ ...input.secret, executionEnvironment }), "utf8");
    const aad = associatedData(binding);
    const wrapAad = wrappingAssociatedData(aad, masterKeyVersion);
    try {
      const secretEnvelope = encryptAesGcm(secretBytes, dataKey, aad);
      const keyEnvelope = encryptAesGcm(dataKey, masterKey, wrapAad);
      const fingerprint = crypto.createHash("sha256").update(String(input.publicIdentifier || "")).digest("hex").slice(0, 32);
      const permissionSnapshot = { ...(input.permissionSnapshot || input.permissionScope || {}), withdrawal: false, walletTransfer: false };
      const { data: reference, error } = await supabase.rpc("black_cloud_store_encrypted_broker_secret_v3", {
        p_user_id: input.userId,
        p_connection_id: input.connectionId,
        p_provider: normalizedProvider(input.provider),
        p_execution_environment: executionEnvironment,
        p_expected_credential_version: credentialVersion,
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
        p_permission_scope: permissionSnapshot,
        p_permission_snapshot: permissionSnapshot,
        p_withdrawal_enabled: false
      });
      if (error) {
        if (String(error.code) === "40001" && attempt < 2) continue;
        throw error;
      }
      return toSafeSecretReference(reference);
    } finally {
      masterKey.fill(0);
      dataKey.fill(0);
      secretBytes.fill(0);
    }
  }
  throw forbidden("Broker credential version could not be reserved safely.");
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
    .select("vault_secret_id,user_id,connection_id,provider,execution_environment,credential_version,status")
    .eq("id", secretReferenceId)
    .single();
  if (referenceError || reference?.status !== "ACTIVE") throw forbidden("Broker credential is not active.");
  assertExpectedIdentity(reference, expected);
  const { data: row, error } = await supabase.from("broker_secret_vault")
    .select("user_id,connection_id,provider,execution_environment,credential_version,encrypted_secret,encryption_iv,authentication_tag,encryption_version,rotation_status,wrapped_data_key,wrapping_iv,wrapping_authentication_tag,associated_data_hash,master_key_version")
    .eq("id", reference.vault_secret_id)
    .single();
  if (error || row?.rotation_status !== "ACTIVE") throw forbidden("Broker credential vault entry is unavailable.");
  assertRowIdentity(row, reference);
  if (Number(row.encryption_version) === 3) return decryptV3(row, reference);
  if (Number(row.encryption_version) === 2) return decryptV2(row, reference);
  return decryptLegacyV1(row);
}

export function toSafeSecretReference(row) {
  if (!row) return null;
  return {
    id: row.id,
    connectionId: row.connection_id,
    provider: row.provider,
    executionEnvironment: row.execution_environment,
    credentialVersion: row.credential_version,
    credentialFingerprint: row.credential_fingerprint,
    authorizationType: row.authorization_type,
    permissionScope: row.permission_scope,
    permissionSnapshot: row.permission_snapshot || row.permission_scope,
    withdrawalEnabled: false,
    status: row.status,
    activatedAt: row.activated_at
  };
}

export function runBrokerCredentialCryptoSelfTest({
  executionEnvironment = "DEMO",
  masterKeyVersion = Number(process.env.BLACK_CLOUD_MASTER_KEY_VERSION || 1)
} = {}) {
  const identity = {
    userId: "00000000-0000-4000-8000-000000000001",
    connectionId: "00000000-0000-4000-8000-000000000002",
    provider: "bybit",
    executionEnvironment: normalizeBybitExecutionEnvironment(executionEnvironment),
    credentialVersion: 1
  };
  const masterKey = credentialMasterKey(masterKeyVersion);
  const dataKey = crypto.randomBytes(32);
  const plaintext = Buffer.from(JSON.stringify({ apiKey: "synthetic", apiSecret: "never-persisted" }), "utf8");
  const aad = associatedData(identity);
  const wrapAad = wrappingAssociatedData(aad, masterKeyVersion);
  let decryptedKey;
  let decrypted;
  try {
    const secretEnvelope = encryptAesGcm(plaintext, dataKey, aad);
    const keyEnvelope = encryptAesGcm(dataKey, masterKey, wrapAad);
    decryptedKey = decryptAesGcm(keyEnvelope, masterKey, wrapAad);
    decrypted = decryptAesGcm(secretEnvelope, decryptedKey, aad);
    const checks = {
      encryptDecrypt: decrypted.equals(plaintext),
      associatedDataBinding: rejection(() => decryptAesGcm(secretEnvelope, decryptedKey, associatedData({ ...identity, credentialVersion: 2 }))),
      tamperRejected: rejection(() => decryptAesGcm({ ...secretEnvelope, ciphertext: tampered(secretEnvelope.ciphertext) }, decryptedKey, aad)),
      wrongTenantRejected: rejection(() => decryptAesGcm(secretEnvelope, decryptedKey, associatedData({ ...identity, userId: "00000000-0000-4000-8000-000000000099" }))),
      wrongProviderRejected: rejection(() => decryptAesGcm(secretEnvelope, decryptedKey, associatedData({ ...identity, provider: "other" }))),
      wrongEnvironmentRejected: rejection(() => decryptAesGcm(secretEnvelope, decryptedKey, associatedData({ ...identity, executionEnvironment: identity.executionEnvironment === "DEMO" ? "MAINNET_LIVE" : "DEMO" })))
    };
    if (!Object.values(checks).every(Boolean)) throw new Error("Broker credential cryptographic self-test failed.");
    return {
      status: "PASS",
      envelopeVersion: ENVELOPE_VERSION,
      masterKeyVersion,
      masterKeyFingerprint: crypto.createHash("sha256").update(masterKey).digest("hex").slice(0, 16),
      checks
    };
  } finally {
    masterKey.fill(0);
    dataKey.fill(0);
    plaintext.fill(0);
    aad.fill(0);
    wrapAad.fill(0);
    decryptedKey?.fill(0);
    decrypted?.fill(0);
  }
}

function decryptV3(row, reference) {
  const identity = {
    userId: reference.user_id,
    connectionId: reference.connection_id,
    provider: reference.provider,
    executionEnvironment: reference.execution_environment,
    credentialVersion: reference.credential_version
  };
  return decryptWrappedEnvelope(row, associatedData(identity));
}

function decryptV2(row, reference) {
  const identity = {
    userId: reference.user_id,
    connectionId: reference.connection_id,
    provider: reference.provider
  };
  const aad = associatedData(identity, 2);
  return decryptWrappedEnvelope(row, aad);
}

function decryptWrappedEnvelope(row, aad) {
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
    throw forbidden("Legacy broker credential authentication failed; rotate this credential into the current v3 environment-bound envelope.");
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

function rejection(run) {
  try { run(); return false; }
  catch { return true; }
}

function tampered(value) {
  const output = Buffer.from(value);
  output[0] ^= 1;
  return output;
}

function associatedData(input, envelopeVersion = ENVELOPE_VERSION) {
  const payload = {
    scope: "black-cloud-broker-credential",
    userId: String(input.userId),
    connectionId: String(input.connectionId),
    provider: normalizedProvider(input.provider),
    envelopeVersion
  };
  if (envelopeVersion >= 3) {
    payload.executionEnvironment = normalizeBybitExecutionEnvironment(input.executionEnvironment);
    payload.credentialVersion = positiveInteger(input.credentialVersion, "credential version");
  }
  return Buffer.from(JSON.stringify(payload), "utf8");
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
  if (expected.executionEnvironment && normalizeBybitExecutionEnvironment(expected.executionEnvironment) !== normalizeBybitExecutionEnvironment(reference.execution_environment)) throw forbidden("Broker credential execution-environment binding mismatch.");
  if (expected.credentialVersion && Number(expected.credentialVersion) !== Number(reference.credential_version)) throw forbidden("Broker credential version binding mismatch.");
}

function assertRowIdentity(row, reference) {
  if (String(row.user_id) !== String(reference.user_id) || String(row.connection_id) !== String(reference.connection_id) || normalizedProvider(row.provider) !== normalizedProvider(reference.provider)) {
    throw forbidden("Broker credential vault ownership mismatch.");
  }
  if (Number(row.encryption_version) >= 3 && (normalizeBybitExecutionEnvironment(row.execution_environment) !== normalizeBybitExecutionEnvironment(reference.execution_environment) || Number(row.credential_version) !== Number(reference.credential_version))) {
    throw forbidden("Broker credential vault environment or version binding mismatch.");
  }
}

async function nextCredentialVersion(supabase, connectionId) {
  const { data, error } = await supabase.from("broker_secret_references")
    .select("credential_version")
    .eq("connection_id", connectionId)
    .order("credential_version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return positiveInteger(Number(data?.credential_version || 0) + 1, "credential version");
}

function credentialMasterKey(version) {
  const encoded = process.env[`BLACK_CLOUD_SECRET_MASTER_KEY_V${version}`]
    || (version === 1 ? process.env.BLACK_CLOUD_SECRET_MASTER_KEY || process.env.EXCHANGE_CREDENTIAL_MASTER_KEY : null);
  if (!encoded) throw Object.assign(new Error(`Black Cloud credential wrapping key v${version} is unavailable.`), { statusCode: 503 });
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw Object.assign(new Error(`Black Cloud credential wrapping key v${version} is not canonical base64.`), { statusCode: 503 });
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
