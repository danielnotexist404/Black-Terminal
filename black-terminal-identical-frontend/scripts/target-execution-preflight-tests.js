import assert from "node:assert/strict";
import fs from "node:fs";
import { preflightTargetExecution } from "../server/strategy-automation/target-execution-preflight.js";
import {
  bybitKlineCloseTimeMs,
  resolveBybitKlineInterval,
  validateBybitClosedKlineSnapshot,
} from "../server/exchanges/bybit.js";
import {
  latestBindingExecutionTelemetry,
  strategyTakeProfitPercentages,
  superAtrTakeProfitPreflightPrices,
} from "../server/strategy-automation/repository.js";

const basePolicy = {
  strategyAllocationMode: "PERCENT_ACCOUNT_EQUITY",
  strategyAllocationValue: 100,
  tradeAmountMode: "PERCENT_ACCOUNT_EQUITY",
  tradeAmountValue: 20,
  requestedLeverage: 5,
  requestedLongLeverage: 5,
  requestedShortLeverage: 3,
  maximumLeverage: 10,
  maximumPositionPercent: 100,
  maximumExposurePercent: 100,
  maximumDailyLoss: 100,
  maximumDrawdown: 20,
  maximumPositions: 1,
  slippageBps: 5,
  marginMode: "CROSS",
};

const venue = { quantityStep: 0.001, quantityPrecision: 3, minQuantity: 0.01, minNotional: 5 };

const strategyRepositorySource = fs.readFileSync(new URL("../server/strategy-automation/repository.js", import.meta.url), "utf8");
assert.match(strategyRepositorySource, /binding\.market_type === "SPOT"[\s\S]*Spot automation with strategy take-profits is blocked/, "arm/resume rejects Spot targets whose strategy protection cannot be certified");

assert.deepEqual(strategyTakeProfitPercentages({
  runtimeKind: "builtin-superatr-seven-step",
  settings: { superAtrAtrExitPercent: 10, superAtrFixedExitPercent: 15 },
}), [10, 10, 10, 10, 15, 15, 15], "arm-time preflight derives the same seven allocations as the SuperATR runtime");
assert.deepEqual(strategyTakeProfitPercentages({
  runtimeKind: "builtin-superatr-seven-step",
  settings: { superAtrMultiStepTakeProfit: false },
}), [], "disabling the native ladder removes TP minimums from arm-time preflight");
assert.deepEqual(strategyTakeProfitPercentages({
  runtimeKind: "builtin-superatr-seven-step",
  settings: { superAtrAtrExitPercent: null, superAtrFixedExitPercent: null },
}), [10, 10, 10, 10, 10, 10, 10], "null persisted percentages use the same 10% defaults as the runtime");

const formulaPrices = superAtrTakeProfitPreflightPrices({
  settings: {
    superAtrTakeProfitAtrLength: 2,
    superAtrAtrMultipliers: [1, 2, 3, 4],
    superAtrFixedPercentages: [10, 20, 30],
  },
}, 100, { timeframe: "5m", serverTimeMs: Date.UTC(2026, 7, 31, 0, 12), candles: [
  { time: Date.UTC(2026, 7, 31, 0, 0), open: 100, high: 110, low: 90, close: 100 },
  { time: Date.UTC(2026, 7, 31, 0, 5), open: 100, high: 115, low: 95, close: 105 },
] });
assert.equal(formulaPrices.ok, true);
assert.equal(formulaPrices.atrValue, 20, "arm-time pricing uses Pine/Wilder ATR from authoritative closed candles");
assert.deepEqual(formulaPrices.directions.long.prices.map((price) => Number(price.toFixed(8))), [120, 140, 160, 180, 110, 120, 130]);
assert.deepEqual(formulaPrices.directions.short.prices.map((price) => Number(price.toFixed(8))), [80, 60, 40, 20, 90, 80, 70]);
assert.equal(formulaPrices.basis, "SUPERATR_LATEST_CLOSED_CANDLE_FORMULAS");
assert.equal(superAtrTakeProfitPreflightPrices({ settings: {
  superAtrTakeProfitAtrLength: 2,
  superAtrAtrMultipliers: [1, 2, 3, 6],
  superAtrFixedPercentages: [10, 20, 30],
} }, 100, { timeframe: "5m", serverTimeMs: Date.UTC(2026, 7, 31, 0, 12), candles: [
  { time: Date.UTC(2026, 7, 31, 0, 0), high: 110, low: 90, close: 100 },
  { time: Date.UTC(2026, 7, 31, 0, 5), high: 115, low: 95, close: 105 },
] }).ok, false, "activation fails closed when an exact short TP formula is non-positive");

