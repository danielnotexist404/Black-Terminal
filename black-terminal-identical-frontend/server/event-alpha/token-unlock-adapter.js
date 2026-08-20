import { normalizeRawEventEnvelope } from "./domain.js";
import { isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 4;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class TokenUnlockSourceAdapter {
  constructor(configuration = {}, fetchImpl = globalThis.fetch) {
    this.fetchImpl = fetchImpl;
    this.sourceKey = String(configuration.sourceKey || "TOKEN_UNLOCK_PROVIDER_V1").toUpperCase();
    this.url = configuration.url || null;
    this.apiToken = configuration.apiToken || null;
    this.timeoutMs = clampInteger(configuration.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, 30_000);
    this.allowedHosts = new Set(configuration.allowedHosts || (this.url ? [new URL(this.url).hostname] : []));
  }

  static fromEnvironment(env = process.env, fetchImpl = globalThis.fetch) {
    return new TokenUnlockSourceAdapter({
      sourceKey: env.EVENT_ALPHA_TOKEN_UNLOCK_SOURCE_KEY || "TOKEN_UNLOCK_PROVIDER_V1",
      url: env.EVENT_ALPHA_TOKEN_UNLOCK_API_URL || null,
      apiToken: env.EVENT_ALPHA_TOKEN_UNLOCK_API_TOKEN || null,
      allowedHosts: String(env.EVENT_ALPHA_TOKEN_UNLOCK_ALLOWED_HOSTS || "").split(",").map((value) => value.trim()).filter(Boolean),
      timeoutMs: Number(env.EVENT_ALPHA_SOURCE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
    }, fetchImpl);
  }

  health() {
    if (!this.url || !this.apiToken) return { status: "DISABLED", reasonCode: "SOURCE_CONFIGURATION_MISSING" };
    try {
      this.assertUrl(this.url);
      return { status: "READY", reasonCode: null };
    } catch (error) {
      return { status: "QUARANTINED", reasonCode: error.code || "SOURCE_URL_REJECTED" };
    }
  }

  async poll(checkpoint = {}, signal) {
    const health = this.health();
    if (health.status !== "READY") return { envelopes: [], checkpoint, health };
    const target = new URL(this.url);
    if (checkpoint.cursorValue) target.searchParams.set("cursor", checkpoint.cursorValue);
    const response = await this.fetchWithRetry(target, signal);
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("application/json")) throw adapterError("SOURCE_CONTENT_TYPE_INVALID", "Token unlock provider must return JSON.", false);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw adapterError("SOURCE_RESPONSE_TOO_LARGE", "Token unlock provider response exceeds two MiB.", false);
    const responseText = await response.text();
    if (Buffer.byteLength(responseText, "utf8") > MAX_RESPONSE_BYTES) throw adapterError("SOURCE_RESPONSE_TOO_LARGE", "Token unlock provider response exceeds two MiB.", false);
    let body;
    try {
      body = JSON.parse(responseText);
    } catch {
      throw adapterError("SOURCE_JSON_INVALID", "Token unlock provider returned malformed JSON.", false);
    }
    if (!body || typeof body !== "object" || !Array.isArray(body.events)) throw adapterError("SOURCE_SCHEMA_INVALID", "Token unlock provider response is invalid.");
    if (body.events.length > 500) throw adapterError("SOURCE_BATCH_TOO_LARGE", "Token unlock provider returned more than 500 events.");
    const envelopes = body.events.map((event) => normalizeRawEventEnvelope({
      sourceKey: this.sourceKey,
      sourceEventId: event.id,
      eventFamily: "TOKEN_SUPPLY",
      sourcePublishedAt: event.publishedAt || null,
      observedAt: event.observedAt,
      firstActionableAt: event.firstActionableAt,
      payload: event.payload,
      ingestionMetadata: { adapter: "TOKEN_UNLOCK_HTTP_V1", providerSequence: event.sequence ?? null }
    }));
    return {
      envelopes,
      checkpoint: {
        cursorValue: body.nextCursor ? String(body.nextCursor).slice(0, 2048) : checkpoint.cursorValue || null,
        watermarkAt: body.watermarkAt ? new Date(body.watermarkAt).toISOString() : new Date().toISOString()
      },
      health: { status: "HEALTHY", reasonCode: null }
    };
  }

  async fetchWithRetry(url, externalSignal) {
    let lastError;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("SOURCE_TIMEOUT")), this.timeoutMs);
      const relayAbort = () => controller.abort(externalSignal?.reason);
      externalSignal?.addEventListener("abort", relayAbort, { once: true });
      try {
        this.assertUrl(url);
        const response = await this.fetchImpl(url, {
          method: "GET",
          redirect: "error",
          headers: { accept: "application/json", authorization: `Bearer ${this.apiToken}` },
          signal: controller.signal
        });
        if (response.ok) return response;
        if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) throw adapterError("SOURCE_HTTP_REJECTED", `Provider rejected request with status ${response.status}.`, false);
        const retryAfter = boundedRetryAfter(response.headers.get("retry-after"));
        await abortableDelay(retryAfter ?? backoffMs(attempt), externalSignal);
      } catch (error) {
        lastError = error;
        if (externalSignal?.aborted) throw adapterError("SOURCE_ABORTED", "Token unlock poll was aborted.");
        if (error?.retryable === false) throw error;
        if (attempt + 1 < MAX_ATTEMPTS) await abortableDelay(backoffMs(attempt), externalSignal);
      } finally {
        clearTimeout(timeout);
        externalSignal?.removeEventListener("abort", relayAbort);
      }
    }
    throw adapterError(lastError?.code || "SOURCE_RETRY_EXHAUSTED", "Token unlock provider could not be reached after bounded retries.");
  }

  assertUrl(value) {
    const url = value instanceof URL ? value : new URL(value);
    if (url.protocol !== "https:") throw adapterError("SOURCE_HTTPS_REQUIRED", "Event source must use HTTPS.");
    if (url.username || url.password) throw adapterError("SOURCE_URL_CREDENTIALS_FORBIDDEN", "Event source URL cannot contain credentials.");
    if (isPrivateHost(url.hostname)) throw adapterError("SOURCE_PRIVATE_HOST_FORBIDDEN", "Event source host cannot target local or private infrastructure.");
    if (!this.allowedHosts.size || !this.allowedHosts.has(url.hostname)) throw adapterError("SOURCE_HOST_NOT_ALLOWED", "Event source host is not allowlisted.");
    return url;
  }
}

function isPrivateHost(hostname) {
  const normalized = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) return true;
  const version = isIP(normalized);
  if (version === 4) {
    const parts = normalized.split(".").map(Number);
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)
      || parts[0] >= 224;
  }
  return version === 6 && (normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb"));
}

function backoffMs(attempt) {
  return Math.min(8_000, 250 * 2 ** attempt);
}

function boundedRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;
  return Math.min(10_000, Math.max(0, seconds * 1_000));
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error("ABORTED"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason || new Error("ABORTED")); }, { once: true });
  });
}

function clampInteger(value, minimum, maximum) {
  const parsed = Math.round(Number(value));
  return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) ? parsed : minimum));
}

function adapterError(code, message, retryable = true) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}
