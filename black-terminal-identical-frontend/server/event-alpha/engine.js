import {
  EVENT_ALPHA_REASON_CODES,
  bindExpectationToEvent,
  canonicalJson,
  finite,
  sha256
} from "./domain.js";

const EPSILON = 1e-9;

export function median(values) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function medianAbsoluteDeviation(values) {
  const center = median(values);
  if (center === null) return null;
  return median(values.map((value) => Math.abs(value - center)));
}

export function robustExpectation(contributors, canonicalEvent, model = {}) {
  const rows = contributors
    .filter((row) => row && typeof row.value === "number" && Number.isFinite(row.value))
    .map((row) => ({
      value: row.value,
      weight: Math.max(EPSILON, Number.isFinite(row.weight) ? row.weight : 1),
      sourceKey: String(row.sourceKey || "UNKNOWN").slice(0, 80),
      observedAt: new Date(row.observedAt).toISOString()
    }));
  if (!rows.length) throw new Error("EVENT_ALPHA_EXPECTATION_CONTRIBUTORS_REQUIRED");
  const center = median(rows.map((row) => row.value));
  const mad = medianAbsoluteDeviation(rows.map((row) => row.value)) || 0;
  const cap = Math.max(EPSILON, mad * 4.5);
  let numerator = 0;
  let denominator = 0;
  for (const row of rows) {
    const winsorized = Math.min(center + cap, Math.max(center - cap, row.value));
    numerator += winsorized * row.weight;
    denominator += row.weight;
  }
  return bindExpectationToEvent({
    asOf: model.asOf,
    modelKey: model.modelKey || "ROBUST_PRE_EVENT_CONSENSUS",
    modelVersion: model.modelVersion || "1.0.0",
    expectedValue: numerator / denominator,
    expectedTime: model.expectedTime || canonicalEvent.eventTime,
    expectedProbability: model.expectedProbability ?? null,
    dispersion: mad * 1.4826,
    confidence: confidenceFromEvidence(rows.length, mad, Math.abs(center)),
    contributors: rows,
    featureManifest: { estimator: "weighted_winsorized_median_center", madScale: 1.4826, contributorCount: rows.length }
  }, canonicalEvent);
}

export function assessEventSurprise({ canonicalEvent, expectation, assetProfile, assessedAt }) {
  const bound = bindExpectationToEvent(expectation, canonicalEvent);
  const payload = canonicalEvent.normalizedPayload;
  const actualValue = eventActualValue(canonicalEvent);
  const expectedValue = bound.expectedValue;
  const quantitySurprise = expectedValue === null ? null : (actualValue - expectedValue) / Math.max(Math.abs(expectedValue), EPSILON);
  const timingSurprise = bound.expectedTime
    ? (Date.parse(canonicalEvent.eventTime) - Date.parse(bound.expectedTime)) / (24 * 60 * 60 * 1000)
    : null;
  const actualProbability = canonicalEvent.eventFamily === "GOVERNANCE" ? Number(payload.passed ? 1 : 0) : null;
  const probabilitySurprise = actualProbability === null || bound.expectedProbability === null
    ? null
    : actualProbability - bound.expectedProbability;
  const structuralSurprise = Number(payload.structuralBreakScore || 0);
  const available = [quantitySurprise, scaleTiming(timingSurprise), probabilitySurprise, structuralSurprise].filter(Number.isFinite);
  const compositeSurprise = clamp(available.reduce((sum, value) => sum + value, 0) / Math.max(1, available.length), -5, 5);
  const economicImpact = calculateEconomicImpact(canonicalEvent, assetProfile, compositeSurprise);
  const confidence = clamp(bound.confidence * canonicalEvent.sourceConfidence * economicImpact.dataQuality, 0, 1);
  const reasonCodes = [];
  if ((quantitySurprise ?? 0) > 0.05 && canonicalEvent.eventFamily === "TOKEN_SUPPLY") reasonCodes.push(EVENT_ALPHA_REASON_CODES.POSITIVE_SUPPLY_SURPRISE);
  if ((quantitySurprise ?? 0) < -0.05 && canonicalEvent.eventFamily === "TOKEN_SUPPLY") reasonCodes.push(EVENT_ALPHA_REASON_CODES.NEGATIVE_SUPPLY_SURPRISE);
  if (economicImpact.valueCaptureScore < 0.3) reasonCodes.push(EVENT_ALPHA_REASON_CODES.WEAK_VALUE_CAPTURE);
  if (canonicalEvent.eventFamily === "GOVERNANCE" && Math.abs(probabilitySurprise ?? 0) < 0.05) reasonCodes.push(EVENT_ALPHA_REASON_CODES.LOW_GOVERNANCE_SURPRISE);
  if (confidence < 0.55) reasonCodes.push(EVENT_ALPHA_REASON_CODES.EVIDENCE_AMBIGUOUS);
  return Object.freeze({
    assessedAt: new Date(assessedAt).toISOString(),
    quantitySurprise,
    timingSurprise,
    probabilitySurprise,
    structuralSurprise,
    compositeSurprise,
    economicImpact,
    confidence,
    reasonCodes,
    calculationManifest: {
      model: "EVENT_SURPRISE_V1",
      actualValue,
      expectedValue,
      expectationAsOf: bound.asOf,
      firstActionableAt: bound.firstActionableAt,
      formulaHash: sha256("mean(qty,timing_scaled,probability,structural)*source*expectation*data_quality")
    }
  });
}

