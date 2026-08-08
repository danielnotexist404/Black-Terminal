import assert from "node:assert/strict";
import type { BclifTileHorizon } from "../server/liquidation-intelligence/contracts.ts";
import { buildCanonicalFrame } from "../server/liquidation-intelligence/normalization/canonicalFrame.ts";
import { buildCumulativeLiveEdges } from "../server/liquidation-intelligence/tiles/liveEdgeRollup.ts";
import { decodeBclifTile, encodeBclifTile } from "../server/liquidation-intelligence/tiles/tileCodec.ts";
import { buildBclifTile } from "../server/liquidation-intelligence/tiles/tileBuilder.ts";
import { makeColumns, makeOpenInterest, TEST_CADENCE_MS, TEST_MODEL_VERSION, TEST_SOURCE_VERSION } from "./bclif-test-fixtures.ts";

const rows = 16;
const allColumns = makeColumns(480, rows);
const options = {
  symbol: "BTCUSDT",
  modelVersion: TEST_MODEL_VERSION,
  sourceVersion: TEST_SOURCE_VERSION,
  minPrice: 50_000,
  priceStep: 25,
  rows,
  baseTimeStepMs: TEST_CADENCE_MS,
  coverageQuality: "HIGH" as const,
  createdAt: allColumns.at(-1)!.timestamp
};

const prefix = buildCumulativeLiveEdges([], allColumns.slice(0, 180), options);
const appended = buildCumulativeLiveEdges([], allColumns.slice(0, 240), { ...options, priorLiveEdges: prefix });
for (const [horizon, original] of prefix) {
  const current = appended.get(horizon);
  assert.ok(current, `${horizon} prefix must survive a causal append`);
  assert.equal(current.startTime, original.startTime);
  assert.ok(current.columns >= original.columns);
  assertPrefixEqual(current.channels.timestamps, original.channels.timestamps, original.columns);
  for (const channel of ["longExposure", "shortExposure", "combinedExposure", "confidence", "validity", "confirmedIntensity", "confirmedNotional", "confirmedCount"] as const) {
    assertPrefixEqual(current.channels[channel], original.channels[channel], original.columns * rows);
  }
  assertPrefixEqual(current.channels.causalNormalizationLow, original.channels.causalNormalizationLow, original.columns);
  assertPrefixEqual(current.channels.causalNormalizationHigh, original.channels.causalNormalizationHigh, original.columns);
}

const sixHourColumns = allColumns.slice(0, 360);
const sixHourEnd = sixHourColumns.at(-1)!.timestamp;
const finalizedSixHour = decodeBclifTile(encodeBclifTile(buildBclifTile(sixHourColumns, {
  venue: "BYBIT", symbol: "BTCUSDT", marketKind: "linear_perpetual", horizon: "6H", authority: "PERSISTENT_NODE",
  modelVersion: TEST_MODEL_VERSION, sourceVersion: TEST_SOURCE_VERSION, coverageQuality: "HIGH", sourceCutoffTimestamp: sixHourEnd,
  minPrice: options.minPrice, priceStep: options.priceStep, rows, timeStepMs: TEST_CADENCE_MS, createdAt: sixHourEnd
})).bytes);
const beforeBoundary = buildCumulativeLiveEdges([], sixHourColumns, options);
const afterBoundary = buildCumulativeLiveEdges([finalizedSixHour], allColumns.slice(360), { ...options, priorLiveEdges: beforeBoundary });
for (const horizon of ["12H", "1D", "3D", "1W", "3W", "1M"] as BclifTileHorizon[]) {
  const before = beforeBoundary.get(horizon);
  const after = afterBoundary.get(horizon);
  assert.ok(before && after, `${horizon} must continue from its compact prefix across a 6H boundary`);
  assert.ok(after.columns > before.columns, `${horizon} must append beyond ${before.columns} columns (received ${after.columns})`);
  assertPrefixEqual(after.channels.combinedExposure, before.channels.combinedExposure, before.columns * rows);
  assertPrefixEqual(after.channels.causalNormalizationLow, before.channels.causalNormalizationLow, before.columns);
}
assert.equal(afterBoundary.get("6H")?.columns, 120, "the new 6H bucket must restart without inheriting finalized columns");

const oi = makeOpenInterest(120_000, 1_000);
const baseFrameInput = {
  symbol: "BTCUSDT", frameStart: 115_000, frameEnd: 120_000, sourceCutoffTimestamp: 120_000, generatedAt: 120_000,
  sourceVersion: TEST_SOURCE_VERSION, trades: [], liquidations: [], currentOpenInterest: oi, previousOpenInterest: oi,
  ticker: { exchangeTimestamp: 120_000, receivedTimestamp: 120_000, lastPrice: 64_000, markPrice: 64_000, indexPrice: 64_000, basisBps: 0, singleSideOpenInterest: 1_000, fundingRate: 0, bestBid: 63_999, bestAsk: 64_001 },
  ratio: null, book: null,
  sourceAvailability: { trades: true, liquidations: true, orderbook: false, openInterest: true, funding: true, positioning: false }
};
const historical = buildCanonicalFrame(baseFrameInput);
assert.throws(() => buildCanonicalFrame({ ...baseFrameInput, ticker: { ...baseFrameInput.ticker, exchangeTimestamp: 120_001 } }), /future data/);
assert.equal(historical.frame.openInterestDelta, 0);

console.log(JSON.stringify({
  decision: "PASS",
  checkedHorizons: [...afterBoundary.keys()],
  historicalPrefixStable: true,
  crossBoundaryIncremental: true,
  futureInputRejected: true
}, null, 2));

function assertPrefixEqual(actual: ArrayLike<number>, expected: ArrayLike<number>, length: number) {
  assert.equal(expected.length, length);
  assert.deepEqual(Array.from(actual).slice(0, length), Array.from(expected));
}
