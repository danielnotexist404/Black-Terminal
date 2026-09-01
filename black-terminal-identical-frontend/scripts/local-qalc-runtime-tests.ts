import assert from "node:assert/strict";
import { normalizeLocalBybitMessage } from "../server/qalc/bybit-browser-normalizer.ts";

const snapshot = normalizeLocalBybitMessage({
  topic: "orderbook.200.BTCUSDT",
  type: "snapshot",
  ts: 1_000,
  data: { u: 44, seq: 90, cts: 999, b: [["100", "2"], ["99", "3"]], a: [["101", "4"]] },
}, "BTCUSDT", 1_010);
assert.equal(snapshot.length, 1);
assert.equal(snapshot[0].eventType, "BOOK_SNAPSHOT");
assert.equal(snapshot[0].updateId, "44");
assert.equal(snapshot[0].matchingTimestamp, 999);
assert.deepEqual((snapshot[0].payload as { bids: unknown }).bids, [[100, 2], [99, 3]]);

const delta = normalizeLocalBybitMessage({
  topic: "orderbook.200.BTCUSDT",
  type: "delta",
  ts: 1_020,
  data: { u: 45, seq: 91, b: [["100", "0"]], a: [["101", "2"]] },
}, "BTCUSDT", 1_030);
assert.equal(delta[0].eventType, "BOOK_DELTA");
assert.equal(delta[0].sequence, "91");

const trades = normalizeLocalBybitMessage({
  topic: "publicTrade.BTCUSDT",
  ts: 2_000,
  seq: 501,
  data: [
    { i: "buy-1", S: "Buy", p: "101", v: "0.2", T: 1_999, BT: false, RPI: true },
    { i: "sell-1", S: "Sell", p: "100", v: "0.3", T: 2_000, BT: true, RPI: false },
  ],
}, "BTCUSDT", 2_010);
assert.equal(trades.length, 2);
assert.deepEqual(trades.map((event) => (event.payload as { side: string }).side), ["BUY", "SELL"]);
assert.ok(Math.abs((trades[0].payload as { notional: number }).notional - 20.2) < 1e-9);
assert.equal((trades[0].payload as { rpiTrade: boolean }).rpiTrade, true);
assert.equal((trades[1].payload as { blockTrade: boolean }).blockTrade, true);

assert.deepEqual(normalizeLocalBybitMessage({ topic: "publicTrade.ETHUSDT", data: [] }, "BTCUSDT", 1), []);
assert.deepEqual(normalizeLocalBybitMessage({ topic: "orderbook.200.BTCUSDT", type: "snapshot", data: { u: "invalid" } }, "BTCUSDT", 1), []);

console.log("Local QALC runtime contracts passed: canonical L200/trade normalization preserves event time, sequence, side, and trade flags.");
