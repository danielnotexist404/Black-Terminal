import { isIP } from "node:net";
import { assessPeadEvidence } from "./pead-engine.js";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Adapter for a server-side normalized earnings feed. The upstream collector
 * may combine SEC EDGAR facts, point-in-time consensus and adjusted equity /
 * factor returns. No credential or raw provider payload reaches the browser.
 */
export class PeadNormalizedSourceAdapter {
  constructor(configuration = {}, fetchImpl = globalThis.fetch) {
    this.fetchImpl = fetchImpl;
    this.sourceKey = "PEAD_NORMALIZED_CAUSAL_V1";
    this.url = configuration.url || null;
    this.allowedHost = String(configuration.allowedHost || "").trim().toLowerCase();
    this.token = configuration.token || null;
    this.timeoutMs = boundedInteger(configuration.timeoutMs ?? 15_000, 1_000, 30_000);
  }

  static fromEnvironment(env = process.env, fetchImpl = globalThis.fetch) {
    return new PeadNormalizedSourceAdapter({
      url: env.EVENT_ALPHA_PEAD_FEED_URL,
      allowedHost: env.EVENT_ALPHA_PEAD_ALLOWED_HOST,
      token: env.EVENT_ALPHA_PEAD_FEED_TOKEN,
      timeoutMs: env.EVENT_ALPHA_SOURCE_TIMEOUT_MS
    }, fetchImpl);
  }

  health() {
    if (!this.url || !this.allowedHost || !this.token) return { status: "DISABLED", reasonCode: "PEAD_PROVIDER_NOT_CONFIGURED" };
    try {
      this.assertUrl(this.url);
      return { status: "READY", reasonCode: null };
    } catch (error) {
      return { status: "QUARANTINED", reasonCode: error.code || "PEAD_SOURCE_URL_REJECTED" };
    }
  }

  async poll(checkpoint = {}, signal) {
    const health = this.health();
    if (health.status !== "READY") return { assessments: [], checkpoint: {}, health };
    const target = this.assertUrl(this.url);
    if (checkpoint.cursorValue) target.searchParams.set("cursor", String(checkpoint.cursorValue).slice(0, 500));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("PEAD_SOURCE_TIMEOUT")), this.timeoutMs);
    const relay = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", relay, { once: true });
    try {
      const response = await this.fetchImpl(target, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { accept: "application/json", authorization: `Bearer ${this.token}` }
      });
      if (!response.ok) throw sourceError(`PEAD_SOURCE_HTTP_${response.status}`, "PEAD provider rejected the request.");
      if (!String(response.headers.get("content-type") || "").toLowerCase().includes("application/json")) throw sourceError("PEAD_SOURCE_CONTENT_TYPE_INVALID", "PEAD provider did not return JSON.");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw sourceError("PEAD_SOURCE_RESPONSE_TOO_LARGE", "PEAD provider response exceeded eight MiB.");
      let body;
      try { body = JSON.parse(text); } catch { throw sourceError("PEAD_SOURCE_JSON_INVALID", "PEAD provider returned malformed JSON."); }
      if (!Array.isArray(body?.events) || body.events.length > 500) throw sourceError("PEAD_SOURCE_SCHEMA_INVALID", "PEAD provider response must contain a bounded events array.");
      return {
        assessments: body.events.map((row) => assessPeadEvidence(row)),
        checkpoint: { cursorValue: body.nextCursor ? String(body.nextCursor).slice(0, 500) : null, watermarkAt: new Date().toISOString() },
        health: { status: "HEALTHY", reasonCode: null }
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", relay);
    }
  }

  assertUrl(value) {
    const url = new URL(String(value));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || host !== this.allowedHost || isIP(host) || host === "localhost" || host.endsWith(".local")) {
      throw sourceError("PEAD_SOURCE_URL_REJECTED", "PEAD provider URL is not an allowlisted public HTTPS endpoint.");
    }
    return url;
  }
}

function boundedInteger(value, minimum, maximum) { const parsed = Math.round(Number(value)); return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) ? parsed : minimum)); }
function sourceError(code, message) { const error = new Error(message); error.code = code; error.retryable = true; return error; }
