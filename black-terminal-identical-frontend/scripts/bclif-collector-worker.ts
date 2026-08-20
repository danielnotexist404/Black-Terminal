#!/usr/bin/env node
import { createClient } from "@supabase/supabase-js";
import { validateBclifRuntime } from "../server/liquidation-intelligence/collector/runtimeConfig.ts";
import { createBclifNodeIdentity } from "../server/liquidation-intelligence/collector/nodeIdentity.ts";
import { installBclifGracefulShutdown } from "../server/liquidation-intelligence/collector/gracefulShutdown.ts";
import { BclifCollectorWorker } from "../server/liquidation-intelligence/collector/worker.ts";

async function main() {
  const config = validateBclifRuntime();
  const node = createBclifNodeIdentity(config);
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { headers: { "X-Client-Info": `black-terminal-bclif/${config.deploymentCommit}` } }
  });
  const worker = new BclifCollectorWorker(supabase, config, node);
  const shutdown = installBclifGracefulShutdown((signal) => worker.shutdown(signal));
  process.once("uncaughtException", (error) => void shutdown("uncaughtException").finally(() => {
    console.error(JSON.stringify({ level: "CRITICAL", event: "collector.uncaught_exception", error: safeMessage(error) }));
    process.exitCode = 1;
  }));
  process.once("unhandledRejection", (error) => void shutdown("unhandledRejection").finally(() => {
    console.error(JSON.stringify({ level: "CRITICAL", event: "collector.unhandled_rejection", error: safeMessage(error) }));
    process.exitCode = 1;
  }));
  await worker.start();
}

function safeMessage(error: unknown) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
  const message = error instanceof Error
    ? error.message
    : record
      ? [record.code, record.message, record.details, record.hint].filter((value) => typeof value === "string" && value.trim()).join(": ") || "Non-Error object"
      : String(error);
  return message.replace(/(service.?role|token|secret|password|authorization|api.?key)[^\s,]*/gi, "$1=[REDACTED]");
}

main().catch((error) => {
  console.error(JSON.stringify({ level: "CRITICAL", event: "collector.start_failed", error: safeMessage(error) }));
  process.exitCode = 1;
});
