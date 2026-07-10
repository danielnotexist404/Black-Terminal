import { getSupabaseAdmin } from "../server/portfolio-api.js";
import { MarketDepthCollector, parseEnvSymbols } from "../server/market-depth/collector.js";
import { upsertCollectorHeartbeat } from "../server/market-depth/collector-status.js";
import { pruneMarketDepthMemory } from "../server/market-depth/retention.js";
import os from "node:os";

const supabase = getSupabaseAdmin();
const symbols = parseEnvSymbols();
const collectorId = process.env.MARKET_DEPTH_COLLECTOR_ID || `${os.hostname()}:${process.pid}`;
const fatalStaleMs = Math.max(0, Number(process.env.MARKET_DEPTH_FATAL_STALE_MS || 10 * 60_000));
const startupGraceMs = Math.max(30_000, Number(process.env.MARKET_DEPTH_STARTUP_GRACE_MS || 2 * 60_000));
const heartbeatIntervalMs = Math.max(5_000, Math.min(15_000, Number(process.env.MARKET_DEPTH_HEARTBEAT_INTERVAL_MS || 10_000)));
const startedAt = Date.now();
let lastHealthyAt = Date.now();
const collector = new MarketDepthCollector({ supabase, symbols });

collector.start();

console.log("[MarketDepthWorker] Black Core Market Depth Memory collector started.");
console.log("[MarketDepthWorker] Symbols:", symbols.join(", "));

function publishHeartbeat() {
  const diagnostics = collector.diagnostics();
  console.log("[MarketDepthWorker] diagnostics", JSON.stringify(diagnostics));
  updateRuntimeHealth(diagnostics);
  upsertCollectorHeartbeat(supabase, collectorId, diagnostics).catch((error) => {
    console.error("[MarketDepthWorker] heartbeat failed", error);
  });
}

function updateRuntimeHealth(diagnostics) {
  if (fatalStaleMs <= 0 || diagnostics.length === 0) return;
  const now = Date.now();
  const anyFresh = diagnostics.some((item) => {
    const lastMessageAt = Number(item.lastMessageAt);
    return item.status === "open" && Number.isFinite(lastMessageAt) && now - lastMessageAt <= fatalStaleMs;
  });
  if (anyFresh || now - startedAt < startupGraceMs) {
    lastHealthyAt = now;
    return;
  }
  if (now - lastHealthyAt <= fatalStaleMs) return;
  console.error(`[MarketDepthWorker] all collector sessions stale for more than ${fatalStaleMs}ms; exiting for supervisor restart.`);
  collector.stop();
  process.exit(1);
}

publishHeartbeat();
setInterval(publishHeartbeat, heartbeatIntervalMs).unref?.();

const pruneIntervalMs = Math.max(5 * 60_000, Number(process.env.MARKET_DEPTH_PRUNE_INTERVAL_MS || 60 * 60_000));
setInterval(async () => {
  try {
    const result = await pruneMarketDepthMemory(supabase);
    console.log("[MarketDepthWorker] retention", JSON.stringify(result.results));
  } catch (error) {
    console.error("[MarketDepthWorker] retention failed", error);
  }
}, pruneIntervalMs).unref?.();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[MarketDepthWorker] received ${signal}, shutting down.`);
    collector.stop();
    process.exit(0);
  });
}
