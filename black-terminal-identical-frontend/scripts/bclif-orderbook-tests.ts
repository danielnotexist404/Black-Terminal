import assert from "node:assert/strict";
import { BybitOrderBookReconstructor } from "../server/liquidation-intelligence/sources/bybitOrderBook.ts";
import { TEST_SOURCE_VERSION } from "./bclif-test-fixtures.ts";

function message(type: "snapshot" | "delta", updateId: number, bids: string[][], asks: string[][], sequence = updateId + 1_000) {
  return {
    topic: "orderbook.200.BTCUSDT",
    type,
    ts: 1_700_000_000_000 + updateId,
    data: { s: "BTCUSDT", u: updateId, seq: sequence, b: bids, a: asks }
  };
}

const book = new BybitOrderBookReconstructor("BTCUSDT", TEST_SOURCE_VERSION, 2, 4);
book.connected();
assert.equal(book.state(), "SNAPSHOT_PENDING");

const buffered = book.apply(message("delta", 11, [["100", "3"]], []), 11_005);
assert.equal(buffered.accepted, false);
assert.match(buffered.reason || "", /awaiting snapshot/);
const snapshot = book.apply(message("snapshot", 10, [["100", "2"], ["99", "1"]], [["101", "4"], ["102", "5"]]), 10_005);
assert.equal(snapshot.accepted, true);
assert.equal(book.state(), "LIVE");
assert.equal(snapshot.frame?.bestBid, 100);
assert.equal(snapshot.frame?.bestAsk, 101);
assert.equal(snapshot.frame?.bids[0]?.quantity, 3, "buffered contiguous delta must apply after snapshot");

const next = book.apply(message("delta", 12, [["100", "0"], ["99.5", "6"]], [["101", "2"]]), 12_005);
assert.equal(next.accepted, true);
assert.equal(next.frame?.bestBid, 99.5);
assert.equal(next.frame?.bids.length, 2);
const duplicate = book.apply(message("delta", 12, [["100", "0"], ["99.5", "6"]], [["101", "2"]]), 12_006);
assert.equal(duplicate.duplicate, true);

const gap = book.apply(message("delta", 14, [["99.4", "1"]], []), 14_005);
assert.equal(gap.resyncRequired, true);
assert.equal(book.state(), "GAP_DETECTED");
book.beginResynchronization();
assert.equal(book.state(), "RESYNCHRONIZING");
book.apply(message("delta", 21, [["100.5", "2"]], []), 21_005);
const resynced = book.apply(message("snapshot", 20, [["100", "1"]], [["101", "1"]]), 20_005);
assert.equal(resynced.accepted, true);
assert.equal(resynced.frame?.bestBid, 100.5);
assert.equal(book.state(), "LIVE");

assert.equal(book.stale(30_000, 5_000), true);
assert.equal(book.state(), "DEGRADED");
const crossed = book.apply(message("delta", 22, [["102", "1"]], []), 22_005);
assert.equal(crossed.resyncRequired, true);
assert.equal(book.state(), "GAP_DETECTED");

const wrongSymbol = new BybitOrderBookReconstructor("ETHUSDT", TEST_SOURCE_VERSION);
wrongSymbol.connected();
assert.equal(wrongSymbol.apply(message("snapshot", 1, [["100", "1"]], [["101", "1"]])).accepted, false);
assert.equal(wrongSymbol.state(), "SNAPSHOT_PENDING");

console.log(JSON.stringify({ decision: "PASS", guarantees: ["snapshot-gate", "strict-update-id", "duplicate-idempotence", "gap-resync", "crossed-book-rejection"] }, null, 2));