const olderFailedGeneration = {
  status: "FAILED",
  strategy_signal_key: "signal-old:binding:entry",
  payload: { action: "ENTRY", direction: "long" },
  last_error_code: "OLD_FAILURE",
  created_at: "2026-08-31T00:00:00.000Z",
  updated_at: "2026-08-31T00:01:00.000Z",
};
const newestSuccessfulGeneration = {
  status: "SUCCEEDED",
  strategy_signal_key: "signal-new:binding:reverse",
  payload: { action: "REVERSE", direction: "short" },
  created_at: "2026-08-31T01:00:00.000Z",
  updated_at: "2026-08-31T01:01:00.000Z",
};
assert.deepEqual(
  latestBindingExecutionTelemetry([olderFailedGeneration, newestSuccessfulGeneration]),
  {},
  "a successful newer command generation clears an older failure",
);
const deadLetterChild = {
  status: "DEAD_LETTER",
  strategy_signal_key: "signal-new:binding:tp1",
  payload: { action: "TAKE_PROFIT", direction: "short", parentStrategySignalKey: newestSuccessfulGeneration.strategy_signal_key },
  last_error_code: "TP_SUBMISSION_EXHAUSTED",
  last_error_message: "TP submission could not be reconciled.",
  created_at: "2026-08-31T01:00:01.000Z",
  updated_at: "2026-08-31T01:02:00.000Z",
};
assert.equal(
  latestBindingExecutionTelemetry([olderFailedGeneration, newestSuccessfulGeneration, deadLetterChild]).latestExecutionStatus,
  "DEAD_LETTER",
  "a terminal child failure in the latest primary generation remains visible",
);
const failedReprice = {
  status: "FAILED",
  strategy_signal_key: "signal-new:binding:tp1:reprice",
  execution_order_id: "tp-order-1",
  payload: { strategyAction: "TAKE_PROFIT_REPRICE", direction: "short", expectedEntryOrderId: "entry-order-new" },
  last_error_code: "TP_REPRICE_REJECTED",
  created_at: "2026-08-31T01:03:00.000Z",
  updated_at: "2026-08-31T01:04:00.000Z",
};
assert.equal(
  latestBindingExecutionTelemetry([{ ...newestSuccessfulGeneration, execution_order_id: "entry-order-new" }, failedReprice]).latestExecutionErrorCode,
  "TP_REPRICE_REJECTED",
  "a protection reprice failure linked to the latest entry remains prominent",
);
const unfilledCancellation = {
  status: "CANCELLED",
  strategy_signal_key: "signal-new:binding:tp1",
  payload: { action: "TAKE_PROFIT", direction: "short", parentStrategySignalKey: newestSuccessfulGeneration.strategy_signal_key },
  last_error_code: "PARENT_ENTRY_UNFILLED",
  last_error_message: "The parent IOC entry terminated without a fill.",
  created_at: "2026-08-31T01:00:01.000Z",
  updated_at: "2026-08-31T01:02:30.000Z",
};
assert.equal(
  latestBindingExecutionTelemetry([newestSuccessfulGeneration, unfilledCancellation]).latestExecutionStatus,
  "CANCELLED",
  "a dependent TP cancellation caused by an unfilled entry is not hidden",
);
assert.deepEqual(
  latestBindingExecutionTelemetry([newestSuccessfulGeneration, deadLetterChild], { updated_at: "2026-08-31T01:03:00.000Z" }),
  {},
  "reconfiguration after a failure clears stale execution telemetry",
);

