import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { apiRouteManifest, resolveApiRoute } from "./api-router.js";

const port = boundedInteger(process.env.PORT || process.env.BLACK_CLOUD_API_PORT, 3000, 1, 65_535);
const host = process.env.BLACK_CLOUD_API_BIND_ADDRESS || "0.0.0.0";
const maxBodyBytes = boundedInteger(process.env.BLACK_CLOUD_API_MAX_BODY_BYTES, 2 * 1024 * 1024, 8_192, 16 * 1024 * 1024);
const requestTimeoutMs = boundedInteger(process.env.BLACK_CLOUD_API_REQUEST_TIMEOUT_MS, 45_000, 1_000, 120_000);
const startedAt = Date.now();
const sockets = new Set();
let draining = false;

const server = createServer(async (req, res) => {
  applyResponseCompatibility(res);
  applySecurityHeaders(res);
  const requestId = requestIdentifier(req);
  res.setHeader("x-request-id", requestId);

  try {
    const url = new URL(req.url || "/", "http://black-cloud-api.internal");
    if (url.pathname === "/health/live") return res.status(200).json(healthPayload("live"));
    if (url.pathname === "/health/ready") return readiness(res);
    if (url.pathname === "/metrics") return metrics(res);
    if (url.pathname === "/api/_black-cloud/routes") return routeManifest(req, res);
    if (draining) return res.status(503).json({ error: "Black Cloud API is draining.", code: "API_DRAINING" });

    const resolved = resolveApiRoute(url.pathname);
    if (!resolved) return res.status(404).json({ error: "API route not found.", code: "API_ROUTE_NOT_FOUND" });

    req.query = { ...queryObject(url.searchParams), ...resolved.params };
    req.body = await readBody(req, maxBodyBytes);
    await withTimeout(Promise.resolve(resolved.handler(req, res)), requestTimeoutMs);
    if (!res.writableEnded) res.end();
  } catch (error) {
    if (res.writableEnded) return;
    const statusCode = Number(error?.statusCode) || (error?.code === "BODY_TOO_LARGE" ? 413 : error?.code === "INVALID_JSON" ? 400 : error?.code === "REQUEST_TIMEOUT" ? 504 : 500);
    if (statusCode >= 500) console.error(JSON.stringify({ level: "error", event: "api_request_failed", requestId, code: error?.code || "INTERNAL_ERROR", message: safeMessage(error) }));
    return res.status(statusCode).json({ error: statusCode >= 500 ? "Black Cloud API request failed." : safeMessage(error), code: error?.code || "API_REQUEST_FAILED" });
  }
});

server.requestTimeout = requestTimeoutMs + 5_000;
server.headersTimeout = Math.min(server.requestTimeout, 50_000);
server.keepAliveTimeout = 5_000;
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void shutdown(signal));
process.on("uncaughtException", (error) => {
  console.error(JSON.stringify({ level: "critical", event: "api_uncaught_exception", message: safeMessage(error) }));
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (error) => {
  console.error(JSON.stringify({ level: "critical", event: "api_unhandled_rejection", message: safeMessage(error) }));
  void shutdown("unhandledRejection", 1);
});

server.listen(port, host, () => console.log(JSON.stringify({ level: "info", event: "black_cloud_api_listening", host, port, commit: process.env.BLACK_CLOUD_DEPLOYMENT_COMMIT || "unknown", routeCount: apiRouteManifest().exact.length + apiRouteManifest().dynamic.length })));

async function readiness(res) {
  const persistenceUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  if (!persistenceUrl) return res.status(503).json({ ...healthPayload("not-ready"), checks: { persistence: "MISCONFIGURED" } });
  try {
    const response = await withTimeout(fetch(`${persistenceUrl}/auth/v1/health`, { headers: apiKeyHeaders(), signal: AbortSignal.timeout(3_000) }), 4_000);
    if (!response.ok) throw new Error(`auth-health-${response.status}`);
    return res.status(200).json({ ...healthPayload("ready"), checks: { persistence: "READY", imm: immReadiness() } });
  } catch {
    return res.status(503).json({ ...healthPayload("not-ready"), checks: { persistence: "UNAVAILABLE", imm: immReadiness() } });
  }
}

function metrics(res) {
  const uptime = Math.max(0, (Date.now() - startedAt) / 1000);
  res.setHeader("content-type", "text/plain; version=0.0.4");
  res.end([
    "# HELP black_cloud_api_up Whether the central API process is running.",
    "# TYPE black_cloud_api_up gauge",
    "black_cloud_api_up 1",
    "# HELP black_cloud_api_uptime_seconds Process uptime in seconds.",
    "# TYPE black_cloud_api_uptime_seconds counter",
    `black_cloud_api_uptime_seconds ${uptime.toFixed(3)}`,
    "# HELP black_cloud_api_open_sockets Current TCP sockets owned by the API.",
    "# TYPE black_cloud_api_open_sockets gauge",
    `black_cloud_api_open_sockets ${sockets.size}`,
    ""
  ].join("\n"));
}

function routeManifest(req, res) {
  if (process.env.BLACK_CLOUD_EXPOSE_ROUTE_MANIFEST !== "true") return res.status(404).json({ error: "API route not found.", code: "API_ROUTE_NOT_FOUND" });
  return res.status(200).json(apiRouteManifest());
}

function healthPayload(status) {
  return { status, service: "black-cloud-central-api", version: 1, commit: process.env.BLACK_CLOUD_DEPLOYMENT_COMMIT || "unknown", uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), draining };
}

