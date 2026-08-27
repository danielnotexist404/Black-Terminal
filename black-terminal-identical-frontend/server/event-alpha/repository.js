import crypto from "node:crypto";
import { normalizeCanonicalEvent, normalizeTokenUnlock, sanitizeSafeMetadata, sha256 } from "./domain.js";

export class EventAlphaRepository {
  constructor(supabase) {
    this.supabase = supabase;
  }

  async ensureSource({ sourceKey, displayName, eventFamily, adapterVersion, authorityClass, enabled, configurationFingerprint }) {
    const row = {
      source_key: sourceKey,
      display_name: displayName,
      event_family: eventFamily,
      adapter_version: adapterVersion,
      authority_class: authorityClass,
      enabled,
      configuration_fingerprint: configurationFingerprint || null,
      updated_at: new Date().toISOString()
    };
    const { data, error } = await this.supabase.from("event_alpha_sources").upsert(row, { onConflict: "source_key" }).select("*").single();
    if (error) throw infrastructure(error, "EVENT_ALPHA_SOURCE_WRITE_FAILED");
    return data;
  }

  async ingestTokenUnlock(envelope, source) {
    const canonical = normalizeTokenUnlock(envelope);
    const { data, error } = await this.supabase.rpc("event_alpha_ingest_token_unlock_v1", {
      p_source_id: source.id,
      p_source_event_id: envelope.sourceEventId,
      p_observed_at: envelope.observedAt,
      p_first_actionable_at: envelope.firstActionableAt,
      p_source_published_at: envelope.sourcePublishedAt,
      p_payload_hash: envelope.payloadHash,
      p_payload: envelope.payload,
      p_ingestion_metadata: envelope.ingestionMetadata,
      p_canonical_key: canonical.canonicalKey,
      p_asset_id: canonical.assetId,
      p_symbol: canonical.symbol,
      p_event_time: canonical.eventTime,
      p_source_confidence: canonical.sourceConfidence,
      p_dedupe_fingerprint: canonical.dedupeFingerprint,
      p_safe_summary: canonical.safeSummary,
      p_normalized_payload: canonical.normalizedPayload
    });
    if (error) throw infrastructure(error, "EVENT_ALPHA_ATOMIC_INGEST_FAILED");
    const result = Array.isArray(data) ? data[0] : data;
    if (!result?.canonical_event_id || !result?.raw_event_id) throw infrastructure(null, "EVENT_ALPHA_ATOMIC_INGEST_EMPTY");
    const { data: canonicalEvent, error: eventError } = await this.supabase.from("event_alpha_canonical_events").select("*").eq("id", result.canonical_event_id).single();
    if (eventError) throw infrastructure(eventError, "EVENT_ALPHA_EVENT_READ_AFTER_INGEST_FAILED");
    return { raw: { id: result.raw_event_id }, canonicalEvent, duplicate: Boolean(result.was_duplicate), revision: Number(result.event_revision) };
  }

  async ingestCanonical(envelope, source) {
    const canonical = normalizeCanonicalEvent(envelope);
    const { data, error } = await this.supabase.rpc("event_alpha_ingest_canonical_v2", {
      p_source_id: source.id,
      p_source_event_id: envelope.sourceEventId,
      p_event_family: canonical.eventFamily,
      p_observed_at: envelope.observedAt,
      p_first_actionable_at: envelope.firstActionableAt,
      p_source_published_at: envelope.sourcePublishedAt,
      p_payload_hash: envelope.payloadHash,
      p_payload: envelope.payload,
      p_ingestion_metadata: envelope.ingestionMetadata,
      p_canonical_key: canonical.canonicalKey,
      p_asset_id: canonical.assetId,
      p_symbol: canonical.symbol,
      p_event_time: canonical.eventTime,
      p_event_status: canonical.status || "SCHEDULED",
      p_source_confidence: canonical.sourceConfidence,
      p_dedupe_fingerprint: canonical.dedupeFingerprint,
      p_safe_summary: canonical.safeSummary,
      p_normalized_payload: canonical.normalizedPayload
    });
    if (error) throw infrastructure(error, "EVENT_ALPHA_ATOMIC_CANONICAL_INGEST_FAILED");
    const result = Array.isArray(data) ? data[0] : data;
    if (!result?.canonical_event_id || !result?.raw_event_id) throw infrastructure(null, "EVENT_ALPHA_ATOMIC_CANONICAL_INGEST_EMPTY");
    const { data: canonicalEvent, error: eventError } = await this.supabase.from("event_alpha_canonical_events").select("*").eq("id", result.canonical_event_id).single();
    if (eventError) throw infrastructure(eventError, "EVENT_ALPHA_EVENT_READ_AFTER_INGEST_FAILED");
    return { raw: { id: result.raw_event_id }, canonicalEvent, duplicate: Boolean(result.was_duplicate), revision: Number(result.event_revision), normalized: canonical };
  }

