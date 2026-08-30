import assert from "node:assert/strict";
import fs from "node:fs";
import {
  createSuperAtrSevenStepSignals,
  positionAwareStrategyEntries,
} from "../src/modules/strategy-lab/adapters/signalAdapter.ts";
import {
  calculateStrategyTakeProfitQuantity,
  evaluateStrategyTakeProfitLadder,
  floorStrategyVenueQuantity,
  reserveStrategyTakeProfits,
  resolveStrategyTakeProfitPrice,
  settledStrategyEntryQuantity,
  shouldQueueStrategyTakeProfits,
} from "../server/strategy-automation/superatr-execution.js";
import {
  buildBybitLeverageRequestBody,
  buildBybitModifyOrderRequestBody,
  buildBybitOrderRequestBody,
  normalizeBybitOrderStatus,
} from "../server/exchanges/bybit.js";
import {
  assertRecoveredVenueOrderShape,
  isPotentialPositionGeneration,
  isTerminalVenueOrder,
  isTerminalUnfilledVenueOrder,
  recoveredFollowerAllocation,
  recoveredGroupIntentFromVenue,
  recoveredStrategyOrderDraft,
  reversalCloseLegName,
  summarizeTakeProfitLadderFailure,
  venuePricesEqual,
} from "../server/cloud-execution/worker.js";
import { compileAndRunScript } from "../src/components/ScriptCompiler.ts";
import type { Candle } from "../src/chart-engine/types.ts";

const pineSettings = {
  emaFastLength: 20,
  emaSlowLength: 50,
  stopLossPercent: 1,
  takeProfitRatio: 2,
  superAtrShortPeriod: 3,
  superAtrLongPeriod: 7,
  superAtrMomentumPeriod: 7,
  superAtrConfirmationPeriod: 7,
  superAtrTrendStrengthThreshold: 1.618,
  superAtrMultiStepTakeProfit: true,
  superAtrTakeProfitAtrLength: 14,
  superAtrAtrMultipliers: [2.618, 5, 10, 13.82],
  superAtrFixedPercentages: [3, 8, 17],
  superAtrAtrExitPercent: 10,
  superAtrFixedExitPercent: 10,
};

const candles: Candle[] = Array.from({ length: 1_400 }, (_, index) => {
  const regime = Math.floor(index / 175) % 2 === 0 ? 1 : -1;
  const local = index % 175;
  const priorLocal = Math.max(0, local - 1);
  const wave = Math.sin(index / 11) * 65 + Math.sin(index / 37) * 210;
  const priorWave = Math.sin((index - 1) / 11) * 65 + Math.sin((index - 1) / 37) * 210;
  const close = 30_000 + regime * local * local * 0.095 + wave;
  const open = index === 0 ? close - 10 : 30_000 + regime * priorLocal * priorLocal * 0.095 + priorWave;
  return {
    time: 1_720_000_000 + index * 300,
    open,
    high: Math.max(open, close) + 35 + index % 9,
    low: Math.min(open, close) - 32 - index % 7,
    close,
    volume: 1_000 + index,
  };
});

const actual = createSuperAtrSevenStepSignals(candles, "BTCUSDT", pineSettings);
const expected = pineReferenceSetups(candles, pineSettings);
assert.deepEqual(
  actual.map(({ timestamp, direction }) => ({ timestamp, direction })),
  expected,
  "the certified adapter must match an independent causal transcription of the supplied Pine formulas",
);

for (const cutoff of [120, 260, 511, 900, 1_200]) {
  const prefix = createSuperAtrSevenStepSignals(candles.slice(0, cutoff), "BTCUSDT", pineSettings);
  assert.deepEqual(
    actual.filter((signal) => signal.timestamp <= candles[cutoff - 1]!.time),
    prefix,
    `future bars changed a finalized SuperATR signal before prefix ${cutoff}`,
  );
}

const transitions = positionAwareStrategyEntries([
  signal(100, "long"),
  signal(200, "long"),
  signal(300, "long"),
  signal(400, "short"),
  signal(500, "short"),
  signal(600, "long"),
], 1);
assert.deepEqual(
  transitions.map((item) => [item.timestamp, item.direction, item.metadata?.positionTransition]),
  [[100, "long", "ENTRY"], [400, "short", "REVERSE"], [600, "long", "REVERSE"]],
  "pyramiding=1 must suppress duplicate same-direction setup bars without suppressing true reversals",
);

