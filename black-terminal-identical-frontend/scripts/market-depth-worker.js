import { getSupabaseAdmin } from "../server/portfolio-api.js";
import { MarketDepthCollector, parseEnvSymbols } from "../server/market-depth/collector.js";

const supabase = getSupabaseAdmin();
const symbols = parseEnvSymbols();
const collector = new MarketDepthCollector({ supabase, symbols });

collector.start();

console.log("[MarketDepthWorker] Black Core Market Depth Memory collector started.");
console.log("[MarketDepthWorker] Symbols:", symbols.join(", "));

setInterval(() => {
  console.log("[MarketDepthWorker] diagnostics", JSON.stringify(collector.diagnostics()));
}, 30_000).unref?.();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[MarketDepthWorker] received ${signal}, shutting down.`);
    collector.stop();
    process.exit(0);
  });
}