  async captureExpectation(canonicalEvent, expectation) {
    if (!expectation) return null;
    const asOf = new Date(expectation.asOf).toISOString();
    if (Date.parse(asOf) >= Date.parse(canonicalEvent.first_actionable_at)) return null;
    const contributors = Array.isArray(expectation.contributors) ? expectation.contributors.map(sanitizeSafeMetadata) : [];
    const featureManifest = sanitizeSafeMetadata(expectation.featureManifest || {});
    const expectationKey = sha256({
      eventId: canonicalEvent.id,
      asOf,
      modelKey: expectation.modelKey,
      modelVersion: expectation.modelVersion,
      expectedValue: expectation.expectedValue ?? null,
      expectedProbability: expectation.expectedProbability ?? null,
      contributors
    });
    const { data, error } = await this.supabase.rpc("event_alpha_insert_expectation_v1", {
      p_canonical_event_id: canonicalEvent.id,
      p_expectation_key: expectationKey,
      p_as_of: asOf,
      p_first_actionable_at: canonicalEvent.first_actionable_at,
      p_model_key: String(expectation.modelKey || "LIVE_SOURCE_EXPECTATION").slice(0, 120),
      p_model_version: String(expectation.modelVersion || "1.0.0").slice(0, 80),
      p_expected_value: expectation.expectedValue ?? null,
      p_expected_time: canonicalEvent.event_time,
      p_expected_probability: expectation.expectedProbability ?? null,
      p_dispersion: Math.max(0, Number(expectation.dispersion || 0)),
      p_confidence: Math.min(1, Math.max(0, Number(expectation.confidence || 0))),
      p_contributors: contributors,
      p_feature_manifest: featureManifest
    });
    if (error) throw infrastructure(error, "EVENT_ALPHA_LIVE_EXPECTATION_WRITE_FAILED");
    return data;
  }

  async latestExpectation(eventId, firstActionableAt) {
    const { data, error } = await this.supabase.from("event_alpha_expectation_snapshots").select("*")
      .eq("canonical_event_id", eventId).lt("as_of", firstActionableAt).order("as_of", { ascending: false }).order("snapshot_version", { ascending: false }).limit(1).maybeSingle();
    if (error) throw infrastructure(error, "EVENT_ALPHA_EXPECTATION_READ_FAILED");
    return data || null;
  }

  async assessmentContext(job) {
    const eventId = job.canonical_event_id || job.payload?.canonicalEventId;
    const eventRevision = Number(job.payload?.eventRevision || 0);
    const [eventResult, revisionResult] = await Promise.all([
      this.supabase.from("event_alpha_canonical_events").select("*").eq("id", eventId).single(),
      this.supabase.from("event_alpha_event_revisions").select("*").eq("canonical_event_id", eventId).eq("revision", eventRevision).single()
    ]);
    if (eventResult.error || revisionResult.error) throw infrastructure(eventResult.error || revisionResult.error, "EVENT_ALPHA_ASSESSMENT_CONTEXT_READ_FAILED");
    return { event: eventResult.data, revision: revisionResult.data, eventRevision };
  }