const pythonSource = fs.readFileSync(new URL("./examples/superatr-seven-step-black-terminal.py", import.meta.url), "utf8");
const pythonResult = compileAndRunScript(pythonSource, candles);
assert.equal(pythonResult.success, true, JSON.stringify(pythonResult.errors));
assert.deepEqual(
  pythonResult.strategy?.fills.filter((fill) => fill.action === "entry").map((fill) => fill.time),
  positionAwareStrategyEntries(actual, 1).map((entry) => entry.timestamp + 300),
  "the saved Python conversion and certified headless adapter must produce identical delayed entries and reversals",
);
const pythonTpFills = pythonResult.strategy?.fills.filter((fill) => fill.action === "exit" && /^TP[1-7] /.test(fill.instructionId)) || [];
assert.ok(pythonTpFills.every((fill) => /^TP[1-7] (Long|Short)$/.test(fill.instructionId)), "the Python runtime emitted an unknown partial-exit identity");
const pythonEntryTimes = pythonResult.strategy?.fills.filter((fill) => fill.action === "entry").map((fill) => fill.time) || [];
assert.equal(
  new Set(pythonTpFills.map((fill) => `${latestEntryTime(pythonEntryTimes, fill.time)}:${fill.instructionId}`)).size,
  pythonTpFills.length,
  "one strategy.exit ID may fill at most once per position",
);

const reserved = reserveStrategyTakeProfits(Array.from({ length: 7 }, (_, index) => ({
  id: `TP${index + 1}`,
  price: 100 + index,
  quantityPercent: 20,
})));
assert.deepEqual(reserved.map((target) => target.quantityPercent), [20, 20, 20, 20, 20]);
assert.equal(reserved.reduce((sum, target) => sum + target.quantityPercent, 0), 100, "Bybit exits cannot reserve more than the original position");
assert.equal(shouldQueueStrategyTakeProfits("ENTRY"), true);
assert.equal(shouldQueueStrategyTakeProfits("REVERSE"), true, "the newly reversed side requires its own TP1-TP7 ladder");
assert.equal(shouldQueueStrategyTakeProfits("CLOSE"), false);
assert.equal(calculateStrategyTakeProfitQuantity(10, 20, 7), 2, "a late TP remains 20% of the original 10-unit fill, not 20% of the reduced remainder");
assert.equal(calculateStrategyTakeProfitQuantity(10, 20, 1.5), 1.5, "the venue request is capped by the actual remaining position");
assert.equal(settledStrategyEntryQuantity({ status: "filled", filledQuantity: 10 }), 10);
assert.equal(settledStrategyEntryQuantity({ status: "partially-filled", filledQuantity: 4 }), null, "TP reservation must wait until the IOC fill is final");
assert.equal(settledStrategyEntryQuantity({ status: "cancelled", filledQuantity: 4 }), 4, "a partially-filled then cancelled IOC reserves from its final cumulative fill");
assert.equal(normalizeBybitOrderStatus("PartiallyFilledCanceled"), "cancelled", "a partially-filled IOC cancellation is terminal instead of waiting forever");
const recoveredEntryOrder = { symbol: "BTCUSDT", category: "linear", side: "buy", orderType: "market", reduceOnly: false, positionIdx: 0, quantity: 0.01, status: "filled" };
assert.doesNotThrow(() => assertRecoveredVenueOrderShape(recoveredEntryOrder, { symbol: "BTCUSDT", category: "linear", side: "buy", orderType: "market", reduceOnly: false, positionIdx: 0 }));
assert.throws(() => assertRecoveredVenueOrderShape(recoveredEntryOrder, { symbol: "ETHUSDT", category: "linear", side: "buy", orderType: "market", reduceOnly: false, positionIdx: 0 }), /unexpected symbol, category, side, type, position index, or reduce-only contract/i);
assert.equal(isTerminalUnfilledVenueOrder({ status: "cancelled", filledQuantity: 0 }), true);
assert.equal(isTerminalUnfilledVenueOrder({ status: "cancelled", filledQuantity: 0.01 }), false, "a terminal partially filled IOC remains an accepted entry generation");
assert.equal(isTerminalVenueOrder(recoveredEntryOrder), true);
assert.equal(isTerminalVenueOrder({ status: "working" }), false);
assert.deepEqual(recoveredStrategyOrderDraft(recoveredEntryOrder, { accountId: "account", symbol: "BTCUSDT", marketKind: "perpetual", clientOrderId: "bt-recovered", source: "strategy-automation-demo", referencePrice: 60_000 }), {
  accountId: "account", symbol: "BTCUSDT", marketKind: "perpetual", side: "buy", orderType: "market", quantity: 0.01, quantityMode: "quantity", referencePrice: 60_000, limitPrice: undefined, takeProfit: undefined, stopLoss: undefined, leverage: 1, marginMode: "cross", reduceOnly: false, positionIdx: 0, timeInForce: "ioc", clientOrderId: "bt-recovered", source: "strategy-automation-demo",
});
assert.equal(recoveredFollowerAllocation({ ...recoveredEntryOrder, averageFillPrice: 60_000 }, { equityUsd: 200, availableBalanceUsd: 180 }, 59_000).targetNotional, 600);
assert.deepEqual(recoveredGroupIntentFromVenue({ id: "intent", symbol: "BTCUSDT", reduce_only: false }, { side: "sell", orderType: "limit", price: 65_000, reduceOnly: true, timeInForce: "gtc" }), {
  id: "intent", symbol: "BTCUSDT", side: "SELL", order_type: "LIMIT", limit_price: 65_000, stop_price: null, take_profit: null, stop_loss: null, reduce_only: true, time_in_force: "GTC",
});
assert.equal(isPotentialPositionGeneration({ status: "rejected", filled_quantity: 0 }), false, "an unfilled rejected order cannot supersede a protected position generation");
assert.equal(isPotentialPositionGeneration({ status: "cancelled", filled_quantity: 0.01 }), true, "a terminal partial fill remains the authoritative position generation");
assert.match(summarizeTakeProfitLadderFailure({ reasons: [{ targetId: "TP1", message: "below minimum" }] }), /TP1: below minimum/);
assert.equal(settledStrategyEntryQuantity({ status: "expired", filledQuantity: 4 }), 4, "an expired IOC is terminal and preserves its final cumulative fill");

