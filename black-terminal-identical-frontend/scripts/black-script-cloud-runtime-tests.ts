import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Candle } from "../src/chart-engine/types.ts";
import {
  blackScriptOwnedSourceVersion,
  evaluateBlackScriptCloudRuntime,
} from "../src/modules/strategy-lab/adapters/blackScriptCloudRuntime.ts";
import {
  assertBlackScriptExpectedTargetFills,
  buildBlackScriptBrokerPlan,
  buildBlackScriptTargetCommandManifest,
  settleBlackScriptTargetMarketActions,
} from "../src/modules/strategy-lab/adapters/blackScriptBrokerPlanner.ts";

const reversalSource = `strategy(default_qty_type=strategy.fixed, default_qty_value=1, process_orders_on_close=False)
long_signal = close > open
short_signal = close < open
strategy.entry("Long", strategy.long, when=long_signal)
strategy.entry("Short", strategy.short, when=short_signal)`;
const firstClosed: Candle[] = [
  { time: 1_900_000_000, open: 100, high: 101, low: 98, close: 99, volume: 100 },
  { time: 1_900_000_060, open: 99, high: 102, low: 98, close: 101, volume: 100 },
];
const firstCurrent: Candle = { time: 1_900_000_120, open: 102, high: 103, low: 101, close: 102, volume: 1 };
const sourceVersion = blackScriptOwnedSourceVersion(reversalSource);
const first = evaluateBlackScriptCloudRuntime({
  source: reversalSource,
  expectedSourceVersion: sourceVersion,
  settings: {},
  closedCandles: firstClosed,
  currentCandle: firstCurrent,
});
assert.deepEqual(first.marketActions.map((intent) => [intent.action, intent.direction, intent.referencePrice]), [["ENTRY", "long", 102]]);
assert.equal(first.marketActions[0]?.placedTime, firstClosed[1].time, "a cloud command must retain the confirmed signal candle");

const duplicateTick = evaluateBlackScriptCloudRuntime({
  source: reversalSource,
  expectedSourceVersion: sourceVersion,
  settings: {},
  closedCandles: firstClosed,
  currentCandle: firstCurrent,
  checkpoint: first.checkpoint,
});
assert.equal(duplicateTick.marketActions.length, 0, "re-evaluating the same closed candle must never duplicate a broker action");

const secondClosed: Candle[] = [
  ...firstClosed,
  { time: firstCurrent.time, open: 102, high: 103, low: 96, close: 97, volume: 100 },
];
const reversed = evaluateBlackScriptCloudRuntime({
  source: reversalSource,
  expectedSourceVersion: sourceVersion,
  settings: {},
  closedCandles: secondClosed,
  currentCandle: { time: 1_900_000_180, open: 96, high: 97, low: 95, close: 96, volume: 1 },
  checkpoint: first.checkpoint,
});
assert.deepEqual(reversed.marketActions.map((intent) => [intent.action, intent.direction, intent.positionDirection]), [["REVERSE", "short", "long"]]);

const protectedSource = `strategy(default_qty_type=strategy.fixed, default_qty_value=10, process_orders_on_close=True, tick_size=1)
enter = close > open
strategy.entry("Core", strategy.long, when=enter)
strategy.exit("TP1", "Core", limit=strategy.position_avg_price + 5, qty_percent=25, when=strategy.position_size > 0)
strategy.exit("Trail", "Core", trail_points=2, trail_offset=1, qty_percent=25, when=strategy.position_size > 0)`;
const protectedVersion = blackScriptOwnedSourceVersion(protectedSource);
const protectedEvaluation = evaluateBlackScriptCloudRuntime({
  source: protectedSource,
  expectedSourceVersion: protectedVersion,
  settings: {},
  closedCandles: firstClosed,
  currentCandle: firstCurrent,
});
assert.deepEqual(protectedEvaluation.marketActions.map((intent) => intent.action), ["ENTRY"]);
assert.equal(protectedEvaluation.desiredOrders.length, 2, "limit and trailing exits must remain explicit durable broker-order intents");
assert.equal(protectedEvaluation.desiredOrders.find((order) => order.instructionId === "TP1")?.quantityPercent, 25);
assert.equal(protectedEvaluation.desiredOrders.find((order) => order.instructionId === "Trail")?.trailActivation, 103);
assert.equal(protectedEvaluation.desiredOrders.find((order) => order.instructionId === "Trail")?.trailOffsetTicks, 1);
assert.throws(() => buildBlackScriptBrokerPlan({ evaluation: protectedEvaluation, tickSize: 1 }), /PARTIAL_TRAILING_REQUIRES_EVENT_STREAM/, "a partial trailing exit must fail closed instead of silently becoming full-position protection");

