import { getSupabaseAdmin } from "../server/portfolio-api.js";
import { EventAlphaWorker } from "../server/event-alpha/worker.js";

const controller = new AbortController();
for (const signalName of ["SIGINT", "SIGTERM"]) process.once(signalName, () => controller.abort());

const worker = new EventAlphaWorker({ supabase: getSupabaseAdmin() });
worker.start({ signal: controller.signal }).catch((error) => {
  console.error("[event-alpha-worker-fatal]", { code: error.code || "EVENT_ALPHA_WORKER_FATAL", message: error.message });
  process.exitCode = 1;
});