assert.equal(floorStrategyVenueQuantity(1.2399, { quantityStep: 0.005, quantityPrecision: 3 }), 1.235);
assert.equal(floorStrategyVenueQuantity(1.2349, { quantityPrecision: 3 }), 1.234);
assert.equal(floorStrategyVenueQuantity(0.0009, { quantityStep: 0.001, quantityPrecision: 3 }), null, "a venue-normalized zero quantity fails closed");
assert.equal(floorStrategyVenueQuantity(1, {}), null, "missing venue quantity rules fail closed");

const validVenueLadder = evaluateStrategyTakeProfitLadder({
  entryQuantity: 1.234,
  targets: [
    { id: "TP1", quantityPercent: 10, price: 100 },
    { id: "TP2", quantityPercent: 20, price: 110 },
    { id: "TP3", quantityPercent: 70, price: 120 },
  ],
  venue: { quantityStep: 0.001, quantityPrecision: 3, minQuantity: 0.01, minNotional: 5 },
});
assert.deepEqual(validVenueLadder, {
  ok: true,
  entryQuantity: 1.234,
  totalReservedQuantity: 1.232,
  remainingQuantity: 0.0020000000000000018,
  legs: [
    { id: "TP1", quantityPercent: 10, price: 100, quantity: 0.123, notional: 12.3 },
    { id: "TP2", quantityPercent: 20, price: 110, quantity: 0.246, notional: 27.06 },
    { id: "TP3", quantityPercent: 70, price: 120, quantity: 0.863, notional: 103.56 },
  ],
  reasons: [],
});

const belowMinimumLadder = evaluateStrategyTakeProfitLadder({
  entryQuantity: 0.05,
  targets: [{ id: "TP1", quantityPercent: 10, price: 100 }],
  venue: { quantityStep: 0.001, quantityPrecision: 3, minQuantity: 0.01, minNotional: 1 },
});
assert.equal(belowMinimumLadder.ok, false);
assert.deepEqual(belowMinimumLadder.legs, [], "one invalid target invalidates the complete executable ladder");
assert.equal(belowMinimumLadder.totalReservedQuantity, 0);
assert.deepEqual(belowMinimumLadder.reasons.map((item) => item.code), ["TP_BELOW_MIN_QUANTITY", "TP_BELOW_MIN_NOTIONAL"]);