const bracketSource = `strategy(default_qty_type=strategy.fixed, default_qty_value=10, process_orders_on_close=True, tick_size=1)
enter = close > open
strategy.entry("Core", strategy.long, when=enter)
strategy.exit("Bracket", "Core", limit=strategy.position_avg_price + 5, stop=strategy.position_avg_price - 3, qty_percent=25, when=strategy.position_size > 0)`;
const bracketEvaluation = evaluateBlackScriptCloudRuntime({
  source: bracketSource,
  expectedSourceVersion: blackScriptOwnedSourceVersion(bracketSource),
  settings: {},
  closedCandles: firstClosed,
  currentCandle: firstCurrent,
});
const bracketPlan = buildBlackScriptBrokerPlan({ evaluation: bracketEvaluation, tickSize: 1 });
assert.deepEqual(bracketPlan.createOrders.map((order) => [order.orderType, order.reduceOnly, order.quantityPercent]), [["limit", true, 25], ["stop-market", true, 25]], "a Pine bracket must become two quantity-identical reduce-only OCO legs");
assert.equal(bracketPlan.createOrders[0]?.ocoGroup, bracketPlan.createOrders[1]?.ocoGroup);

const manifestRequest = {
  strategyId: "10000000-0000-4000-8000-000000000001",
  strategyVersion: 3,
  ownerUserId: "10000000-0000-4000-8000-000000000002",
  bindingId: "10000000-0000-4000-8000-000000000003",
  connectionId: "10000000-0000-4000-8000-000000000004",
  accountId: "10000000-0000-4000-8000-000000000005",
  symbol: "BTCUSDT",
  marketType: "FUTURES" as const,
  executionEnvironment: "DEMO" as const,
  requestedLongLeverage: 5,
  requestedShortLeverage: 7,
  digest: (value: string) => crypto.createHash("sha256").update(value).digest("hex"),
};
const firstManifest = buildBlackScriptTargetCommandManifest({
  ...manifestRequest,
  evaluation: bracketEvaluation,
  plan: bracketPlan,
});
assert.equal(firstManifest.commands.length, 3, "the entry plus both reduce-only bracket legs must be one durable target manifest");
assert.deepEqual(firstManifest.commands.map((command) => command.payload.action), ["ENTRY", "BLACK_SCRIPT_EXIT", "BLACK_SCRIPT_EXIT"]);
assert.equal(firstManifest.commands[0]?.payload.quantity, 10, "an explicit/default fixed-contract market entry must retain its script sizing at the broker boundary");
assert.equal(firstManifest.commands[0]?.payload.requestedLeverage, 5);
assert.ok(firstManifest.commands.every((command) => command.idempotencyKey.length === 64));
assert.ok(firstManifest.commands.every((command) => !command.deterministicClientOrderId || command.deterministicClientOrderId.length <= 36));
assert.equal(Object.keys(firstManifest.brokerOrderHandles).length, 3, "the market entry and both resting OCO legs must retain independent reconciliation handles");
assert.deepEqual(firstManifest.commands[1]?.payload.dependsOnIdempotencyKeys, [firstManifest.commands[0]?.idempotencyKey], "protective exits must wait for the exact entry acknowledgement");
assert.deepEqual(firstManifest.commands[2]?.payload.dependsOnIdempotencyKeys, [firstManifest.commands[0]?.idempotencyKey]);
const marketEntryHandleEntry = Object.entries(firstManifest.brokerOrderHandles)
  .find(([, handle]) => handle.logicalKind === "MARKET_ACTION")!;
assert.throws(() => settleBlackScriptTargetMarketActions({
  priorHandles: firstManifest.brokerOrderHandles,
  state: {
    commandsByIdempotencyKey: {
      [marketEntryHandleEntry[1].placeIdempotencyKey]: { status: "PROCESSING", executionOrderId: "entry-order" },
    },
    ordersById: { "entry-order": { status: "filled", filledQuantity: 10 } },
    ownedPositions: [{ direction: "long", quantity: 10 }],
  },
}), /BLACK_SCRIPT_MARKET_ACTION_PENDING/, "a durable market command must not advance the shared clock before its worker attempt succeeds");
const settledFirstHandles = settleBlackScriptTargetMarketActions({
  priorHandles: firstManifest.brokerOrderHandles,
  state: {
    commandsByIdempotencyKey: {
      [marketEntryHandleEntry[1].placeIdempotencyKey]: { status: "SUCCEEDED", executionOrderId: "entry-order" },
    },
    ordersById: { "entry-order": { status: "cancelled", quantity: 10, filledQuantity: 4 } },
    ownedPositions: [{ direction: "long", quantity: 4 }],
  },
});
assert.equal(settledFirstHandles[marketEntryHandleEntry[0]], undefined, "a confirmed market action handle is retired after broker and owned-position confirmation");
assert.equal(Object.keys(settledFirstHandles).length, 2);