  async persistLiveAssessment({ canonicalEventId, eventRevision, expectationSnapshotId, assetProfile, surprise, forecast, thesis }) {
    const { data, error } = await this.supabase.rpc("event_alpha_persist_live_assessment_v1", {
      p_canonical_event_id: canonicalEventId,
      p_event_revision: eventRevision,
      p_expectation_snapshot_id: expectationSnapshotId,
      p_asset_profile: assetProfile,
      p_surprise: surprise,
      p_forecast: forecast,
      p_thesis: thesis
    });
    if (error) throw infrastructure(error, "EVENT_ALPHA_ASSESSMENT_WRITE_FAILED");
    const result = Array.isArray(data) ? data[0] : data;
    if (!result?.surprise_assessment_id || !result?.response_forecast_id || !result?.thesis_id) throw infrastructure(null, "EVENT_ALPHA_ASSESSMENT_WRITE_EMPTY");
    return result;
  }

  async updateCheckpoint(sourceId, checkpoint, outcome = {}) {
    const row = {
      source_id: sourceId,
      cursor_value: checkpoint.cursorValue || null,
      watermark_at: checkpoint.watermarkAt || null,
      consecutive_failures: outcome.errorCode ? Number(outcome.consecutiveFailures || 1) : 0,
      backoff_until: outcome.backoffUntil || null,
      last_error_code: outcome.errorCode || null,
      updated_at: new Date().toISOString()
    };
    const { error } = await this.supabase.from("event_alpha_source_checkpoints").upsert(row, { onConflict: "source_id" });
    if (error) throw infrastructure(error, "EVENT_ALPHA_CHECKPOINT_WRITE_FAILED");
  }

  async getCheckpoint(sourceId) {
    const { data, error } = await this.supabase.from("event_alpha_source_checkpoints").select("*").eq("source_id", sourceId).maybeSingle();
    if (error) throw infrastructure(error, "EVENT_ALPHA_CHECKPOINT_READ_FAILED");
    return data || {};
  }

  async listFeed({ limit = 50, before, family, symbol }) {
    let query = this.supabase.from("event_alpha_canonical_events")
      .select("id,canonical_key,event_family,asset_id,symbol,event_time,first_actionable_at,status,current_revision,source_confidence,safe_summary,updated_at")
      .order("first_actionable_at", { ascending: false }).order("id", { ascending: false }).limit(Math.min(100, Math.max(1, limit)));
    if (before) query = query.lt("first_actionable_at", before);
    if (family) query = query.eq("event_family", family);
    if (symbol) query = query.eq("symbol", symbol);
    const { data, error } = await query;
    if (error) throw infrastructure(error, "EVENT_ALPHA_FEED_READ_FAILED");
    return data || [];
  }

  async eventDetail(eventId) {
    const eventQuery = this.supabase.from("event_alpha_canonical_events").select("*").eq("id", eventId).single();
    const revisionQuery = this.supabase.from("event_alpha_event_revisions").select("id,revision,effective_at,known_at,payload_hash,normalized_payload,changed_fields,reason_code,created_at").eq("canonical_event_id", eventId).order("revision", { ascending: false }).limit(100);
    const expectationQuery = this.supabase.from("event_alpha_expectation_snapshots").select("*").eq("canonical_event_id", eventId).order("snapshot_version", { ascending: false }).limit(50);
    const thesisQuery = this.supabase.from("event_alpha_theses").select("*").eq("canonical_event_id", eventId).order("created_at", { ascending: false }).limit(50);
    const [eventResult, revisionResult, expectationResult, thesisResult] = await Promise.all([eventQuery, revisionQuery, expectationQuery, thesisQuery]);
    for (const result of [eventResult, revisionResult, expectationResult, thesisResult]) if (result.error) throw infrastructure(result.error, "EVENT_ALPHA_DETAIL_READ_FAILED");
    return { event: eventResult.data, revisions: revisionResult.data || [], expectations: expectationResult.data || [], theses: thesisResult.data || [] };
  }

  async listTheses({ limit = 100, state }) {
    let query = this.supabase.from("event_alpha_theses").select("*").order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(Math.min(200, Math.max(1, limit)));
    if (state) query = query.eq("state", state);
    const { data, error } = await query;
    if (error) throw infrastructure(error, "EVENT_ALPHA_THESES_READ_FAILED");
    return data || [];
  }

