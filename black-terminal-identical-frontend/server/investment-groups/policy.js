export const INVESTMENT_RISK_DISCLOSURE_VERSION = "2026-08-12.v1";

export const REQUIRED_RISK_ACKNOWLEDGEMENTS = Object.freeze([
  "noProfitGuarantee",
  "capitalLoss",
  "leverageLiquidation",
  "executionDivergence",
  "persistentExecution",
  "noWithdrawalAuthority",
  "pauseOrLeaveAnytime"
]);

const MEMBER_STATES = new Set([
  "DRAFT", "RISK_ACCEPTED", "METHOD_SELECTED", "CONFIGURING", "PENDING_APPROVAL",
  "APPROVED", "ACTIVATING", "ACTIVE", "PAUSED_BY_USER", "PAUSED_BY_MANAGER",
  "RISK_SUSPENDED", "LEAVING", "LEFT", "REMOVED", "REJECTED", "EXPIRED"
]);

export function validateRiskAcknowledgement(input, document) {
  if (!document?.version || input?.version !== document.version) {
    throw policyError(409, "The risk disclosure changed. Review the current version before continuing.", "DISCLOSURE_VERSION_CHANGED");
  }
  if (!document.document_hash || input?.documentHash !== document.document_hash) {
    throw policyError(409, "The risk disclosure document hash does not match the active document.", "DISCLOSURE_HASH_MISMATCH");
  }
  if (input?.reachedEnd !== true) {
    throw policyError(400, "Read the complete risk disclosure before continuing.", "DISCLOSURE_NOT_READ");
  }
  const checks = input?.acknowledgements || {};
  const missing = REQUIRED_RISK_ACKNOWLEDGEMENTS.filter((key) => checks[key] !== true);
  if (missing.length) {
    throw policyError(400, "Every mandatory risk acknowledgement must be accepted.", "RISK_ACKNOWLEDGEMENT_INCOMPLETE", { missing });
  }
  return true;
}

export function normalizeRiskPolicy(input, limits = {}) {
  const allocationPercent = bounded(input.allocationPercent, "allocationPercent", 0.01, Math.min(100, finite(limits.maximumAllocationPercent, 100)));
  const userMaximumLeverage = bounded(input.userMaximumLeverage, "userMaximumLeverage", 1, Math.min(125, finite(limits.groupMaxLeverage, 125)));
  const maximumPositionEquityPercent = bounded(input.maximumPositionEquityPercent, "maximumPositionEquityPercent", 0.01, 100);
  const maximumTotalExposurePercent = bounded(input.maximumTotalExposurePercent, "maximumTotalExposurePercent", maximumPositionEquityPercent, 500);
  const maximumDailyLossPercent = bounded(input.maximumDailyLossPercent, "maximumDailyLossPercent", 0.01, 100);
  const maximumDrawdownPercent = bounded(input.maximumDrawdownPercent, "maximumDrawdownPercent", 0.01, 100);
  const maximumSlippageBps = bounded(input.maximumSlippageBps, "maximumSlippageBps", 0, 10000);
  const allowedSymbols = normalizedList(input.allowedSymbols, 100);
  const allowedMarketTypes = normalizedList(input.allowedMarketTypes, 10);
  const allowedOrderTypes = normalizedList(input.allowedOrderTypes, 20);
  if (!allowedSymbols.length || !allowedMarketTypes.length || !allowedOrderTypes.length) {
    throw policyError(400, "Allowed symbols, market types, and order types cannot be empty.", "RISK_POLICY_SCOPE_EMPTY");
  }
  if (input.longEnabled !== true && input.shortEnabled !== true) {
    throw policyError(400, "At least one trading direction must remain enabled.", "RISK_POLICY_DIRECTION_EMPTY");
  }
  const marginMode = String(input.marginMode || "CROSS").toUpperCase();
  if (!["CROSS", "ISOLATED"].includes(marginMode)) throw policyError(400, "Unsupported margin mode.", "RISK_POLICY_MARGIN_MODE_INVALID");
  const exitPolicy = String(input.exitPolicy || "DETACH").toUpperCase();
  if (!["DETACH", "CLOSE_NOW", "WHEN_FLAT"].includes(exitPolicy)) throw policyError(400, "Unsupported open-position exit policy.", "RISK_POLICY_EXIT_INVALID");
  const portfolioVisibility = String(input.portfolioVisibility || "GROUP_ONLY").toUpperCase();
  if (!["GROUP_ONLY", "GROUP_AND_RISK_SUMMARY", "FULL_SELECTED_ACCOUNT"].includes(portfolioVisibility)) {
    throw policyError(400, "Unsupported portfolio visibility choice.", "PORTFOLIO_VISIBILITY_INVALID");
  }
  return {
    allocationPercent,
    userMaximumLeverage,
    maximumPositionEquityPercent,
    maximumTotalExposurePercent,
    maximumDailyLossPercent,
    maximumDrawdownPercent,
    allowedSymbols,
    allowedMarketTypes,
    allowedOrderTypes,
    longEnabled: input.longEnabled === true,
    shortEnabled: input.shortEnabled === true,
    marginMode,
    maximumSlippageBps,
    exitPolicy,
    portfolioVisibility
  };
}