const bracketFilled = evaluateBlackScriptCloudRuntime({
  source: bracketSource,
  expectedSourceVersion: blackScriptOwnedSourceVersion(bracketSource),
  settings: {},
  closedCandles: [
    ...firstClosed,
    { time: firstCurrent.time, open: 102, high: 108, low: 100, close: 107, volume: 100 },
  ],
  checkpoint: bracketEvaluation.checkpoint,
});
assert.equal(bracketFilled.expectedOrderFills[0]?.logicalOrderKey, bracketPlan.createOrders[0]?.key);
const filledHandle = firstManifest.brokerOrderHandles[bracketFilled.expectedOrderFills[0]!.logicalOrderKey]!;
assert.throws(() => assertBlackScriptExpectedTargetFills({
  evaluation: bracketFilled,
  priorHandles: settledFirstHandles,
  state: {
    commandsByIdempotencyKey: {
      [filledHandle.placeIdempotencyKey]: { status: "SUCCEEDED", executionOrderId: "tp-order" },
    },
    ordersById: { "tp-order": { status: "partially-filled", filledQuantity: 1 } },
    ownedPositions: [{ direction: "long", quantity: 8 }],
  },
}), /BLACK_SCRIPT_EXPECTED_BROKER_FILL_PENDING/, "a virtual OHLC fill cannot advance while the target is only partially filled");
assert.doesNotThrow(() => assertBlackScriptExpectedTargetFills({
  evaluation: bracketFilled,
  priorHandles: settledFirstHandles,
  state: {
    commandsByIdempotencyKey: {
      [filledHandle.placeIdempotencyKey]: { status: "SUCCEEDED", executionOrderId: "tp-order" },
    },
    ordersById: { "tp-order": { status: "filled", filledQuantity: 2.5 } },
    ownedPositions: [{ direction: "long", quantity: 7.5 }],
  },
}), "the checkpoint may advance only after the exact target order is fully filled");

const changedLimit = { ...bracketPlan.createOrders[0]!, fingerprint: `${bracketPlan.createOrders[0]!.fingerprint}:repriced`, limitPrice: bracketPlan.createOrders[0]!.limitPrice! + 1 };
const deltaManifest = buildBlackScriptTargetCommandManifest({
  ...manifestRequest,
  evaluation: { ...bracketEvaluation, latestClosedCandleTime: bracketEvaluation.latestClosedCandleTime + 60 },
  plan: {
    ...bracketPlan,
    marketActions: [],
    createOrders: [],
    modifyOrders: [changedLimit],
    cancelOrderKeys: [bracketPlan.createOrders[1]!.key],
    setProtections: [],
    brokerOrderFingerprints: { [changedLimit.key]: changedLimit.fingerprint },
  },
  priorHandles: settledFirstHandles,
});
assert.deepEqual(deltaManifest.commands.map((command) => command.commandType), ["MODIFY_ORDER", "CANCEL_ORDER"]);
assert.equal(deltaManifest.commands[0]?.payload.parentPlaceIdempotencyKey, settledFirstHandles[changedLimit.key]?.placeIdempotencyKey);
assert.equal(Object.keys(deltaManifest.brokerOrderHandles).length, 1, "a retired OCO sibling must be removed from the target handle set");

