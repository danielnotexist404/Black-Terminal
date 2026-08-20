import assert from "node:assert/strict";
import {
  bindExpectationToEvent,
  normalizeRawEventEnvelope,
  normalizeTokenUnlock,
  sanitizeExternalPayload
} from "../server/event-alpha/domain.js";
import {
  assessEventSurprise,
  buildEventAlphaThesis,
  deterministicPaperFill,
  evaluateBcrdaTacticalGate,
  forecastEventResponse,
  robustExpectation
} from "../server/event-alpha/engine.js";
import { runPointInTimeEventReplay } from "../server/event-alpha/replay.js";

const firstActionableAt = "2026-08-01T12:00:00.000Z";
const eventTime = "2026-08-05T12:00:00.000Z";
const envelope = normalizeRawEventEnvelope({
  sourceKey: "TOKEN_UNLOCK_PRIMARY",
  sourceEventId: "unlock-1",
  eventFamily: "TOKEN_SUPPLY",
  observedAt: firstActionableAt,
  firstActionableAt,
  sourcePublishedAt: firstActionableAt,
  payload: {
    assetId: "TEST",
    symbol: "TESTUSDT",
    eventTime,
    unlockTokens: 120,
    circulatingSupply: 1_000,
    liquidImmediatelyPct: 1,
    beneficiaryClass: "TEAM",
    referencePrice: 10,
    sourceConfidence: 0.95
  }
});
const tokenEvent = normalizeTokenUnlock(envelope);
assert.equal(tokenEvent.normalizedPayload.unlockPctCirculating, 0.12);
assert.equal(tokenEvent.canonicalKey, `TOKEN_SUPPLY:TEST:${eventTime}:TEAM`);

const expectation = robustExpectation([
  { value: 80, weight: 1, sourceKey: "CALENDAR_A", observedAt: "2026-07-30T00:00:00Z" },
  { value: 82, weight: 1, sourceKey: "CALENDAR_B", observedAt: "2026-07-30T00:00:00Z" },
  { value: 10_000, weight: 0.1, sourceKey: "OUTLIER", observedAt: "2026-07-30T00:00:00Z" }
], tokenEvent, { asOf: "2026-07-31T00:00:00Z", modelVersion: "test-v1" });
assert.ok(expectation.expectedValue < 100, "robust expectation must winsorize the extreme outlier");
assert.throws(() => bindExpectationToEvent({ ...expectation, asOf: firstActionableAt }, tokenEvent), /before first actionable/i, "same-time expectation is lookahead");

const profile = {
  knownAt: "2026-07-31T00:00:00Z",
  circulatingSupply: 1_000,
  averageDailyDollarVolume: 100,
  liquidSupplyRatio: 1,
  valueCaptureScore: 0.2,
  benchmarkSymbol: "BTCUSDT"
};
const surprise = assessEventSurprise({ canonicalEvent: tokenEvent, expectation, assetProfile: profile, assessedAt: firstActionableAt });
assert.ok(surprise.quantitySurprise > 0.35);
assert.equal(surprise.economicImpact.direction, -1, "unlock pressure is signed downside");
assert.ok(surprise.reasonCodes.includes("WEAK_VALUE_CAPTURE"));

// Scenario A: economically material unlock, little realized response -> downside underreaction.
const underreaction = forecastEventResponse({
  surprise,
  realizedAssetReturnBps: -50,
  realizedBenchmarkReturnBps: 0,
  horizonSeconds: 3_600,
  costs: { spreadBps: 1, slippageBps: 2, feesBps: 2, fundingBps: 0 }
});
assert.equal(underreaction.outcome, "UNDERREACTION");
assert.ok(underreaction.remainingAlphaBps < 0);
const shortThesis = buildEventAlphaThesis({ canonicalEvent: tokenEvent, forecast: underreaction, validFrom: firstActionableAt, expiresAt: "2026-08-03T00:00:00Z" });
assert.equal(shortThesis.direction, "SHORT");
assert.equal(shortThesis.state, "OBSERVING");