export function calculateEconomicImpact(canonicalEvent, assetProfile, compositeSurprise) {
  const payload = canonicalEvent.normalizedPayload;
  const circulatingSupply = finite(Number(assetProfile.circulatingSupply ?? payload.circulatingSupply), "circulatingSupply", { minimum: EPSILON });
  const dailyDollarVolume = finite(Number(assetProfile.averageDailyDollarVolume), "averageDailyDollarVolume", { minimum: EPSILON });
  const valueCaptureScore = clamp(Number(assetProfile.valueCaptureScore ?? 0.5), 0, 1);
  const liquidSupplyRatio = clamp(Number(assetProfile.liquidSupplyRatio ?? 0.5), 0, 1);
  let supplyImpact = 0;
  let direction = 0;
  if (canonicalEvent.eventFamily === "TOKEN_SUPPLY") {
    supplyImpact = (payload.unlockTokens / circulatingSupply) * Number(payload.liquidImmediatelyPct ?? 1) * liquidSupplyRatio;
    direction = -1;
  } else if (canonicalEvent.eventFamily === "GOVERNANCE") {
    supplyImpact = Math.abs(Number(payload.treasuryImpactUsd || 0)) / dailyDollarVolume;
    direction = Number(payload.directionalImpact || 0);
  } else {
    supplyImpact = Math.abs(Number(payload.annualizedCashFlowDeltaUsd || 0)) / dailyDollarVolume;
    direction = Math.sign(Number(payload.annualizedCashFlowDeltaUsd || 0));
  }
  const absorptionDays = Math.abs(supplyImpact * circulatingSupply * Number(payload.referencePrice || 1)) / dailyDollarVolume;
  const impactMagnitude = Math.log1p(Math.max(0, absorptionDays)) * (0.5 + 0.5 * (1 - valueCaptureScore)) * Math.abs(compositeSurprise || 1);
  return Object.freeze({
    direction,
    supplyImpact,
    absorptionDays,
    valueCaptureScore,
    liquidSupplyRatio,
    impactMagnitude,
    dataQuality: assetProfile.knownAt && Date.parse(assetProfile.knownAt) <= Date.parse(canonicalEvent.firstActionableAt) ? 1 : 0.35
  });
}

export function forecastEventResponse({ surprise, realizedAssetReturnBps, realizedBenchmarkReturnBps = 0, horizonSeconds, costs }) {
  const realizedAbnormalReturnBps = finite(realizedAssetReturnBps, "realizedAssetReturnBps") - finite(realizedBenchmarkReturnBps, "realizedBenchmarkReturnBps");
  const signedImpact = surprise.economicImpact.direction * surprise.economicImpact.impactMagnitude;
  const expectedAbnormalReturnBps = clamp(signedImpact * 1_000, -5_000, 5_000);
  const estimatedRoundTripCostBps = Math.max(0,
    Number(costs?.spreadBps || 0) + Number(costs?.slippageBps || 0) + Number(costs?.feesBps || 0) + Number(costs?.fundingBps || 0)
  );
  const uncertaintyPenaltyBps = Math.abs(expectedAbnormalReturnBps) * (1 - surprise.confidence) * 0.5;
  const grossRemaining = expectedAbnormalReturnBps - realizedAbnormalReturnBps;
  const remainingAlphaBps = Math.sign(grossRemaining || expectedAbnormalReturnBps) * Math.max(0, Math.abs(grossRemaining) - estimatedRoundTripCostBps - uncertaintyPenaltyBps);
  const outcome = classifyResponse({ expectedAbnormalReturnBps, realizedAbnormalReturnBps, remainingAlphaBps, confidence: surprise.confidence, estimatedRoundTripCostBps });
  return Object.freeze({
    horizonSeconds: Math.round(finite(horizonSeconds, "horizonSeconds", { minimum: 60, maximum: 2_592_000 })),
    expectedAbnormalReturnBps,
    realizedAbnormalReturnBps,
    estimatedRoundTripCostBps,
    uncertaintyPenaltyBps,
    remainingAlphaBps,
    outcome,
    confidence: surprise.confidence,
    reasonCodes: responseReasonCodes(outcome),
    calculationManifest: {
      model: "REMAINING_EVENT_ALPHA_V1",
      formula: "signed_impact*1000 - abnormal_return - costs - uncertainty",
      source: "point_in_time_only"
    }
  });
}

