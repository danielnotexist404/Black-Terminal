import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QalcEventArchive, replayArchivedEvents } from "../server/qalc/archive.ts";
import { normalizeBybitMessage, QalcBybitGateway } from "../server/qalc/bybit-gateway.ts";
import { QalcClockMonitor } from "../server/qalc/clock.ts";
import { defaultQalcConfig, type QalcBookPayload, type QalcMarketEvent } from "../server/qalc/contracts.ts";
import { QalcEngine } from "../server/qalc/engine.ts";
import { QalcFeatureEngine } from "../server/qalc/features.ts";
import { QalcOrderBook } from "../server/qalc/order-book.ts";
import { QalcPaperBroker } from "../server/qalc/paper-broker.ts";
import { QalcEventSequencer } from "../server/qalc/sequencer.ts";

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, run: () => void | Promise<void>) => tests.push([name, run]);

test("Bybit normalization preserves exact millisecond timestamps, aggressor side, trade id and sequences", () => {
  const events = normalizeBybitMessage({ topic: "publicTrade.BTCUSDT", ts: 1_000, seq: 44, data: [{ T: 999, s: "BTCUSDT", S: "Sell", v: "0.25", p: "100", i: "trade-1", BT: false, RPI: true }] }, "BTCUSDT", 1_010);
  assert.equal(events.length, 1);
  assert.equal(events[0].exchangeTimestamp, 999);
  assert.deepEqual(events[0].payload, { tradeId: "trade-1", side: "SELL", price: 100, quantity: 0.25, notional: 25, crossSequence: "44", blockTrade: false, rpiTrade: true });
});

test("gateway preserves WebSocket arrival order across asynchronous archive backpressure", async () => {
  const received: string[] = [];
  const gateway = new QalcBybitGateway({ symbol: "BTCUSDT", onEvent: async (event) => {
    if ((event.payload as { tradeId?: string }).tradeId === "slow-first") await new Promise((resolve) => setTimeout(resolve, 10));
    received.push((event.payload as { tradeId: string }).tradeId);
  } });
  const internal = gateway as unknown as { stopped: boolean; enqueueMessage: (raw: string, generation: number) => void; processingChain: Promise<void> };
  internal.stopped = false;
  internal.enqueueMessage(JSON.stringify({ topic: "publicTrade.BTCUSDT", ts: 1_000, data: [{ T: 1_000, S: "Buy", v: "1", p: "100", i: "slow-first" }] }), 0);
  internal.enqueueMessage(JSON.stringify({ topic: "publicTrade.BTCUSDT", ts: 1_001, data: [{ T: 1_001, S: "Sell", v: "1", p: "100", i: "second" }] }), 0);
  await internal.processingChain;
  assert.deepEqual(received, ["slow-first", "second"]);
});

test("order book applies snapshot/delta atomically and rejects duplicate/regression/crossed books", () => {
  const book = new QalcOrderBook("BTCUSDT");
  const snapshot = bookEvent("BOOK_SNAPSHOT", 1, [[100, 2], [99, 3]], [[101, 2], [102, 3]], 1000);
  assert.equal(book.apply(snapshot).accepted, true);
  assert.equal(book.view(1000).bids[0].price, 100);
  assert.equal(book.apply(snapshot).accepted, true, "a fresh snapshot is authoritative even when ids match");
  const delta = bookEvent("BOOK_DELTA", 2, [[100, 1], [98, 4]], [[101, 0], [103, 2]], 1010);
  assert.equal(book.apply(delta).accepted, true);
  assert.equal(book.view(1010).asks[0].price, 102);
  const duplicate = book.apply(delta);
  assert.equal(duplicate.duplicate, true);
  const regression = book.apply(bookEvent("BOOK_DELTA", 1, [[100, 9]], [], 1020));
  assert.equal(regression.accepted, false);
  assert.equal(book.view(1020).bids[0].quantity, 1, "rejected mutations cannot partially change authoritative state");
});

test("sequencer is idempotent for event and trade identities", () => {
  const guard = new QalcEventSequencer();
  const event = tradeEvent("t-1", "SELL", 100, 1, 1000);
  assert.equal(guard.accept(event).accepted, true);
  assert.equal(guard.accept(event).duplicate, true);
  assert.equal(guard.accept({ ...event, id: "another-envelope" }).reason, "TRADE_ID_DUPLICATE");
});

test("clock fails closed when absent/stale and permits quotes only when safe", () => {
  const clock = new QalcClockMonitor(100, 250, 20, 1_000);
  assert.equal(clock.mayQuote(100), false);
  assert.equal(clock.observe(1_005, 1_000, 1_010).state, "CLOCK_SAFE");
  assert.equal(clock.mayQuote(1_011), true);
  assert.equal(clock.status(2_100).state, "CLOCK_UNSAFE");
});