// Scenario B: positive protocol-economics event whose abnormal response already matches the forecast.
const protocolEvent = {
  canonicalKey: "PROTOCOL_ECONOMICS:PROTO:2026-08-05",
  eventFamily: "PROTOCOL_ECONOMICS",
  assetId: "PROTO",
  symbol: "PROTOUSDT",
  eventTime,
  firstActionableAt,
  sourceConfidence: 0.95,
  normalizedPayload: { annualizedCashFlowDeltaUsd: 100, referencePrice: 1 }
};
const protocolExpectation = bindExpectationToEvent({ asOf: "2026-07-31T00:00:00Z", modelKey: "CASH_FLOW", modelVersion: "1", expectedValue: 80, confidence: 0.9 }, protocolEvent);
const protocolSurprise = assessEventSurprise({ canonicalEvent: protocolEvent, expectation: protocolExpectation, assetProfile: { ...profile, circulatingSupply: 1_000, averageDailyDollarVolume: 10, valueCaptureScore: 0.9 }, assessedAt: firstActionableAt });
const provisional = forecastEventResponse({ surprise: protocolSurprise, realizedAssetReturnBps: 0, horizonSeconds: 3_600, costs: { spreadBps: 1, slippageBps: 1, feesBps: 1 } });
const fullyPriced = forecastEventResponse({ surprise: protocolSurprise, realizedAssetReturnBps: provisional.expectedAbnormalReturnBps, horizonSeconds: 3_600, costs: { spreadBps: 1, slippageBps: 1, feesBps: 1 } });
assert.equal(fullyPriced.outcome, "FULLY_PRICED");

// Scenario C: weak value capture is explicit rather than converted into fabricated alpha.
assert.ok(surprise.reasonCodes.includes("WEAK_VALUE_CAPTURE"));

// Scenario D: a 98% expected governance pass has only 2% probability surprise.
const governanceEvent = {
  canonicalKey: "GOVERNANCE:GOV:proposal-1",
  eventFamily: "GOVERNANCE",
  assetId: "GOV",
  symbol: "GOVUSDT",
  eventTime,
  firstActionableAt,
  sourceConfidence: 0.95,
  normalizedPayload: { passed: true, treasuryImpactUsd: 0, directionalImpact: 0 }
};
const governanceExpectation = bindExpectationToEvent({ asOf: "2026-07-31T00:00:00Z", modelKey: "GOV_PASS", modelVersion: "1", expectedProbability: 0.98, expectedValue: 1, confidence: 0.95 }, governanceEvent);
const governance = assessEventSurprise({ canonicalEvent: governanceEvent, expectation: governanceExpectation, assetProfile: profile, assessedAt: firstActionableAt });
assert.ok(Math.abs(governance.probabilitySurprise - 0.02) < 1e-10);
assert.ok(governance.reasonCodes.includes("LOW_GOVERNANCE_SURPRISE"));

