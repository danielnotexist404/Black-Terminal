import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { calculateInstitutionalVwap } from "../src/chart-engine/indicators/institutionalVwap.ts";
import { defaultVwapSettings } from "../src/chart-engine/profile/volumeProfileDefaults.ts";
import type { Candle, VwapAnchorMode, VwapSettings, VwapWeightingModel } from "../src/chart-engine/types.ts";

const candle = (time: number, close: number, volume: number, range = 0): Candle => ({
  time,
  open: close,
  high: close + range / 2,
  low: close - range / 2,
  close,
  volume
});

const nearlyEqual = (actual: number, expected: number, epsilon = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, "expected " + expected + ", received " + actual);
};

const sessionSettings: VwapSettings = {
  ...defaultVwapSettings,
  source: "close",
  weightingModel: "volume",
  anchorMode: "session",
  sessionAnchorHourUtc: 0,
  smoothingMethod: "none"
};
const day = 86_400;
const sessionCandles = [
  candle(day, 100, 1),
  candle(day + 60, 110, 2),
  candle(day + 120, 120, 1),
  candle(day * 2, 130, 1),
  candle(day * 2 + 60, 150, 3)
];
const session = calculateInstitutionalVwap(sessionCandles, sessionSettings);
nearlyEqual(session.points[0].value, 100);
nearlyEqual(session.points[1].value, 106.66666666666667);
nearlyEqual(session.points[2].value, 110);
nearlyEqual(session.points[3].value, 130);
nearlyEqual(session.points[4].value, 145);
nearlyEqual(session.points[3].previousVwap!, 110);
assert.deepEqual(session.anchorIndices, [0, 3], "session VWAP must reset on stable UTC boundaries");

const rolling = calculateInstitutionalVwap(
  [candle(day, 10, 1), candle(day + 60, 20, 3), candle(day + 120, 30, 1)],
  { ...sessionSettings, anchorMode: "rolling", lookbackBars: 2 }
);
nearlyEqual(rolling.points[0].value, 10);
nearlyEqual(rolling.points[1].value, 17.5);
nearlyEqual(rolling.points[2].value, 22.5);

const eventCandles = [
  candle(day, 100, 10, 2),
  candle(day + 60, 110, 20, 3),
  candle(day + 120, 90, 500, 20),
  candle(day + 180, 105, 30, 2)
];
const swingHigh = calculateInstitutionalVwap(eventCandles, {
  ...sessionSettings,
  anchorMode: "swingHigh",
  anchorLookbackBars: 100
});
assert.equal(swingHigh.activeAnchorIndex, 1);
assert.ok(Number.isNaN(swingHigh.points[0].value));
const swingLow = calculateInstitutionalVwap(eventCandles, {
  ...sessionSettings,
  anchorMode: "swingLow",
  anchorLookbackBars: 100
});
assert.equal(swingLow.activeAnchorIndex, 2);
const volumeClimax = calculateInstitutionalVwap(eventCandles, {
  ...sessionSettings,
  anchorMode: "volumeClimax",
  anchorLookbackBars: 100
});
assert.equal(volumeClimax.activeAnchorIndex, 2);

const anchors: VwapAnchorMode[] = [
  "session",
  "week",
  "month",
  "fullHistory",
  "rolling",
  "swingHigh",
  "swingLow",
  "volumeClimax",
  "volatilityBreak",
  "autoRegime"
];
const weights: VwapWeightingModel[] = [
  "volume",
  "time",
  "exponentialVolume",
  "liquidityAdjusted",
  "volatilityParticipation",
  "directionalConviction",
  "blackCoreHybrid"
];
for (const anchorMode of anchors) {
  for (const weightingModel of weights) {
    const result = calculateInstitutionalVwap(eventCandles, {
      ...defaultVwapSettings,
      anchorMode,
      weightingModel,
      source: "weightedClose"
    });
    assert.equal(result.points.length, eventCandles.length);
    assert.ok(
      result.points.some((point) => Number.isFinite(point.value)),
      anchorMode + "/" + weightingModel + " must produce a finite VWAP"
    );
  }
}

const performanceCandles: Candle[] = Array.from({ length: 22_000 }, (_, index) => {
  const center = 62_000 + Math.sin(index / 71) * 1_800 + index * 0.035;
  const spread = 35 + (index % 47) * 1.7;
  return {
    time: 1_720_000_000 + index * 60,
    open: center - Math.sin(index) * 12,
    high: center + spread,
    low: center - spread * 0.9,
    close: center + Math.cos(index / 11) * 18,
    volume: 100 + (index % 131) * 8 + (index % 701 === 0 ? 25_000 : 0)
  };
});
const started = performance.now();
const institutional = calculateInstitutionalVwap(performanceCandles, {
  ...defaultVwapSettings,
  preset: "Black Core Adaptive",
  anchorMode: "autoRegime",
  weightingModel: "blackCoreHybrid",
  bandMode: "microstructure",
  dynamicSlopeColor: true
});
const buildMs = performance.now() - started;
assert.equal(institutional.points.length, performanceCandles.length);
assert.ok(Number.isFinite(institutional.points.at(-1)?.value));
assert.ok(buildMs < 1_000, "22,000-bar institutional VWAP exceeded the 1s budget: " + buildMs.toFixed(1) + "ms");

console.log(JSON.stringify({
  decision: "PASS",
  sessionAnchors: session.anchorIndices,
  modes: anchors.length,
  weightingModels: weights.length,
  bars: performanceCandles.length,
  buildMs: Number(buildMs.toFixed(2))
}, null, 2));