export function calculateEffectiveLeverage({ managerRequestedLeverage, userMaximumLeverage, groupMaximumLeverage, emsRiskCap, exchangeInstrumentCap }) {
  const caps = [managerRequestedLeverage, userMaximumLeverage, groupMaximumLeverage, emsRiskCap, exchangeInstrumentCap]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 1);
  if (caps.length !== 5) throw policyError(400, "Every leverage cap must be a number greater than or equal to one.", "LEVERAGE_CAP_INVALID");
  return Math.min(...caps);
}

export function assertManagerLeverageRequest(requested, policy, caps = {}) {
  const value = bounded(requested, "managerRequestedLeverage", 1, 125);
  if (value > Number(policy.user_maximum_leverage)) {
    throw policyError(409, "Manager requested leverage exceeds the member's signed maximum.", "USER_LEVERAGE_CAP_EXCEEDED");
  }
  return calculateEffectiveLeverage({
    managerRequestedLeverage: value,
    userMaximumLeverage: policy.user_maximum_leverage,
    groupMaximumLeverage: caps.groupMaximumLeverage,
    emsRiskCap: caps.emsRiskCap,
    exchangeInstrumentCap: caps.exchangeInstrumentCap
  });
}

export function coarseMembershipStatus(state) {
  const normalized = String(state || "").toUpperCase();
  if (!MEMBER_STATES.has(normalized)) throw policyError(400, "Unsupported membership state.", "MEMBERSHIP_STATE_INVALID");
  if (["ACTIVE", "PAUSED_BY_USER", "PAUSED_BY_MANAGER", "RISK_SUSPENDED", "LEAVING"].includes(normalized)) return "active";
  if (["LEFT", "REMOVED", "REJECTED", "EXPIRED"].includes(normalized)) return "removed";
  return "pending";
}

export function aggregateMemberSnapshots(snapshots, sampledAt = new Date().toISOString()) {
  const active = snapshots.filter((item) => item.membershipState === "ACTIVE");
  const sum = (key) => active.reduce((total, row) => total + finite(row[key]), 0);
  const allocatedEquity = sum("allocatedEquity");
  const weightedLeverage = allocatedEquity > 0
    ? active.reduce((total, row) => total + finite(row.effectiveLeverage, 1) * finite(row.allocatedEquity), 0) / allocatedEquity
    : 0;
  return {
    sampledAt,
    activeMembers: active.length,
    pausedMembers: snapshots.filter((item) => String(item.membershipState).startsWith("PAUSED_")).length,
    degradedMembers: snapshots.filter((item) => item.freshness !== "LIVE").length,
    connectedEquity: sum("equity"),
    allocatedEquity,
    grossExposure: sum("grossExposure"),
    netExposure: active.reduce((total, row) => total + finite(row.netExposure), 0),
    longExposure: sum("longExposure"),
    shortExposure: sum("shortExposure"),
    realizedPnl: active.reduce((total, row) => total + finite(row.realizedPnl), 0),
    unrealizedPnl: active.reduce((total, row) => total + finite(row.unrealizedPnl), 0),
    grossPnl: active.reduce((total, row) => total + finite(row.grossPnl), 0),
    fees: sum("fees"),
    funding: sum("funding"),
    netPnl: active.reduce((total, row) => total + finite(row.netPnl), 0),
    currentDrawdownPercent: nullableMaximum(active.map((row) => row.currentDrawdownPercent)),
    maximumDrawdownPercent: nullableMaximum(active.map((row) => row.maximumDrawdownPercent)),
    weightedLeverage,
    marginUtilizationPercent: allocatedEquity > 0 ? (sum("usedMargin") / allocatedEquity) * 100 : 0
  };
}

export function policyError(statusCode, message, code, publicDetails) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (publicDetails) error.publicDetails = publicDetails;
  return error;
}

function bounded(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw policyError(400, `${name} must be between ${minimum} and ${maximum}.`, "RISK_POLICY_VALUE_INVALID", { field: name, minimum, maximum });
  }
  return parsed;
}

function normalizedList(value, maximum) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item).trim().toUpperCase()).filter(Boolean))].slice(0, maximum);
}

function maximum(values) {
  return values.reduce((result, value) => Math.max(result, finite(value)), 0);
}

function nullableMaximum(values) {
  const available = values.filter((value) => value !== null && value !== undefined && value !== "").map(Number).filter(Number.isFinite);
  return available.length ? maximum(available) : null;
}

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
