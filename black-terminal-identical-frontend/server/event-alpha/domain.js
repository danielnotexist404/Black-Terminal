import crypto from "node:crypto";

export const EVENT_FAMILIES = Object.freeze(["TOKEN_SUPPLY", "GOVERNANCE", "PROTOCOL_ECONOMICS"]);
export const THESIS_STATES = Object.freeze(["DRAFT", "OBSERVING", "ARMED", "TRIGGERED", "PAPER_ACTIVE", "RESOLVED", "EXPIRED", "INVALIDATED", "REJECTED"]);
export const RESPONSE_OUTCOMES = Object.freeze(["UNDERREACTION", "FULLY_PRICED", "OVERREACTION", "AMBIGUOUS", "NO_TRADE"]);
export const EVENT_ALPHA_REASON_CODES = Object.freeze({
  EXPECTATION_CAUSAL: "EXPECTATION_CAUSAL",
  EXPECTATION_LATE: "EXPECTATION_LATE",
  SOURCE_QUARANTINED: "SOURCE_QUARANTINED",
  SOURCE_CONFIDENCE_LOW: "SOURCE_CONFIDENCE_LOW",
  DUPLICATE_REVISION: "DUPLICATE_REVISION",
  POSITIVE_SUPPLY_SURPRISE: "POSITIVE_SUPPLY_SURPRISE",
  NEGATIVE_SUPPLY_SURPRISE: "NEGATIVE_SUPPLY_SURPRISE",
  WEAK_VALUE_CAPTURE: "WEAK_VALUE_CAPTURE",
  LOW_GOVERNANCE_SURPRISE: "LOW_GOVERNANCE_SURPRISE",
  UNDERREACTION_DETECTED: "UNDERREACTION_DETECTED",
  FULLY_PRICED: "FULLY_PRICED",
  OVERREACTION_DETECTED: "OVERREACTION_DETECTED",
  EVIDENCE_AMBIGUOUS: "EVIDENCE_AMBIGUOUS",
  ALPHA_BELOW_COST: "ALPHA_BELOW_COST",
  TACTICAL_SETUP_CONFIRMED: "TACTICAL_SETUP_CONFIRMED",
  TACTICAL_SETUP_STALE: "TACTICAL_SETUP_STALE",
  TACTICAL_SETUP_IDENTITY_INVALID: "TACTICAL_SETUP_IDENTITY_INVALID",
  TACTICAL_DIRECTION_CONFLICT: "TACTICAL_DIRECTION_CONFLICT",
  COOLDOWN_ACTIVE: "COOLDOWN_ACTIVE",
  PAPER_ONLY: "PAPER_ONLY",
  LIVE_EXECUTION_FORBIDDEN: "LIVE_EXECUTION_FORBIDDEN",
  MANUAL_APPROVAL_REQUIRED: "MANUAL_APPROVAL_REQUIRED",
  RISK_LIMIT_REJECTED: "RISK_LIMIT_REJECTED",
  THESIS_EXPIRED: "THESIS_EXPIRED",
  THESIS_NOT_ARMED: "THESIS_NOT_ARMED",
  THESIS_DIRECTION_NOT_TRADABLE: "THESIS_DIRECTION_NOT_TRADABLE",
  CONFIDENCE_BELOW_MINIMUM: "CONFIDENCE_BELOW_MINIMUM",
  ALPHA_BELOW_MINIMUM: "ALPHA_BELOW_MINIMUM",
  SYMBOL_NOT_ALLOWED: "SYMBOL_NOT_ALLOWED",
  MARKET_PRICE_INVALID: "MARKET_PRICE_INVALID",
  MAX_LOSS_EXCEEDED: "MAX_LOSS_EXCEEDED",
  POINT_IN_TIME_EVIDENCE_INCOMPLETE: "POINT_IN_TIME_EVIDENCE_INCOMPLETE",
  INVALID_TIMESTAMP: "INVALID_TIMESTAMP",
  INVALID_SCHEMA: "INVALID_SCHEMA",
  SOURCE_EVIDENCE_ACCEPTED: "SOURCE_EVIDENCE_ACCEPTED",
  ADMIN_REVIEW_APPROVED: "ADMIN_REVIEW_APPROVED",
  ADMIN_INVALIDATED: "ADMIN_INVALIDATED",
  THESIS_RESOLVED: "THESIS_RESOLVED",
  EVENT_REVISION_MATERIAL: "EVENT_REVISION_MATERIAL",
  MANUAL_APPROVAL_CONFIRMED: "MANUAL_APPROVAL_CONFIRMED",
  PAPER_FILL_CONFIRMED: "PAPER_FILL_CONFIRMED"
});
export const EVENT_ALPHA_REASON_CODE_SET = new Set(Object.values(EVENT_ALPHA_REASON_CODES));

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

