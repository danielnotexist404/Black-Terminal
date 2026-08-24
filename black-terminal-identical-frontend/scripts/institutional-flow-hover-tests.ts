import assert from "node:assert/strict";
import { nearestHistoricalCoinPrice, oscillatorHoverIndex } from "../src/institutional-flow/oscillatorHoverModel.ts";

assert.equal(oscillatorHoverIndex(100, 100, 320, 96), 0, "left edge selects the oldest oscillator point");
assert.equal(oscillatorHoverIndex(420, 100, 320, 96), 95, "right edge selects the newest oscillator point");
assert.equal(oscillatorHoverIndex(260, 100, 320, 96), 48, "pointer position maps deterministically to the nearest sample");
assert.equal(oscillatorHoverIndex(0, 0, 0, 96), null, "zero-width charts cannot produce a false hover sample");

const history = [
  { time: 1_000, close: 70_000 },
  { time: 1_060, close: 70_100 },
  { time: 1_120, close: 70_250 }
];
assert.deepEqual(nearestHistoricalCoinPrice(history, 1_065_000, 90), history[1], "the closest venue candle supplies the historical coin price");
assert.equal(nearestHistoricalCoinPrice(history, 2_000_000, 90), null, "stale candles cannot masquerade as the hovered historical price");

console.log("Institutional flow oscillator hover tests passed (pointer mapping, nearest-price alignment, and stale-price rejection)." );