function immReadiness() {
  return process.env.IMM_ENABLED === "true" ? "CONFIGURED_NOT_REQUIRED_FOR_BOOT" : "DISABLED";
}

function apiKeyHeaders() {
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return key ? { apikey: key, authorization: `Bearer ${key}` } : {};
}

async function shutdown(signal, exitCode = 0) {
  if (draining) return;
  draining = true;
  console.log(JSON.stringify({ level: "info", event: "black_cloud_api_draining", signal }));
  const forced = setTimeout(() => {
    for (const socket of sockets) socket.destroy();
  }, 25_000);
  forced.unref?.();
  await new Promise((resolve) => server.close(resolve));
  clearTimeout(forced);
  process.exit(exitCode);
}

async function readBody(req, limit) {
  if (["GET", "HEAD", "OPTIONS"].includes(String(req.method || "GET").toUpperCase())) return {};
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw codedError("BODY_TOO_LARGE", "Request body exceeds the Black Cloud API limit.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (type === "application/json" || type.endsWith("+json")) {
    try { return JSON.parse(raw); } catch { throw codedError("INVALID_JSON", "Request body is not valid JSON."); }
  }
  if (type === "application/x-www-form-urlencoded") return queryObject(new URLSearchParams(raw));
  return raw;
}

function applyResponseCompatibility(res) {
  res.status = function status(code) { this.statusCode = Number(code); return this; };
  res.json = function json(payload) {
    if (!this.headersSent) this.setHeader("content-type", "application/json; charset=utf-8");
    this.end(JSON.stringify(payload));
    return this;
  };
  res.send = function send(payload) {
    if (Buffer.isBuffer(payload) || typeof payload === "string") this.end(payload);
    else this.json(payload);
    return this;
  };
}

function applySecurityHeaders(res) {
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
}

function queryObject(searchParams) {
  const output = {};
  for (const [key, value] of searchParams) {
    if (Object.hasOwn(output, key)) output[key] = Array.isArray(output[key]) ? [...output[key], value] : [output[key], value];
    else output[key] = value;
  }
  return output;
}

function requestIdentifier(req) {
  const supplied = String(req.headers["x-request-id"] || "").replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 96);
  return supplied || randomUUID();
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function codedError(code, message) { return Object.assign(new Error(message), { code }); }

function safeMessage(error) {
  return String(error instanceof Error ? error.message : error || "Unknown failure").replace(/(authorization|password|secret|token|api.?key|service.?role)\s*[:=]\s*\S+/gi, "$1=[REDACTED]").slice(0, 500);
}

function withTimeout(promise, milliseconds) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(codedError("REQUEST_TIMEOUT", "Black Cloud upstream request timed out.")), milliseconds); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
