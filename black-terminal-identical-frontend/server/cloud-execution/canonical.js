import crypto from "node:crypto";

export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

export function hashCanonicalPayload(payload) {
  return crypto.createHash("sha256").update(canonicalize(payload)).digest("hex");
}

export function signCanonicalPayload(payload, signingKey = process.env.BLACK_CLOUD_INTENT_SIGNING_KEY) {
  assertSigningKey(signingKey);
  return crypto.createHmac("sha256", signingKey).update(canonicalize(payload)).digest("hex");
}

export function verifyCanonicalSignature(payload, signature, signingKey = process.env.BLACK_CLOUD_INTENT_SIGNING_KEY) {
  assertSigningKey(signingKey);
  const expected = Buffer.from(signCanonicalPayload(payload, signingKey), "hex");
  const actual = Buffer.from(String(signature || ""), "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function createExecutionIdempotencyKey({ groupIntentId, mandateId, connectionId, intentVersion, executionLeg }) {
  return hashCanonicalPayload({
    groupIntentId: String(groupIntentId),
    mandateId: String(mandateId),
    connectionId: String(connectionId),
    intentVersion: Number(intentVersion),
    executionLeg: String(executionLeg || "primary")
  });
}

export function createDeterministicClientOrderId(input) {
  const digest = hashCanonicalPayload(input);
  return `bt-grp-${digest.slice(0, 28)}`;
}

export function intentSigningPayload(intent) {
  return {
    groupId: intent.group_id ?? intent.groupId,
    createdBy: intent.created_by ?? intent.createdBy,
    clientIntentId: intent.client_intent_id ?? intent.clientIntentId,
    symbol: String(intent.symbol || "").toUpperCase(),
    marketType: intent.market_type ?? intent.marketType,
    side: intent.side,
    orderType: intent.order_type ?? intent.orderType,
    limitPrice: nullableNumber(intent.limit_price ?? intent.limitPrice),
    stopPrice: nullableNumber(intent.stop_price ?? intent.stopPrice),
    quantityModel: intent.quantity_model ?? intent.quantityModel,
    quantityValue: Number(intent.quantity_value ?? intent.quantityValue),
    leverage: nullableNumber(intent.leverage),
    marginMode: intent.margin_mode ?? intent.marginMode ?? null,
    timeInForce: intent.time_in_force ?? intent.timeInForce ?? null,
    reduceOnly: Boolean(intent.reduce_only ?? intent.reduceOnly),
    takeProfit: nullableNumber(intent.take_profit ?? intent.takeProfit),
    stopLoss: nullableNumber(intent.stop_loss ?? intent.stopLoss),
    trailingStop: intent.trailing_stop ?? intent.trailingStop ?? null,
    validFrom: normalizeTimestamp(intent.valid_from ?? intent.validFrom),
    expiresAt: normalizeTimestamp(intent.expires_at ?? intent.expiresAt),
    intentVersion: Number(intent.intent_version ?? intent.intentVersion),
    mandatePolicyVersion: Number(intent.mandate_policy_version ?? intent.mandatePolicyVersion),
    idempotencyKey: intent.idempotency_key ?? intent.idempotencyKey,
    supersedesIntentId: intent.supersedes_intent_id ?? intent.supersedesIntentId ?? null
  };
}

function assertSigningKey(value) {
  if (!value || Buffer.byteLength(value) < 32) {
    throw new Error("BLACK_CLOUD_INTENT_SIGNING_KEY must contain at least 32 bytes.");
  }
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTimestamp(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`Invalid intent timestamp: ${value}`);
  return new Date(time).toISOString();
}