export function asUtcIso(value, field = "timestamp") {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw domainError("EVENT_ALPHA_INVALID_TIMESTAMP", `${field} must be a valid UTC timestamp.`);
  return parsed.toISOString();
}

export function boundedText(value, field, maximum = 240) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maximum) throw domainError("EVENT_ALPHA_INVALID_TEXT", `${field} must contain 1-${maximum} characters.`);
  return text;
}

export function normalizedAsset(value) {
  const asset = boundedText(value, "assetId", 80).replace(/[^a-zA-Z0-9._:-]/g, "").toUpperCase();
  if (asset.length < 2) throw domainError("EVENT_ALPHA_INVALID_ASSET", "assetId is invalid.");
  return asset;
}

export function normalizedSymbol(value) {
  const symbol = boundedText(value, "symbol", 40).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (symbol.length < 2) throw domainError("EVENT_ALPHA_INVALID_SYMBOL", "symbol is invalid.");
  return symbol;
}

export function finite(value, field, options = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw domainError("EVENT_ALPHA_INVALID_NUMBER", `${field} must be a finite number.`);
  if (options.minimum !== undefined && value < options.minimum) throw domainError("EVENT_ALPHA_INVALID_NUMBER", `${field} is below its minimum.`);
  if (options.maximum !== undefined && value > options.maximum) throw domainError("EVENT_ALPHA_INVALID_NUMBER", `${field} is above its maximum.`);
  return value;
}

