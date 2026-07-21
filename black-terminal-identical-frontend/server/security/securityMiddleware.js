import crypto from "node:crypto";
import { applyCors, getClientIp } from "./http-security.js";
import { getSupabaseAdmin, requireUser } from "../portfolio-api.js";
import { sanitizeAuditMetadata } from "./audit-safety.js";

const localBuckets = new Map();

const TIER_PERMISSIONS = Object.freeze({
  retail: ["ai.blackGpt", "execution.connectBroker", "execution.connectWallet", "execution.managePositions", "portfolio.retailAnalytics", "portfolio.investmentGroupDiscovery", "can_publish_research", "can_follow_users"],
  professional: ["ai.blackGpt", "execution.connectBroker", "execution.connectWallet", "execution.managePositions", "portfolio.retailAnalytics", "portfolio.investmentGroupDiscovery", "can_publish_research", "can_publish_indicators", "can_publish_strategies", "can_follow_users"],
  enterprise: ["ai.blackGpt", "execution.connectBroker", "execution.connectWallet", "execution.managePositions", "portfolio.retailAnalytics", "portfolio.investmentGroupDiscovery", "portfolio.enterpriseCapital", "portfolio.followers", "portfolio.executionMatrix", "portfolio.audit", "portfolio.permissions", "can_create_investment_group", "can_manage_investment_group", "can_approve_group_requests", "can_post_group_announcements", "can_view_enterprise_portfolio_tools", "can_publish_research", "can_publish_indicators", "can_publish_strategies", "can_follow_users", "proprietary.domPro"],
  admin: ["ai.blackGpt", "execution.connectBroker", "execution.connectWallet", "execution.managePositions", "portfolio.retailAnalytics", "portfolio.investmentGroupDiscovery", "portfolio.enterpriseCapital", "portfolio.followers", "portfolio.executionMatrix", "portfolio.audit", "portfolio.permissions", "can_create_investment_group", "can_manage_investment_group", "can_approve_group_requests", "can_post_group_announcements", "can_view_enterprise_portfolio_tools", "can_publish_research", "can_publish_indicators", "can_publish_strategies", "can_follow_users", "proprietary.domPro", "proprietary.hdlxProfile", "admin.override"]
});

export function enforcePayloadLimit(req, maximumBytes) {
  const declared = Number(req.headers?.["content-length"] || 0);
  if (declared > maximumBytes) throw httpError(413, "Request payload is too large.", "PAYLOAD_TOO_LARGE");
  if (req.body !== undefined) {
    const measured = Buffer.byteLength(typeof req.body === "string" ? req.body : JSON.stringify(req.body), "utf8");
    if (measured > maximumBytes) throw httpError(413, "Request payload is too large.", "PAYLOAD_TOO_LARGE");
  }
  validateJsonEnvelope(req.body);
}

export async function requireApiSecurity(req, res, policy = {}) {
  if (applyCors(req, res)) return { handled: true };
  enforcePayloadLimit(req, policy.maxBytes || 50 * 1024);
  const { supabase, user } = await requireUser(req);
  const identity = await loadSecurityIdentity(supabase, user);
  if (identity.status === "suspended") throw httpError(403, "Account access is suspended.", "ACCOUNT_SUSPENDED");
  if (policy.allowedTiers?.length && !policy.allowedTiers.includes(identity.productTier)) {
    throw httpError(403, "Subscription level does not permit this API.", "SUBSCRIPTION_REQUIRED");
  }
  if (policy.permission && !identity.permissions.has(policy.permission) && identity.role !== "admin") {
    throw httpError(403, "API permission is not granted.", "API_PERMISSION_REQUIRED");
  }
  const rateLimit = typeof policy.rateLimit === "function" ? policy.rateLimit(identity) : policy.rateLimit || {};
  await enforceRateLimit(supabase, req, user.id, policy.endpoint || req.url || "api", rateLimit);
  return { handled: false, supabase, user, identity };
}

