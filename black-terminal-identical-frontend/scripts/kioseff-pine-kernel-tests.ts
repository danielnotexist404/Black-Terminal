import assert from "node:assert/strict";
import {
  pineBinarySearchLeftmost,
  pineBinarySearchRightmost,
  pineGet,
  pineInsert,
  pineRemove,
  pineShift,
  pineSlice,
  pineSortedInsertRightmost
} from "../src/modules/kioseff-stop-loss-clustering/core/pineCollections.ts";
import {
  PineAtr,
  PineHistorySeries,
  PineSma
} from "../src/modules/kioseff-stop-loss-clustering/core/pineSeries.ts";
import {
  pineMedian,
  pinePercentileNearestRank,
  pineSma
} from "../src/modules/kioseff-stop-loss-clustering/core/pineStatistics.ts";
import {
  pineBarDistance,
  pineTimeframeDayChange
} from "../src/modules/kioseff-stop-loss-clustering/core/pineTime.ts";
import {
  PINE_NA,
  pineChange,
  pineFinite,
  pineNa,
  pineNz,
  pineOverlap,
  pineSign
} from "../src/modules/kioseff-stop-loss-clustering/core/pineValue.ts";
import {
  parseDecimalStep,
  pineTickIndex,
  pineTickPrice,
  stableFloatEqual
} from "../src/modules/kioseff-stop-loss-clustering/core/ticks.ts";

assert.equal(pineNa(PINE_NA), true);
assert.equal(pineNa(null), false, "null is not the Pine na sentinel");
assert.equal(pineNa(Number.NaN), false, "NaN is rejected by finite normalization, not conflated in raw state");
assert.equal(pineFinite(Number.NaN), undefined);
assert.equal(pineFinite(null), undefined);
assert.equal(pineNz(undefined), 0);
assert.equal(pineNz(0, 99), 0, "zero is not na");
assert.equal(pineSign(undefined), undefined);
assert.equal(pineSign(-0), 0);
assert.equal(pineChange(5, 2), 3);
assert.equal(pineChange(5, undefined), undefined);
assert.equal(pineOverlap(1, 2, 2, 3), true, "equality is a Pine overlap");

const values = [1, 3, 3, 3, 5];
assert.equal(pineBinarySearchLeftmost(values, 3), 1);
assert.equal(pineBinarySearchRightmost(values, 3), 3);
assert.equal(pineBinarySearchLeftmost(values, 4), 3);
assert.equal(pineBinarySearchRightmost(values, 4), 4);
assert.equal(pineBinarySearchLeftmost(values, 0), -1);
assert.equal(pineBinarySearchRightmost(values, 0), 0);
assert.equal(pineBinarySearchLeftmost(values, 6), 4);
assert.equal(pineBinarySearchRightmost(values, 6), 5);
assert.equal(pineBinarySearchLeftmost([], 1), -1);
assert.equal(pineBinarySearchRightmost([], 1), 0);

const mutable = [1, 3, 5];
pineInsert(mutable, pineBinarySearchRightmost(mutable, 4), 4);
pineSortedInsertRightmost(mutable, 3);
assert.deepEqual(mutable, [1, 3, 3, 4, 5]);
assert.equal(pineGet(mutable, -1), 5);
assert.equal(pineGet(mutable, -2), 4);
assert.deepEqual(pineSlice(mutable, 1, 4), [3, 3, 4]);
assert.equal(pineRemove(mutable, -1), 5);
assert.equal(pineShift(mutable), 1);
assert.throws(() => pineGet([], 0), /out of bounds/);
assert.throws(() => pineShift([]), /empty/);

assert.equal(pinePercentileNearestRank([], 95), undefined);
assert.equal(pinePercentileNearestRank([1], 95), 1);
assert.equal(pinePercentileNearestRank([1, 2, 2, 3], 50), 2);
assert.equal(pinePercentileNearestRank([1, 2, 3, 4], 75), 3);
assert.equal(pineMedian([]), undefined);
assert.equal(pineMedian([1]), 1);
assert.equal(pineMedian([1, 3]), 2);
assert.equal(pineSma([1, 2, 3], 3), 2);
assert.equal(pineSma([undefined, 1, 2], 3), undefined);

const sma = new PineSma(3);
assert.equal(sma.update(1), undefined);
assert.equal(sma.update(undefined), undefined);
assert.equal(sma.update(2), undefined);
assert.equal(sma.update(3), 2);
assert.equal(sma.update(4), 3);

const atr = new PineAtr(14);
const atrValues = Array.from({ length: 14 }, (_, index) => atr.update(2 + index, index, 1 + index));
assert.ok(atrValues.slice(0, 13).every((value) => value === undefined), "ATR warms up for 13 bars");
assert.ok(Number.isFinite(atrValues[13]));

const history = new PineHistorySeries<number>();
history.push(10);
history.push(20);
assert.equal(history.current(), 20);
assert.equal(history.history(1), 10);
assert.equal(history.history(2), undefined);

assert.equal(pineTimeframeDayChange(86_400, 86_399), true);
assert.equal(pineTimeframeDayChange(86_399, 1), false);
assert.equal(
  pineBarDistance({
    assetClass: "crypto",
    currentTime: 1_000_000,
    pivotTime: 700_000,
    chartBarMilliseconds: 100_000,
    currentBarIndex: 10,
    barTimes: []
  }),
  3
);
assert.equal(
  pineBarDistance({
    assetClass: "equity",
    currentTime: 1_000,
    pivotTime: 200,
    chartBarMilliseconds: 60_000,
    currentBarIndex: 4,
    barTimes: [100, 200, 300, 400, 500]
  }),
  3
);

for (const source of ["0.5", "0.05", "0.0005"]) {
  const tick = parseDecimalStep(source);
  assert.equal(pineTickIndex(tick.value * 10, tick), 10);
  assert.ok(stableFloatEqual(pineTickPrice(10, tick), tick.value * 10));
}
const half = parseDecimalStep("0.5");
assert.equal(pineTickIndex(-0.1, half), -1, "generic negative prices retain floor semantics");

console.log("Kioseff Pine semantic kernel tests passed.");
