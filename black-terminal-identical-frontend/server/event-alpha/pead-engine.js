import { asUtcIso, boundedText, finite, sanitizeExternalPayload, sha256 } from "./domain.js";

export const PEAD_SIGNAL_STATES = Object.freeze(["POSITIVE_DRIFT", "NEGATIVE_DRIFT", "FULLY_PRICED", "OVERREACTION", "NO_TRADE"]);
export const PEAD_METHODOLOGY_VERSION = "BC_PEAD_CAUSAL_V1";

/**
 * Build one point-in-time PEAD assessment. Inputs are deliberately provider
 * neutral, but every estimate must have existed before the announcement and
 * every return observation must exist at or after the first actionable time.
 */
export function assessPeadEvidence(input) {
  const evidence = normalizePeadEvidence(input);
  const epsError = evidence.actuals.eps - evidence.consensus.eps;
  const revenueError = evidence.actuals.revenue - evidence.consensus.revenue;
  const epsDispersion = robustScale(evidence.history.epsForecastErrors, Math.max(Math.abs(evidence.consensus.eps) * 0.08, 0.01));
  const revenueDispersion = robustScale(evidence.history.revenueForecastErrors, Math.max(Math.abs(evidence.consensus.revenue) * 0.025, 1));
  const epsSue = clamp(epsError / epsDispersion, -8, 8);
  const revenueSue = clamp(revenueError / revenueDispersion, -8, 8);
  const guidanceSue = evidence.actuals.guidance === null || evidence.consensus.guidance === null
    ? null
    : clamp((evidence.actuals.guidance - evidence.consensus.guidance) / robustScale(evidence.history.guidanceForecastErrors, Math.max(Math.abs(evidence.consensus.guidance) * 0.05, 0.01)), -8, 8);
  const marginSue = evidence.actuals.margin === null || evidence.consensus.margin === null
    ? null
    : clamp((evidence.actuals.margin - evidence.consensus.margin) / robustScale(evidence.history.marginForecastErrors, 0.005), -8, 8);

  const components = [
    { name: "EPS", value: epsSue, weight: 0.5 },
    { name: "REVENUE", value: revenueSue, weight: 0.25 },
    ...(guidanceSue === null ? [] : [{ name: "GUIDANCE", value: guidanceSue, weight: 0.15 }]),
    ...(marginSue === null ? [] : [{ name: "MARGIN", value: marginSue, weight: 0.10 }])
  ];
  const weightTotal = components.reduce((sum, row) => sum + row.weight, 0);
  const compositeSurprise = components.reduce((sum, row) => sum + row.value * row.weight, 0) / weightTotal;
  const returnPath = buildAbnormalReturnPath(evidence);
  const immediateCarBps = returnPath.length ? returnPath[0].cumulativeAbnormalReturnBps : 0;
  const totalCarBps = returnPath.length ? returnPath.at(-1).cumulativeAbnormalReturnBps : 0;
  const expectedDriftBps = Math.tanh(compositeSurprise / 2) * evidence.policy.maximumExpectedDriftBps;
  const directionalCostBps = Math.sign(expectedDriftBps || 1) * evidence.costs.roundTripBps;
  const remainingDriftBps = expectedDriftBps - totalCarBps - directionalCostBps;
  const coverage = components.reduce((sum, row) => sum + row.weight, 0);
  const confidence = clamp(
    evidence.sourceConfidence * 0.42
      + Math.min(1, evidence.consensus.contributorCount / 12) * 0.22
      + Math.min(1, evidence.history.epsForecastErrors.length / 8) * 0.14
      + Math.min(1, returnPath.length / 4) * 0.12
      + coverage * 0.10,
    0,
    1
  );
  const classification = classifyPead({
    compositeSurprise,
    expectedDriftBps,
    totalCarBps,
    remainingDriftBps,
    confidence,
    policy: evidence.policy
  });
  const evidenceHash = sha256(evidence);
  return Object.freeze({
    canonicalKey: `EQUITY_PEAD:${evidence.ticker}:${evidence.fiscalPeriod}:${evidence.announcedAt}`,
    evidenceHash,
    methodologyVersion: PEAD_METHODOLOGY_VERSION,
    evidence,
    metrics: Object.freeze({ epsError, revenueError, epsSue, revenueSue, guidanceSue, marginSue, compositeSurprise, immediateCarBps, totalCarBps, expectedDriftBps, remainingDriftBps, confidence }),
    signal: Object.freeze(classification),
    returnPath: Object.freeze(returnPath)
  });
}