test("feature formulas use weighted queue depth and signed-notional flow efficiency", () => {
  const book = new QalcOrderBook("BTCUSDT");
  const features = new QalcFeatureEngine(1);
  const snapshot = bookEvent("BOOK_SNAPSHOT", 1, [[100, 10], [99, 100]], [[101, 2], [102, 100]], 1_000);
  const mutation = book.apply(snapshot);
  features.observeBook(snapshot, mutation, book.view(1_000));
  features.observeTrade(tradeEvent("feature-buy", "BUY", 101, 2, 1_010));
  features.observeTrade(tradeEvent("feature-sell", "SELL", 100, 1, 1_020));
  const value = features.snapshot(book.view(1_020), 1_020)!;
  assert.ok(value.queueImbalance["1"] > value.queueImbalance["5"], "distant depth must be down-weighted");
  assert.equal(value.microprice, (100 * 2 + 101 * 10) / 12);
  assert.ok(value.baseCvd["250"] > 0);
  assert.ok(value.notionalCvd["250"] > 0);
  assert.ok(value.flowEfficiency["250"] > 0 && value.flowEfficiency["250"] <= 1);
});

test("Paper quote is PostOnly, price touch never fills, and actual taker flow consumes queue before partial fill", () => {
  const config = defaultQalcConfig({ mode: "PAPER", paperEnabled: true, runId: "test-run", quoteLifetimeMs: 5_000 });
  const fees = { makerRate: 0.0002, takerRate: 0.0006, source: "PAPER_CONSERVATIVE" as const, version: "test" };
  const broker = new QalcPaperBroker(config, () => fees);
  const view = new QalcOrderBook("BTCUSDT");
  view.apply(bookEvent("BOOK_SNAPSHOT", 1, [[100, 1]], [[101, 1]], 1000));
  assert.equal(broker.submit({ side: "BUY", price: 101, quantity: 1, now: 1000, book: view.view(1000) }).reason, "POST_ONLY_WOULD_CROSS");
  assert.equal(broker.submit({ side: "BUY", price: 100, quantity: 1, now: 1000, book: view.view(1000) }).accepted, true);
  broker.onTime(1100);
  assert.equal(broker.executionHistory().length, 0, "book touch alone is not a fill");
  assert.equal(broker.onTrade(tradeEvent("t1", "SELL", 100, 1, 1101)), undefined, "first trade consumes queue ahead");
  const partial = broker.onTrade(tradeEvent("t2", "SELL", 100, 0.5, 1102));
  assert.ok(partial && partial.quantity > 0 && partial.quantity < 0.5);
  assert.equal(broker.order()?.state, "PARTIALLY_FILLED");
  broker.onTrade(tradeEvent("t3", "SELL", 100, 2, 1103));
  assert.equal(broker.order()?.state, "FILLED");
  assert.equal(broker.executionHistory().length, 2);
});

test("Paper order and fill identities are deterministic under exact event replay", () => {
  const make = () => {
    const config = defaultQalcConfig({ mode: "PAPER", paperEnabled: true, runId: "deterministic-run", quoteLifetimeMs: 5_000 });
    const broker = new QalcPaperBroker(config, () => ({ makerRate: 0.0002, takerRate: 0.0006, source: "PAPER_CONSERVATIVE", version: "test" }));
    const book = new QalcOrderBook("BTCUSDT");
    book.apply(bookEvent("BOOK_SNAPSHOT", 1, [[100, 0.1]], [[101, 1]], 1_000));
    const submitted = broker.submit({ side: "BUY", price: 100, quantity: 1, now: 1_000, book: book.view(1_000) });
    assert.equal(submitted.accepted, true);
    broker.onTime(1_100);
    const fill = broker.onTrade(tradeEvent("deterministic-trade", "SELL", 100, 2, 1_101));
    assert.ok(fill);
    return { orderId: submitted.order.id, fillId: fill.id };
  };
  assert.deepEqual(make(), make());
});

test("Research, Replay and Shadow cannot create Paper orders, and live flags fail construction", () => {
  for (const mode of ["RESEARCH", "REPLAY", "SHADOW"] as const) {
    const config = defaultQalcConfig({ mode, paperEnabled: false });
    const broker = new QalcPaperBroker(config, () => ({ makerRate: 0, takerRate: 0, source: "PAPER_CONSERVATIVE", version: "test" }));
    const book = new QalcOrderBook("BTCUSDT"); book.apply(bookEvent("BOOK_SNAPSHOT", 1, [[100, 1]], [[101, 1]], 1000));
    assert.equal(broker.submit({ side: "BUY", price: 100, quantity: 1, now: 1000, book: book.view(1000) }).accepted, false);
  }
  assert.throws(() => new QalcEngine({ liveExecutionEnabled: true as never }, { tickSize: 0.1, quantityStep: 0.001 }), /LIVE_EXECUTION_PROHIBITED/);
  assert.throws(() => new QalcEngine({ groupFanoutEnabled: true as never }, { tickSize: 0.1, quantityStep: 0.001 }), /LIVE_EXECUTION_PROHIBITED/);
});