const overReservedLadder = evaluateStrategyTakeProfitLadder({
  entryQuantity: 1,
  targets: [
    { id: "TP1", quantityPercent: 60, price: 100 },
    { id: "TP2", quantityPercent: 60, price: 100 },
  ],
  venue: { quantityStep: 0.001, quantityPrecision: 3 },
});
assert.equal(overReservedLadder.ok, false);
assert.deepEqual(overReservedLadder.legs, []);
assert.deepEqual(overReservedLadder.reasons.map((item) => item.code), ["TP_LADDER_PERCENT_EXCEEDS_100", "TP_LADDER_EXCEEDS_ENTRY_QUANTITY"]);

const missingPriceLadder = evaluateStrategyTakeProfitLadder({
  entryQuantity: 1,
  targets: [{ id: "TP1", quantityPercent: 10 }],
  venue: { quantityStep: 0.001, quantityPrecision: 3, minNotional: 5 },
});
assert.equal(missingPriceLadder.ok, false);
assert.deepEqual(missingPriceLadder.reasons.map((item) => item.code), ["TP_PRICE_REQUIRED_FOR_MIN_NOTIONAL"]);

assert.equal(resolveStrategyTakeProfitPrice({ direction: "long", targetBasis: "ATR", targetValue: 2.5, targetAtrValue: 20, targetPrice: 9_999 }, { averagePrice: 1_000 }), 1_050);
assert.equal(resolveStrategyTakeProfitPrice({ direction: "short", targetBasis: "ATR", targetValue: 2.5, targetAtrValue: 20, targetPrice: 1 }, { averagePrice: 1_000 }), 950);
assert.equal(resolveStrategyTakeProfitPrice({ direction: "long", targetBasis: "PERCENT", targetValue: 3, targetPrice: 9_999 }, { averagePrice: 1_000 }), 1_030);
assert.equal(resolveStrategyTakeProfitPrice({ direction: "short", targetBasis: "PERCENT", targetValue: 3, targetPrice: 1 }, { averagePrice: 1_000 }), 970);
assert.equal(resolveStrategyTakeProfitPrice({ direction: "long", targetPrice: 1_234.5 }, { averagePrice: 1_000 }), 1_234.5, "legacy queued commands retain an explicit compatibility price");

const venueMetadata = { quantityPrecision: 3, pricePrecision: 1 };
const entryBody = buildBybitOrderRequestBody({
  marketKind: "perpetual", symbol: "BTCUSDT", side: "buy", orderType: "market",
  quantity: 0.125, timeInForce: "ioc", clientOrderId: "bt-entry", positionIdx: 0,
}, { normalized: { quantity: 0.125 }, metadata: venueMetadata });
assert.deepEqual(entryBody, {
  category: "linear", symbol: "BTCUSDT", side: "Buy", orderType: "Market", qty: "0.125",
  timeInForce: "IOC", orderLinkId: "bt-entry", positionIdx: 0,
});

const takeProfitBody = buildBybitOrderRequestBody({
  marketKind: "perpetual", symbol: "BTCUSDT", side: "sell", orderType: "limit",
  quantity: 0.012, limitPrice: 65_123.4, timeInForce: "gtc", clientOrderId: "bt-tp1",
  reduceOnly: true, positionIdx: 0,
}, { normalized: { quantity: 0.012 }, metadata: venueMetadata });
assert.deepEqual(takeProfitBody, {
  category: "linear", symbol: "BTCUSDT", side: "Sell", orderType: "Limit", qty: "0.012",
  timeInForce: "GTC", orderLinkId: "bt-tp1", price: "65123.4", reduceOnly: true, positionIdx: 0,
});