const executable = preflightTargetExecution({
  equity: 10_000,
  availableBalance: 8_000,
  capitalPolicy: basePolicy,
  direction: "long",
  directionSpecificLeverageCaps: { long: { providerCap: 100, riskTierCap: 50 } },
  referencePrice: 100,
  venue,
  takeProfitPercentages: [10, 10, 10, 10, 10, 10, 10],
});
assert.equal(executable.ok, true);
assert.equal(executable.effectiveLeverage, 5);
assert.equal(executable.estimated.rawEntryQuantity, 100);
assert.equal(executable.estimated.entryQuantity, 100);
assert.equal(executable.estimated.entryNotional, 10_000);
assert.equal(executable.estimated.entryMargin, 2_000);
assert.equal(executable.fullLadder.feasible, true);
assert.equal(executable.fullLadder.legs.length, 7);
assert.equal(executable.fullLadder.priceBasis, "REFERENCE_PRICE", "TP pricing falls back to the entry reference price when no override is supplied");
assert.equal(executable.pricing.takeProfitReferencePriceFallback, true);

const aboveMarketMaximum = preflightTargetExecution({
  equity: 10_000,
  availableBalance: 10_000,
  capitalPolicy: basePolicy,
  direction: "long",
  referencePrice: 100,
  venue: { ...venue, maxQuantity: 1_000, maxMarketQuantity: 50 },
  takeProfitPercentages: [],
});
assert.equal(aboveMarketMaximum.ok, false, "arm-time sizing rejects entries above Bybit's market-order maximum");
assert.ok(aboveMarketMaximum.reasonDetails.some((reason) => reason.code === "ENTRY_ABOVE_MAX_MARKET_QUANTITY"));

const separateLimitMaximum = preflightTargetExecution({
  equity: 10_000,
  availableBalance: 10_000,
  capitalPolicy: basePolicy,
  direction: "long",
  referencePrice: 100,
  venue: { ...venue, maxQuantity: 10, maxMarketQuantity: 200 },
  takeProfitPercentages: [20],
});
assert.equal(separateLimitMaximum.estimated.entryQuantity, 100, "the distinct market ceiling admits the entry");
assert.equal(separateLimitMaximum.ok, false, "the protective limit child still obeys maxQuantity");
assert.ok(separateLimitMaximum.reasonDetails.some((reason) => reason.code === "TAKE_PROFIT_ABOVE_MAX_QUANTITY"));

const limitMaximumFallback = preflightTargetExecution({
  equity: 10_000,
  availableBalance: 10_000,
  capitalPolicy: basePolicy,
  direction: "long",
  referencePrice: 100,
  venue: { ...venue, maxQuantity: 50 },
  takeProfitPercentages: [],
});
assert.equal(limitMaximumFallback.ok, false, "maxQuantity is the conservative market ceiling when Bybit omits maxMarketQuantity");

const directionalCap = preflightTargetExecution({
  equity: 10_000,
  availableBalance: 10_000,
  capitalPolicy: basePolicy,
  direction: "short",
  directionSpecificLeverageCaps: { short: { accountRiskCap: 2, providerCap: 100 } },
  referencePrice: 100,
  venue,
  takeProfitPercentages: [],
});
assert.equal(directionalCap.effectiveLeverage, 2, "the selected direction and the tightest live cap determine leverage");
assert.equal(directionalCap.estimated.entryMargin, 2_000);
assert.equal(directionalCap.estimated.entryNotional, 4_000);

const undersizedSevenLeg = preflightTargetExecution({
  equity: 200,
  availableBalance: 200,
  capitalPolicy: { ...basePolicy, tradeAmountValue: 10, requestedLeverage: 1, requestedLongLeverage: 1, maximumLeverage: 1 },
  direction: "long",
  directionSpecificLeverageCaps: { long: { providerCap: 100 } },
  referencePrice: 100,
  venue,
  takeProfitPercentages: [10, 10, 10, 10, 10, 10, 10],
});
assert.equal(undersizedSevenLeg.ok, false);
assert.equal(undersizedSevenLeg.estimated.entryQuantity, 0.2, "preflight preserves the configured risk-bounded size");
assert.equal(undersizedSevenLeg.estimated.entryNotional, 20);
assert.equal(undersizedSevenLeg.estimated.entryMargin, 20);
assert.equal(undersizedSevenLeg.fullLadder.legs.length, 0, "a failed ladder exposes no partly executable leg set");
assert.equal(undersizedSevenLeg.minimumExecutable.entryQuantity, 0.5);
assert.equal(undersizedSevenLeg.minimumExecutable.entryNotional, 50);
assert.equal(undersizedSevenLeg.minimumExecutable.entryMargin, 50);
assert.equal(undersizedSevenLeg.minimumExecutable.tradePercent, 25);
assert.equal(undersizedSevenLeg.minimumExecutable.tradePercentBasis, "ACCOUNT_EQUITY");
assert.equal(undersizedSevenLeg.minimumExecutable.withinConfiguredRiskBoundedSize, false);
assert.match(undersizedSevenLeg.minimumExecutable.reasons.join(" "), /will not increase/i);