export function normalizeRawEventEnvelope(input, now = new Date()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw domainError("EVENT_ALPHA_INVALID_SCHEMA", "Raw event envelope must be an object.");
  const eventFamily = String(input.eventFamily || "").toUpperCase();
  if (!EVENT_FAMILIES.includes(eventFamily)) throw domainError("EVENT_ALPHA_INVALID_EVENT_FAMILY", "Unsupported Event Alpha family.");
  if (!input.observedAt || !input.firstActionableAt) {
    throw domainError("EVENT_ALPHA_SOURCE_TIMESTAMP_REQUIRED", "observedAt and firstActionableAt are required provider evidence.");
  }
  const observedAt = asUtcIso(input.observedAt, "observedAt");
  const firstActionableAt = asUtcIso(input.firstActionableAt, "firstActionableAt");
  if (Date.parse(observedAt) > now.getTime() + 30_000) throw domainError("EVENT_ALPHA_CLOCK_SKEW", "observedAt is implausibly far in the future.");
  if (Date.parse(firstActionableAt) > Date.parse(observedAt)) throw domainError("EVENT_ALPHA_CAUSAL_ORDER_INVALID", "firstActionableAt cannot be later than collection time.");
  const sourcePublishedAt = input.sourcePublishedAt ? asUtcIso(input.sourcePublishedAt, "sourcePublishedAt") : null;
  if (sourcePublishedAt && Date.parse(sourcePublishedAt) > Date.parse(observedAt)) throw domainError("EVENT_ALPHA_CAUSAL_ORDER_INVALID", "sourcePublishedAt cannot be later than collection time.");
  const payload = sanitizeExternalPayload(input.payload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw domainError("EVENT_ALPHA_INVALID_SCHEMA", "Raw event payload must be an object.");
  return Object.freeze({
    sourceKey: boundedText(input.sourceKey, "sourceKey", 80).toUpperCase(),
    sourceEventId: boundedText(input.sourceEventId, "sourceEventId", 240),
    eventFamily,
    observedAt,
    firstActionableAt,
    sourcePublishedAt,
    payload,
    payloadHash: sha256(payload),
    ingestionMetadata: sanitizeSafeMetadata(input.ingestionMetadata || {})
  });
}

export function normalizeTokenUnlock(envelope) {
  if (envelope.eventFamily !== "TOKEN_SUPPLY") throw domainError("EVENT_ALPHA_EVENT_FAMILY_MISMATCH", "Token unlock normalizer received another family.");
  const payload = envelope.payload;
  const assetId = normalizedAsset(payload.assetId);
  const symbol = normalizedSymbol(payload.symbol);
  const eventTime = asUtcIso(payload.eventTime, "eventTime");
  if (Date.parse(eventTime) < Date.parse(envelope.firstActionableAt)) throw domainError("EVENT_ALPHA_EVENT_ALREADY_STALE", "Event time precedes first actionable evidence.");
  const unlockTokens = finite(payload.unlockTokens, "unlockTokens", { minimum: 0 });
  const circulatingSupply = finite(payload.circulatingSupply, "circulatingSupply", { minimum: Number.EPSILON });
  const unlockPctCirculating = unlockTokens / circulatingSupply;
  const beneficiaryClass = boundedText(payload.beneficiaryClass || "UNKNOWN", "beneficiaryClass", 80).toUpperCase();
  const canonicalKey = `TOKEN_SUPPLY:${assetId}:${eventTime}:${beneficiaryClass}`;
  const normalizedPayload = Object.freeze({
    assetId,
    symbol,
    eventTime,
    unlockTokens,
    circulatingSupply,
    unlockPctCirculating,
    beneficiaryClass,
    liquidImmediatelyPct: optionalRatio(payload.liquidImmediatelyPct, 1),
    cliff: Boolean(payload.cliff),
    sourceNoticeId: payload.sourceNoticeId ? boundedText(payload.sourceNoticeId, "sourceNoticeId", 160) : null
  });
  return Object.freeze({
    canonicalKey,
    dedupeFingerprint: sha256({ canonicalKey, normalizedPayload }),
    eventFamily: "TOKEN_SUPPLY",
    assetId,
    symbol,
    eventTime,
    firstActionableAt: envelope.firstActionableAt,
    normalizedPayload,
    sourceConfidence: finite(payload.sourceConfidence ?? 0.8, "sourceConfidence", { minimum: 0, maximum: 1 }),
    safeSummary: `${symbol} unlock ${unlockTokens} tokens (${(unlockPctCirculating * 100).toFixed(4)}% of circulating supply).`
  });
}

export function bindExpectationToEvent(expectation, canonicalEvent) {
  const asOf = asUtcIso(expectation.asOf, "expectation.asOf");
  const firstActionableAt = asUtcIso(canonicalEvent.firstActionableAt, "event.firstActionableAt");
  if (Date.parse(asOf) >= Date.parse(firstActionableAt)) {
    throw domainError("EVENT_ALPHA_EXPECTATION_LOOKAHEAD", "Expectation snapshot must exist before first actionable event evidence.");
  }
  const contributors = Array.isArray(expectation.contributors) ? expectation.contributors.map(sanitizeSafeMetadata) : [];
  for (const contributor of contributors) {
    const contributorObservedAt = contributor.observedAt ? Date.parse(String(contributor.observedAt)) : Number.NaN;
    if (!Number.isFinite(contributorObservedAt) || contributorObservedAt > Date.parse(asOf)) {
      throw domainError("EVENT_ALPHA_EXPECTATION_CONTRIBUTOR_LOOKAHEAD", "Every expectation contributor must be observed by the snapshot as-of time.");
    }
  }
  return Object.freeze({
    canonicalEventKey: canonicalEvent.canonicalKey,
    asOf,
    firstActionableAt,
    modelKey: boundedText(expectation.modelKey, "modelKey", 120),
    modelVersion: boundedText(expectation.modelVersion, "modelVersion", 80),
    expectedValue: expectation.expectedValue === null || expectation.expectedValue === undefined ? null : finite(expectation.expectedValue, "expectedValue"),
    expectedTime: expectation.expectedTime ? asUtcIso(expectation.expectedTime, "expectedTime") : null,
    expectedProbability: expectation.expectedProbability === null || expectation.expectedProbability === undefined ? null : finite(expectation.expectedProbability, "expectedProbability", { minimum: 0, maximum: 1 }),
    dispersion: expectation.dispersion === null || expectation.dispersion === undefined ? null : finite(expectation.dispersion, "dispersion", { minimum: 0 }),
    confidence: finite(expectation.confidence, "expectation.confidence", { minimum: 0, maximum: 1 }),
    contributors,
    featureManifest: sanitizeSafeMetadata(expectation.featureManifest || {})
  });
}

export function eventAlphaRuntimeConfig(env = process.env) {
  const engineEnabled = env.EVENT_ALPHA_ENGINE_ENABLED === "true";
  const ingestionEnabled = engineEnabled && env.EVENT_ALPHA_INGESTION_ENABLED === "true";
  const tokenSupplyEnabled = ingestionEnabled && env.EVENT_ALPHA_TOKEN_SUPPLY_ENABLED === "true";
  const strategyKillSwitchEngaged = env.EVENT_ALPHA_STRATEGY_KILL_SWITCH !== "false";
  const globalExecutionKillSwitchEngaged = env.EVENT_ALPHA_GLOBAL_EXECUTION_KILL_SWITCH !== "false";
  const paperRequested = env.EVENT_ALPHA_PAPER_EXECUTION_ENABLED === "true";
  const paperExecutionEnabled = engineEnabled && paperRequested && !strategyKillSwitchEngaged && !globalExecutionKillSwitchEngaged;
  const liveRequested = env.EVENT_ALPHA_LIVE_EXECUTION_ENABLED === "true";
  const manualApprovalDisabled = env.EVENT_ALPHA_REQUIRE_MANUAL_APPROVAL === "false" || env.EVENT_ALPHA_MANUAL_APPROVAL_REQUIRED === "false";
  return Object.freeze({
    engineEnabled,
    ingestionEnabled,
    tokenSupplyEnabled,
    paperExecutionEnabled,
    paperExecutionConfigurationRejected: paperRequested && (strategyKillSwitchEngaged || globalExecutionKillSwitchEngaged),
    liveExecutionEnabled: false,
    liveExecutionConfigurationRejected: liveRequested,
    manualApprovalRequired: true,
    manualApprovalConfigurationRejected: manualApprovalDisabled,
    strategyKillSwitchEngaged,
    globalExecutionKillSwitchEngaged,
    tokenUnlockSourceConfigured: tokenSupplyEnabled && Boolean(env.EVENT_ALPHA_TOKEN_UNLOCK_API_URL && env.EVENT_ALPHA_TOKEN_UNLOCK_API_TOKEN),
    governanceAdapterEnabled: false,
    governanceConfigurationRequested: env.EVENT_ALPHA_GOVERNANCE_ENABLED === "true",
    protocolEconomicsAdapterEnabled: false,
    protocolEconomicsConfigurationRequested: env.EVENT_ALPHA_PROTOCOL_ECONOMICS_ENABLED === "true",
    llmExtractionEnabled: false,
    llmExtractionConfigurationRejected: env.EVENT_ALPHA_LLM_EXTRACTION_ENABLED === "true"
  });
}

export function sanitizeExternalPayload(value, depth = 0) {
  if (depth > 8) throw domainError("EVENT_ALPHA_PAYLOAD_DEPTH", "External event payload is too deeply nested.");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw domainError("EVENT_ALPHA_INVALID_NUMBER", "External payload contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 500) throw domainError("EVENT_ALPHA_PAYLOAD_SIZE", "External payload array is too large.");
    return value.map((entry) => sanitizeExternalPayload(entry, depth + 1));
  }
  if (!value || typeof value !== "object") throw domainError("EVENT_ALPHA_INVALID_SCHEMA", "External payload contains an unsupported value.");
  const entries = Object.entries(value);
  if (entries.length > 500) throw domainError("EVENT_ALPHA_PAYLOAD_SIZE", "External payload object is too large.");
  const result = {};
  for (const [key, entry] of entries) {
    if (/^(?:__proto__|prototype|constructor)$/i.test(key)) throw domainError("EVENT_ALPHA_PROTOTYPE_KEY", "External payload contains a blocked key.");
    result[String(key).slice(0, 120)] = sanitizeExternalPayload(entry, depth + 1);
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 1024 * 1024) throw domainError("EVENT_ALPHA_PAYLOAD_SIZE", "External payload exceeds one MiB.");
  return result;
}

export function sanitizeSafeMetadata(value) {
  const safe = sanitizeExternalPayload(value);
  if (!safe || typeof safe !== "object" || Array.isArray(safe)) throw domainError("EVENT_ALPHA_INVALID_SCHEMA", "Safe metadata must be an object.");
  return safe;
}

function optionalRatio(value, fallback) {
  if (value === null || value === undefined) return fallback;
  return finite(value, "ratio", { minimum: 0, maximum: 1 });
}

export function domainError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
