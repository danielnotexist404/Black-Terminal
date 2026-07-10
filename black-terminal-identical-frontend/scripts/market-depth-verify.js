import { getSupabaseAdmin } from "../server/portfolio-api.js";
import { getIMMSystemStatus } from "../server/imm/status-service.js";

const supabase = getSupabaseAdmin();
const freshnessMs = Math.max(60_000, Number(process.env.MARKET_DEPTH_VERIFY_FRESHNESS_MS || 15 * 60_000));
const minRollups = Math.max(1, Number(process.env.MARKET_DEPTH_VERIFY_MIN_ROLLUPS || 5));
const horizons = ["15m", "1h", "6h", "24h", "3d", "1w"];

const checks = [];

await runCheck("imm_status_available", async () => {
  const status = await getIMMSystemStatus(supabase);
  return {
    ok: !["error", "misconfigured", "unavailable"].includes(status.overallStatus),
    detail: `${status.overallStatus} ${status.currentVenue || "-"}:${status.currentSymbol || "-"}`
  };
});

await runCheck("recent_rollups_exist", async () => {
  const { data, error } = await supabase
    .from("market_depth_rollups")
    .select("venue,market_kind,symbol,bucket_start,price_bucket,bid_size,ask_size,resolution")
    .order("bucket_start", { ascending: false })
    .limit(500);
  if (error) throw error;
  const newest = data?.[0] ? Date.parse(data[0].bucket_start) : null;
  const fresh = newest ? Date.now() - newest <= freshnessMs : false;
  return {
    ok: (data?.length || 0) >= minRollups && fresh,
    detail: `${data?.length || 0} rows, newest=${newest ? new Date(newest).toISOString() : "none"}`
  };
});

await runCheck("bid_ask_rows_exist", async () => {
  const { data, error } = await supabase
    .from("market_depth_rollups")
    .select("bid_size,ask_size")
    .order("bucket_start", { ascending: false })
    .limit(1000);
  if (error) throw error;
  const bidRows = (data || []).filter((row) => Number(row.bid_size) > 0).length;
  const askRows = (data || []).filter((row) => Number(row.ask_size) > 0).length;
  return { ok: bidRows > 0 && askRows > 0, detail: `${bidRows} bid rows / ${askRows} ask rows` };
});

await runCheck("no_impossible_rollup_values", async () => {
  const { data, error } = await supabase
    .from("market_depth_rollups")
    .select("price_bucket,bucket_size,bid_size,ask_size,bid_peak_size,ask_peak_size")
    .order("bucket_start", { ascending: false })
    .limit(1000);
  if (error) throw error;
  const bad = (data || []).filter((row) =>
    Number(row.price_bucket) <= 0 ||
    Number(row.bucket_size) <= 0 ||
    Number(row.bid_size) < 0 ||
    Number(row.ask_size) < 0 ||
    Number(row.bid_peak_size) < 0 ||
    Number(row.ask_peak_size) < 0
  );
  return { ok: bad.length === 0, detail: `${bad.length} impossible rows` };
});

await runCheck("expected_resolutions_exist", async () => {
  const { data, error } = await supabase
    .from("market_depth_rollups")
    .select("resolution")
    .order("bucket_start", { ascending: false })
    .limit(2000);
  if (error) throw error;
  const resolutions = new Set((data || []).map((row) => row.resolution));
  const present = ["1s", "10s", "1m"].filter((resolution) => resolutions.has(resolution));
  return { ok: present.length >= 1, detail: `present=${present.join(",") || "none"}` };
});

await runCheck("walls_are_symmetric_when_present", async () => {
  const { data, error } = await supabase
    .from("market_liquidity_walls")
    .select("side,status,last_seen_at")
    .in("status", ["ACTIVE", "GROWING", "WEAKENING", "MIGRATING", "SPOOF_SUSPECTED"])
    .order("last_seen_at", { ascending: false })
    .limit(250);
  if (error) throw error;
  const buy = (data || []).filter((row) => row.side === "buy").length;
  const sell = (data || []).filter((row) => row.side === "sell").length;
  return { ok: data?.length ? buy > 0 && sell > 0 : true, detail: `${buy} buy / ${sell} sell active walls` };
});

await runCheck("worker_heartbeat_seen", async () => {
  const { data, error } = await supabase
    .from("imm_worker_heartbeats")
    .select("worker_instance_id,heartbeat_at,status")
    .order("heartbeat_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const heartbeatAt = data?.[0]?.heartbeat_at ? Date.parse(data[0].heartbeat_at) : null;
  const fresh = heartbeatAt ? Date.now() - heartbeatAt <= freshnessMs : false;
  return { ok: fresh, detail: data?.[0] ? `${data[0].status} ${data[0].heartbeat_at}` : "none" };
});

await runCheck("replay_windows_bounded", async () => {
  const details = [];
  for (const horizon of horizons) {
    const { data, error } = await supabase
      .from("market_depth_rollups")
      .select("bucket_start,resolution,price_bucket,bid_size,ask_size")
      .gte("bucket_start", new Date(Date.now() - horizonMs(horizon)).toISOString())
      .order("bucket_start", { ascending: false })
      .limit(3000);
    if (error) throw error;
    const hasBid = (data || []).some((row) => Number(row.bid_size) > 0);
    const hasAsk = (data || []).some((row) => Number(row.ask_size) > 0);
    details.push(`${horizon}:${data?.length || 0}:${hasBid && hasAsk ? "bidask" : "partial"}`);
  }
  const ok = details.some((detail) => detail.includes("bidask"));
  return { ok, detail: details.join(" | ") };
});

const failed = checks.filter((check) => !check.ok);
for (const check of checks) {
  console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name} - ${check.detail}`);
}

if (failed.length) {
  console.error(`IMM verification failed: ${failed.length}/${checks.length} checks failed.`);
  process.exit(1);
}

console.log(`IMM verification passed: ${checks.length}/${checks.length} checks.`);

async function runCheck(name, fn) {
  try {
    const result = await fn();
    checks.push({ name, ok: Boolean(result.ok), detail: result.detail || "" });
  } catch (error) {
    checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

function horizonMs(horizon) {
  switch (horizon) {
    case "15m": return 15 * 60_000;
    case "1h": return 60 * 60_000;
    case "6h": return 6 * 60 * 60_000;
    case "24h": return 24 * 60 * 60_000;
    case "3d": return 3 * 24 * 60 * 60_000;
    case "1w": return 7 * 24 * 60 * 60_000;
    default: return 24 * 60 * 60_000;
  }
}
