import { getSupabaseAdmin } from "../server/portfolio-api.js";
import { BlackCloudExecutionWorker } from "../server/cloud-execution/worker.js";
import { createServer } from "node:http";

const worker = new BlackCloudExecutionWorker(getSupabaseAdmin(), {
  workerId: process.env.BLACK_CLOUD_WORKER_ID,
  pollIntervalMs: Number(process.env.BLACK_CLOUD_POLL_INTERVAL_MS || 1_000),
  claimLimit: Number(process.env.BLACK_CLOUD_CLAIM_LIMIT || 10),
  leaseTtlSeconds: Number(process.env.BLACK_CLOUD_LEASE_TTL_SECONDS || 30)
});
const healthPort = Number(process.env.BLACK_CLOUD_HEALTH_PORT || process.env.PORT || 8080);
const healthServer = createServer(async (req, res) => {
  const path = req.url || "";
  if (path === "/metrics") {
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

function toPrometheus(state) {
  const connections = state.connectionMetrics || {};
  const counters = state.counters || {};
  const gauge = (name, help, value, type = "gauge") => `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${Number(value || 0)}\n`;
  return [
    gauge("black_cloud_worker_up", "Whether the Black Cloud process loop is running.", state.running ? 1 : 0),
    gauge("black_cloud_worker_ready", "Whether all worker dependencies and the loop are ready.", state.readiness?.ready ? 1 : 0),
    gauge("black_cloud_in_flight_commands", "Execution commands currently in flight.", state.inFlightCommands),
    gauge("black_cloud_active_connections", "Persistent broker connections owned by this worker.", connections.activeConnections),
    gauge("black_cloud_ready_connections", "Persistent broker connections reporting ready.", connections.readyConnections),
    gauge("black_cloud_degraded_connections", "Persistent broker connections reporting degraded.", connections.degradedConnections),
    gauge("black_cloud_reconnect_total", "Broker private-stream reconnect attempts.", connections.reconnectCount, "counter"),
    gauge("black_cloud_oldest_account_stream_age_ms", "Oldest observed account-stream age on this worker.", connections.oldestAccountStreamAgeMs),
    gauge("black_cloud_commands_claimed_total", "Durable execution commands claimed.", counters.commandsClaimed, "counter"),
    gauge("black_cloud_commands_succeeded_total", "Durable execution commands completed successfully.", counters.commandsSucceeded, "counter"),
    gauge("black_cloud_commands_failed_total", "Durable execution commands that failed.", counters.commandsFailed, "counter"),
    gauge("black_cloud_lease_contention_total", "Connection lease acquisitions rejected because another worker owns the lease.", counters.leaseContention, "counter"),
    gauge("black_cloud_unknown_submission_outcomes_total", "Broker submissions requiring reconciliation because acknowledgement was unknown.", counters.unknownSubmissionOutcomes, "counter")
  ].join("");
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[black-cloud-worker] ${signal} received; draining in-flight commands.`);
  await worker.stop().catch((error) => console.error("[black-cloud-worker-stop]", error.message));
  await new Promise((resolve) => healthServer.close(resolve));
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  console.error("[black-cloud-worker-uncaught]", error.message);
  void shutdown("uncaughtException");
});
process.on("unhandledRejection", (error) => {
  console.error("[black-cloud-worker-rejection]", error instanceof Error ? error.message : String(error));
});

healthServer.listen(healthPort, "0.0.0.0", () => console.log(`[black-cloud-worker] health endpoint listening on ${healthPort}`));
await worker.start();