const conservativeShortTakeProfitPrice = preflightTargetExecution({
  equity: 500,
  availableBalance: 500,
  capitalPolicy: {
    ...basePolicy,
    tradeAmountValue: 10,
    requestedLeverage: 1,
    requestedShortLeverage: 1,
    maximumLeverage: 1,
  },
  direction: "short",
  referencePrice: 100,
  takeProfitReferencePrice: 80,
  takeProfitPriceBasis: "SHORT_FORMULA_TEST_BOUND",
  venue: { quantityStep: 0.001, quantityPrecision: 3, minQuantity: 0.001, minNotional: 5 },
  takeProfitPercentages: [10, 10, 10, 10, 10, 10, 10],
});
assert.equal(conservativeShortTakeProfitPrice.estimated.entryQuantity, 0.5);
assert.equal(conservativeShortTakeProfitPrice.ok, false, "short TPs are rejected when their lower conservative price puts each child below minNotional");
assert.equal(conservativeShortTakeProfitPrice.minimumExecutable.entryQuantity, 0.63, "5 USDT at the 80 USDT TP basis requires 0.063 per 10% child and a 0.630 entry");
assert.equal(conservativeShortTakeProfitPrice.fullLadder.priceBasis, "SHORT_FORMULA_TEST_BOUND");
assert.equal(conservativeShortTakeProfitPrice.fullLadder.referencePrice, 80);
assert.equal(conservativeShortTakeProfitPrice.minimumExecutable.takeProfitPriceBasis, "SHORT_FORMULA_TEST_BOUND");
assert.equal(conservativeShortTakeProfitPrice.minimumExecutable.takeProfitReferencePrice, 80);
assert.equal(conservativeShortTakeProfitPrice.pricing.takeProfitReferencePriceFallback, false);

const invalidExplicitTakeProfitPrice = preflightTargetExecution({
  equity: 500,
  availableBalance: 500,
  capitalPolicy: basePolicy,
  direction: "short",
  referencePrice: 100,
  takeProfitReferencePrice: 0,
  venue,
  takeProfitPercentages: [10],
});
assert.equal(invalidExplicitTakeProfitPrice.ok, false, "an explicitly invalid TP reference cannot fall back to the entry price");
assert.ok(invalidExplicitTakeProfitPrice.reasonDetails.some((reason) => reason.code === "TAKE_PROFIT_REFERENCE_PRICE_INVALID"));

const exactFloor = preflightTargetExecution({
  equity: 1_000,
  availableBalance: 1_000,
  capitalPolicy: {
    ...basePolicy,
    tradeAmountMode: "FIXED_QUANTITY",
    tradeAmountValue: 1.2399,
    requestedLeverage: 1,
    requestedLongLeverage: 1,
    maximumLeverage: 1,
  },
  direction: "long",
  referencePrice: 100,
  venue: { quantityStep: 0.005, quantityPrecision: 3, minQuantity: 0.005, minNotional: 0 },
  takeProfitPercentages: [],
});
assert.equal(exactFloor.estimated.entryQuantity, 1.235);
assert.equal(exactFloor.estimated.entryNotional, 123.50000000000001);
assert.equal(exactFloor.estimated.entryMargin, 123.50000000000001);

const minimumQuantityDriven = preflightTargetExecution({
  equity: 10,
  availableBalance: 10,
  capitalPolicy: { ...basePolicy, tradeAmountValue: 1, requestedLeverage: 1, requestedLongLeverage: 1, maximumLeverage: 1 },
  direction: "long",
  referencePrice: 100,
  venue: { quantityStep: 0.001, quantityPrecision: 3, minQuantity: 0.01, minNotional: 0 },
  takeProfitPercentages: [10],
});
assert.equal(minimumQuantityDriven.minimumExecutable.entryQuantity, 0.1);

