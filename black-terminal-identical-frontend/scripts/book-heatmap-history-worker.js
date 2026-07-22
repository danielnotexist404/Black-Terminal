import os from "node:os";
import { getSupabaseAdmin } from "../server/portfolio-api.js";
import { HistoricalLiquidityCollector } from "../server/book-heatmap/historical-liquidity-collector.js";
import { upsertCollectorHeartbeat } from "../server/market-depth/collector-status.js";

const supabase = getSupabaseAdmin();
const symbol = String(process.env.BOOK_HEATMAP_SYMBOL || "BTCUSDT").toUpperCase().replace(/[^A-Z0-9]/g, "");
const collectorId = process.env.BOOK_HEATMAP_COLLECTOR_ID || `book-heatmap:${os.hostname()}:${process.pid}`;
const collector = new HistoricalLiquidityCollector({ supabase, symbol });
collector.start();

async function heartbeat() {
  const diagnostics = [collector.diagnostics()];
  console.log("[BookHeatmapWorker]", JSON.stringify(diagnostics[0]));
  await upsertCollectorHeartbeat(supabase, collectorId, diagnostics).catch((error) => {
    console.error("[BookHeatmapWorker] heartbeat failed", error);
  });
}

void heartbeat();
setInterval(() => void heartbeat(), 10_000).unref?.();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    collector.stop();
    process.exit(0);
  });
}
