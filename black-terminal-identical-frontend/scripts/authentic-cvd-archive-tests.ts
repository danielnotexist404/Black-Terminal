import assert from "node:assert/strict";
import crypto from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateCachedFlowBars, decodeVerifiedTradeChunk, mergeAuthoritativeFlowBars, parseAuthenticCvdQuery, readOfficialArchiveBars } from "../server/market-flow/authenticCvdService.js";
import { buildBybitPublicTradeArchiveUrl, parseDownloadedArchive } from "../server/market-flow/bybitPublicTradeArchive.js";
import { authenticFlowRevision, mergePersistentAndLiveFlow } from "../src/modules/acvd/data/flowMerge.ts";
import type { AuthenticFlowBarInput } from "../src/modules/acvd/core/types.ts";

const source = { id: "00000000-0000-4000-8000-000000000001", symbol: "BTCUSDT", state: "LIVE", continuity_state: "DERIVED", trade_continuity_state: "OBSERVED", source_cutoff_at: new Date(1_800_180_000_000).toISOString(), trade_cutoff_at: new Date(1_800_180_000_000).toISOString() };
const events = [
  event("buy-1", 1_800_000_005_000, "BUY", 2, 100),
  event("sell-1", 1_800_000_015_000, "SELL", 1, 101),
  event("buy-2", 1_800_000_065_000, "BUY", 3, 102)
];
const raw = Buffer.from(`${events.map((value) => JSON.stringify(value)).join("\n")}\n`);
const compressed = new Uint8Array(gzipSync(raw));
const checksum = `sha256:${crypto.createHash("sha256").update(compressed).digest("hex")}`;
const chunk = { id: "00000000-0000-4000-8000-000000000002", source_id: source.id, event_kind: "TRADE", bucket_id: "bclif-field-chunks", object_path: `events/v1/BYBIT/linear_perpetual/BTCUSDT/TRADE/1800000000000/00000000-0000-4000-8000-000000000002-${checksum.slice(7)}.events.gz`, checksum };

assert.deepEqual(parseAuthenticCvdQuery({ venue: "bybit", symbol: "btcusdt", timeframeSeconds: "60", start: "1800000000", end: "1800000120" }), { venue: "BYBIT", symbol: "BTCUSDT", timeframeSeconds: 60, start: 1_800_000_000, end: 1_800_000_120 });
assert.throws(() => parseAuthenticCvdQuery({ venue: "binance", symbol: "BTCUSDT", timeframeSeconds: 60, start: 1, end: 61 }), /Bybit only/);
assert.throws(() => parseAuthenticCvdQuery({ venue: "BYBIT", symbol: "BTCUSDT", timeframeSeconds: 30, start: 1, end: 61 }), /Unsupported/);

const rows = decodeVerifiedTradeChunk(compressed, chunk, source);
assert.equal(rows.length, 2);
assert.equal(rows[0]!.buy_volume, 2);
assert.equal(rows[0]!.sell_volume, 1);
assert.equal(rows[0]!.buy_notional, 200);
assert.equal(rows[0]!.sell_notional, 101);
assert.equal(rows[0]!.exact_trade_count, 2);
assert.throws(() => decodeVerifiedTradeChunk(new Uint8Array([...compressed, 0]), chunk, source), /checksum mismatch/);

const cached = rows.map((row) => ({ ...row, interval_start: row.interval_start }));
const bars = aggregateCachedFlowBars(cached, { venue: "BYBIT", symbol: "BTCUSDT", timeframeSeconds: 120, start: 1_800_000_000, end: 1_800_000_120 }, source);
assert.equal(bars.length, 1);
assert.equal(bars[0]!.deliveryComplete, true);
assert.equal(bars[0]!.buyVolume, 5);
assert.equal(bars[0]!.sellVolume, 1);
assert.equal(bars[0]!.exactTradeCount, 3);
const incomplete = aggregateCachedFlowBars(cached.slice(0, 1), { venue: "BYBIT", symbol: "BTCUSDT", timeframeSeconds: 120, start: 1_800_000_000, end: 1_800_000_120 }, source);
assert.equal(incomplete[0]!.deliveryComplete, false, "missing one-minute archive coverage fails closed");