export function normalizePeadEvidence(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw peadError("PEAD_INVALID_SCHEMA", "PEAD evidence must be an object.");
  const announcedAt = asUtcIso(input.announcedAt, "announcedAt");
  const firstActionableAt = asUtcIso(input.firstActionableAt || input.announcedAt, "firstActionableAt");
  const expectationAsOf = asUtcIso(input.expectationAsOf, "expectationAsOf");
  if (Date.parse(expectationAsOf) >= Date.parse(firstActionableAt)) throw peadError("PEAD_EXPECTATION_LOOKAHEAD", "Consensus snapshot must predate the first actionable announcement time.");
  if (Date.parse(firstActionableAt) < Date.parse(announcedAt) - 60_000) throw peadError("PEAD_ACTIONABLE_ORDER_INVALID", "First actionable evidence cannot materially predate the announcement.");
  if (Date.parse(firstActionableAt) > Date.now() + 30_000) throw peadError("PEAD_ANNOUNCEMENT_NOT_ACTIONABLE", "A future earnings announcement cannot be assessed as completed evidence.");
  const actuals = normalizeFundamentals(input.actuals, "actuals", true);
  const consensus = normalizeFundamentals(input.consensus, "consensus", true);
  const contributorCount = integer(input.consensus?.contributorCount, "consensus.contributorCount", 1, 10_000);
  const observations = normalizeReturnObservations(input.returnObservations, firstActionableAt);
  const sourceManifest = sanitizeExternalPayload(input.sourceManifest || {});
  rejectSensitiveManifestKeys(sourceManifest);
  const filingUrl = optionalHttps(input.filingUrl, "filingUrl");
  const consensusSourceUrl = optionalHttps(input.consensusSourceUrl, "consensusSourceUrl");
  const priceSourceUrl = optionalHttps(input.priceSourceUrl, "priceSourceUrl");
  return Object.freeze({
    providerEventId: boundedText(input.providerEventId, "providerEventId", 240),
    cik: normalizeCik(input.cik),
    ticker: ticker(input.ticker),
    issuer: boundedText(input.issuer, "issuer", 240),
    fiscalPeriod: boundedText(input.fiscalPeriod, "fiscalPeriod", 40).toUpperCase(),
    announcedAt,
    firstActionableAt,
    expectationAsOf,
    session: enumValue(input.session || "UNKNOWN", ["PRE_MARKET", "REGULAR", "AFTER_HOURS", "UNKNOWN"], "session"),
    actuals,
    consensus: Object.freeze({ ...consensus, contributorCount }),
    history: Object.freeze({
      epsForecastErrors: finiteArray(input.history?.epsForecastErrors, "history.epsForecastErrors", 64),
      revenueForecastErrors: finiteArray(input.history?.revenueForecastErrors, "history.revenueForecastErrors", 64),
      guidanceForecastErrors: finiteArray(input.history?.guidanceForecastErrors || [], "history.guidanceForecastErrors", 64),
      marginForecastErrors: finiteArray(input.history?.marginForecastErrors || [], "history.marginForecastErrors", 64)
    }),
    returnObservations: observations,
    beta: boundedFinite(input.beta ?? 1, "beta", -5, 5),
    sectorBeta: boundedFinite(input.sectorBeta ?? 0, "sectorBeta", -5, 5),
    sourceConfidence: boundedFinite(input.sourceConfidence, "sourceConfidence", 0, 1),
    costs: Object.freeze({ roundTripBps: boundedFinite(input.costs?.roundTripBps ?? 8, "costs.roundTripBps", 0, 500) }),
    policy: Object.freeze({
      minimumAbsoluteSue: boundedFinite(input.policy?.minimumAbsoluteSue ?? 0.55, "policy.minimumAbsoluteSue", 0.05, 5),
      minimumRemainingDriftBps: boundedFinite(input.policy?.minimumRemainingDriftBps ?? 20, "policy.minimumRemainingDriftBps", 0, 2_000),
      minimumConfidence: boundedFinite(input.policy?.minimumConfidence ?? 0.58, "policy.minimumConfidence", 0, 1),
      fullyPricedRatio: boundedFinite(input.policy?.fullyPricedRatio ?? 0.8, "policy.fullyPricedRatio", 0.25, 1.5),
      maximumExpectedDriftBps: boundedFinite(input.policy?.maximumExpectedDriftBps ?? 600, "policy.maximumExpectedDriftBps", 25, 5_000)
    }),
    filingUrl,
    consensusSourceUrl,
    priceSourceUrl,
    sourceManifest
  });
}