// Scenario E: duplicate storm is deterministic and produces one replay result.
const replay = runPointInTimeEventReplay({
  configuration: replayConfiguration({ spreadBps: 1, slippageBps: 2, feesBps: 2 }),
  rawEvents: [envelope, envelope, { ...envelope }],
  expectations: [{ ...expectation, canonicalEventKey: tokenEvent.canonicalKey }],
  assetProfiles: [{ ...profile, canonicalEventKey: tokenEvent.canonicalKey }],
  tradableUniverse: [{ symbol: "TESTUSDT", knownAt: "2026-07-01T00:00:00Z", listedAt: "2025-01-01T00:00:00Z", delistedAt: null, venueAvailable: true, marketKind: "PERPETUAL" }],
  marketObservations: [{ canonicalEventKey: tokenEvent.canonicalKey, cutoffAt: "2026-08-01T12:00:00.500Z", assetReturnBps: -50, benchmarkReturnBps: 0, horizonSeconds: 3_600, expiresAt: "2026-08-03T00:00:00Z" }]
});
assert.equal(replay.results.length, 1);
assert.match(replay.manifest.manifestHash, /^[a-f0-9]{64}$/);
assert.deepEqual(runPointInTimeEventReplay({
  configuration: replayConfiguration({ spreadBps: 1, slippageBps: 2, feesBps: 2 }),
  rawEvents: [envelope, envelope, { ...envelope }], expectations: [{ ...expectation, canonicalEventKey: tokenEvent.canonicalKey }],
  assetProfiles: [{ ...profile, canonicalEventKey: tokenEvent.canonicalKey }],
  tradableUniverse: [{ symbol: "TESTUSDT", knownAt: "2026-07-01T00:00:00Z", listedAt: "2025-01-01T00:00:00Z", delistedAt: null, venueAvailable: true, marketKind: "PERPETUAL" }],
  marketObservations: [{ canonicalEventKey: tokenEvent.canonicalKey, cutoffAt: "2026-08-01T12:00:00.500Z", assetReturnBps: -50, benchmarkReturnBps: 0, horizonSeconds: 3_600, expiresAt: "2026-08-03T00:00:00Z" }]
}), replay, "identical point-in-time manifest and data must reproduce exactly");

const delistedReplay = runPointInTimeEventReplay({
  configuration: replayConfiguration(), rawEvents: [envelope],
  expectations: [{ ...expectation, canonicalEventKey: tokenEvent.canonicalKey }], assetProfiles: [{ ...profile, canonicalEventKey: tokenEvent.canonicalKey }],
  tradableUniverse: [{ symbol: "TESTUSDT", knownAt: "2026-07-01T00:00:00Z", listedAt: "2025-01-01T00:00:00Z", delistedAt: "2026-08-01T11:00:00Z", venueAvailable: true, marketKind: "PERPETUAL" }],
  marketObservations: [{ canonicalEventKey: tokenEvent.canonicalKey, cutoffAt: "2026-08-01T12:00:00.500Z", assetReturnBps: -50, benchmarkReturnBps: 0, horizonSeconds: 3_600, expiresAt: "2026-08-03T00:00:00Z" }]
});
assert.equal(delistedReplay.results[0].outcome, "NO_TRADE", "a delisted asset remains in history but cannot trade after delisting");
const revisionStormReplay = runPointInTimeEventReplay({
  configuration: replayConfiguration(),
  rawEvents: [envelope, { ...envelope, sourceEventId: "unlock-1-correction", observedAt: "2026-08-01T12:00:01Z", payload: { ...envelope.payload, unlockTokens: 125 } }],
  expectations: [{ ...expectation, canonicalEventKey: tokenEvent.canonicalKey }], assetProfiles: [{ ...profile, canonicalEventKey: tokenEvent.canonicalKey }],
  tradableUniverse: [{ symbol: "TESTUSDT", knownAt: "2026-07-01T00:00:00Z", listedAt: "2025-01-01T00:00:00Z", delistedAt: null, venueAvailable: true, marketKind: "PERPETUAL" }],
  marketObservations: [{ canonicalEventKey: tokenEvent.canonicalKey, cutoffAt: "2026-08-01T12:00:01Z", assetReturnBps: -50, benchmarkReturnBps: 0, horizonSeconds: 3_600, expiresAt: "2026-08-03T00:00:00Z" }]
});
assert.equal(revisionStormReplay.results.length, 1, "source corrections revise one canonical replay event instead of creating a second thesis");
assert.equal(revisionStormReplay.manifest.canonicalEventCount, 1);

// Scenario F: hostile provider keys are rejected as data and never interpreted.
const malicious = JSON.parse('{"assetId":"SAFE","__proto__":{"polluted":true}}');
assert.throws(() => sanitizeExternalPayload(malicious), /blocked key/i);
assert.equal({}.polluted, undefined);