const official = [{ ...bars[0]!, authority: "BYBIT_OFFICIAL_PUBLIC_ARCHIVE" }];
const overlappingBclif = [{ ...bars[0]!, buyVolume: 999, authority: "BCLIF_CANONICAL_TRADE_CHUNKS" }];
assert.equal(mergeAuthoritativeFlowBars(official, overlappingBclif)[0]!.buyVolume, 5, "official completed history cannot be double counted with overlapping BCLIF chunks");
assert.equal(mergeAuthoritativeFlowBars([{ ...official[0]!, deliveryComplete: false }], overlappingBclif)[0]!.buyVolume, 999, "a completed BCLIF bar replaces an incomplete official bucket");

const pagedRows = Array.from({ length: 2_505 }, (_, index) => ({
  time: 1_700_000_000 + index * 300,
  buy_volume: 10,
  sell_volume: 9,
  buy_notional: 1_000,
  sell_notional: 900,
  exact_trade_count: 2,
  total_trade_count: 2,
  minute_count: 5,
  delivery_complete: true
}));
let pageCalls = 0;
const pagedRpc = {
  rpc: () => ({
    range: async (from: number, to: number) => {
      pageCalls += 1;
      return { data: pagedRows.slice(from, to + 1), error: null };
    }
  })
};
const pagedOfficial = await readOfficialArchiveBars(pagedRpc, { venue: "BYBIT", symbol: "BTCUSDT", timeframeSeconds: 300, start: 1_700_000_000, end: 1_700_751_500 });
assert.equal(pagedOfficial.length, 2_505, "official archive reads past the PostgREST 1,000-row response ceiling");
assert.equal(pageCalls, 3, "official archive pagination stops after the terminal partial page");
assert.equal(pagedOfficial.at(-1)?.time, pagedRows.at(-1)?.time);

assert.equal(buildBybitPublicTradeArchiveUrl("btcusdt", "2026-08-24"), "https://public.bybit.com/trading/BTCUSDT/BTCUSDT2026-08-24.csv.gz");
assert.throws(() => buildBybitPublicTradeArchiveUrl("BTC/USDT", "2026-08-24"), /Invalid/);
const archiveRoot = await mkdtemp(join(tmpdir(), "acvd-public-archive-test-"));
try {
  const archivePath = join(archiveRoot, "BTCUSDT2026-08-24.csv.gz");
  const csv = [
    "timestamp,symbol,side,size,price,tickDirection,trdMatchID,grossValue,homeNotional,foreignNotional,RPI",
    "1787529600.1947,BTCUSDT,Buy,0.002,77712.60,ZeroPlusTick,buy-1,0,0.002,155.4252,0",
    "1787529660.2500,BTCUSDT,Sell,0.003,77700.00,MinusTick,sell-1,0,0.003,233.1,0",
    "1787615999.9000,BTCUSDT,Buy,0.001,78000.00,PlusTick,buy-2,0,0.001,78,0",
    ""
  ].join("\n");
  writeFileSync(archivePath, gzipSync(csv), { mode: 0o600 });
  const parsedArchive = await parseDownloadedArchive(archivePath, { symbol: "BTCUSDT", archiveDate: "2026-08-24" });
  assert.equal(parsedArchive.minutes.length, 1440, "a completed official day certifies every UTC minute, including genuine zero-trade minutes");
  assert.equal(parsedArchive.exactTradeCount, 3);
  assert.equal(parsedArchive.minutes[0]!.buy_volume, 0.002);
  assert.equal(parsedArchive.minutes[1]!.sell_volume, 0.003);
  assert.equal(parsedArchive.minutes[1439]!.buy_notional, 78);
  assert.equal(parsedArchive.minutes[2]!.total_trade_count, 0);
} finally {
  await rm(archiveRoot, { recursive: true, force: true });
}