const lowPercentHighMinimum = preflightTargetExecution({
  equity: 1_000_000,
  availableBalance: 1_000_000,
  capitalPolicy: { ...basePolicy, requestedLeverage: 1, requestedLongLeverage: 1, maximumLeverage: 1 },
  direction: "long",
  referencePrice: 3.7,
  venue: { quantityStep: 0.001, quantityPrecision: 3, minQuantity: 0.002, minNotional: 5 },
  takeProfitPercentages: [1, 1, 1, 1, 1, 1, 1],
});
assert.equal(lowPercentHighMinimum.minimumExecutable.available, true);
assert.equal(lowPercentHighMinimum.minimumExecutable.entryQuantity, 135.2, "each TP minimum is stepped before deriving the minimum entry");

const reserved = preflightTargetExecution({
  equity: 10_000,
  availableBalance: 10_000,
  capitalPolicy: basePolicy,
  direction: "long",
  referencePrice: 100,
  venue,
  takeProfitPercentages: [60, 60],
});
assert.deepEqual(reserved.fullLadder.effectivePercentages, [60, 40], "later TP allocation is reduced to TradingView's unreserved remainder");

const zeroBalance = preflightTargetExecution({
  equity: 10_000,
  availableBalance: 0,
  capitalPolicy: basePolicy,
  direction: "long",
  referencePrice: 100,
  venue,
  takeProfitPercentages: [],
});
assert.equal(zeroBalance.ok, false);
assert.equal(zeroBalance.estimated.entryQuantity, null);
assert.match(zeroBalance.reasons.join(" "), /zero after applying/i);

const invalidStep = preflightTargetExecution({
  equity: 10_000,
  availableBalance: 10_000,
  capitalPolicy: basePolicy,
  direction: "long",
  referencePrice: 100,
  venue: { quantityStep: 0, minQuantity: 0.01, minNotional: 5 },
  takeProfitPercentages: [10],
});
assert.equal(invalidStep.ok, false);
assert.equal(invalidStep.minimumExecutable.available, false);
assert.match(invalidStep.reasons.join(" "), /quantity step/i);

const noCapIncrease = preflightTargetExecution({
  equity: 10_000,
  availableBalance: 10_000,
  capitalPolicy: basePolicy,
  direction: "short",
  directionSpecificLeverageCaps: { short: { targetMaximum: 5, providerCap: 100 } },
  referencePrice: 100,
  venue,
  takeProfitPercentages: [],
});
assert.equal(noCapIncrease.effectiveLeverage, 3, "a venue maximum is a ceiling and never raises requested leverage");

const fixedQuantityMarginFailure = preflightTargetExecution({
  equity: 1_000,
  availableBalance: 50,
  capitalPolicy: {
    ...basePolicy,
    tradeAmountMode: "FIXED_QUANTITY",
    tradeAmountValue: 10,
    requestedLeverage: 1,
    requestedLongLeverage: 1,
    maximumLeverage: 1,
  },
  direction: "long",
  referencePrice: 100,
  venue,
  takeProfitPercentages: [],
});
assert.equal(fixedQuantityMarginFailure.ok, false);
assert.match(fixedQuantityMarginFailure.reasons.join(" "), /exceeds the available balance/i);

const incidentVenue = { quantityStep: 0.001, quantityPrecision: 3, minQuantity: 0.001, minNotional: 5 };
const incidentTakeProfits = [10, 10, 10, 10, 10, 10, 10];
const mainnetSlotTwo = preflightTargetExecution({
  equity: 202.5,
  availableBalance: 200.4,
  capitalPolicy: {
    ...basePolicy,
    tradeAmountValue: 5,
    requestedLeverage: 7,
    requestedLongLeverage: 7,
    requestedShortLeverage: 7,
    maximumLeverage: 7,
    maximumPositionPercent: 25,
  },
  direction: "short",
  directionSpecificLeverageCaps: { short: { providerCap: 100 } },
  referencePrice: 77_403.68,
  venue: incidentVenue,
  takeProfitPercentages: incidentTakeProfits,
});
assert.equal(mainnetSlotTwo.ok, false, "incident slot two is rejected before arming");
assert.equal(mainnetSlotTwo.estimated.entryQuantity, null, "slot two floors below BTCUSDT's 0.001 quantity step");
assert.equal(mainnetSlotTwo.minimumExecutable.entryQuantity, 0.01, "seven 10% TP legs require at least 0.010 BTC");
assert.equal(mainnetSlotTwo.minimumExecutable.fitsRiskCaps, false, "the minimum ladder exceeds slot two's 25% position cap at 7x");