assert.deepEqual(buildBybitLeverageRequestBody({ category: "linear", symbol: "BTCUSDT", leverage: 5 }), {
  category: "linear", symbol: "BTCUSDT", buyLeverage: "5", sellLeverage: "5",
});
assert.deepEqual(buildBybitLeverageRequestBody({ category: "linear", symbol: "BTCUSDT", buyLeverage: 7, sellLeverage: 3 }), {
  category: "linear", symbol: "BTCUSDT", buyLeverage: "7", sellLeverage: "3",
});
assert.deepEqual(buildBybitModifyOrderRequestBody({ marketKind: "perpetual", symbol: "BTCUSDT", clientOrderId: "bt-tp1", limitPrice: 65_200.5 }), {
  category: "linear", symbol: "BTCUSDT", orderId: undefined, orderLinkId: "bt-tp1", qty: undefined,
  price: "65200.5", triggerPrice: undefined, takeProfit: undefined, stopLoss: undefined,
});
assert.equal(venuePricesEqual(65_200.49, 65_200.5, 0.1), true, "venue confirmation tolerates only sub-half-tick representation noise");
assert.equal(venuePricesEqual(65_200.4, 65_200.5, 0.1), false, "a full-tick difference still requires an amend");
assert.deepEqual([1, 2, 3, 4].map(reversalCloseLegName), ["c", "c2", "c3", "c4"], "residual reversals use bounded deterministic client-order legs");

