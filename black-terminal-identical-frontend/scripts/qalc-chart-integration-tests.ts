import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QalcMarketEvent, QalcPaperExecution, QalcPaperInventory, QalcPaperOrder, QalcTelemetry } from "../server/qalc/contracts.ts";
import { deriveRecordedResearchSignals, QalcTimelineProjector, QalcTimelineStore } from "../server/qalc/timeline.ts";
import { handleQalcRequest } from "../server/qalc/service.js";

const source = event("source-1", 1_000, 100);
const projector = new QalcTimelineProjector({ strategyId: "strategy-1", runId: "run-1", modelVersion: "BC-QALC-BASELINE-1", symbol: "BTCUSDT", origin: "REPLAY" });
const candidate = telemetry({ decision: decision("QUOTE_BID", "SHADOW_CANDIDATE", 100) });
projector.observe(source, candidate);
projector.observe(source, candidate);
assert.deepEqual(projector.pendingEvents().map((row) => row.kind), ["CANDIDATE_LONG"], "repeated snapshots must not duplicate a decision marker");

const order = paperOrder();
projector.observe(event("source-2", 1_100, 100), telemetry({ decision: decision("QUOTE_BID", "PAPER_POST_ONLY_SUBMITTED", 100), activeQuote: order }));
assert.equal(projector.pendingEvents().filter((row) => row.kind === "QUOTE_BID").length, 1);

const firstFill = execution("fill-1", "BUY", 100, 0.4, true, 1_200);
projector.observe(event("source-3", 1_200, 100), telemetry({ activeQuote: { ...order, state: "PARTIALLY_FILLED", filledQuantity: .4, remainingQuantity: .6 }, executions: [firstFill], inventory: inventory("LONG", .4, 100) }));
const secondFill = execution("fill-2", "BUY", 100, 0.6, true, 1_250);
projector.observe(event("source-4", 1_250, 100), telemetry({ activeQuote: { ...order, state: "FILLED", filledQuantity: 1, remainingQuantity: 0 }, executions: [firstFill, secondFill], inventory: inventory("LONG", 1, 100) }));
const exit = execution("fill-exit", "SELL", 101, 1, false, 1_400);
projector.observe(event("source-5", 1_400, 101), telemetry({ executions: [firstFill, secondFill, exit], recentAudit: [{ type: "PAPER_INVENTORY_CLOSED", time: 1_400, severity: "INFO", message: "TIME_EXIT" }] }));
const lifecycle = projector.pendingEvents();
assert.equal(lifecycle.filter((row) => row.kind === "ENTRY_LONG").length, 1, "first maker fill is one entry");
assert.equal(lifecycle.filter((row) => row.kind === "PARTIAL_FILL").length, 1, "later maker execution mutates the same position cycle");
assert.equal(lifecycle.filter((row) => row.kind === "EXIT_LONG").length, 1, "exit closes the correct long position cycle");
assert.equal(lifecycle.find((row) => row.kind === "ENTRY_LONG")?.positionCycleId, lifecycle.find((row) => row.kind === "EXIT_LONG")?.positionCycleId);

const prefixIds = lifecycle.map((row) => row.id);
projector.observe(event("future", 9_000, 102), telemetry({ decision: decision("NO_QUOTE", "TOXICITY_GATE", 102) }));
assert.deepEqual(projector.pendingEvents().slice(0, prefixIds.length).map((row) => row.id), prefixIds, "future events cannot mutate finalized marker identities");
const gatedRows = projector.pendingEvents().slice(prefixIds.length);
assert.equal(gatedRows.filter((row) => row.kind === "CANDIDATE_LONG").length, 1, "a direction-confirmed gate rejection must remain visible as a research setup");
assert.equal(gatedRows.filter((row) => row.kind === "ENTRY_LONG" || row.kind === "ENTRY_SHORT").length, 0, "a rejected research setup must never become a fake fill");
assert.match(gatedRows.find((row) => row.kind === "CANDIDATE_LONG")?.reason || "", /^RESEARCH_SETUP:/);
const recovered = deriveRecordedResearchSignals(gatedRows.filter((row) => row.kind === "REJECTED"));
assert.equal(recovered.length, 1, "recorded causal rejection metrics must support deterministic research-marker recovery");
assert.equal(deriveRecordedResearchSignals([...gatedRows, ...recovered]).length, 0, "research-marker recovery must be idempotent");

const folder = await mkdtemp(join(tmpdir(), "qalc-timeline-"));
try {
  const path = join(folder, "timeline.json");
  const store = new QalcTimelineStore(path, 100);
  await store.load();
  await store.append(lifecycle);
  await store.append(lifecycle);
  const restored = await new QalcTimelineStore(path, 100).load();
  assert.equal(restored.events.length, lifecycle.length, "timeline persistence is idempotent by canonical event id");
  assert.equal(restored.coverage.source, "RECORDED_QALC_EVENT_TIME");
  assert.equal(restored.coverage.complete, false, "bounded event history must never claim complete market coverage");
  const previousPath = process.env.QALC_TIMELINE_PATH;
  process.env.QALC_TIMELINE_PATH = path;
  const response = mockResponse();
  await handleQalcRequest({ method: "GET", query: { symbol: "BTCUSDT", from: "1100", to: "1300", limit: "20" } }, response, {}, ["timeline"]);
  assert.equal(response.body.source, "VPS_CANONICAL_QALC_TIMELINE");
  assert.ok(response.body.events.every((row: { eventTime: number }) => row.eventTime >= 1_100 && row.eventTime <= 1_300), "timeline API must filter on canonical event time");
  if (previousPath == null) delete process.env.QALC_TIMELINE_PATH; else process.env.QALC_TIMELINE_PATH = previousPath;
} finally {
  await rm(folder, { recursive: true, force: true });
}