export async function enforceAnonymousSecurity(req, res, policy = {}) {
  if (applyCors(req, res)) return { handled: true };
  enforcePayloadLimit(req, policy.maxBytes || 16 * 1024);
  const supabase = getSupabaseAdmin();
  await enforceRateLimit(supabase, req, null, policy.endpoint || req.url || "anonymous", policy.rateLimit || {});
  return { handled: false, supabase };
}

export async function writeSecurityAudit(supabase, event) {
  const safeMetadata = sanitizeAuditMetadata(event.metadata || {});
  const { error } = await supabase.from("security_audit_events").insert({
    user_id: event.userId || null,
    event_type: String(event.type || "SECURITY_EVENT").slice(0, 80),
    severity: String(event.severity || "INFO").toUpperCase().slice(0, 16),
    endpoint: event.endpoint ? String(event.endpoint).slice(0, 160) : null,
    ip_hash: event.ip ? hashValue(event.ip) : null,
    safe_metadata: safeMetadata
  });
  if (error && error.code !== "PGRST205") console.error("[security-audit-write]", error.code || "unknown");
}

async function loadSecurityIdentity(supabase, user) {
  const { data } = await supabase
    .from("bt_users")
    .select("role,status,product_tier,permissions")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const role = data?.role || user.app_metadata?.role || "user";
  const productTier = role === "admin" ? "admin" : data?.product_tier || user.app_metadata?.productTier || "retail";
  const permissions = new Set([
    ...(TIER_PERMISSIONS[productTier] || TIER_PERMISSIONS.retail),
    ...(Array.isArray(data?.permissions) ? data.permissions : []),
    ...(Array.isArray(user.app_metadata?.permissions) ? user.app_metadata.permissions : [])
  ]);
  return { role, productTier, permissions, status: data?.status || "online" };
}

function validateJsonEnvelope(body) {
  if (body === undefined || body === null || typeof body === "string" || Buffer.isBuffer(body)) return;
  if (Array.isArray(body) || typeof body !== "object") throw httpError(400, "JSON request body must be an object.", "INVALID_JSON_BODY");
  const blockedKey = /^(?:__proto__|prototype|constructor)$/;
  const visit = (value, depth) => {
    if (depth > 10) throw httpError(400, "JSON request body is too deeply nested.", "INVALID_JSON_BODY");
    if (!value || typeof value !== "object") return;
    const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
    let count = 0;
    for (const [key, child] of entries) {
      count += 1;
      if (count > 500 || blockedKey.test(String(key))) throw httpError(400, "JSON request body is invalid.", "INVALID_JSON_BODY");
      visit(child, depth + 1);
    }
  };
  visit(body, 0);
}

async function enforceRateLimit(supabase, req, userId, endpoint, config) {
  const minuteLimit = Math.max(1, Number(config.perMinute || 60));
  const dailyLimit = Math.max(minuteLimit, Number(config.perDay || 5000));
  const ipHash = hashValue(getClientIp(req));
  const key = `${endpoint}:${userId || ipHash}`;
  enforceLocalBucket(key, minuteLimit);
  const { data, error } = await supabase.rpc("consume_api_rate_limit", {
    p_endpoint: String(endpoint).slice(0, 160),
    p_user_id: userId || null,
    p_ip_hash: ipHash,
    p_minute_limit: minuteLimit,
    p_daily_limit: dailyLimit
  });
  if (error) {
    if (process.env.NODE_ENV === "production" && error.code !== "PGRST202") {
      throw httpError(503, "Security rate-limit service is unavailable.", "RATE_LIMIT_UNAVAILABLE");
    }
    return;
  }
  const result = Array.isArray(data) ? data[0] : data;
  if (result && result.allowed === false) throw httpError(429, "Rate limit exceeded.", "RATE_LIMITED");
}

function enforceLocalBucket(key, limit) {
  const now = Date.now();
  const bucket = localBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    localBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    if (localBuckets.size > 2000) {
      for (const [entryKey, value] of localBuckets) if (now >= value.resetAt) localBuckets.delete(entryKey);
    }
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) throw httpError(429, "Rate limit exceeded.", "RATE_LIMITED");
}

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function httpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
