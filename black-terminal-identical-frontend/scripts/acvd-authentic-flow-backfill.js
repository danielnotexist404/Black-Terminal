import { getSupabaseAdmin } from "../server/portfolio-api.js";
import { backfillAuthenticCvdCache } from "../server/market-flow/authenticCvdService.js";

const symbol = String(process.argv[2] || "BTCUSDT").toUpperCase();
if (!/^[A-Z0-9_-]{2,40}$/.test(symbol)) throw new Error("Invalid backfill symbol");

let lastReported = 0;
const result = await backfillAuthenticCvdCache(
  getSupabaseAdmin(),
  getSupabaseAdmin({ storageCompatible: true }),
  {
    symbol,
    onProgress(progress) {
      if (progress.materialized - lastReported < 100 && progress.materialized !== progress.total) return;
      lastReported = progress.materialized;
      console.log(JSON.stringify({ event: "acvd_flow_backfill_progress", symbol, materialized: progress.materialized, discovered: progress.total }));
    }
  }
);

console.log(JSON.stringify({ event: "acvd_flow_backfill_complete", symbol, discovered: result.chunks, materialized: result.materialized }));
