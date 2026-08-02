import { getSupabaseAdmin } from "../server/portfolio-api.js";
import { BlackCloudExecutionWorker } from "../server/cloud-execution/worker.js";
import { sanitizeError } from "../server/cloud-execution/repository.js";
import { createServer } from "node:http";

const worker = new BlackCloudExecutionWorker(getSupabaseAdmin(), {
  nodeId: process.env.BLACK_CLOUD_NODE_ID,
  pollIntervalMs: Number(process.env.BLACK_CLOUD_POLL_INTERVAL_MS || 1_000),
  claimLimit: Number(process.env.BLACK_CLOUD_CLAIM_LIMIT || 10),
  leaseTtlSeconds: Number(process.env.BLACK_CLOUD_LEASE_TTL_SECONDS || 30)
});
const healthPort = Number(process.env.BLACK_CLOUD_HEALTH_PORT || process.env.PORT || 8080);
const healthBindAddress = process.env.BLACK_CLOUD_HEALTH_BIND_ADDRESS || "0.0.0.0";
const metricsPort = Number(process.env.BLACK_CLOUD_METRICS_PORT || healthPort);
const metricsBindAddress = process.env.BLACK_CLOUD_METRICS_BIND_ADDRESS || healthBindAddress;
const sharedMetricsEndpoint = metricsPort === healthPort && metricsBindAddress === healthBindAddress;
const healthServer = createServer(async (req, res) => {
  const path = req.url || "";
  if (path === "/metrics" && sharedMetricsEndpoint) {
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4", "Cache-Control": "no-store" });
    res.end(toPrometheus(worker.diagnostics()));
    return;
  }
  if (!["/live", "/ready", "/health/live", "/health/ready"].includes(path)) { res.writeHead(404).end(); return; }
  const state = worker.diagnostics();
  let readiness = state.readiness;
  const isLive = path.endsWith("/live") || path === "/live";
  if (!isLive) readiness = await worker.readiness().catch((error) => ({ ready: false, error: error.message }));
  const ready = isLive ? state.running : readiness?.ready === true;
  res.writeHead(!isLive && !ready ? 503 : 200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ status: ready ? (isLive ? "live" : "ready") : state.running ? "degraded" : "stopped", ...state, readiness }));
});
const metricsServer = sharedMetricsEndpoint ? null : createServer((req, res) => {
  if ((req.url || "") !== "/metrics") { res.writeHead(404).end(); return; }
  res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4", "Cache-Control": "no-store" });
  res.end(toPrometheus(worker.diagnostics()));
});