const overlaySource = await readFile(new URL("../src/modules/qalc-indicator/QalcIndicatorOverlay.tsx", import.meta.url), "utf8");
const chartSource = await readFile(new URL("../src/components/PixiBlackChart.tsx", import.meta.url), "utf8");
const manifestSource = await readFile(new URL("../src/modules/strategy-lab/my-strategy/state/indicatorManifest.ts", import.meta.url), "utf8");
assert.match(overlaySource, /event\.eventTime\s*\/\s*1_000/, "markers must map canonical exchange event time directly to chart coordinates");
assert.doesNotMatch(overlaySource, /candle.*(signal|entry)|close\s*[<>]=?/i, "QALC overlay must not synthesize decisions from candle direction or close");
assert.match(overlaySource, /NO CANDLE FALLBACK/);
assert.match(overlaySource, /RESEARCH SETUP — NOT AN ORDER OR FILL/, "research setups must be explicitly separated from Paper fills");
assert.match(overlaySource, /PAPER ENTRIES/, "the overlay must expose actual fill count instead of appearing silently empty");
assert.match(chartSource, /saveQalcStrategyHandoff\(displaySymbol, qalcSettings\)/, "chart configuration must hand off exactly to Strategy Lab");
assert.match(manifestSource, /id:\s*"qalc:candidate-long"[\s\S]*?intrabar:\s*true/, "Strategy Lab must expose QALC event-time semantics");
assert.match(manifestSource, /key:\s*"qalc"/, "BC-QALC must be registered as an active-chart indicator");

console.log("QALC_CHART_INTEGRATION_TESTS_OK 20");

function event(id: string, time: number, price: number): QalcMarketEvent {
  return { id, venue: "BYBIT", category: "linear", symbol: "BTCUSDT", eventType: "TRADE", exchangeTimestamp: time, receiveTimestamp: time, processTimestamp: time, payloadVersion: 1, payload: { tradeId: id, side: "BUY", price, quantity: 1, notional: price, blockTrade: false, rpiTrade: false } };
}

function decision(action: "QUOTE_BID" | "QUOTE_ASK" | "NO_QUOTE", reason: string, price: number): NonNullable<QalcTelemetry["decision"]> {
  return { time: 1_000, action, reason, quotePrice: price, quantity: 1, directional: { horizonMs: 1000, probabilityUp: .63, probabilityDown: .37, expectedMoveTicks: 2.1, confidence: .72, modelVersion: "test" }, fill: { within100Ms: .1, within250Ms: .2, within500Ms: .3, within1Second: .5, beforeInvalidation: .46, confidence: .6, modelVersion: "test" }, costs: { grossEdgeUsdt: 1, entryFeeUsdt: .1, expectedExitFeeUsdt: .1, expectedSlippageUsdt: .1, expectedAdverseSelectionUsdt: .1, fundingEstimateUsdt: 0, safetyBufferUsdt: .05, allInCostUsdt: .45, expectedNetEdgeUsdt: .55, feeSource: "PAPER_CONSERVATIVE" }, toxicity: 22 };
}

function telemetry(overrides: Partial<QalcTelemetry> = {}): QalcTelemetry {
  return { engineId: "black-core-qalc", modelVersion: "BC-QALC-BASELINE-1", certificationState: "RESEARCH", runtimeState: "QUOTE_CANDIDATE", book: { state: "LIVE", symbol: "BTCUSDT", bids: [{ price: 100, quantity: 1 }], asks: [{ price: 101, quantity: 1 }], version: 1, ageMs: 0 }, clock: { state: "CLOCK_SAFE", offsetMs: 0, driftMsPerMinute: 0, sampledAt: 1_000 }, risk: { suspended: false, dailyPnl: 0, dailyDrawdownPercent: 0, consecutiveLosses: 0, toxicExits10m: 0, recentMarkoutsBps: [] }, executions: [], recentAudit: [], counters: {}, performance: {}, updatedAt: 1_000, ...overrides };
}

function paperOrder(): QalcPaperOrder {
  return { id: "order-1", clientOrderId: "client-1", generation: 1, symbol: "BTCUSDT", side: "BUY", price: 100, quantity: 1, filledQuantity: 0, remainingQuantity: 1, state: "ACTIVE", createdAt: 1_000, acknowledgedAt: 1_010, activatedAt: 1_010, expiresAt: 2_000, queueAheadInitial: 1, queueAheadEstimated: 1, queueConfidence: .6, maker: true };
}

function execution(id: string, side: "BUY" | "SELL", price: number, quantity: number, maker: boolean, time: number): QalcPaperExecution {
  return { id, orderId: maker ? "order-1" : "exit-1", symbol: "BTCUSDT", side, price, quantity, notional: price * quantity, fee: .01, maker, time };
}

function inventory(side: "LONG" | "SHORT", quantity: number, price: number): QalcPaperInventory {
  return { side, quantity, averagePrice: price, openedAt: 1_200, entryFees: .01, realizedPnl: 0, unrealizedPnl: 0, lastMarkPrice: price };
}

function mockResponse() {
  return {
    body: {} as any,
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json(value: any) { this.body = value; return this; },
  };
}
