import assert from "node:assert/strict";
import crypto from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { aggregateCachedFlowBars, decodeVerifiedTradeChunk, parseAuthenticCvdQuery } from "../server/market-flow/authenticCvdService.js";
import { mergePersistentAndLiveFlow } from "../src/modules/acvd/data/flowMerge.ts";
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

const archived: AuthenticFlowBarInput = { time: 1_800_000_000, buyVolume: 5, sellVolume: 1, unknownVolume: 0, buyNotional: 506, sellNotional: 101, unknownNotional: 0, exactTradeCount: 3, totalTradeCount: 3, deliveryComplete: true };
const live: AuthenticFlowBarInput = { ...archived, buyVolume: 999, buyNotional: 999, exactTradeCount: 99 };
const merged = mergePersistentAndLiveFlow([archived.time], { version: 1, authority: "EXACT_AGGRESSOR_TRADES", venue: "BYBIT", symbol: "BTCUSDT", timeframeSeconds: 120, bars: [archived], coverage: { completeBars: 1, pendingChunks: 0, availableStart: archived.time, availableEnd: archived.time }, warning: null }, [live]);
assert.equal(merged[0]!.buyVolume, 5, "verified archive wins over overlapping session capture and cannot double count");

const handler = readFileSync(new URL("../api/market-flow/[action].js", import.meta.url), "utf8");
assert.match(handler, /requireApiSecurity/);
assert.match(handler, /indicator:\s*"acvdOscillator"/);
assert.doesNotMatch(handler, /placeOrder|cancelOrder|modifyOrder|execution_commands/i);
const migration = readFileSync(new URL("../supabase/migrations/20260825143000_acvd_authentic_flow_cache.sql", import.meta.url), "utf8");
assert.match(migration, /enable row level security/i);
assert.match(migration, /bclif_reject_immutable_change/);
assert.match(migration, /revoke all.*anon, authenticated/i);

console.log("Authentic CVD archive tests passed (checksum, exact side aggregation, gap fail-closed, idempotent merge, read-only API contract).");

function event(id: string, exchangeTimestamp: number, aggressorSide: "BUY" | "SELL", quantity: number, price: number) {
  return { schemaVersion: 1, venue: "BYBIT", kind: "TRADE", symbol: "BTCUSDT", eventId: id, dedupKey: `sha256:${crypto.createHash("sha256").update(id).digest("hex")}`, exchangeTimestamp, receivedTimestamp: exchangeTimestamp + 5, payload: { venue: "BYBIT", symbol: "BTCUSDT", tradeId: id, exchangeTimestamp, receivedTimestamp: exchangeTimestamp + 5, price, quantity, notional: price * quantity, aggressorSide, certainty: "OBSERVED", sourceVersion: "test" } };
}