export function buildEventAlphaThesis({ canonicalEvent, forecast, validFrom, expiresAt }) {
  const validFromIso = new Date(validFrom).toISOString();
  const expiresAtIso = new Date(expiresAt).toISOString();
  if (Date.parse(expiresAtIso) <= Date.parse(validFromIso)) throw new Error("EVENT_ALPHA_THESIS_EXPIRY_INVALID");
  const direction = forecast.remainingAlphaBps > 0 ? "LONG" : forecast.remainingAlphaBps < 0 ? "SHORT" : "NEUTRAL";
  const state = forecast.outcome === "UNDERREACTION" && direction !== "NEUTRAL" ? "OBSERVING" : forecast.outcome === "AMBIGUOUS" ? "REJECTED" : "DRAFT";
  const keyPayload = { event: canonicalEvent.canonicalKey, eventRevision: canonicalEvent.currentRevision || 1, horizon: forecast.horizonSeconds, evidenceCutoffAt: validFromIso, forecast: forecast.calculationManifest.model };
  return Object.freeze({
    thesisKey: sha256(keyPayload),
    state,
    direction,
    eventFamily: canonicalEvent.eventFamily,
    confidence: forecast.confidence,
    remainingAlphaBps: forecast.remainingAlphaBps,
    validFrom: validFromIso,
    expiresAt: expiresAtIso,
    reasonCodes: forecast.reasonCodes,
    invalidationConditions: ["EVENT_REVISION_MATERIAL", "SOURCE_QUARANTINED", "ALPHA_BELOW_COST", "TACTICAL_DIRECTION_CONFLICT"]
  });
}

export function evaluateBcrdaTacticalGate({ thesis, tacticalSetup, now, cooldownSeconds = 900 }) {
  const reasonCodes = [];
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs) || nowMs >= Date.parse(thesis.expiresAt)) reasonCodes.push(EVENT_ALPHA_REASON_CODES.THESIS_EXPIRED);
  const confirmedAtMs = Date.parse(tacticalSetup?.confirmedAt);
  const maxAgeMs = Number(tacticalSetup?.maxAgeMs);
  if (!tacticalSetup?.setupKey || typeof tacticalSetup.setupKey !== "string" || tacticalSetup.setupKey.length > 240) reasonCodes.push(EVENT_ALPHA_REASON_CODES.TACTICAL_SETUP_IDENTITY_INVALID);
  if (!tacticalSetup?.confirmed || !Number.isFinite(confirmedAtMs) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || confirmedAtMs > nowMs || nowMs - confirmedAtMs > maxAgeMs) {
    reasonCodes.push(EVENT_ALPHA_REASON_CODES.TACTICAL_SETUP_STALE);
  }
  if (String(tacticalSetup?.direction || "").toUpperCase() !== thesis.direction) reasonCodes.push(EVENT_ALPHA_REASON_CODES.TACTICAL_DIRECTION_CONFLICT);
  if (thesis.lastTriggeredAt && nowMs - Date.parse(thesis.lastTriggeredAt) < cooldownSeconds * 1000) reasonCodes.push(EVENT_ALPHA_REASON_CODES.COOLDOWN_ACTIVE);
  if (thesis.state !== "ARMED") reasonCodes.push(EVENT_ALPHA_REASON_CODES.THESIS_NOT_ARMED);
  const allowed = reasonCodes.length === 0;
  return Object.freeze({
    allowed,
    tacticalSetupKey: tacticalSetup?.setupKey || null,
    reasonCodes: allowed ? [EVENT_ALPHA_REASON_CODES.TACTICAL_SETUP_CONFIRMED] : reasonCodes,
    idempotencyKey: sha256({ thesisKey: thesis.thesisKey, setupKey: tacticalSetup?.setupKey || null })
  });
}

