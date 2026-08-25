import { EVENT_ALPHA_REASON_CODES, sha256 } from "./domain.js";
import { assessEventSurprise, buildEventAlphaThesis, forecastEventResponse } from "./engine.js";
import { BybitPublicMarketEvidence } from "./market-evidence.js";

export class EventAlphaLiveAssessor {
  constructor({ repository, marketEvidence = BybitPublicMarketEvidence.fromEnvironment(), clock = () => new Date() }) {
    this.repository = repository;
    this.marketEvidence = marketEvidence;
    this.clock = clock;
  }

  async assess(job, signal) {
    const context = await this.repository.assessmentContext(job);
    const event = context.event;
    if (context.eventRevision < Number(event.current_revision)) return { action: "COMPLETE", outcome: "SUPERSEDED" };
    if (["CANCELLED", "INVALIDATED"].includes(event.status)) return { action: "COMPLETE", outcome: event.status };
    const now = this.clock();
    if (event.status !== "COMPLETED" || Date.parse(event.event_time) > now.getTime()) {
      return { action: "DEFER", reasonCode: "EVENT_ALPHA_EVENT_NOT_COMPLETED", delaySeconds: 300 };
    }

    const expectation = await this.repository.latestExpectation(event.id, event.first_actionable_at);
    if (!expectation) {
      await this.auditNoTrade(event, context.eventRevision, EVENT_ALPHA_REASON_CODES.POINT_IN_TIME_EVIDENCE_INCOMPLETE);
      return { action: "COMPLETE", outcome: "NO_TRADE" };
    }

    let market;
    try {
      market = await this.marketEvidence.context({ symbol: event.symbol, eventTime: event.event_time, signal });
    } catch (error) {
      if (Number(job.attempts || 0) < 5) return { action: "DEFER", reasonCode: error.code || "EVENT_ALPHA_MARKET_EVIDENCE_INCOMPLETE", delaySeconds: 300 };
      await this.auditNoTrade(event, context.eventRevision, EVENT_ALPHA_REASON_CODES.POINT_IN_TIME_EVIDENCE_INCOMPLETE, error.code);
      return { action: "COMPLETE", outcome: "NO_TRADE" };
    }

    const canonicalEvent = mapCanonical(event, context.revision.normalized_payload, expectation);
    const valueCaptureScore = boundedRatio(expectation.feature_manifest?.valueCaptureScore, canonicalEvent.eventFamily === "PROTOCOL_ECONOMICS" ? 0.4 : 0.5);
    const assetProfile = {
      assetId: event.asset_id,
      effectiveFrom: market.cutoffAt,
      knownAt: market.cutoffAt,
      evidenceCutoffAt: market.cutoffAt,
      circulatingSupply: numericOrNull(canonicalEvent.normalizedPayload.circulatingSupply),
      averageDailyDollarVolume: market.averageDailyDollarVolume,
      floatAdjustment: 1,
      liquidSupplyRatio: 0.65,
      valueCaptureScore,
      benchmarkSymbol: market.benchmarkSymbol,
      sourceManifest: market.sourceManifest
    };
    const expectationInput = mapExpectation(expectation);
    const surprise = assessEventSurprise({ canonicalEvent, expectation: expectationInput, assetProfile, assessedAt: market.cutoffAt });
    const horizonSeconds = canonicalEvent.eventFamily === "GOVERNANCE" ? 86_400 : 21_600;
    const forecastBase = forecastEventResponse({
      surprise,
      realizedAssetReturnBps: market.realizedAssetReturnBps,
      realizedBenchmarkReturnBps: market.realizedBenchmarkReturnBps,
      horizonSeconds,
      costs: { spreadBps: 2, slippageBps: 4, feesBps: 6, fundingBps: 1 }
    });
    const forecast = { ...forecastBase, benchmarkSymbol: market.benchmarkSymbol, priceCutoffAt: market.cutoffAt };
    const thesis = buildEventAlphaThesis({
      canonicalEvent,
      forecast,
      validFrom: market.cutoffAt,
      expiresAt: new Date(Date.parse(market.cutoffAt) + horizonSeconds * 1_000).toISOString()
    });
    const persisted = await this.repository.persistLiveAssessment({
      canonicalEventId: event.id,
      eventRevision: context.eventRevision,
      expectationSnapshotId: expectation.id,
      assetProfile,
      surprise,
      forecast,
      thesis
    });
    await this.repository.writeAudit({
      correlationId: event.id,
      canonicalEventId: event.id,
      thesisId: persisted.thesis_id,
      decisionType: "LIVE_EVENT_ASSESSMENT",
      outcome: forecast.outcome,
      reasonCodes: thesis.reasonCodes,
      modelVersions: { surprise: "EVENT_SURPRISE_V1", forecast: "REMAINING_EVENT_ALPHA_V1", market: "BYBIT_PUBLIC_V5" },
      evidenceHash: sha256({ eventId: event.id, revision: context.eventRevision, expectationId: expectation.id, marketCutoffAt: market.cutoffAt }),
      safeMetadata: { symbol: event.symbol, family: event.event_family, priceCutoffAt: market.cutoffAt, executionAuthority: "NONE" }
    });
    return { action: "COMPLETE", outcome: forecast.outcome, thesisId: persisted.thesis_id };
  }

  async auditNoTrade(event, revision, reasonCode, detailCode = null) {
    await this.repository.writeAudit({
      correlationId: event.id,
      canonicalEventId: event.id,
      decisionType: "LIVE_EVENT_ASSESSMENT",
      outcome: "NO_TRADE",
      reasonCodes: [reasonCode],
      modelVersions: { pipeline: "EVENT_ALPHA_LIVE_V1" },
      evidenceHash: sha256({ eventId: event.id, revision, reasonCode, detailCode }),
      safeMetadata: { symbol: event.symbol, family: event.event_family, detailCode, executionAuthority: "NONE" }
    });
  }
}

function mapCanonical(event, revisionPayload, expectation) {
  const normalizedPayload = { ...(revisionPayload || {}) };
  if (event.event_family === "PROTOCOL_ECONOMICS") {
    const actual = Number(normalizedPayload.actualValue);
    const expected = Number(expectation.expected_value);
    normalizedPayload.annualizedCashFlowDeltaUsd = Number.isFinite(actual) && Number.isFinite(expected) ? (actual - expected) * 365 : 0;
  }
  return {
    id: event.id,
    canonicalKey: event.canonical_key,
    eventFamily: event.event_family,
    assetId: event.asset_id,
    symbol: event.symbol,
    eventTime: event.event_time,
    firstActionableAt: event.first_actionable_at,
    currentRevision: Number(event.current_revision),
    sourceConfidence: Number(event.source_confidence),
    normalizedPayload
  };
}

function mapExpectation(row) {
  return {
    asOf: row.as_of,
    firstActionableAt: row.first_actionable_at,
    modelKey: row.model_key,
    modelVersion: row.model_version,
    expectedValue: numericOrNull(row.expected_value),
    expectedTime: row.expected_time,
    expectedProbability: numericOrNull(row.expected_probability),
    dispersion: numericOrNull(row.dispersion),
    confidence: Number(row.confidence),
    contributors: row.contributors || [],
    featureManifest: row.feature_manifest || {}
  };
}

function numericOrNull(value) { if (value === null || value === undefined || value === "") return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function boundedRatio(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback; }
