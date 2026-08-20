import crypto from "node:crypto";
import { eventAlphaRuntimeConfig, sha256 } from "./domain.js";
import { EventAlphaRepository } from "./repository.js";
import { executePaperJob } from "./service.js";
import { TokenUnlockSourceAdapter } from "./token-unlock-adapter.js";

export class EventAlphaWorker {
  constructor({ supabase, workerId = `event-alpha-${crypto.randomUUID()}`, adapter = TokenUnlockSourceAdapter.fromEnvironment(), logger = console }) {
    this.supabase = supabase;
    this.workerId = workerId;
    this.adapter = adapter;
    this.logger = logger;
    this.repository = new EventAlphaRepository(supabase);
    this.running = false;
  }

  async runOnce(signal) {
    const config = eventAlphaRuntimeConfig();
    if (!config.engineEnabled) return { status: "DISABLED", polled: 0, claimed: 0 };
    if (config.liveExecutionConfigurationRejected) throw workerError("EVENT_ALPHA_LIVE_FORBIDDEN", "Unsafe live Event Alpha configuration was rejected.");
    if (config.manualApprovalConfigurationRejected) throw workerError("EVENT_ALPHA_MANUAL_APPROVAL_REQUIRED", "Unsafe paper approval configuration was rejected.");
    const polled = config.ingestionEnabled && config.tokenSupplyEnabled ? await this.pollTokenUnlocks(signal) : 0;
    const { data: jobs, error } = await this.supabase.rpc("event_alpha_claim_jobs_v1", { p_worker_id: this.workerId, p_limit: 20, p_lease_seconds: 90 });
    if (error) throw workerError("EVENT_ALPHA_JOB_CLAIM_FAILED", "Event Alpha work queue is unavailable.", error);
    let completed = 0;
    let deferred = 0;
    for (const job of jobs || []) {
      if (signal?.aborted) break;
      try {
        if (job.job_type === "PAPER_EXECUTE") {
          if (!config.paperExecutionEnabled || config.strategyKillSwitchEngaged || config.globalExecutionKillSwitchEngaged) {
            await this.deferJob(job.id, config.paperExecutionEnabled ? "EVENT_ALPHA_KILL_SWITCH_ENGAGED" : "EVENT_ALPHA_PAPER_DISABLED", 60);
            deferred += 1;
            continue;
          }
          await executePaperJob({ supabase: this.supabase, job });
          await this.completeJob(job.id);
          completed += 1;
        } else if (job.job_type === "ASSESS") {
          const { data: thesis, error: thesisError } = await this.supabase.from("event_alpha_theses").select("id").eq("canonical_event_id", job.canonical_event_id).limit(1).maybeSingle();
          if (thesisError) throw workerError("EVENT_ALPHA_ASSESSMENT_LOOKUP_FAILED", "Assessment status is unavailable.", thesisError);
          if (thesis) { await this.completeJob(job.id); completed += 1; }
          else if (Number(job.attempts) >= 96) await this.failJob(job.id, "EXPECTATION_OR_MARKET_EVIDENCE_NOT_READY", true);
          else { await this.deferJob(job.id, "EXPECTATION_OR_MARKET_EVIDENCE_NOT_READY", 900); deferred += 1; }
        } else {
          await this.failJob(job.id, "UNSUPPORTED_JOB_TYPE", job.attempts >= 5);
        }
      } catch (error) {
        await this.failJob(job.id, error.code || "EVENT_ALPHA_JOB_FAILED", job.attempts >= 5);
      }
    }
    return { status: "HEALTHY", polled, claimed: jobs?.length || 0, completed, deferred };
  }

  async start({ intervalMs = 5_000, signal } = {}) {
    if (this.running) throw workerError("EVENT_ALPHA_WORKER_ALREADY_RUNNING", "Event Alpha worker is already running.");
    this.running = true;
    try {
      while (!signal?.aborted) {
        const result = await this.runOnce(signal);
        this.logger.info?.("[event-alpha-worker]", { workerId: this.workerId, ...result });
        await delay(Math.min(60_000, Math.max(1_000, intervalMs)), signal);
      }
    } finally {
      this.running = false;
    }
  }