const mainnetSlotThree = preflightTargetExecution({
  equity: 182.4,
  availableBalance: 148.8,
  capitalPolicy: {
    ...basePolicy,
    tradeAmountValue: 6,
    requestedLeverage: 17,
    requestedLongLeverage: 17,
    requestedShortLeverage: 17,
    maximumLeverage: 25,
    maximumPositionPercent: 25,
  },
  direction: "short",
  directionSpecificLeverageCaps: { short: { providerCap: 100 } },
  referencePrice: 77_403.68,
  venue: incidentVenue,
  takeProfitPercentages: incidentTakeProfits,
});
assert.equal(mainnetSlotThree.ok, false, "incident slot three is rejected before arming");
assert.equal(mainnetSlotThree.estimated.entryQuantity, 0.002, "slot three entry itself clears the venue step");
assert.equal(mainnetSlotThree.fullLadder.feasible, false, "slot three's seven 10% children each floor below the venue step");
assert.equal(mainnetSlotThree.minimumExecutable.entryQuantity, 0.01);
assert.equal(mainnetSlotThree.minimumExecutable.withinConfiguredRiskBoundedSize, false);

const fiveMinuteMs = 5 * 60 * 1000;
const candleBaseMs = Date.UTC(2026, 7, 31, 0, 0);
const freshSnapshot = validateBybitClosedKlineSnapshot({
  timeframe: "5m",
  serverTimeMs: candleBaseMs + 12 * 60 * 1000,
  candles: [
    { time: candleBaseMs, open: 1, high: 2, low: 1, close: 2 },
    { time: candleBaseMs + fiveMinuteMs, open: 2, high: 3, low: 2, close: 3 },
  ],
});
assert.equal(freshSnapshot.ok, true, "the latest fully closed interval is fresh until the following candle closes");
assert.equal(freshSnapshot.latestClosedCandleAt, new Date(candleBaseMs + 2 * fiveMinuteMs).toISOString(), "telemetry records the actual close boundary, not the candle open");
assert.equal(validateBybitClosedKlineSnapshot({
  timeframe: "5m",
  serverTimeMs: candleBaseMs + 12 * 60 * 1000,
  candles: [
    { time: candleBaseMs, open: 1, high: 2, low: 1, close: 2 },
    { time: candleBaseMs + 2 * fiveMinuteMs, open: 2, high: 3, low: 2, close: 3 },
  ],
}).ok, false, "a missing closed interval fails preflight continuity");
assert.match(validateBybitClosedKlineSnapshot({
  timeframe: "5m",
  serverTimeMs: candleBaseMs + 16 * 60 * 1000,
  candles: [
    { time: candleBaseMs, open: 1, high: 2, low: 1, close: 2 },
    { time: candleBaseMs + fiveMinuteMs, open: 2, high: 3, low: 2, close: 3 },
  ],
}).reasons.join(" "), /stale/i, "a window more than one complete interval behind Bybit server time fails closed");
assert.equal(resolveBybitKlineInterval("3h").value, "180", "arm-time Bybit metadata supports the live worker's 3h contract");
const januaryOpen = Date.UTC(2024, 0, 1);
assert.equal(bybitKlineCloseTimeMs(januaryOpen, "1M"), Date.UTC(2024, 1, 1), "monthly closure uses the next UTC calendar month");
assert.equal(bybitKlineCloseTimeMs(Date.UTC(2024, 1, 1), "1M"), Date.UTC(2024, 2, 1), "calendar-month closure preserves leap-February parity");
assert.equal(validateBybitClosedKlineSnapshot({
  timeframe: "1M",
  serverTimeMs: Date.UTC(2024, 2, 15),
  candles: [
    { time: Date.UTC(2024, 0, 1), open: 1, high: 2, low: 1, close: 2 },
    { time: Date.UTC(2024, 1, 1), open: 2, high: 3, low: 2, close: 3 },
  ],
}).latestClosedCandleAt, new Date(Date.UTC(2024, 2, 1)).toISOString(), "monthly snapshots expose the actual calendar close timestamp");

console.log("Target execution preflight tests PASS — venue maxima, candle freshness/continuity, exact floor, directional leverage caps, full-ladder minimums, and no risk auto-increase verified.");