  async rankedCrypto({ limit = 50, family, symbol, minimumConfidence = 0 }) {
    let thesisQuery = this.supabase.from("event_alpha_theses").select("*")
      .gte("confidence", minimumConfidence).order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(200);
    if (family) thesisQuery = thesisQuery.eq("event_family", family);
    const { data: theses, error: thesisError } = await thesisQuery;
    if (thesisError) throw infrastructure(thesisError, "EVENT_ALPHA_RANKED_THESES_READ_FAILED");
    const eventIds = [...new Set((theses || []).map((row) => row.canonical_event_id))];
    if (!eventIds.length) return [];
    let eventQuery = this.supabase.from("event_alpha_canonical_events")
      .select("id,symbol,asset_id,event_family,event_time,first_actionable_at,status,safe_summary,source_confidence,current_revision")
      .in("id", eventIds);
    if (symbol) eventQuery = eventQuery.eq("symbol", symbol);
    const { data: events, error: eventError } = await eventQuery;
    if (eventError) throw infrastructure(eventError, "EVENT_ALPHA_RANKED_EVENTS_READ_FAILED");
    return rankCryptoCandidates(theses || [], events || [], limit);
  }

  async ensurePeadProvider({ providerKey, displayName, adapterVersion, enabled, configurationFingerprint }) {
    const row = {
      provider_key: providerKey,
      display_name: displayName,
      adapter_version: adapterVersion,
      enabled,
      configuration_fingerprint: configurationFingerprint || null,
      updated_at: new Date().toISOString()
    };
    const { data, error } = await this.supabase.from("event_alpha_pead_providers").upsert(row, { onConflict: "provider_key" }).select("*").single();
    if (error) throw infrastructure(error, "EVENT_ALPHA_PEAD_PROVIDER_WRITE_FAILED");
    return data;
  }