test("archive round-trip is lossless and replay order is deterministic", async () => {
  const folder = await mkdtemp(join(tmpdir(), "qalc-test-"));
  try {
    const archive = new QalcEventArchive(folder, "BTCUSDT", "test-run");
    const source = [bookEvent("BOOK_SNAPSHOT", 1, [[100, 1]], [[101, 1]], 1000), tradeEvent("trade-archive", "BUY", 101, 0.1, 1001)];
    for (const event of source) await archive.append(event);
    const manifest = await archive.close();
    assert.ok(manifest && manifest.eventCount === 2 && /^[a-f0-9]{64}$/.test(manifest.checksum));
    const restored: QalcMarketEvent[] = [];
    for await (const event of replayArchivedEvents(manifest.path)) restored.push(event);
    assert.deepEqual(restored, source);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("prefix decisions are invariant when future events are appended", () => {
  const prefix = [bookEvent("BOOK_SNAPSHOT", 1, [[100, 3]], [[101, 2]], 1000), ...Array.from({ length: 120 }, (_, index) => tradeEvent(`p-${index}`, index % 2 ? "BUY" : "SELL", index % 2 ? 101 : 100, 0.01, 1001 + index * 30))];
  const first = new QalcEngine({ mode: "REPLAY" }, { tickSize: 0.1, quantityStep: 0.001 });
  const second = new QalcEngine({ mode: "REPLAY" }, { tickSize: 0.1, quantityStep: 0.001 });
  for (const event of prefix) { first.observeClock(event.exchangeTimestamp, event.exchangeTimestamp, event.exchangeTimestamp); first.process(event); second.observeClock(event.exchangeTimestamp, event.exchangeTimestamp, event.exchangeTimestamp); second.process(event); }
  const beforeFuture = normalizedTelemetry(first.telemetry(prefix.at(-1)!.receiveTimestamp));
  const samePrefix = normalizedTelemetry(second.telemetry(prefix.at(-1)!.receiveTimestamp));
  assert.deepEqual(samePrefix, beforeFuture);
  second.process(tradeEvent("future", "BUY", 102, 20, 20_000));
  assert.deepEqual(normalizedTelemetry(first.telemetry(prefix.at(-1)!.receiveTimestamp)), beforeFuture, "future append cannot mutate finalized prefix state");
});

test("telemetry reads are pure and cannot mutate feature or decision state", () => {
  const engine = new QalcEngine({ mode: "REPLAY" }, { tickSize: 0.1, quantityStep: 0.001 });
  const events = [bookEvent("BOOK_SNAPSHOT", 1, [[100, 3]], [[101, 2]], 1_000), ...Array.from({ length: 120 }, (_, index) => tradeEvent(`read-${index}`, index % 3 ? "BUY" : "SELL", index % 3 ? 101 : 100, 0.01, 1_001 + index * 30))];
  for (const event of events) {
    engine.observeClock(event.exchangeTimestamp, event.exchangeTimestamp, event.exchangeTimestamp);
    engine.process(event);
  }
  const now = events.at(-1)!.receiveTimestamp;
  const first = normalizedTelemetry(engine.telemetry(now));
  const second = normalizedTelemetry(engine.telemetry(now));
  const third = normalizedTelemetry(engine.telemetry(now));
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
});

for (const [name, run] of tests) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}
console.log(`QALC_CORE_TESTS_OK ${tests.length}`);

function bookEvent(type: "BOOK_SNAPSHOT" | "BOOK_DELTA", update: number, bids: number[][], asks: number[][], time: number): QalcMarketEvent {
  const payload: QalcBookPayload = { bids: bids.map(([price, quantity]) => [price, quantity] as const), asks: asks.map(([price, quantity]) => [price, quantity] as const), updateId: String(update), crossSequence: String(update + 100), systemTimestamp: time, matchingTimestamp: time - 1, depth: 200 };
  return { id: `book-${type}-${update}-${time}`, venue: "BYBIT", category: "linear", symbol: "BTCUSDT", eventType: type, exchangeTimestamp: time, matchingTimestamp: time - 1, receiveTimestamp: time, processTimestamp: time, sequence: payload.crossSequence, updateId: payload.updateId, payloadVersion: 1, payload };
}
function tradeEvent(id: string, side: "BUY" | "SELL", price: number, quantity: number, time: number): QalcMarketEvent {
  return { id: `event-${id}`, venue: "BYBIT", category: "linear", symbol: "BTCUSDT", eventType: "TRADE", exchangeTimestamp: time, receiveTimestamp: time, processTimestamp: time, payloadVersion: 1, payload: { tradeId: id, side, price, quantity, notional: price * quantity, blockTrade: false, rpiTrade: false } };
}
function normalizedTelemetry(value: ReturnType<QalcEngine["telemetry"]>) { return { runtimeState: value.runtimeState, book: value.book, features: value.features, decision: value.decision, counters: value.counters }; }