const percentSource = `strategy(default_qty_type=strategy.percent_of_equity, default_qty_value=20, process_orders_on_close=True)
enter = close > open
trim = close < open
strategy.entry("Core", strategy.long, when=enter)
strategy.close("Core", qty_percent=25, when=trim)`;
const percentVersion = blackScriptOwnedSourceVersion(percentSource);
const percentEntry = evaluateBlackScriptCloudRuntime({
  source: percentSource,
  expectedSourceVersion: percentVersion,
  settings: {},
  closedCandles: firstClosed,
});
assert.equal(percentEntry.marketActions[0]?.quantityMode, "percent_of_equity");
assert.equal(percentEntry.marketActions[0]?.quantityValue, 20);
const percentExit = evaluateBlackScriptCloudRuntime({
  source: percentSource,
  expectedSourceVersion: percentVersion,
  settings: {},
  closedCandles: secondClosed,
  checkpoint: percentEntry.checkpoint,
});
assert.equal(percentExit.marketActions[0]?.action, "CLOSE");
assert.equal(percentExit.marketActions[0]?.quantityMode, "percent_of_position");
assert.equal(percentExit.marketActions[0]?.quantityValue, 25);
const percentManifest = buildBlackScriptTargetCommandManifest({
  ...manifestRequest,
  evaluation: percentExit,
  plan: buildBlackScriptBrokerPlan({ evaluation: percentExit, previousCheckpoint: percentEntry.checkpoint, tickSize: 1 }),
});
assert.equal(percentManifest.commands[0]?.payload.closeQuantity, null);
assert.equal(percentManifest.commands[0]?.payload.closeQuantityPercent, 25);
const closeHandleEntry = Object.entries(percentManifest.brokerOrderHandles)
  .find(([, handle]) => handle.logicalKind === "MARKET_ACTION")!;
assert.deepEqual(settleBlackScriptTargetMarketActions({
  priorHandles: percentManifest.brokerOrderHandles,
  state: {
    commandsByIdempotencyKey: {
      [closeHandleEntry[1].placeIdempotencyKey]: { status: "SUCCEEDED", executionOrderId: "partial-close" },
    },
    ordersById: { "partial-close": { status: "cancelled", quantity: 1, filledQuantity: 1 } },
    ownedPositions: [{ direction: "long", quantity: 3 }],
  },
}), {}, "a terminal partial IOC close settles from its actual positive fill while retaining the intended remainder");
assert.throws(() => settleBlackScriptTargetMarketActions({
  priorHandles: percentManifest.brokerOrderHandles,
  state: {
    commandsByIdempotencyKey: {
      [closeHandleEntry[1].placeIdempotencyKey]: { status: "SUCCEEDED", executionOrderId: "partial-close" },
    },
    ordersById: { "partial-close": { status: "cancelled", quantity: 2, filledQuantity: 1 } },
    ownedPositions: [{ direction: "long", quantity: 3 }],
  },
}), /BLACK_SCRIPT_MARKET_CLOSE_PARTIAL_FILL/, "an underfilled close cannot silently diverge from the deterministic strategy position");

const reversalManifest = buildBlackScriptTargetCommandManifest({
  ...manifestRequest,
  evaluation: reversed,
  plan: buildBlackScriptBrokerPlan({ evaluation: reversed, previousCheckpoint: first.checkpoint, tickSize: 1 }),
});
const reverseHandleEntry = Object.entries(reversalManifest.brokerOrderHandles)
  .find(([, handle]) => handle.logicalKind === "MARKET_ACTION")!;
assert.throws(() => settleBlackScriptTargetMarketActions({
  priorHandles: reversalManifest.brokerOrderHandles,
  state: {
    commandsByIdempotencyKey: {
      [reverseHandleEntry[1].placeIdempotencyKey]: { status: "SUCCEEDED", executionOrderId: "reverse-entry" },
    },
    ordersById: { "reverse-entry": { status: "filled", filledQuantity: 1 } },
    ownedPositions: [{ direction: "long", quantity: 1 }],
  },
}), /BLACK_SCRIPT_MARKET_POSITION_PENDING/, "a reversal cannot settle while the prior side remains open");
assert.deepEqual(settleBlackScriptTargetMarketActions({
  priorHandles: reversalManifest.brokerOrderHandles,
  state: {
    commandsByIdempotencyKey: {
      [reverseHandleEntry[1].placeIdempotencyKey]: { status: "SUCCEEDED", executionOrderId: "reverse-entry" },
    },
    ordersById: { "reverse-entry": { status: "filled", filledQuantity: 1 } },
    ownedPositions: [{ direction: "short", quantity: 1 }],
  },
}), {}, "a reversal settles only after its filled entry and owned target-side position are both authoritative");

assert.throws(() => evaluateBlackScriptCloudRuntime({
  source: reversalSource,
  expectedSourceVersion: "tampered",
  settings: {},
  closedCandles: firstClosed,
}), /SOURCE_VERSION_MISMATCH/, "headless execution must fail closed if the saved source version changes");

console.log("Black Script Black Cloud runtime tests: PASS — version pinning, restart idempotency, reversals and durable exits verified.");