  async pollTokenUnlocks(signal) {
    const health = this.adapter.health();
    const source = await this.repository.ensureSource({
      sourceKey: this.adapter.sourceKey,
      displayName: "Verified Token Unlock Provider",
      eventFamily: "TOKEN_SUPPLY",
      adapterVersion: "TOKEN_UNLOCK_HTTP_V1",
      authorityClass: "VERIFIED_PROVIDER",
      enabled: health.status === "READY",
      configurationFingerprint: sha256({ sourceKey: this.adapter.sourceKey, configured: health.status === "READY" })
    });
    if (health.status !== "READY") {
      const disabled = await this.supabase.from("event_alpha_sources").update({ health_status: health.status, safe_error_code: health.reasonCode, updated_at: new Date().toISOString() }).eq("id", source.id);
      if (disabled.error) throw workerError("EVENT_ALPHA_SOURCE_HEALTH_WRITE_FAILED", "Source health could not be persisted.", disabled.error);
      return 0;
    }
    const checkpoint = await this.repository.getCheckpoint(source.id);
    if (checkpoint.backoff_until && Date.parse(checkpoint.backoff_until) > Date.now()) return 0;
    try {
      const result = await this.adapter.poll({ cursorValue: checkpoint.cursor_value, watermarkAt: checkpoint.watermark_at }, signal);
      for (const envelope of result.envelopes) await this.repository.ingestTokenUnlock(envelope, source);
      await this.repository.updateCheckpoint(source.id, result.checkpoint);
      const healthy = await this.supabase.from("event_alpha_sources").update({ health_status: "HEALTHY", last_success_at: new Date().toISOString(), safe_error_code: null, updated_at: new Date().toISOString() }).eq("id", source.id);
      if (healthy.error) throw workerError("EVENT_ALPHA_SOURCE_HEALTH_WRITE_FAILED", "Source health could not be persisted.", healthy.error);
      return result.envelopes.length;
    } catch (error) {
      const failures = Number(checkpoint.consecutive_failures || 0) + 1;
      const quarantine = failures >= 10;
      const backoffSeconds = Math.min(3_600, 2 ** Math.min(10, failures) * 5);
      await this.repository.updateCheckpoint(source.id, checkpoint, { errorCode: error.code || "SOURCE_POLL_FAILED", consecutiveFailures: failures, backoffUntil: new Date(Date.now() + backoffSeconds * 1_000).toISOString() });
      const degraded = await this.supabase.from("event_alpha_sources").update({ health_status: quarantine ? "QUARANTINED" : "DEGRADED", last_error_at: new Date().toISOString(), safe_error_code: String(error.code || "SOURCE_POLL_FAILED").slice(0, 80), updated_at: new Date().toISOString() }).eq("id", source.id);
      if (degraded.error) this.logger.error?.("[event-alpha-source-health-write]", degraded.error.code || "unknown");
      throw error;
    }
  }

  async completeJob(id) {
    const { data, error } = await this.supabase.from("event_alpha_processing_jobs").update({ status: "COMPLETED", locked_by: null, locked_until: null, updated_at: new Date().toISOString() }).eq("id", id).eq("status", "PROCESSING").eq("locked_by", this.workerId).select("id").maybeSingle();
    if (error || !data) throw workerError("EVENT_ALPHA_JOB_COMPLETE_FAILED", "Could not complete the currently leased Event Alpha job.", error);
  }

  async deferJob(id, code, delaySeconds) {
    const { data, error } = await this.supabase.from("event_alpha_processing_jobs").update({ status: "QUEUED", locked_by: null, locked_until: null, available_at: new Date(Date.now() + delaySeconds * 1_000).toISOString(), safe_error_code: code, updated_at: new Date().toISOString() }).eq("id", id).eq("status", "PROCESSING").eq("locked_by", this.workerId).select("id").maybeSingle();
    if (error || !data) throw workerError("EVENT_ALPHA_JOB_DEFER_FAILED", "Could not defer the currently leased Event Alpha job.", error);
  }

  async failJob(id, code, deadLetter) {
    const { data, error } = await this.supabase.from("event_alpha_processing_jobs").update({ status: deadLetter ? "DEAD_LETTER" : "QUEUED", locked_by: null, locked_until: null, available_at: new Date(Date.now() + 60_000).toISOString(), safe_error_code: String(code).slice(0, 80), updated_at: new Date().toISOString() }).eq("id", id).eq("status", "PROCESSING").eq("locked_by", this.workerId).select("id").maybeSingle();
    if (error || !data) this.logger.error?.("[event-alpha-job-fail-write]", error?.code || "LEASE_LOST");
  }
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function workerError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  error.cause = cause;
  return error;
}
