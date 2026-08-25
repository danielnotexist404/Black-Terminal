import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(new URL("../supabase/migrations/20260825184500_acvd_bybit_public_trade_archive.sql", import.meta.url), "utf8");
const db = new PGlite();
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create or replace function public.bclif_reject_immutable_change()
  returns trigger language plpgsql set search_path=public as $$
  begin raise exception 'BCLIF published records are immutable' using errcode='55000'; end;
  $$;
`);
await db.exec(migration);

const archiveDate = "2026-08-24";
const start = Date.parse(`${archiveDate}T00:00:00.000Z`);
const sha = "a".repeat(64);
const minutes = Array.from({ length: 1440 }, (_, index) => ({
  interval_start: new Date(start + index * 60_000).toISOString(),
  buy_volume: index === 0 ? 2 : 0,
  sell_volume: index === 1 ? 3 : 0,
  buy_notional: index === 0 ? 200 : 0,
  sell_notional: index === 1 ? 303 : 0,
  exact_trade_count: index < 2 ? 1 : 0,
  total_trade_count: index < 2 ? 1 : 0
}));
const manifest = {
  symbol: "BTCUSDT",
  archiveDate,
  sourceUrl: `https://public.bybit.com/trading/BTCUSDT/BTCUSDT${archiveDate}.csv.gz`,
  sourceEtag: "test-etag",
  sourceSha256: sha,
  compressedBytes: 100,
  uncompressedBytes: 1_000,
  exactTradeCount: 2,
  firstTradeAt: new Date(start + 1_000).toISOString(),
  lastTradeAt: new Date(start + 61_000).toISOString()
};

const committed = await db.query("select public.acvd_commit_bybit_public_trade_day($1::jsonb,$2::jsonb) as result", [JSON.stringify(manifest), JSON.stringify(minutes)]);
assert.equal(committed.rows[0].result.status, "inserted");
assert.equal((await db.query("select count(*)::int as count from public.acvd_bybit_public_trade_minutes")).rows[0].count, 1440);
assert.equal((await db.query("select count(*)::int as count from public.acvd_bybit_public_trade_days")).rows[0].count, 1);

const bars = await db.query("select * from public.acvd_read_bybit_public_trade_bars('BTCUSDT',14400,$1,$2)", [start / 1000, start / 1000 + 86_400]);
assert.equal(bars.rows.length, 6, "one official UTC day yields six uninterrupted 4H bars");
assert.ok(bars.rows.every((bar) => bar.delivery_complete), "every 4H bar has all 240 exact minute authorities");
assert.equal(Number(bars.rows[0].buy_volume), 2);
assert.equal(Number(bars.rows[0].sell_volume), 3);
assert.equal(Number(bars.rows[0].minute_count), 240);

const replay = await db.query("select public.acvd_commit_bybit_public_trade_day($1::jsonb,$2::jsonb) as result", [JSON.stringify(manifest), JSON.stringify(minutes)]);
assert.equal(replay.rows[0].result.status, "existing", "archive commit is idempotent by symbol/day/checksum");
await assert.rejects(
  () => db.query("select public.acvd_commit_bybit_public_trade_day($1::jsonb,$2::jsonb)", [JSON.stringify({ ...manifest, sourceSha256: "b".repeat(64) }), JSON.stringify(minutes)]),
  /checksum changed/i
);
await assert.rejects(
  () => db.query("select public.acvd_commit_bybit_public_trade_day($1::jsonb,$2::jsonb)", [JSON.stringify({ ...manifest, archiveDate: "2026-08-23", sourceUrl: "https://public.bybit.com/trading/BTCUSDT/BTCUSDT2026-08-23.csv.gz", firstTradeAt: "2026-08-23T00:00:01Z", lastTradeAt: "2026-08-23T00:01:01Z" }), JSON.stringify(minutes.slice(1))]),
  /1,440|1440|every UTC minute|Invalid/i
);
await assert.rejects(() => db.query("update public.acvd_bybit_public_trade_minutes set buy_volume=999 where interval_start=$1", [new Date(start).toISOString()]), /immutable/i);

await db.exec("set role anon");
await assert.rejects(() => db.query("select * from public.acvd_bybit_public_trade_days"), /permission denied/i);
await assert.rejects(() => db.query("select * from public.acvd_read_bybit_public_trade_bars('BTCUSDT',60,$1,$2)", [start / 1000, start / 1000 + 60]), /permission denied/i);
await db.exec("reset role");
await db.close();
console.log("ACVD official Bybit archive PostgreSQL tests passed (atomic 1,440-minute commit, 4H continuity, idempotency, checksum conflict, immutability, RLS).");
