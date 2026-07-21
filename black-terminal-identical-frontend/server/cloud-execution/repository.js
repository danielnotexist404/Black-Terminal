import { decryptBrokerCredential } from "./secret-vault.js";

export class BlackCloudRepository {
  constructor(supabase, workerId) {
    this.supabase = supabase;
    this.workerId = workerId;
  }

  async claimCommands(limit = 10, lockSeconds = 45) {
    return this.rpc("black_cloud_claim_execution_commands", {
      p_worker_id: this.workerId,
      p_limit: limit,
      p_lock_seconds: lockSeconds
    });
  }

  async acquireLease(connectionId, ttlSeconds = 30) {
    const leaseKey = connectionId ? `connection:${connectionId}` : "global:group-intents";
    const value = await this.rpc("black_cloud_acquire_worker_lease", {
      p_lease_key: leaseKey,
      p_connection_id: connectionId || null,
      p_worker_id: this.workerId,
      p_ttl_seconds: ttlSeconds
    });
    return Array.isArray(value) ? value[0] || null : value;
  }

  async finishCommand(commandId, fencingToken, status, options = {}) {
    const value = await this.rpc("black_cloud_finish_execution_command", {
      p_command_id: commandId,
      p_worker_id: this.workerId,
      p_fencing_token: fencingToken,
      p_status: status,
      p_error_code: options.errorCode || null,
      p_error_message: sanitizeError(options.errorMessage),
      p_retry_after_seconds: options.retryAfterSeconds || null
    });
    return Array.isArray(value) ? value[0] || null : value;
  }

  async readBrokerSecret(secretReferenceId, purpose) {
    const { data: reference, error } = await this.supabase.from("broker_secret_references")
      .select("user_id,connection_id,provider,credential_version,status")
      .eq("id", secretReferenceId).single();
    if (error || reference?.status !== "ACTIVE") throw error || new Error("Active broker credential reference was not found.");
    const secret = await decryptBrokerCredential(this.supabase, secretReferenceId);
    const { error: usedError } = await this.supabase.from("broker_secret_references")
      .update({ last_used_at: new Date().toISOString() }).eq("id", secretReferenceId);
    if (usedError) throw usedError;
    await this.audit({
      userId: reference.user_id,
      connectionId: reference.connection_id,
      eventType: "CREDENTIAL_USED",
      purpose,
      userVisible: false,
      message: "The execution worker accessed a broker credential for an authorized operation.",
      metadata: { provider: reference.provider, credentialVersion: reference.credential_version }
    });
    return secret;
  }

  async audit(event) {
    const { error } = await this.supabase.from("execution_audit_events").insert({
      user_id: event.userId || null,
      connection_id: event.connectionId || null,
      group_id: event.groupId || null,
      group_intent_id: event.groupIntentId || null,
      follower_plan_id: event.followerPlanId || null,
      command_id: event.commandId || null,
      worker_id: this.workerId,
      event_type: event.eventType,
      severity: event.severity || "INFO",
      operation_purpose: event.purpose || null,
      user_visible: event.userVisible !== false,
      message: event.message,
      safe_metadata: redactObject(event.metadata || {})
    });
    if (error) throw error;
  }

  async startAttempt(command, fencingToken) {
    const { data, error } = await this.supabase.from("execution_command_attempts").insert({
      command_id: command.id,
      worker_id: this.workerId,
      fencing_token: fencingToken,
      attempt_number: command.attempt_count,
      outcome: "STARTED"
    }).select("id").single();
    if (error) throw error;
    return data.id;
  }

  async finishAttempt(attemptId, outcome, details = {}) {
    const { error } = await this.supabase.from("execution_command_attempts").update({
      outcome,
      provider_request_id: details.providerRequestId || null,
      venue_order_id: details.venueOrderId || null,
      safe_details: redactObject(details.safeDetails || {}),
      error_code: details.errorCode || null,
      error_message: sanitizeError(details.errorMessage),
      completed_at: new Date().toISOString()
    }).eq("id", attemptId);
    if (error) throw error;
  }

  async rpc(name, parameters) {
    const { data, error } = await this.supabase.rpc(name, parameters);
    if (error) throw error;
    return data;
  }
}

const SENSITIVE_KEY = /(secret|private.?key|api.?key|signature|authorization|token|password|seed|mnemonic|credential|encrypted|cipher|nonce|tag)/i;

export function redactObject(value, depth = 0) {
  if (depth > 8) return "[REDACTED_DEPTH]";
  if (Array.isArray(value)) return value.map((entry) => redactObject(entry, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactObject(entry, depth + 1)
  ]));
}

export function sanitizeError(value) {
  if (!value) return null;
  return String(value)
    .replace(/(api[-_ ]?key|secret|token|signature|authorization|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 1000);
}