  async ingestPeadAssessment(providerId, assessment) {
    const { data, error } = await this.supabase.rpc("event_alpha_ingest_pead_v1", { p_provider_id: providerId, p_assessment: assessment });
    if (error) throw infrastructure(error, "EVENT_ALPHA_PEAD_INGEST_FAILED");
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.pead_event_id || !row?.signal_id) throw infrastructure(null, "EVENT_ALPHA_PEAD_INGEST_EMPTY");
    return row;
  }

  async listPeadSignals({ limit = 100, state, ticker }) {
    let query = this.supabase.from("event_alpha_pead_signals").select("*")
      .order("calculated_at", { ascending: false }).order("id", { ascending: false }).limit(Math.min(200, Math.max(1, limit)));
    if (state) query = query.eq("signal_state", state);
    const { data: signals, error: signalError } = await query;
    if (signalError) throw infrastructure(signalError, "EVENT_ALPHA_PEAD_SIGNAL_READ_FAILED");
    const eventIds = [...new Set((signals || []).map((row) => row.pead_event_id))];
    if (!eventIds.length) return [];
    let eventQuery = this.supabase.from("event_alpha_pead_events")
      .select("id,ticker,issuer,fiscal_period,announced_at,first_actionable_at,expectation_as_of,announcement_session,status,current_revision,source_confidence")
      .in("id", eventIds);
    if (ticker) eventQuery = eventQuery.eq("ticker", ticker);
    const { data: events, error: eventError } = await eventQuery;
    if (eventError) throw infrastructure(eventError, "EVENT_ALPHA_PEAD_EVENT_READ_FAILED");
    const eventById = new Map((events || []).map((row) => [row.id, row]));
    const seen = new Set();
    return (signals || []).filter((row) => eventById.has(row.pead_event_id) && !seen.has(row.pead_event_id) && seen.add(row.pead_event_id))
      .map((row) => ({ ...row, event: eventById.get(row.pead_event_id) }))
      .sort((a, b) => Math.abs(Number(b.remaining_drift_bps)) * Number(b.confidence) - Math.abs(Number(a.remaining_drift_bps)) * Number(a.confidence))
      .slice(0, Math.min(100, Math.max(1, limit)));
  }

  async peadSignalDetail(signalId) {
    const { data: signal, error: signalError } = await this.supabase.from("event_alpha_pead_signals").select("*").eq("id", signalId).single();
    if (signalError) throw infrastructure(signalError, "EVENT_ALPHA_PEAD_SIGNAL_DETAIL_FAILED");
    const [eventResult, evidenceResult, returnResult] = await Promise.all([
      this.supabase.from("event_alpha_pead_events").select("*").eq("id", signal.pead_event_id).single(),
      this.supabase.from("event_alpha_pead_evidence").select("id,revision,evidence_hash,expectation_as_of,first_actionable_at,immutable_evidence,source_manifest,filing_url,consensus_source_url,price_source_url,known_at").eq("id", signal.evidence_id).single(),
      this.supabase.from("event_alpha_pead_return_points").select("point_index,observed_at,price,stock_return_bps,market_return_bps,sector_return_bps,abnormal_return_bps,cumulative_abnormal_return_bps").eq("signal_id", signalId).order("point_index", { ascending: true })
    ]);
    for (const result of [eventResult, evidenceResult, returnResult]) if (result.error) throw infrastructure(result.error, "EVENT_ALPHA_PEAD_DETAIL_READ_FAILED");
    return { event: eventResult.data, evidence: evidenceResult.data, signal, returnPath: returnResult.data || [] };
  }

  async health() {
    const { data: sources, error: sourceError } = await this.supabase.from("event_alpha_sources").select("source_key,event_family,enabled,health_status,last_success_at,last_error_at,safe_error_code,updated_at").order("source_key");
    if (sourceError) throw infrastructure(sourceError, "EVENT_ALPHA_HEALTH_READ_FAILED");
    const { count, error: queueError } = await this.supabase.from("event_alpha_processing_jobs").select("id", { count: "exact", head: true }).in("status", ["QUEUED", "PROCESSING"]);
    if (queueError) throw infrastructure(queueError, "EVENT_ALPHA_QUEUE_HEALTH_FAILED");
    const peadResult = await this.supabase.from("event_alpha_pead_providers").select("provider_key,display_name,enabled,health_status,last_success_at,last_error_at,safe_error_code,updated_at").order("provider_key");
    if (peadResult.error && !["42P01", "PGRST205"].includes(peadResult.error.code)) throw infrastructure(peadResult.error, "EVENT_ALPHA_PEAD_HEALTH_READ_FAILED");
    return { sources: sources || [], peadProviders: peadResult.data || [], pendingJobs: count || 0 };
  }

  async audit({ limit = 100, eventId, thesisId }) {
    let query = this.supabase.from("event_alpha_decision_audit").select("id,correlation_id,canonical_event_id,thesis_id,decision_type,outcome,reason_codes,model_versions,evidence_hash,safe_metadata,actor_type,created_at")
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(Math.min(200, Math.max(1, limit)));
    if (eventId) query = query.eq("canonical_event_id", eventId);
    if (thesisId) query = query.eq("thesis_id", thesisId);
    const { data, error } = await query;
    if (error) throw infrastructure(error, "EVENT_ALPHA_AUDIT_READ_FAILED");
    return data || [];
  }

  async paperState({ limit = 100 }) {
    const bounded = Math.min(200, Math.max(1, limit));
    const positions = this.supabase.from("event_alpha_paper_positions").select("id,thesis_id,trade_intent_id,symbol,direction,quantity,average_entry_price,status,realized_pnl,unrealized_pnl,total_fees,total_funding,opened_at,closed_at,market_data_cutoff_at,version,updated_at").order("opened_at", { ascending: false }).order("id", { ascending: false }).limit(bounded);
    const orders = this.supabase.from("event_alpha_paper_orders").select("id,trade_intent_id,paper_order_id,status,submitted_at,filled_quantity,average_fill_price,total_fees,version,updated_at").order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(bounded);
    const intents = this.supabase.from("event_alpha_trade_intents").select("id,thesis_id,client_intent_id,mode,symbol,side,order_type,quantity,expires_at,status,created_at,updated_at").order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(bounded);
    const [positionResult, orderResult, intentResult] = await Promise.all([positions, orders, intents]);
    for (const result of [positionResult, orderResult, intentResult]) if (result.error) throw infrastructure(result.error, "EVENT_ALPHA_PAPER_STATE_READ_FAILED");
    return { positions: positionResult.data || [], orders: orderResult.data || [], intents: intentResult.data || [] };
  }

  async writeAudit(event) {
    let correlationId = event.correlationId || event.canonicalEventId || null;
    let canonicalEventId = event.canonicalEventId || null;
    if (!correlationId && event.thesisId) {
      const { data, error } = await this.supabase.from("event_alpha_theses").select("canonical_event_id").eq("id", event.thesisId).single();
      if (error || !data?.canonical_event_id) throw infrastructure(error, "EVENT_ALPHA_AUDIT_CORRELATION_READ_FAILED");
      correlationId = data.canonical_event_id;
      canonicalEventId = data.canonical_event_id;
    }
    const { error } = await this.supabase.from("event_alpha_decision_audit").insert({
      correlation_id: correlationId || crypto.randomUUID(),
      canonical_event_id: canonicalEventId,
      thesis_id: event.thesisId || null,
      decision_type: event.decisionType,
      outcome: event.outcome,
      reason_codes: event.reasonCodes || [],
      model_versions: event.modelVersions || {},
      evidence_hash: event.evidenceHash,
      safe_metadata: event.safeMetadata || {},
      actor_type: event.actorType || "SYSTEM",
      actor_id: event.actorId || null
    });
    if (error && error.code !== "23505") throw infrastructure(error, "EVENT_ALPHA_AUDIT_WRITE_FAILED");
  }
}

