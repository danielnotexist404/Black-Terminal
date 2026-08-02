import crypto from "node:crypto";
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
      .select("user_id,connection_id,provider,execution_environment,credential_version,status")
      .eq("id", secretReferenceId).single();
    if (error || reference?.status !== "ACTIVE") throw error || new Error("Active broker credential reference was not found.");
    const secret = await decryptBrokerCredential(this.supabase, secretReferenceId, {
      userId: reference.user_id,
      connectionId: reference.connection_id,
      provider: reference.provider,
      executionEnvironment: reference.execution_environment,
      credentialVersion: reference.credential_version
    });
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
      metadata: { provider: reference.provider, executionEnvironment: reference.execution_environment, credentialVersion: reference.credential_version }
    });
    return secret;
  }

  async assertFencingToken(connectionId, fencingToken) {
    return this.rpc("black_cloud_assert_current_fencing_token", {
      p_connection_id: connectionId,
      p_worker_id: this.workerId,
      p_fencing_token: fencingToken
    });
  }

  async requireAutomationMandate(connectionId, operation) {
    const { data, error } = await this.supabase.from("broker_automation_mandates")
      .select("*")
      .eq("connection_id", connectionId)
      .eq("status", "ACTIVE")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw mandateError("AUTOMATION_MANDATE_REQUIRED", "An active broker automation mandate is required.");
    if (data.expires_at && Date.parse(data.expires_at) <= Date.now()) throw mandateError("AUTOMATION_MANDATE_EXPIRED", "The broker automation mandate has expired.");
    const field = {
      read: "allow_read", trade: "allow_trade", cancel: "allow_cancel", modify: "allow_modify",
      strategy: "allow_strategy_execution", copy: "allow_copy_trading", group: "allow_investment_group_execution"
    }[operation];
    if (!field || data[field] !== true) throw mandateError("AUTOMATION_MANDATE_SCOPE_REJECTED", `The automation mandate does not permit ${operation}.`);
    if (data.allow_withdrawals) throw mandateError("WITHDRAWAL_PERMISSION_DETECTED", "Withdrawal authority is forbidden.");
    return data;
  }

  async recordInboxEvent(connection, event) {
    const eventIdentity = providerEventIdentity(connection.provider, event);
    const payloadHash = hashCanonical(event);
    const { data, error } = await this.supabase.from("execution_inbox").upsert({
      connection_id: connection.id,
      provider: String(connection.provider).toLowerCase(),
      event_identity: eventIdentity,
      event_type: String(event.type || "unknown").toUpperCase(),
      event_at: new Date(Number(event.time || Date.now())).toISOString(),
      payload_hash: payloadHash,
      status: "RECEIVED"
    }, { onConflict: "connection_id,event_identity", ignoreDuplicates: true }).select("id,status").maybeSingle();
    if (error) throw error;
    return { inserted: Boolean(data), id: data?.id || null, eventIdentity };
  }

  async markInboxEvent(id, status = "APPLIED", errorCode = null) {
    if (!id) return;
    const { error } = await this.supabase.from("execution_inbox").update({
      status,
      error_code: errorCode,
      applied_at: status === "APPLIED" || status === "IGNORED" ? new Date().toISOString() : null
    }).eq("id", id);
    if (error) throw error;
  }

  async probeReadiness() {
    const checks = await Promise.allSettled([
      head(this.supabase.from("execution_commands").select("id", { head: true, count: "exact" })),
      head(this.supabase.from("broker_secret_vault").select("id", { head: true, count: "exact" })),
      head(this.supabase.from("worker_leases").select("lease_key", { head: true, count: "exact" })),
      head(this.supabase.from("execution_inbox").select("id", { head: true, count: "exact" }))
    ]);
    const names = ["queue", "credentialVault", "leaseSubsystem", "eventInbox"];
    const dependencies = Object.fromEntries(checks.map((result, index) => [names[index], result.status === "fulfilled"]));
    return { ready: Object.values(dependencies).every(Boolean) && Boolean(this.workerId), workerIdentity: Boolean(this.workerId), dependencies };
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

export function providerEventIdentity(provider, event) {
  const body = event.report || event.fill || event.position || event.wallet || event.strategy || event.raw || event;
  const nativeId = body?.executionId || body?.fillId || body?.eventId || body?.orderId || body?.exchangeOrderId;
  const version = body?.updatedTime || body?.updateTime || body?.timestamp || event.time || "0";
  if (nativeId) return `${String(provider).toLowerCase()}:${String(event.type || "event").toLowerCase()}:${nativeId}:${version}`;
  return `${String(provider).toLowerCase()}:${String(event.type || "event").toLowerCase()}:${hashCanonical(event)}`;
}

function hashCanonical(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

async function head(builder) {
  const { error } = await builder;
  if (error) throw error;
  return true;
}

function mandateError(code, message) { return Object.assign(new Error(message), { code, statusCode: 403 }); }
