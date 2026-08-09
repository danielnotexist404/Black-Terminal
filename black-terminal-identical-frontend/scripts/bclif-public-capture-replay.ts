import assert from "node:assert/strict";
import { buildLiquidationFieldSnapshot, stableBrowserPriceGrid } from "../src/modules/liquidation-field/core/exposureRaster.ts";
import {
  DEFAULT_LIQUIDATION_FIELD_SETTINGS,
  migrateLiquidationFieldSettings
} from "../src/modules/liquidation-field/core/settings.ts";
import { bclifExposureHash, bclifModelHash } from "../src/modules/liquidation-field/rendering/displayProjection.ts";
import { bootstrapBybitLiquidationField } from "../src/modules/liquidation-field/data/bybitPublicData.ts";

const requestedHours = Math.max(2, Math.min(6, Number(process.env.BCLIF_CAPTURE_HOURS ?? 2)));
const settings = migrateLiquidationFieldSettings({
  ...DEFAULT_LIQUIDATION_FIELD_SETTINGS,
  horizon: "CUSTOM",
  customHours: requestedHours,
  priceRows: 384,
  timeColumns: 512,
  smoothing: "SHARP"
});
const capturedAt = Date.now();
const bootstrap = await bootstrapBybitLiquidationField([], "BTCUSDT", settings, new AbortController().signal);
assert.ok(bootstrap.frames.length >= 12, "real public capture must contain at least one hour of five-minute evidence");
assert.ok(bootstrap.coverage.openInterestCoveragePercent > 0, "real public capture must contain observed Bybit OI history");
const anchor = bootstrap.frames[0]!;
const grid = stableBrowserPriceGrid(anchor.markPrice, bootstrap.rules.tickSize ?? 0, settings.priceRows, 0.6);
const first = buildLiquidationFieldSnapshot(
  bootstrap.frames,
  [],
  bootstrap.rules,
  settings,
  bootstrap.coverage,
  grid
);
const second = buildLiquidationFieldSnapshot(
  bootstrap.frames,
  [],
  bootstrap.rules,
  settings,
  bootstrap.coverage,
  grid
);
assert.equal(bclifModelHash(first), bclifModelHash(second), "captured replay must rebuild deterministically");
assert.equal(bclifExposureHash(first), bclifExposureHash(second), "captured raw exposure must rebuild deterministically");
assert.deepEqual(first.absoluteDistribution, second.absoluteDistribution);

console.log(JSON.stringify({
  decision: "PASS",
  contract: "BCLIF_PUBLIC_CAPTURE_REPLAY_V1",
  venue: "BYBIT",
  symbol: "BTCUSDT",
  requestedHours,
  capturedAt,
  requestedStart: bootstrap.coverage.requestedStart,
  requestedEnd: bootstrap.coverage.requestedEnd,
  frames: bootstrap.frames.length,
  firstFrameAt: bootstrap.frames[0]!.timestamp,
  lastFrameAt: bootstrap.frames.at(-1)!.timestamp,
  oiCoveragePercent: bootstrap.coverage.openInterestCoveragePercent,
  tradeCoveragePercent: bootstrap.coverage.observedTradeCoveragePercent,
  liquidationCoveragePercent: bootstrap.coverage.liquidationEventCoveragePercent,
  orderbookCoveragePercent: bootstrap.coverage.orderbookCoveragePercent,
  modelHash: bclifModelHash(first),
  exposureHash: bclifExposureHash(first),
  rawShelves: first.rawCohortShelves?.length ?? 0,
  grid: first.absoluteDistribution,
  authority: first.authority,
  limitations: [
    "Public REST capture contains five-minute OI and price-derived entry evidence.",
    "It does not fabricate unavailable historical trades, liquidations, or L2 order books.",
    "No private endpoint, credentials, account data, or execution surface was used."
  ]
}, null, 2));
