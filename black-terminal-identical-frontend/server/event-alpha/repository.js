import crypto from "node:crypto";
import { normalizeTokenUnlock } from "./domain.js";

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

  async health() {
    const { data: sources, error: sourceError } = await this.supabase.from("event_alpha_sources").select("source_key,event_family,enabled,health_status,last_success_at,last_error_at,safe_error_code,updated_at").order("source_key");
    if (sourceError) throw infrastructure(sourceError, "EVENT_ALPHA_HEALTH_READ_FAILED");
    const { count, error: queueError } = await this.supabase.from("event_alpha_processing_jobs").select("id", { count: "exact", head: true }).in("status", ["QUEUED", "PROCESSING"]);
    if (queueError) throw infrastructure(queueError, "EVENT_ALPHA_QUEUE_HEALTH_FAILED");
    return { sources: sources || [], pendingJobs: count || 0 };
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

function infrastructure(error, code) {
  const wrapped = new Error("Event Alpha persistence is temporarily unavailable.");
  wrapped.statusCode = 503;
  wrapped.code = code;
  wrapped.cause = error;
  return wrapped;
}