export function evaluatePaperRisk({ thesis, gate, policy, market }) {
  const reasons = [];
  if (!gate.allowed) reasons.push(...gate.reasonCodes);
  if (!["LONG", "SHORT"].includes(thesis.direction)) reasons.push(EVENT_ALPHA_REASON_CODES.THESIS_DIRECTION_NOT_TRADABLE);
  if (thesis.confidence < policy.minimumConfidence) reasons.push(EVENT_ALPHA_REASON_CODES.CONFIDENCE_BELOW_MINIMUM);
  if (Math.abs(thesis.remainingAlphaBps) < policy.minimumRemainingAlphaBps) reasons.push(EVENT_ALPHA_REASON_CODES.ALPHA_BELOW_MINIMUM);
  if (!policy.allowedSymbols.includes(market.symbol)) reasons.push(EVENT_ALPHA_REASON_CODES.SYMBOL_NOT_ALLOWED);
  if (!Number.isFinite(market.price) || market.price <= 0) reasons.push(EVENT_ALPHA_REASON_CODES.MARKET_PRICE_INVALID);
  const requestedNotional = Math.min(policy.maxNotional, policy.paperEquity * policy.riskPerThesisPct);
  const maxLoss = requestedNotional * policy.stopDistancePct;
  if (maxLoss > policy.maxLossPerThesis) reasons.push(EVENT_ALPHA_REASON_CODES.MAX_LOSS_EXCEEDED);
  return Object.freeze({
    decision: reasons.length ? "REJECT" : "ALLOW_PAPER",
    approvedNotional: reasons.length ? 0 : requestedNotional,
    maxLoss: reasons.length ? 0 : maxLoss,
    reasonCodes: reasons.length ? reasons : [EVENT_ALPHA_REASON_CODES.PAPER_ONLY],
    policyVersion: policy.version,
    evidenceHash: sha256({ thesis: thesis.thesisKey, gate, policy: policy.version, market })
  });
}

export function deterministicPaperFill({ intent, market, model }) {
  const sideSign = intent.side === "BUY" ? 1 : -1;
  const spreadHalf = Math.max(0, model.spreadBps) / 20_000;
  const slippage = Math.max(0, model.slippageBps) / 10_000;
  const price = market.price * (1 + sideSign * (spreadHalf + slippage));
  const notional = intent.quantity * price;
  return Object.freeze({
    fillKey: sha256({ order: intent.clientIntentId, cutoff: market.cutoffAt, model: model.version }),
    quantity: intent.quantity,
    price,
    fee: notional * Math.max(0, model.feeBps) / 10_000,
    slippageBps: model.slippageBps,
    filledAt: market.cutoffAt,
    marketDataCutoffAt: market.cutoffAt,
    modelVersion: model.version
  });
}

function eventActualValue(event) {
  if (event.eventFamily === "TOKEN_SUPPLY") return event.normalizedPayload.unlockTokens;
  if (event.eventFamily === "GOVERNANCE") return event.normalizedPayload.passed ? 1 : 0;
  return Number(event.normalizedPayload.annualizedCashFlowDeltaUsd || 0);
}

function scaleTiming(days) {
  return Number.isFinite(days) ? clamp(days / 30, -1, 1) : null;
}

function confidenceFromEvidence(count, dispersion, scale) {
  const breadth = Math.min(1, Math.log2(count + 1) / 3);
  const coherence = 1 / (1 + dispersion / Math.max(Math.abs(scale), EPSILON));
  return clamp(0.25 + 0.75 * breadth * coherence, 0, 1);
}

function classifyResponse({ expectedAbnormalReturnBps, realizedAbnormalReturnBps, remainingAlphaBps, confidence, estimatedRoundTripCostBps }) {
  if (confidence < 0.55 || Math.abs(expectedAbnormalReturnBps) < estimatedRoundTripCostBps) return "AMBIGUOUS";
  if (Math.sign(expectedAbnormalReturnBps) === Math.sign(realizedAbnormalReturnBps)
    && Math.abs(realizedAbnormalReturnBps) > Math.abs(expectedAbnormalReturnBps) + estimatedRoundTripCostBps) return "OVERREACTION";
  if (Math.sign(expectedAbnormalReturnBps) !== Math.sign(realizedAbnormalReturnBps) && Math.abs(realizedAbnormalReturnBps) > estimatedRoundTripCostBps) return "OVERREACTION";
  if (Math.abs(remainingAlphaBps) <= estimatedRoundTripCostBps) return "FULLY_PRICED";
  if (Math.sign(remainingAlphaBps) === Math.sign(expectedAbnormalReturnBps)) return "UNDERREACTION";
  return "NO_TRADE";
}

function responseReasonCodes(outcome) {
  return {
    UNDERREACTION: [EVENT_ALPHA_REASON_CODES.UNDERREACTION_DETECTED],
    FULLY_PRICED: [EVENT_ALPHA_REASON_CODES.FULLY_PRICED],
    OVERREACTION: [EVENT_ALPHA_REASON_CODES.OVERREACTION_DETECTED],
    AMBIGUOUS: [EVENT_ALPHA_REASON_CODES.EVIDENCE_AMBIGUOUS],
    NO_TRADE: [EVENT_ALPHA_REASON_CODES.ALPHA_BELOW_COST]
  }[outcome];
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function calculationFingerprint(value) {
  return sha256(canonicalJson(value));
}