export function rankCryptoCandidates(theses, events, limit = 50) {
  const eventById = new Map(events.map((row) => [row.id, row]));
  const stateWeight = { PAPER_ACTIVE: 1, TRIGGERED: 0.95, ARMED: 0.85, OBSERVING: 0.65, DRAFT: 0.35, RESOLVED: 0.15 };
  const eventWinners = new Map();
  for (const row of theses) {
    const event = eventById.get(row.canonical_event_id);
    if (!event) continue;
    const score = Number(row.confidence) * 55 + Math.min(1, Math.abs(Number(row.remaining_alpha_bps)) / 500) * 30 + (stateWeight[row.state] || 0) * 15;
    const candidate = { ...row, event, rank_score: score, market_verified: true };
    const previous = eventWinners.get(event.id);
    if (!previous || compareCryptoRank(candidate, previous) < 0) eventWinners.set(event.id, candidate);
  }

  // Provider schedules can create hundreds of hourly revisions for the same
  // protocol. One asset must never monopolize the discovery surface: retain
  // the strongest causal thesis and expose how many related events collapsed
  // beneath it for transparent drill-down.
  const assetWinners = new Map();
  for (const candidate of eventWinners.values()) {
    const assetKey = String(candidate.event.asset_id || candidate.event.symbol || candidate.event.id).toUpperCase();
    const bucket = assetWinners.get(assetKey);
    if (!bucket) {
      assetWinners.set(assetKey, { winner: candidate, count: 1 });
      continue;
    }
    bucket.count += 1;
    if (compareCryptoRank(candidate, bucket.winner) < 0) bucket.winner = candidate;
  }

  return [...assetWinners.values()].map(({ winner, count }) => ({ ...winner, collapsed_event_count: count }))
    .sort(compareCryptoRank)
    .slice(0, Math.min(100, Math.max(1, limit)));
}

function compareCryptoRank(a, b) {
  return b.rank_score - a.rank_score || Date.parse(b.updated_at) - Date.parse(a.updated_at) || String(a.id).localeCompare(String(b.id));
}

function infrastructure(error, code) {
  const wrapped = new Error("Event Alpha persistence is temporarily unavailable.");
  wrapped.statusCode = 503;
  wrapped.code = code;
  wrapped.cause = error;
  return wrapped;
}