const signalWorker = fs.readFileSync(new URL("./strategy-automation-worker.ts", import.meta.url), "utf8");
const brokerWorker = fs.readFileSync(new URL("../server/cloud-execution/worker.js", import.meta.url), "utf8");
const groupMigration = fs.readFileSync(new URL("../supabase/migrations/202608300003_strategy_superatr_group_take_profits.sql", import.meta.url), "utf8");
const repriceMigration = fs.readFileSync(new URL("../supabase/migrations/202608300005_strategy_superatr_live_repricing.sql", import.meta.url), "utf8");
assert.match(signalWorker, /shouldQueueStrategyTakeProfits\(action\)/, "direct targets queue TP1-TP7 after entries and reversals");
assert.match(signalWorker, /targetBasis:[\s\S]*targetValue:[\s\S]*targetAtrValue:/, "durable commands retain the Pine target formula");
assert.match(signalWorker, /parentEntryIdempotencyKey: idempotencyKey/, "direct TP commands name their immutable parent entry");
assert.match(signalWorker, /parentGroupIntentId: intentId/, "group TP intents name their immutable parent direction intent");
assert.match(brokerWorker, /resolveStrategyTakeProfitPrice\(payload, position\)/, "direct target prices anchor to authoritative Bybit average fill");
assert.match(brokerWorker, /parentCommand\.status !== "SUCCEEDED"[\s\S]*STRATEGY_TAKE_PROFIT_WAITING_FOR_PARENT_ENTRY/, "direct targets cannot pass the parent-entry completion barrier");
assert.match(brokerWorker, /parentOrder\.reduce_only === true[\s\S]*STRATEGY_GROUP_TAKE_PROFIT_WAITING_FOR_PARENT_ENTRY/, "group reversal targets cannot attach to the old reduce-only close leg");
assert.match(brokerWorker, /settledStrategyEntryQuantity\(parentVenueOrder\)[\s\S]*calculateStrategyTakeProfitQuantity\(originalEntryQuantity/, "late TP retries size from the parent's final filled quantity");
assert.match(brokerWorker, /reversalCloseLegName\(legNumber\)[\s\S]*deterministicStrategyLegId\(command\.deterministic_client_order_id, "e"\)/, "group reversal close and entry legs keep separate venue and OMS identities");
assert.match(brokerWorker, /reduceOnly = true[\s\S]*positionIdx = position\.positionIdx/, "partial exits are position-specific reduce-only orders");
assert.match(brokerWorker, /configureLeverage\(leverageConfiguration\)[\s\S]*placeOrder\(orderDraft, venueValidation\)/, "Bybit leverage is configured before the entry request");
assert.match(signalWorker, /command_type: "MODIFY_ORDER"[\s\S]*strategyAction: "TAKE_PROFIT_REPRICE"/, "every confirmed candle can enqueue a durable ATR take-profit amendment");
assert.match(brokerWorker, /TAKE_PROFIT_REPRICE_SUPERSEDED[\s\S]*adapter\.modifyOrder/, "a stale reprice cannot overwrite a newer closed-candle target");
assert.match(brokerWorker, /STRATEGY_TP_REPRICE_WAITING_FOR_CONFIRMATION/, "Bybit's asynchronous amend acknowledgement is reconciled before command completion");
assert.match(brokerWorker, /MAX_STRATEGY_REVERSAL_CLOSE_LEGS[\s\S]*STRATEGY_REVERSE_RESIDUAL_CLOSE_EXHAUSTED/, "partial reversal closes continue through deterministic residual legs and still fail closed at a hard bound");
assert.match(groupMigration, /strategy_action in \('SYNC_DIRECTION','TAKE_PROFIT'\)/, "Investment Group TP intents are admitted by the database contract");
assert.match(repriceMigration, /command_type in \('PLACE_ORDER','EXPAND_GROUP_INTENT','MODIFY_ORDER','CANCEL_ORDER'\)/, "the database admits only explicitly strategy-owned mutation commands");
assert.match(repriceMigration, /pine_checkpoint jsonb/, "confirmed-bar strategy state survives browser and worker restarts");

console.log("SuperATR offline audit PASS — setup parity, prefix no-repaint, duplicate suppression, durable ATR repricing, bounded residual reversal continuation, final-fill TP reservations, venue-fill anchoring, reduce-only API shape, and leverage mapping verified without broker mutation.");

function signal(timestamp: number, direction: "long" | "short") {
  return { timestamp, symbol: "BTCUSDT", direction, entry: true } as const;
}

function latestEntryTime(entries: number[], fillTime: number) {
  let latest = 0;
  for (const time of entries) {
    if (time > fillTime) break;
    latest = time;
  }
  return latest;
}

function pineReferenceSetups(input: Candle[], settings: typeof pineSettings) {
  const closes = input.map((candle) => candle.close);
  const ranges = input.map((candle, index) => index === 0 ? Number.NaN : Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - input[index - 1]!.close),
    Math.abs(candle.low - input[index - 1]!.close),
  ));
  const shortAtr = fullSma(ranges, settings.superAtrShortPeriod);
  const longAtr = fullSma(ranges, settings.superAtrLongPeriod);
  const deviation = fullStdev(closes, settings.superAtrMomentumPeriod);
  const momentum = closes.map((close, index) => index >= settings.superAtrMomentumPeriod
    ? close - closes[index - settings.superAtrMomentumPeriod]!
    : Number.NaN);
  const adaptive = closes.map((_, index) => {
    if (![shortAtr[index], longAtr[index], deviation[index], momentum[index]].every(Number.isFinite)) return Number.NaN;
    const factor = deviation[index] === 0 ? 0 : Math.abs(momentum[index]! / deviation[index]!);
    return (shortAtr[index]! * factor + longAtr[index]!) / (1 + factor);
  });
  const multiples = adaptive.map((value, index) => Number.isFinite(value) && Number.isFinite(momentum[index])
    ? value === 0 ? 0 : momentum[index]! / value!
    : Number.NaN);
  const strength = fullSma(multiples, settings.superAtrMomentumPeriod);
  const shortMa = fullSma(closes, settings.superAtrShortPeriod);
  const longMa = fullSma(closes, settings.superAtrLongPeriod);
  const confirmation = fullSma(adaptive, settings.superAtrConfirmationPeriod);
  return input.flatMap((candle, index) => {
    if (![adaptive[index], strength[index], shortMa[index], longMa[index], confirmation[index]].every(Number.isFinite)) return [];
    const long = shortMa[index]! > longMa[index]!
      && strength[index]! > settings.superAtrTrendStrengthThreshold
      && candle.close > shortMa[index]!
      && adaptive[index]! > confirmation[index]!;
    const short = shortMa[index]! < longMa[index]!
      && strength[index]! < -settings.superAtrTrendStrengthThreshold
      && candle.close < shortMa[index]!
      && adaptive[index]! > confirmation[index]!;
    return long || short ? [{ timestamp: candle.time, direction: long ? "long" as const : "short" as const }] : [];
  });
}

function fullSma(values: number[], length: number) {
  return values.map((_, index) => {
    if (index < length - 1) return Number.NaN;
    const window = values.slice(index - length + 1, index + 1);
    return window.every(Number.isFinite) ? window.reduce((sum, value) => sum + value, 0) / length : Number.NaN;
  });
}

function fullStdev(values: number[], length: number) {
  return values.map((_, index) => {
    if (index < length - 1) return Number.NaN;
    const window = values.slice(index - length + 1, index + 1);
    const average = window.reduce((sum, value) => sum + value, 0) / length;
    return Math.sqrt(window.reduce((sum, value) => sum + (value - average) ** 2, 0) / length);
  });
}