const archived: AuthenticFlowBarInput = { time: 1_800_000_000, buyVolume: 5, sellVolume: 1, unknownVolume: 0, buyNotional: 506, sellNotional: 101, unknownNotional: 0, exactTradeCount: 3, totalTradeCount: 3, deliveryComplete: true };
const live: AuthenticFlowBarInput = { ...archived, buyVolume: 999, buyNotional: 999, exactTradeCount: 99 };
const merged = mergePersistentAndLiveFlow([archived.time], { version: 1, authority: "EXACT_AGGRESSOR_TRADES", venue: "BYBIT", symbol: "BTCUSDT", timeframeSeconds: 120, bars: [archived], coverage: { completeBars: 1, pendingChunks: 0, availableStart: archived.time, availableEnd: archived.time }, warning: null }, [live]);
assert.equal(merged[0]!.buyVolume, 5, "verified archive wins over overlapping session capture and cannot double count");
const olderChanged = [{ ...archived, time: archived.time - 120 }, archived];
const sameTailDifferentHistory = [{ ...olderChanged[0]!, buyNotional: olderChanged[0]!.buyNotional + 1 }, archived];
assert.notEqual(authenticFlowRevision(olderChanged), authenticFlowRevision(sameTailDifferentHistory), "an older archive update invalidates the ACVD calculation even when the last bar is unchanged");

const handler = readFileSync(new URL("../api/market-flow/[action].js", import.meta.url), "utf8");
assert.match(handler, /requireApiSecurity/);
assert.match(handler, /indicator:\s*"acvdOscillator"/);
assert.doesNotMatch(handler, /placeOrder|cancelOrder|modifyOrder|execution_commands/i);
const migration = readFileSync(new URL("../supabase/migrations/20260825143000_acvd_authentic_flow_cache.sql", import.meta.url), "utf8");
assert.match(migration, /enable row level security/i);
assert.match(migration, /bclif_reject_immutable_change/);
assert.match(migration, /revoke all.*anon, authenticated/i);
const publicArchiveMigration = readFileSync(new URL("../supabase/migrations/20260825184500_acvd_bybit_public_trade_archive.sql", import.meta.url), "utf8");
assert.match(publicArchiveMigration, /acvd_commit_bybit_public_trade_day/i);
assert.match(publicArchiveMigration, /jsonb_array_length\(p_minutes\) <> 1440/i);
assert.match(publicArchiveMigration, /count\(distinct.*interval_start/i);
assert.match(publicArchiveMigration, /acvd_read_bybit_public_trade_bars/i);
assert.match(publicArchiveMigration, /enable row level security/gi);
assert.match(publicArchiveMigration, /revoke all.*anon, authenticated/gi);
assert.doesNotMatch(publicArchiveMigration, /grant (?:select|insert|update|delete).*authenticated/i);

console.log("Authentic CVD archive tests passed (checksum, official archive parsing, exact side aggregation, gap fail-closed, idempotent authority merge, read-only API contract).");

function event(id: string, exchangeTimestamp: number, aggressorSide: "BUY" | "SELL", quantity: number, price: number) {
  return { schemaVersion: 1, venue: "BYBIT", kind: "TRADE", symbol: "BTCUSDT", eventId: id, dedupKey: `sha256:${crypto.createHash("sha256").update(id).digest("hex")}`, exchangeTimestamp, receivedTimestamp: exchangeTimestamp + 5, payload: { venue: "BYBIT", symbol: "BTCUSDT", tradeId: id, exchangeTimestamp, receivedTimestamp: exchangeTimestamp + 5, price, quantity, notional: price * quantity, aggressorSide, certainty: "OBSERVED", sourceVersion: "test" } };
}