function toPrometheus(state) {
  const connections = state.connectionMetrics || {};
  const counters = state.counters || {};
  const gauge = (name, help, value, type = "gauge") => `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${Number(value || 0)}\n`;
  return [
    gauge("black_cloud_worker_up", "Whether the Black Cloud process loop is running.", state.running ? 1 : 0),
    gauge("black_cloud_worker_ready", "Whether all worker dependencies and the loop are ready.", state.operationalReady ? 1 : 0),
    gauge("black_cloud_node_heartbeat_age_ms", "Age of the last successful persistent node heartbeat, or -1 before registration.", state.lastNodeHeartbeatAt ? Date.now() - Date.parse(state.lastNodeHeartbeatAt) : -1),
    gauge("black_cloud_clock_drift_ms", "Absolute estimated drift against the broker public time reference, or -1 when unavailable.", state.clockHealth?.estimatedDriftMs == null ? -1 : Math.abs(Number(state.clockHealth.estimatedDriftMs))),
    gauge("black_cloud_clock_safe", "Whether new signed broker submissions are permitted by the clock gate.", state.clockHealth?.status && state.clockHealth.status !== "UNSAFE" ? 1 : 0),
    gauge("black_cloud_in_flight_commands", "Execution commands currently in flight.", state.inFlightCommands),
    gauge("black_cloud_active_connections", "Persistent broker connections owned by this worker.", connections.activeConnections),
    gauge("black_cloud_ready_connections", "Persistent broker connections reporting ready.", connections.readyConnections),
    gauge("black_cloud_degraded_connections", "Persistent broker connections reporting degraded.", connections.degradedConnections),
    gauge("black_cloud_reconnect_total", "Broker private-stream reconnect attempts.", connections.reconnectCount, "counter"),
    gauge("black_cloud_lease_renewals_total", "Successful connection lease renewals.", connections.leaseRenewals, "counter"),
    gauge("black_cloud_lease_failures_total", "Lease renewal failures or fencing-generation losses.", connections.leaseFailures, "counter"),
    gauge("black_cloud_reconciliation_runs_total", "Account reconciliation runs completed.", connections.reconciliationRuns, "counter"),
    gauge("black_cloud_last_reconciliation_duration_ms", "Duration of the most recent account reconciliation.", connections.reconciliationDurationMs),
    gauge("black_cloud_private_events_total", "Deduplicated private account events observed.", connections.privateEvents, "counter"),
    gauge("black_cloud_order_events_total", "Private order events observed.", connections.orderEvents, "counter"),
    gauge("black_cloud_execution_events_total", "Private execution events observed.", connections.executionEvents, "counter"),
    gauge("black_cloud_oldest_account_stream_age_ms", "Oldest observed account-stream age on this worker.", connections.oldestAccountStreamAgeMs),
    gauge("black_cloud_active_strategies", "Durable strategy deployments visible to this node.", state.readiness?.activeStrategyCount),
    gauge("black_cloud_queue_depth", "Durable execution commands waiting for processing.", state.readiness?.queueDepth),
    gauge("black_cloud_oldest_queue_age_ms", "Age of the oldest waiting execution command.", state.readiness?.oldestQueueAgeMs),
    gauge("black_cloud_commands_claimed_total", "Durable execution commands claimed.", counters.commandsClaimed, "counter"),
    gauge("black_cloud_commands_succeeded_total", "Durable execution commands completed successfully.", counters.commandsSucceeded, "counter"),
    gauge("black_cloud_commands_failed_total", "Durable execution commands that failed.", counters.commandsFailed, "counter"),
    gauge("black_cloud_lease_contention_total", "Connection lease acquisitions rejected because another worker owns the lease.", counters.leaseContention, "counter"),
    gauge("black_cloud_fencing_rejections_total", "Broker mutations rejected by stale fencing ownership.", counters.fencingRejections, "counter"),
    gauge("black_cloud_orders_submitted_total", "External order submissions accepted by the adapter.", counters.ordersSubmitted, "counter"),
    gauge("black_cloud_orders_confirmed_total", "External orders persisted after venue acknowledgement or deterministic recovery.", counters.ordersConfirmed, "counter"),
    gauge("black_cloud_orders_rejected_total", "Place-order commands rejected before confirmation.", counters.ordersRejected, "counter"),
    gauge("black_cloud_unknown_submission_outcomes_total", "Broker submissions requiring reconciliation because acknowledgement was unknown.", counters.unknownSubmissionOutcomes, "counter")
  ].join("");
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log("INFO", "worker_draining", { signal });
  await worker.stop().catch((error) => log("ERROR", "worker_stop_failed", { error: sanitizeError(error.message) }));
  await new Promise((resolve) => healthServer.close(resolve));
  if (metricsServer) await new Promise((resolve) => metricsServer.close(resolve));
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  log("ERROR", "worker_uncaught_exception", { error: sanitizeError(error.message) });
  void shutdown("uncaughtException");
});
process.on("unhandledRejection", (error) => {
  log("ERROR", "worker_unhandled_rejection", { error: sanitizeError(error instanceof Error ? error.message : String(error)) });
});

function log(level, event, fields = {}) {
  const order = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50 };
  const configured = String(process.env.BLACK_CLOUD_LOG_LEVEL || "INFO").toUpperCase();
  if ((order[level] || 20) < (order[configured] || 20)) return;
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, event, nodeId: process.env.BLACK_CLOUD_NODE_ID || null, ...fields }));
}

healthServer.listen(healthPort, healthBindAddress, () => log("INFO", "health_endpoint_listening", { bindAddress: healthBindAddress, port: healthPort }));
if (metricsServer) metricsServer.listen(metricsPort, metricsBindAddress, () => log("INFO", "metrics_endpoint_listening", { bindAddress: metricsBindAddress, port: metricsPort }));
await worker.start();
