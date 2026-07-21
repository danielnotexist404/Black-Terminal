const SENSITIVE_KEY = /(password|secret|token|api.?key|private.?key|credential|prompt|messages?|html|authorization|signature|seed|mnemonic|encrypted|cipher|nonce|raw|payload)/i;

export function sanitizeAuditText(value, maximum = 1000) {
  return String(value ?? "")
    .replace(/-----BEGIN [^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END [^-]{0,40}PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(?:sk-ant-|re_)[a-zA-Z0-9_-]{16,}\b/g, "[REDACTED_PROVIDER_KEY]")
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, "[REDACTED_TOKEN]")
    .replace(/(password|secret|token|api.?key|private.?key|authorization|signature|seed|mnemonic)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/[\u0000-\u001f]/g, " ")
    .slice(0, maximum);
}

export function sanitizeAuditMetadata(value, depth = 0) {
  if (depth > 8) return "[REDACTED_DEPTH]";
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeAuditMetadata(entry, depth + 1));
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? sanitizeAuditText(value, 500) : value;
  }
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, entry]) => [
    String(key).slice(0, 80),
    SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeAuditMetadata(entry, depth + 1)
  ]));
}