const armed = { ...shortThesis, state: "ARMED", lastTriggeredAt: null };
const setup = { setupKey: "bcrda-dot-1", confirmed: true, confirmedAt: "2026-08-01T12:01:00Z", maxAgeMs: 300_000, direction: "SHORT" };
const gate = evaluateBcrdaTacticalGate({ thesis: armed, tacticalSetup: setup, now: "2026-08-01T12:02:00Z" });
assert.equal(gate.allowed, true);
assert.equal(evaluateBcrdaTacticalGate({ thesis: { ...armed, lastTriggeredAt: "2026-08-01T12:01:30Z" }, tacticalSetup: setup, now: "2026-08-01T12:02:00Z" }).allowed, false, "cooldown blocks repeat trigger");
assert.equal(evaluateBcrdaTacticalGate({ thesis: armed, tacticalSetup: { ...setup, direction: "LONG" }, now: "2026-08-01T12:02:00Z" }).allowed, false, "direction conflict blocks trigger");
assert.equal(evaluateBcrdaTacticalGate({ thesis: armed, tacticalSetup: { ...setup, maxAgeMs: undefined }, now: "2026-08-01T12:02:00Z" }).allowed, false, "missing freshness bound blocks trigger");

const sameDirectionOvershoot = forecastEventResponse({ surprise, realizedAssetReturnBps: underreaction.expectedAbnormalReturnBps * 1.5, horizonSeconds: 3_600, costs: { spreadBps: 1, slippageBps: 1, feesBps: 1 } });
assert.equal(sameDirectionOvershoot.outcome, "OVERREACTION", "same-direction response beyond forecast is overreaction");

assert.throws(() => normalizeRawEventEnvelope({ ...envelope, observedAt: "2026-08-01T00:00:00Z", firstActionableAt: "2026-08-01T00:00:01Z" }), /later than collection/i);
assert.throws(() => normalizeRawEventEnvelope({ ...envelope, observedAt: undefined }), /required provider evidence/i, "missing observation time must never be replaced with ingestion time");
assert.throws(() => normalizeRawEventEnvelope({ ...envelope, firstActionableAt: undefined }), /required provider evidence/i, "missing first-actionable time must fail closed");
assert.throws(() => normalizeRawEventEnvelope({ ...envelope, observedAt: "2099-01-01T00:00:00Z", firstActionableAt: "2099-01-01T00:00:00Z" }), /future/i, "provider clock skew must fail closed");

const fillA = deterministicPaperFill({ intent: { clientIntentId: "paper-1", side: "SELL", quantity: 2 }, market: { price: 100, cutoffAt: "2026-08-01T12:02:00Z" }, model: { version: "1", spreadBps: 2, slippageBps: 3, feeBps: 5 } });
const fillB = deterministicPaperFill({ intent: { clientIntentId: "paper-1", side: "SELL", quantity: 2 }, market: { price: 100, cutoffAt: "2026-08-01T12:02:00Z" }, model: { version: "1", spreadBps: 2, slippageBps: 3, feeBps: 5 } });
assert.deepEqual(fillA, fillB, "paper fill is deterministic and idempotent by evidence cutoff");

function replayConfiguration(costs = {}) {
  return {
    cutoffAt: "2026-08-10T00:00:00Z", latencyMs: 500, costs,
    codeCommit: "SYNTHETIC_TEST_COMMIT", dataSnapshotIdentifiers: ["synthetic-fixture-v1"],
    tradableUniverseDefinition: "synthetic perpetual fixture", randomSeed: 7,
    modelVersions: { expectation: "test-v1", surprise: "EVENT_SURPRISE_V1", forecast: "REMAINING_EVENT_ALPHA_V1" },
    featureVersions: { tokenSupply: "TOKEN_UNLOCK_V1" }
  };
}

console.log("Event Alpha engine tests PASS — scenarios A-F, causal expectation, BC-RDA gate, replay, and paper determinism verified.");
