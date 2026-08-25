import { getSupabaseAdmin } from "../server/portfolio-api.js";
import { backfillBybitPublicTradeArchives } from "../server/market-flow/bybitPublicTradeArchive.js";

const options = parseArguments(process.argv.slice(2));
const result = await backfillBybitPublicTradeArchives(getSupabaseAdmin(), {
  ...options,
  onProgress(progress) {
    console.log(JSON.stringify({ event: "acvd_bybit_public_archive_progress", ...progress }));
  }
});
console.log(JSON.stringify({ event: "acvd_bybit_public_archive_complete", ...result, results: undefined }));

function parseArguments(args) {
  const options = { symbol: "BTCUSDT", days: 14 };
  for (const argument of args) {
    const [key, rawValue] = String(argument).split("=", 2);
    if (key === "--symbol") options.symbol = String(rawValue || "").toUpperCase();
    else if (key === "--days") options.days = Number(rawValue);
    else if (key === "--start") options.startDate = rawValue;
    else if (key === "--end") options.endDate = rawValue;
    else throw new Error(`Unsupported argument: ${key}`);
  }
  if (!/^[A-Z0-9_-]{2,40}$/.test(options.symbol) || !(Number.isInteger(options.days) && options.days >= 1 && options.days <= 3_000)) throw new Error("Invalid Bybit public archive backfill arguments");
  return options;
}
