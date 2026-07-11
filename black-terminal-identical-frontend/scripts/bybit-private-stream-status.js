import process from "node:process";
import { getSupabaseAdmin } from "../server/portfolio-api.js";
import { statusLine } from "../server/exchanges/bybit-certification.js";

const accountId = process.env.BYBIT_STREAM_ACCOUNT_ID || process.env.BYBIT_CERTIFY_ACCOUNT_ID || "";
const freshMs = Number(process.env.BYBIT_CERTIFY_PRIVATE_STREAM_FRESH_MS || 60_000);

try {
  if (!accountId) {
    console.error(statusLine("FAIL", "account", "BYBIT_STREAM_ACCOUNT_ID or BYBIT_CERTIFY_ACCOUNT_ID is required."));
    process.exit(1);
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("connection_health_snapshots")
    .select("account_id,venue_id,private_stream,authentication,synchronization,reconnect_count,last_error,health,captured_at")
    .eq("account_id", accountId)
    .eq("venue_id", "bybit")
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    console.log(statusLine("FAIL", "private-stream", "No Bybit health snapshot found. Start npm run bybit:private-stream:supervise."));
    process.exit(1);
  }

  const ageMs = Date.now() - new Date(data.captured_at).getTime();
  const connected = data.private_stream === "connected" && data.authentication === "authenticated" && ageMs <= freshMs;

  console.log("Black Terminal Bybit private-stream status\n");
  console.log(statusLine(connected ? "PASS" : "FAIL", "private-stream", `${data.private_stream}/${data.authentication}`));
  console.log(statusLine(ageMs <= freshMs ? "PASS" : "WARNING", "freshness", `${ageMs}ms old`));
  console.log(statusLine(data.synchronization === "stale" ? "WARNING" : "PASS", "sync", data.synchronization || "unknown"));
  console.log(statusLine(data.last_error ? "WARNING" : "PASS", "last-error", data.last_error || "none"));
  console.log(statusLine("PASS", "reconnect-count", String(data.reconnect_count ?? 0)));

  process.exitCode = connected ? 0 : 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(statusLine("FAIL", "private-stream-status", message));
  process.exitCode = 1;
}
