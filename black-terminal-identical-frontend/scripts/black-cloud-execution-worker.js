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
const healthServer = createServer((req, res) => {
  if (!["/live", "/ready"].includes(req.url || "")) { res.writeHead(404).end(); return; }
  const state = worker.diagnostics();
  const ready = state.running && Boolean(state.lastTickAt) && !state.lastLoopError;
  res.writeHead(req.url === "/ready" && !ready ? 503 : 200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ status: ready ? "ready" : state.running ? "degraded" : "stopped", ...state }));
});

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