export function buildAbnormalReturnPath(evidence) {
  let cumulative = 0;
  return evidence.returnObservations.map((row, index) => {
    const abnormal = row.stockReturnBps - evidence.beta * row.marketReturnBps - evidence.sectorBeta * row.sectorReturnBps;
    cumulative += abnormal;
    return Object.freeze({ index, observedAt: row.observedAt, price: row.price, stockReturnBps: row.stockReturnBps, marketReturnBps: row.marketReturnBps, sectorReturnBps: row.sectorReturnBps, abnormalReturnBps: abnormal, cumulativeAbnormalReturnBps: cumulative });
  });
}

function classifyPead({ compositeSurprise, expectedDriftBps, totalCarBps, remainingDriftBps, confidence, policy }) {
  const reasons = [];
  if (Math.abs(compositeSurprise) < policy.minimumAbsoluteSue) reasons.push("SURPRISE_BELOW_THRESHOLD");
  if (confidence < policy.minimumConfidence) reasons.push("CONFIDENCE_BELOW_THRESHOLD");
  if (reasons.length) return { state: "NO_TRADE", direction: "NEUTRAL", reasonCodes: reasons };
  const sameDirection = Math.sign(totalCarBps) === Math.sign(expectedDriftBps) || totalCarBps === 0;
  if (sameDirection && Math.abs(totalCarBps) > Math.abs(expectedDriftBps) * 1.25) return { state: "OVERREACTION", direction: "NEUTRAL", reasonCodes: ["EXPECTED_DRIFT_OVERSHOT"] };
  if (sameDirection && Math.abs(totalCarBps) >= Math.abs(expectedDriftBps) * policy.fullyPricedRatio) return { state: "FULLY_PRICED", direction: "NEUTRAL", reasonCodes: ["ANNOUNCEMENT_FULLY_PRICED"] };
  if (Math.abs(remainingDriftBps) < policy.minimumRemainingDriftBps || Math.sign(remainingDriftBps) !== Math.sign(expectedDriftBps)) return { state: "NO_TRADE", direction: "NEUTRAL", reasonCodes: ["REMAINING_DRIFT_BELOW_COST"] };
  return expectedDriftBps > 0
    ? { state: "POSITIVE_DRIFT", direction: "LONG", reasonCodes: ["POSITIVE_STANDARDIZED_SURPRISE", "UNDERREACTION_DETECTED"] }
    : { state: "NEGATIVE_DRIFT", direction: "SHORT", reasonCodes: ["NEGATIVE_STANDARDIZED_SURPRISE", "UNDERREACTION_DETECTED"] };
}

function normalizeFundamentals(value, field, required) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw peadError("PEAD_FUNDAMENTALS_REQUIRED", `${field} evidence is required.`);
  const eps = numeric(value.eps, `${field}.eps`, required);
  const revenue = numeric(value.revenue, `${field}.revenue`, required);
  return Object.freeze({ eps, revenue, guidance: numeric(value.guidance, `${field}.guidance`, false), margin: numeric(value.margin, `${field}.margin`, false) });
}

