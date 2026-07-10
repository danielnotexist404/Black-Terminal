import { getSupabaseAdmin } from "../server/portfolio-api.js";
import { MarketDepthCollector, parseEnvSymbols } from "../server/market-depth/collector.js";
import { pruneMarketDepthMemory } from "../server/market-depth/retention.js";

const supabase = getSupabaseAdmin();
const symbols = parseEnvSymbols();
const collector = new MarketDepthCollector({ supabase, symbols });

collector.start();

console.log("[MarketDepthWorker] Black Core Market Depth Memory collector started.");
console.log("[MarketDepthWorker] Symbols:", symbols.join(", "));

setInterval(() => {
  console.log("[MarketDepthWorker] diagnostics", JSON.stringify(collector.diagnostics()));
}, 30_000).unref?.();

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
