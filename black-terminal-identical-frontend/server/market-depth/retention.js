const defaultPolicy = {
  rawHours: Number(process.env.MARKET_DEPTH_RETENTION_RAW_HOURS || 6),
  deltaHours: Number(process.env.MARKET_DEPTH_RETENTION_DELTA_HOURS || 6),
  secondDays: Number(process.env.MARKET_DEPTH_RETENTION_1S_DAYS || 3),
  tenSecondDays: Number(process.env.MARKET_DEPTH_RETENTION_10S_DAYS || 21),
  minuteDays: Number(process.env.MARKET_DEPTH_RETENTION_1M_DAYS || 180)
};

export async function pruneMarketDepthMemory(supabase, policy = defaultPolicy) {
  const now = Date.now();
  const results = [];
  results.push(await pruneBefore(supabase, "market_depth_snapshots", "captured_at", now - hours(policy.rawHours), "raw snapshots"));
  results.push(await pruneBefore(supabase, "market_depth_deltas", "captured_at", now - hours(policy.deltaHours), "raw deltas"));
  results.push(await pruneRollups(supabase, "1s", now - days(policy.secondDays)));
  results.push(await pruneRollups(supabase, "10s", now - days(policy.tenSecondDays)));
  results.push(await pruneRollups(supabase, "1m", now - days(policy.minuteDays)));
  results.push(await pruneStatistics(supabase, "1s", now - days(policy.secondDays)));
  results.push(await pruneStatistics(supabase, "10s", now - days(policy.tenSecondDays)));
  results.push(await pruneStatistics(supabase, "1m", now - days(policy.minuteDays)));

  return {
    status: "ok",
    source: "black-core-market-depth-memory",
    prunedAt: new Date(now).toISOString(),
    policy,
    results
  };
}

async function pruneBefore(supabase, table, column, cutoffMs, label) {
  const { count, error } = await supabase
    .from(table)
    .delete({ count: "exact" })
    .lt(column, new Date(cutoffMs).toISOString());
  if (error) throw error;
  return { table, label, deleted: count ?? 0, cutoff: new Date(cutoffMs).toISOString() };
}

async function pruneRollups(supabase, resolution, cutoffMs) {
  let builder = supabase
    .from("market_depth_rollups")
    .delete({ count: "exact" })
    .eq("resolution", resolution)
    .lt("bucket_start", new Date(cutoffMs).toISOString());
  const { count, error } = await builder;
  if (error) throw error;
  return { table: "market_depth_rollups", label: `${resolution} rollups`, deleted: count ?? 0, cutoff: new Date(cutoffMs).toISOString() };
}

async function pruneStatistics(supabase, resolution, cutoffMs) {
  const { count, error } = await supabase
    .from("market_depth_statistics")
    .delete({ count: "exact" })
    .eq("resolution", resolution)
    .lt("bucket_start", new Date(cutoffMs).toISOString());
  if (error) throw error;
  return { table: "market_depth_statistics", label: `${resolution} statistics`, deleted: count ?? 0, cutoff: new Date(cutoffMs).toISOString() };
}

function hours(value) {
  return Math.max(1, Number(value) || 1) * 60 * 60 * 1000;
}

function days(value) {
  return Math.max(1, Number(value) || 1) * 24 * 60 * 60 * 1000;
}