function normalizeReturnObservations(value, cutoff) {
  if (!Array.isArray(value) || !value.length || value.length > 256) throw peadError("PEAD_RETURN_PATH_REQUIRED", "At least one bounded return observation is required.");
  let previous = 0;
  return Object.freeze(value.map((row, index) => {
    const observedAt = asUtcIso(row.observedAt, `returnObservations[${index}].observedAt`);
    const time = Date.parse(observedAt);
    if (time < Date.parse(cutoff) || time <= previous) throw peadError("PEAD_RETURN_PATH_NONCAUSAL", "Return observations must be strictly ordered after the announcement cutoff.");
    if (time > Date.now() + 30_000) throw peadError("PEAD_RETURN_PATH_FUTURE", "Return observations cannot use future market evidence.");
    previous = time;
    return Object.freeze({
      observedAt,
      price: row.price === null || row.price === undefined ? null : finite(Number(row.price), `returnObservations[${index}].price`, { minimum: Number.EPSILON }),
      stockReturnBps: boundedFinite(row.stockReturnBps, `returnObservations[${index}].stockReturnBps`, -20_000, 20_000),
      marketReturnBps: boundedFinite(row.marketReturnBps, `returnObservations[${index}].marketReturnBps`, -20_000, 20_000),
      sectorReturnBps: boundedFinite(row.sectorReturnBps ?? 0, `returnObservations[${index}].sectorReturnBps`, -20_000, 20_000)
    });
  }));
}

function robustScale(values, fallback) {
  if (values.length < 3) return fallback;
  const center = median(values);
  const mad = median(values.map((value) => Math.abs(value - center))) * 1.4826;
  return Math.max(mad, fallback * 0.1, Number.EPSILON);
}
function median(values) { const rows = [...values].sort((a, b) => a - b); const mid = Math.floor(rows.length / 2); return rows.length % 2 ? rows[mid] : (rows[mid - 1] + rows[mid]) / 2; }
function finiteArray(value, field, maximum) { if (!Array.isArray(value) || value.length > maximum) throw peadError("PEAD_HISTORY_INVALID", `${field} must be a bounded array.`); return Object.freeze(value.map((entry, index) => boundedFinite(entry, `${field}[${index}]`, -1e15, 1e15))); }
function boundedFinite(value, field, minimum, maximum) { return finite(Number(value), field, { minimum, maximum }); }
function numeric(value, field, required) { if ((value === null || value === undefined || value === "") && !required) return null; if (value === null || value === undefined || value === "") throw peadError("PEAD_FUNDAMENTAL_MISSING", `${field} is required.`); return boundedFinite(value, field, -1e15, 1e15); }
function ticker(value) { const result = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9.-]/g, ""); if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(result)) throw peadError("PEAD_TICKER_INVALID", "ticker is invalid."); return result; }
function normalizeCik(value) { if (value === null || value === undefined || value === "") return null; const text = String(value).trim(); if (!/^\d{1,10}$/.test(text)) throw peadError("PEAD_CIK_INVALID", "CIK must contain one to ten digits."); return text.padStart(10, "0"); }
function rejectSensitiveManifestKeys(value, depth = 0) { if (depth > 8 || value === null || typeof value !== "object") return; for (const [key, entry] of Object.entries(value)) { if (/(?:secret|token|password|authorization|api.?key|credential|private.?key)/i.test(key)) throw peadError("PEAD_SOURCE_MANIFEST_SENSITIVE", "Source manifests cannot contain credential-like fields."); rejectSensitiveManifestKeys(entry, depth + 1); } }
function enumValue(value, allowed, field) { const result = String(value || "").toUpperCase(); if (!allowed.includes(result)) throw peadError("PEAD_ENUM_INVALID", `${field} is invalid.`); return result; }
function optionalHttps(value, field) { if (!value) return null; const url = new URL(String(value)); if (url.protocol !== "https:" || url.username || url.password) throw peadError("PEAD_SOURCE_URL_INVALID", `${field} must be an uncredentialed HTTPS URL.`); return url.toString().slice(0, 1200); }
function clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }
function integer(value, field, minimum, maximum) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw peadError("PEAD_INTEGER_INVALID", `${field} is invalid.`); return parsed; }
function peadError(code, message) { const error = new Error(message); error.code = code; error.statusCode = 400; return error; }
