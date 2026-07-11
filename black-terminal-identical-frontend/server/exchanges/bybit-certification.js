export const BYBIT_CERTIFICATION_OUTCOMES = Object.freeze({
  CERTIFIED: "CERTIFIED",
  PARTIALLY_CERTIFIED: "PARTIALLY_CERTIFIED",
  FAILED: "FAILED",
  BLOCKED_EXTERNAL_CONFIGURATION: "BLOCKED_EXTERNAL_CONFIGURATION",
  BLOCKED_ACCOUNT_PERMISSION: "BLOCKED_ACCOUNT_PERMISSION",
  BLOCKED_VENUE_LIMITATION: "BLOCKED_VENUE_LIMITATION",
  BLOCKED_RUNTIME_DEFECT: "BLOCKED_RUNTIME_DEFECT"
});

export const BYBIT_MANDATORY_CERTIFICATION_STAGES = Object.freeze([
  "credential-validation",
  "account-read",
  "private-stream",
  "limit-cancel",
  "modify",
  "market-position",
  "tp-sl",
  "close",
  "reconnect-reconcile",
  "persisted-evidence"
]);

export function evaluateBybitCertification({ rows = [], blockers = [], defects = [] } = {}) {
  const normalizedRows = rows.map((row) => ({
    ...row,
    operation: String(row.operation || row.stage || "").trim(),
    status: String(row.status || "").toLowerCase()
  }));
  const passed = new Set(normalizedRows.filter((row) => row.status === "passed").map((row) => row.operation));
  const failed = normalizedRows.filter((row) => ["failed", "blocked"].includes(row.status));
  const missingMandatory = BYBIT_MANDATORY_CERTIFICATION_STAGES.filter((stage) => !passed.has(stage));
  const normalizedBlockers = blockers.map((item) => classifyBybitBlocker(item));
  const normalizedDefects = defects.map((item) => classifyBybitBlocker(item));
  const allClassifications = [...normalizedBlockers, ...normalizedDefects];

  if (missingMandatory.length === 0 && failed.length === 0 && allClassifications.length === 0) {
    return {
      outcome: BYBIT_CERTIFICATION_OUTCOMES.CERTIFIED,
      mandatoryPassed: true,
      missingMandatory,
      failed,
      blockers: []
    };
  }

  if (allClassifications.some((item) => item.category === "permission")) {
    return decision(BYBIT_CERTIFICATION_OUTCOMES.BLOCKED_ACCOUNT_PERMISSION, missingMandatory, failed, allClassifications);
  }
  if (allClassifications.some((item) => item.category === "venue")) {
    return decision(BYBIT_CERTIFICATION_OUTCOMES.BLOCKED_VENUE_LIMITATION, missingMandatory, failed, allClassifications);
  }
  if (allClassifications.some((item) => item.category === "runtime")) {
    return decision(BYBIT_CERTIFICATION_OUTCOMES.BLOCKED_RUNTIME_DEFECT, missingMandatory, failed, allClassifications);
  }
  if (allClassifications.length > 0 || missingMandatory.length > 0) {
    return decision(BYBIT_CERTIFICATION_OUTCOMES.BLOCKED_EXTERNAL_CONFIGURATION, missingMandatory, failed, allClassifications);
  }

  return decision(BYBIT_CERTIFICATION_OUTCOMES.FAILED, missingMandatory, failed, allClassifications);
}

export function classifyBybitBlocker(input) {
  const message = typeof input === "string" ? input : input?.message || String(input || "");
  const lower = message.toLowerCase();
  let category = "configuration";

  if (/is required|allowlist|allowed_connections|allowed_symbols|max_notional|must be configured|must be true|supabase|certify_|credential_master|not in bybit_mainnet_allowed/.test(lower)) category = "configuration";
  else if (/permission|withdraw|read-only|trading permission|api key/.test(lower)) category = "permission";
  else if (/minimum venue|venue minimum|trading status|market closed|not trading/.test(lower)) category = "venue";
  else if (/stream|reconnect|oms|position manager|normalization|lifecycle|runtime|server error|route/.test(lower)) category = "runtime";

  return { message, category };
}

export function statusLine(status, label, message = "") {
  const normalized = String(status || "skipped").toUpperCase();
  return `${normalized.padEnd(7)} ${label}${message ? ` - ${message}` : ""}`;
}

function decision(outcome, missingMandatory, failed, blockers) {
  return {
    outcome,
    mandatoryPassed: false,
    missingMandatory,
    failed,
    blockers
  };
}
