import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { BCLIF_MODEL_VERSION, BCLIF_SOURCE_VERSION } from "../src/modules/liquidation-field/core/types.ts";
import { BCLIF_MAX_REQUEST_HOURS, DEFAULT_LIQUIDATION_FIELD_SETTINGS, migrateLiquidationFieldSettings } from "../src/modules/liquidation-field/core/settings.ts";
import type { LiquidationFieldRuntimeStatus, LiquidationFieldSettings, LiquidationFieldSnapshot } from "../src/modules/liquidation-field/core/types.ts";
import {
  decodeLiquidationFieldTile,
  LiquidationFieldTileContractError,
  type DecodedLiquidationFieldTile,
  type PersistentTileManifestMetadata
} from "../src/modules/liquidation-field/data/LiquidationFieldTileCodec.ts";
import {
  assemblePersistentLiquidationField,
  preflightPersistentLiquidationManifestMemory
} from "../src/modules/liquidation-field/data/LiquidationFieldTileAssembler.ts";
import { LiquidationFieldTileCache, liquidationFieldTileCacheKey } from "../src/modules/liquidation-field/data/LiquidationFieldTileCache.ts";
import {
  PersistentLiquidationFieldAccessError,
  PersistentLiquidationFieldClient,
  parsePersistentCoverageGaps,
  persistentLiquidationFieldRequestRange,
  persistentManifestRequestRange,
  persistentStatusDisposition,
  persistentTileQuery,
  resolvePersistentManifestTiles,
  type PersistentLiquidationFieldLoadResult
} from "../src/modules/liquidation-field/data/PersistentLiquidationFieldClient.ts";
import {
  LiquidationFieldController,
  type BrowserLiquidationFieldHandle,
  type PersistentLiquidationFieldAuthorityClient
} from "../src/modules/liquidation-field/data/LiquidationFieldController.ts";
import { resolveLiquidationFieldRenderIntensity, shapeThermalIntensity } from "../src/modules/liquidation-field/rendering/thermalPalette.ts";

assert.equal(
  migrateLiquidationFieldSettings({ horizon: "CUSTOM", customHours: 24 * 180 }).customHours,
  BCLIF_MAX_REQUEST_HOURS,
  "client settings must not permit a custom window larger than the protected manifest API accepts"
);

const valid = buildEnvelope();
const decoded = await decodeLiquidationFieldTile(toArrayBuffer(valid.envelope), valid.metadata);
assert.equal(decoded.metadata.tileId, valid.metadata.tileId);
assert.deepEqual([...decoded.timestamps], [1_000, 2_000, 3_000]);
assert.ok(decoded.combinedExposure.every((value) => Number.isFinite(value) && value >= 0));

const lateCorrection = buildEnvelope({ tileVersion: 1, sourceCutoffTimestamp: 5_000 });
const decodedCorrection = await decodeLiquidationFieldTile(toArrayBuffer(lateCorrection.envelope), lateCorrection.metadata);
assert.equal(decodedCorrection.metadata.tileVersion, 1, "late-data corrections retain the fixed codec tile version");
assert.equal(decodedCorrection.metadata.sourceCutoffTimestamp, 5_000);

const appendedEnvelope = buildEnvelope({ columns: 5, globalScaleMultiplier: 9 });
const decodedAppended = await decodeLiquidationFieldTile(toArrayBuffer(appendedEnvelope.envelope), appendedEnvelope.metadata);
assert.deepEqual(
  [...decodedAppended.combinedExposure.slice(0, decoded.combinedExposure.length)],
  [...decoded.combinedExposure],
  "causal per-column scales must preserve the decoded historical prefix when later columns change global summary scales"
);
assert.deepEqual(
  [...decodedAppended.confirmedNotional.slice(0, decoded.confirmedNotional.length)],
  [...decoded.confirmedNotional],
  "future quantitative liquidation columns must not mutate the decoded notional prefix"
);
assert.deepEqual(
  [...decodedAppended.confirmedCount.slice(0, decoded.confirmedCount.length)],
  [...decoded.confirmedCount],
  "future quantitative liquidation columns must not mutate the decoded event-count prefix"
);

const missingCausalBounds = buildEnvelope({ omitCausalBounds: true });
await assert.rejects(
  decodeLiquidationFieldTile(toArrayBuffer(missingCausalBounds.envelope), missingCausalBounds.metadata),
  (error: unknown) => contractCode(error, "BCLIF_CAUSAL_BOUNDS_REQUIRED")
);
const invalidCausalBounds = buildEnvelope({ invalidCausalBounds: true });
await assert.rejects(
  decodeLiquidationFieldTile(toArrayBuffer(invalidCausalBounds.envelope), invalidCausalBounds.metadata),
  (error: unknown) => contractCode(error, "BCLIF_CAUSAL_BOUNDS_INVALID")
);
const missingColumnScales = buildEnvelope({ omitColumnScales: true });
await assert.rejects(
  decodeLiquidationFieldTile(toArrayBuffer(missingColumnScales.envelope), missingColumnScales.metadata),
  (error: unknown) => contractCode(error, "BCLIF_COLUMN_SCALES_REQUIRED")
);
const invalidColumnScales = buildEnvelope({ invalidColumnScales: true });
await assert.rejects(
  decodeLiquidationFieldTile(toArrayBuffer(invalidColumnScales.envelope), invalidColumnScales.metadata),
  (error: unknown) => contractCode(error, "BCLIF_COLUMN_SCALE_INVALID")
);
const missingConfirmedQuantitative = buildEnvelope({ omitConfirmedQuantitative: true });
await assert.rejects(
  decodeLiquidationFieldTile(toArrayBuffer(missingConfirmedQuantitative.envelope), missingConfirmedQuantitative.metadata),
  (error: unknown) => contractCode(error, "BCLIF_CONFIRMED_QUANTITATIVE_REQUIRED")
);
const invalidConfirmedNotional = buildEnvelope({ invalidConfirmedNotional: true });
await assert.rejects(
  decodeLiquidationFieldTile(toArrayBuffer(invalidConfirmedNotional.envelope), invalidConfirmedNotional.metadata),
  (error: unknown) => contractCode(error, "BCLIF_CONFIRMED_NOTIONAL_INVALID")
);
const inconsistentConfirmedQuantitative = buildEnvelope({ inconsistentConfirmedQuantitative: true });
await assert.rejects(
  decodeLiquidationFieldTile(toArrayBuffer(inconsistentConfirmedQuantitative.envelope), inconsistentConfirmedQuantitative.metadata),
  (error: unknown) => contractCode(error, "BCLIF_CONFIRMED_QUANTITATIVE_INVALID")
);

const shapedLow = shapeThermalIntensity(40, 58);
const shapedMedian = shapeThermalIntensity(165, 58);
const shapedShelf = shapeThermalIntensity(245, 58);
assert.ok(shapedLow <= 2, "low energy must remain in the near-black thermal floor");
assert.ok(shapedMedian <= 2, "the broad median population must remain dark purple");
assert.ok(shapedShelf > shapedMedian && shapeThermalIntensity(255, 58) === 255, "high shelves and rare cores must retain ordered contrast");
assert.ok(shapeThermalIntensity(238, 58) < 16, "the lower edge of a dense visible regime must remain dark");
assert.ok(shapeThermalIntensity(248, 58) > 90 && shapeThermalIntensity(248, 58) < 160, "upper shelves must enter the teal ramp without premature saturation");
assert.ok(shapeThermalIntensity(252, 58) > 170 && shapeThermalIntensity(252, 58) < 220, "high shelves must enter the green ramp without becoming yellow");
assert.equal(shapeThermalIntensity(255, 58), 255, "only the rarest cores should reach the yellow end of the ramp");

const corrupt = Buffer.from(valid.envelope);
corrupt[corrupt.length - 3] ^= 0xff;
await assert.rejects(
  decodeLiquidationFieldTile(toArrayBuffer(corrupt), valid.metadata),
  (error: unknown) => contractCode(error, "BCLIF_OUTER_CHECKSUM")
);
await assert.rejects(
  decodeLiquidationFieldTile(toArrayBuffer(valid.envelope.subarray(0, valid.envelope.length - 1)), valid.metadata),
  (error: unknown) => contractCode(error, "BCLIF_LENGTH")
);

const unsupportedSchema = buildEnvelope({ schemaVersion: 3 });
await assert.rejects(
  decodeLiquidationFieldTile(toArrayBuffer(unsupportedSchema.envelope), unsupportedSchema.metadata),
  (error: unknown) => contractCode(error, "BCLIF_HEADER_BOUND")
);
const unsupportedModel = buildEnvelope({ modelVersion: "BCLIF_MODEL_FUTURE_UNSUPPORTED" });
await assert.rejects(
  decodeLiquidationFieldTile(toArrayBuffer(unsupportedModel.envelope), unsupportedModel.metadata),
  (error: unknown) => contractCode(error, "BCLIF_UNSUPPORTED_VERSION")
);
const nonCanonical = buildEnvelope({ canonicalHeader: false });
await assert.rejects(
  decodeLiquidationFieldTile(toArrayBuffer(nonCanonical.envelope), nonCanonical.metadata),
  (error: unknown) => contractCode(error, "BCLIF_HEADER_CANONICAL")
);
const badInnerChecksum = buildEnvelope({ corruptInnerChecksum: true });
await assert.rejects(
  decodeLiquidationFieldTile(toArrayBuffer(badInnerChecksum.envelope), badInnerChecksum.metadata),
  (error: unknown) => contractCode(error, "BCLIF_PAYLOAD_CHECKSUM")
);

const context = {
  collectorNodeId: "LIQUIDATION_INTELLIGENCE_NODE_01",
  coverage: {
    venue: "BYBIT",
    symbol: "BTCUSDT",
    horizon: "3W",
    requestedStart: 1_000,
    requestedEnd: 3_000,
    modelStart: 1_000,
    modelEnd: 3_000,
    coverage: { trades: 100, openInterest: 100, liquidations: 100, orderbook: 100, funding: 100, continuity: 100 },
    gaps: [{ start: 2_000, end: 3_000, missingSources: ["OPEN_INTEREST"] }],
    quality: "EXCELLENT" as const,
    sourceMode: "PERSISTENT_COLLECTOR" as const,
    updatedAt: 3_000
  }
};
const gapped = assemblePersistentLiquidationField([decoded], context);
assert.ok(gapped.validity.slice(0, 2).every((value) => value === 255));
assert.ok(gapped.validity.slice(2, 4).every((value) => value === 0), "declared gap must mask the intersecting atlas column");
assert.ok(gapped.combinedExposure.slice(2, 4).some((value) => value > 0), "gap masking must retain raw numerical channels behind validity=0");
const secondaryGap = assemblePersistentLiquidationField([decoded], {
  ...context,
  coverage: { ...context.coverage, gaps: [{ start: 2_000, end: 3_000, missingSources: ["ORDERBOOK"] }] }
});
assert.ok(secondaryGap.validity.slice(2, 4).every((value) => value === 255), "a missing secondary source must not erase modeled exposure");
assert.ok(secondaryGap.confidence[2]! < decoded.confidence[2]!, "a missing secondary source must reduce confidence");
const tradeGap = assemblePersistentLiquidationField([decoded], {
  ...context,
  coverage: { ...context.coverage, gaps: [{ start: 2_000, end: 3_000, missingSources: ["TRADE"] }] }
});
const bookFrameGap = assemblePersistentLiquidationField([decoded], {
  ...context,
  coverage: { ...context.coverage, gaps: [{ start: 2_000, end: 3_000, missingSources: ["BOOK_FRAME"] }] }
});
assert.equal(tradeGap.confidence[2], Math.round(decoded.confidence[2]! * 0.72), "collector TRADE gap must receive the canonical trade penalty");
assert.equal(bookFrameGap.confidence[2], Math.round(decoded.confidence[2]! * 0.84), "collector BOOK_FRAME gap must receive the canonical book penalty");

const unknownCoverage = assemblePersistentLiquidationField([decoded], {
  ...context,
  coverage: {
    ...context.coverage,
    coverage: { trades: null, openInterest: null, liquidations: null, orderbook: null, funding: null, continuity: null },
    gaps: []
  }
});
assert.ok(unknownCoverage.validity.every((value) => value === 255), "unknown aggregate coverage must not erase verified tile cells");
assert.ok(unknownCoverage.confidence[0]! < decoded.confidence[0]!, "unknown aggregate coverage must reduce confidence");

const explicitlyUnknownCoverage = assemblePersistentLiquidationField([decoded], {
  ...context,
  coverage: {
    ...context.coverage,
    gaps: [{ start: 2_000, end: 3_000, missingSources: ["OPEN_INTEREST_COVERAGE_UNKNOWN"] }]
  }
});
assert.ok(
  explicitlyUnknownCoverage.validity.slice(2, 4).every((value) => value === 255),
  "an explicit unknown-coverage marker must remain a soft confidence penalty"
);
assert.ok(explicitlyUnknownCoverage.confidence[2]! < decoded.confidence[2]!);

const noValidity: DecodedLiquidationFieldTile = { ...decoded, validity: new Uint8Array(decoded.validity.length) };
const missing = assemblePersistentLiquidationField([noValidity], { ...context, coverage: { ...context.coverage, gaps: [] } });
assert.equal(missing.certainty, "MISSING", "an atlas with no valid cells must use explicit MISSING certainty");

const mixedSource: DecodedLiquidationFieldTile = { ...decoded, sourceVersion: "BYBIT_V5_PUBLIC_FUTURE" };
assert.throws(
  () => assemblePersistentLiquidationField([decoded, mixedSource], context),
  (error: unknown) => contractCode(error, "BCLIF_SOURCE_VERSION")
);

const futureEdge = metadataFor({
  tileId: "9c0a5ea0-079e-4a19-bd00-5f7af0f02411",
  startTime: 1_000,
  endTime: 4_000,
  columns: 4,
  sourceCutoffTimestamp: 4_000
});
assert.throws(
  () => preflightPersistentLiquidationManifestMemory([futureEdge], 64 * 1024 * 1024, { start: 1_000, end: 3_000 }),
  (error: unknown) => contractCode(error, "BCLIF_MANIFEST_LOOKAHEAD")
);

const clippedTile = extendDecodedTile(decoded, {
  tileId: "9c0a5ea0-079e-4a19-bd00-5f7af0f02412",
  startTime: 1_000,
  endTime: 4_000,
  columns: 4,
  sourceCutoffTimestamp: 3_000
});
const clipped = assemblePersistentLiquidationField([clippedTile], context);
assert.deepEqual([...clipped.timestamps], [1_000, 2_000, 3_000], "mid-tile future columns must be clipped from a historical request");

const appendedSnapshot = assemblePersistentLiquidationField([decodedAppended], {
  ...context,
  coverage: {
    ...context.coverage,
    requestedEnd: 5_000,
    modelEnd: 5_000,
    gaps: []
  }
});
const prefixSnapshot = assemblePersistentLiquidationField([decoded], {
  ...context,
  coverage: { ...context.coverage, gaps: [] }
});
const hotMicrotile = sliceDecodedTileColumns(decodedAppended, 3, 2, {
  tileId: "9c0a5ea0-079e-4a19-bd00-5f7af0f02431",
  tileVersion: 1,
  sourceCutoffTimestamp: 5_000,
  publicationState: "STAGING"
});
const rootPlusMicrotile = assemblePersistentLiquidationField([decoded, hotMicrotile], {
  ...context,
  coverage: {
    ...context.coverage,
    requestedEnd: 5_000,
    modelEnd: 5_000,
    gaps: []
  }
});
assert.deepEqual([...rootPlusMicrotile.timestamps], [1_000, 2_000, 3_000, 4_000, 5_000], "finalized root and hot microtile must form one exact lattice without a duplicate seam");
assert.deepEqual([...rootPlusMicrotile.combinedExposure], [...appendedSnapshot.combinedExposure], "a hot microtile must match the equivalent later finalized-root column");
assert.deepEqual([...rootPlusMicrotile.normalizedIntensity], [...appendedSnapshot.normalizedIntensity]);
assert.deepEqual([...rootPlusMicrotile.longNormalizedIntensity], [...appendedSnapshot.longNormalizedIntensity]);
assert.deepEqual([...rootPlusMicrotile.shortNormalizedIntensity], [...appendedSnapshot.shortNormalizedIntensity]);
assert.deepEqual([...rootPlusMicrotile.confirmedNotional], [...appendedSnapshot.confirmedNotional]);
assert.deepEqual([...rootPlusMicrotile.confirmedCount], [...appendedSnapshot.confirmedCount]);
assert.deepEqual(
  [...appendedSnapshot.longNormalizedIntensity.slice(0, prefixSnapshot.longNormalizedIntensity.length)],
  [...prefixSnapshot.longNormalizedIntensity],
  "appending a later column must not repaint historical long-side intensity"
);
assert.deepEqual(
  [...appendedSnapshot.shortNormalizedIntensity.slice(0, prefixSnapshot.shortNormalizedIntensity.length)],
  [...prefixSnapshot.shortNormalizedIntensity],
  "appending a later column must not repaint historical short-side intensity"
);
const viewModes: LiquidationFieldSettings["viewMode"][] = [
  "COMBINED_THERMAL",
  "LONG_EXPOSURE",
  "SHORT_EXPOSURE",
  "DIRECTIONAL_SPLIT",
  "CONFIDENCE_FIELD",
  "CONFIRMED_LIQUIDATIONS",
  "CASCADE_RISK",
  "COMBINED_INTELLIGENCE"
];
for (const viewMode of viewModes) {
  const settings = { ...DEFAULT_LIQUIDATION_FIELD_SETTINGS, viewMode };
  for (let index = 0; index < prefixSnapshot.normalizedIntensity.length; index++) {
    assert.deepEqual(
      resolveLiquidationFieldRenderIntensity(appendedSnapshot, settings, index),
      resolveLiquidationFieldRenderIntensity(prefixSnapshot, settings, index),
      `${viewMode} must preserve the rendered historical prefix after a future append`
    );
  }
}

const hugeManifest = Array.from({ length: 128 }, (_, index) => metadataFor({
  tileId: uuidFor(index),
  columns: 4_096,
  rows: 1_024,
  startTime: 1_000,
  endTime: 4_096_000,
  sourceCutoffTimestamp: 4_096_000
}));
assert.throws(
  () => preflightPersistentLiquidationManifestMemory(hugeManifest, 64 * 1024 * 1024),
  (error: unknown) => contractCode(error, "BCLIF_MANIFEST_MEMORY"),
  "adversarial manifests must fail before any tile download/decode allocation"
);

const finalizedRootMetadata = { ...decoded.metadata, publicationState: "FINALIZED" as const };
const hotMetadata = hotMicrotile.metadata;
const firstHotResolution = resolvePersistentManifestTiles([finalizedRootMetadata], hotMetadata, null, 5_000);
assert.deepEqual(firstHotResolution.tiles.map((tile) => tile.tileId), [finalizedRootMetadata.tileId, hotMetadata.tileId]);
assert.deepEqual(firstHotResolution.nextCursor, {
  tileId: hotMetadata.tileId,
  checksum: hotMetadata.checksum,
  sourceCutoffTimestamp: hotMetadata.sourceCutoffTimestamp,
  tileVersion: hotMetadata.tileVersion,
  columns: hotMetadata.columns
});
const repeatedHotResolution = resolvePersistentManifestTiles(
  [finalizedRootMetadata],
  hotMetadata,
  firstHotResolution.nextCursor,
  5_000
);
assert.deepEqual(repeatedHotResolution.nextCursor, firstHotResolution.nextCursor, "an unchanged live cursor must be idempotent and cacheable");
assert.throws(
  () => resolvePersistentManifestTiles(
    [finalizedRootMetadata],
    { ...hotMetadata, sourceCutoffTimestamp: 5_001 },
    firstHotResolution.nextCursor,
    5_000
  ),
  (error: unknown) => contractCode(error, "BCLIF_LIVE_EDGE_BOUND"),
  "a live microtile may not advance beyond the exact request cutoff"
);
assert.throws(
  () => resolvePersistentManifestTiles(
    [finalizedRootMetadata],
    { ...hotMetadata, sourceCutoffTimestamp: 5_250 },
    { ...firstHotResolution.nextCursor!, sourceCutoffTimestamp: 5_500 },
    6_000
  ),
  (error: unknown) => contractCode(error, "BCLIF_LIVE_EDGE_NON_MONOTONIC"),
  "a live microtile cutoff may not move backwards"
);
assert.throws(
  () => resolvePersistentManifestTiles(
    [finalizedRootMetadata],
    { ...hotMetadata, sourceCutoffTimestamp: 5_500 },
    firstHotResolution.nextCursor,
    6_000
  ),
  (error: unknown) => contractCode(error, "BCLIF_LIVE_EDGE_NON_MONOTONIC"),
  "a newer cutoff must publish a new immutable checksum and additional cumulative columns at the fixed tile version"
);
const advancedHotMetadata = {
  ...hotMetadata,
  columns: 3,
  endTime: 6_000,
  sourceCutoffTimestamp: 6_000,
  checksum: `sha256:${"5".repeat(64)}`
};
assert.deepEqual(
  resolvePersistentManifestTiles(
    [finalizedRootMetadata],
    advancedHotMetadata,
    firstHotResolution.nextCursor,
    6_000
  ).nextCursor,
  {
    tileId: hotMetadata.tileId,
    checksum: advancedHotMetadata.checksum,
    sourceCutoffTimestamp: 6_000,
    tileVersion: hotMetadata.tileVersion,
    columns: 3
  },
  "a cumulative STAGING revision advances at constant codec tileVersion when cutoff, columns, and checksum advance"
);
assert.throws(
  () => resolvePersistentManifestTiles(
    [finalizedRootMetadata],
    { ...hotMetadata, timeStepMs: 500, endTime: 4_500, sourceCutoffTimestamp: 4_500 },
    null,
    5_000
  ),
  (error: unknown) => contractCode(error, "BCLIF_LIVE_EDGE_GENERATION"),
  "a STAGING microtile may not change the finalized root cadence"
);
assert.throws(
  () => resolvePersistentManifestTiles(
    [finalizedRootMetadata],
    { ...hotMetadata, startTime: 3_000, endTime: 4_000, sourceCutoffTimestamp: 4_000 },
    null,
    5_000
  ),
  (error: unknown) => contractCode(error, "BCLIF_LIVE_EDGE_OVERLAP"),
  "a STAGING microtile may not overlap its immutable finalized root"
);
assert.throws(
  () => resolvePersistentManifestTiles(
    [finalizedRootMetadata],
    { ...hotMetadata, columns: 1, endTime: hotMetadata.startTime },
    null,
    5_000
  ),
  (error: unknown) => contractCode(error, "BCLIF_LIVE_EDGE_BOUND"),
  "the collector may not publish a live edge before two cadence columns exist"
);
const finalizedHotMetadata = { ...hotMetadata, publicationState: "FINALIZED" as const };
const closedResolution = resolvePersistentManifestTiles(
  [finalizedRootMetadata, finalizedHotMetadata],
  null,
  firstHotResolution.nextCursor,
  6_000
);
assert.equal(closedResolution.nextCursor, null, "the identical hot payload must retire only after it appears as FINALIZED");
assert.throws(
  () => resolvePersistentManifestTiles([finalizedRootMetadata], null, firstHotResolution.nextCursor, 6_000),
  (error: unknown) => contractCode(error, "BCLIF_LIVE_EDGE_ROLLOVER"),
  "a collector may not silently remove an unfinalized live cursor"
);
const nextHotMetadata = metadataFor({
  ...hotMetadata,
  tileId: "9c0a5ea0-079e-4a19-bd00-5f7af0f02432",
  startTime: 6_000,
  endTime: 7_000,
  columns: 2,
  tileVersion: 1,
  checksum: `sha256:${"4".repeat(64)}`,
  sourceCutoffTimestamp: 7_000,
  publicationState: "STAGING"
});
assert.throws(
  () => resolvePersistentManifestTiles([finalizedRootMetadata], nextHotMetadata, firstHotResolution.nextCursor, 7_000),
  (error: unknown) => contractCode(error, "BCLIF_LIVE_EDGE_ROLLOVER"),
  "a new UTC bucket must not appear before the previous hot cursor is finalized"
);
assert.equal(
  resolvePersistentManifestTiles(
    [finalizedRootMetadata, finalizedHotMetadata],
    nextHotMetadata,
    firstHotResolution.nextCursor,
    7_000
  ).nextCursor?.tileId,
  nextHotMetadata.tileId,
  "a new UTC bucket may advance only after the previous payload is present as a finalized root"
);

const liveRangeNow = Date.UTC(2026, 7, 5, 12, 30, 0);
for (const [label, intervalSeconds] of [["1H", 3_600], ["4H", 14_400], ["1D", 86_400]] as const) {
  const lastOpenSeconds = (liveRangeNow - intervalSeconds * 500) / 1_000;
  const candles = [
    candleAt(lastOpenSeconds - intervalSeconds),
    candleAt(lastOpenSeconds)
  ];
  const liveRange = persistentLiquidationFieldRequestRange(candles, 21 * 86_400_000, false, liveRangeNow);
  assert.equal(liveRange.requestedEnd, liveRangeNow, `${label} live requests must extend past bar-open through the bounded wall-clock cutoff`);
  assert.equal(liveRange.mode, "LIVE");
  assert.ok(liveRange.requestedEnd <= liveRangeNow, `${label} live requests may not authorize future data`);
  assert.ok(liveRange.requestedEnd - 60_000 > lastOpenSeconds * 1_000, `${label} must accept a current minute live-edge snapshot`);
  const replayRange = persistentLiquidationFieldRequestRange(candles, 21 * 86_400_000, true, liveRangeNow);
  assert.equal(replayRange.requestedEnd, lastOpenSeconds * 1_000, `${label} replay must remain pinned to its historical candle cutoff`);
  assert.equal(replayRange.mode, "REPLAY");
}
const staleMarketRange = persistentLiquidationFieldRequestRange(
  [candleAt((liveRangeNow - 4 * 3_600_000) / 1_000), candleAt((liveRangeNow - 3 * 3_600_000) / 1_000)],
  21 * 86_400_000,
  false,
  liveRangeNow
);
assert.equal(staleMarketRange.mode, "REPLAY", "an old bounded chart range may not claim LIVE authority");
assert.throws(
  () => resolvePersistentManifestTiles([finalizedRootMetadata], hotMetadata, null, 5_000, "REPLAY"),
  (error: unknown) => contractCode(error, "BCLIF_REPLAY_LIVE_EDGE"),
  "historical replay must reject every STAGING live edge"
);

assert.throws(
  () => parsePersistentCoverageGaps(
    Array.from({ length: 1_025 }, (_, index) => ({ start: index * 2 + 1, end: index * 2 + 2 })),
    { requestedStart: 0, requestedEnd: 10_000 }
  ),
  (error: unknown) => contractCode(error, "BCLIF_COVERAGE_GAPS_BOUND"),
  "oversized coverage-gap arrays must fail closed instead of being silently truncated"
);
assert.throws(
  () => parsePersistentCoverageGaps(
    [{ start: 999, end: 1_500, missingSources: ["TRADE_COVERAGE_UNKNOWN"] }],
    { requestedStart: 1_000, requestedEnd: 3_000 }
  ),
  (error: unknown) => contractCode(error, "BCLIF_COVERAGE_GAP_SCOPE"),
  "coverage gaps outside the authorized request range must fail closed"
);

const verifiedRange = new URLSearchParams({
  venue: "BYBIT",
  marketKind: "linear_perpetual",
  symbol: "BTCUSDT",
  horizon: "3W",
  from: "1000",
  to: "3000",
  mode: "REPLAY"
});
const directTileQuery = persistentTileQuery(verifiedRange, valid.metadata.tileId, valid.metadata.checksum);
assert.equal(directTileQuery.get("from"), "1000");
assert.equal(directTileQuery.get("to"), "3000");
assert.equal(directTileQuery.get("tileId"), valid.metadata.tileId);
assert.equal(directTileQuery.get("mode"), "REPLAY");
assert.equal(directTileQuery.get("checksum"), valid.metadata.checksum);
assert.deepEqual(
  [...verifiedRange.entries()],
  [...new URLSearchParams({ venue: "BYBIT", marketKind: "linear_perpetual", symbol: "BTCUSDT", horizon: "3W", from: "1000", to: "3000", mode: "REPLAY" }).entries()],
  "building a direct tile request must not mutate its verified manifest query"
);
assert.deepEqual(
  persistentManifestRequestRange({ requestedStart: 1_000, requestedEnd: 3_000, mode: "REPLAY" }, verifiedRange),
  { requestedStart: 1_000, requestedEnd: 3_000, mode: "REPLAY" }
);
assert.throws(
  () => persistentManifestRequestRange({ requestedStart: 1_000, requestedEnd: 4_000, mode: "REPLAY" }, verifiedRange),
  (error: unknown) => contractCode(error, "BCLIF_MANIFEST_REQUEST_SCOPE"),
  "a manifest response may not widen the exact requested replay range"
);
assert.throws(
  () => persistentManifestRequestRange({ requestedStart: 1_000, requestedEnd: 3_000, mode: "LIVE" }, verifiedRange),
  (error: unknown) => contractCode(error, "BCLIF_MANIFEST_REQUEST_SCOPE"),
  "a manifest response may not switch a replay request into live authority"
);
assert.throws(
  () => preflightPersistentLiquidationManifestMemory(
    [{ ...hotMicrotile.metadata, sourceCutoffTimestamp: 5_000 }],
    64 * 1024 * 1024,
    { start: 1_000, end: 4_000 }
  ),
  (error: unknown) => contractCode(error, "BCLIF_MANIFEST_LOOKAHEAD"),
  "an old replay cursor must reject a newer hot microtile cutoff before download"
);

const collector = { nodeId: "LIQUIDATION_INTELLIGENCE_NODE_01" };
assert.equal(persistentStatusDisposition({ deploymentState: "LIVE", modelAuthority: "PERSISTENT_NODE", persistence: true, collector }, 200), "LIVE");
assert.equal(persistentStatusDisposition({ deploymentState: "DEGRADED", modelAuthority: "PERSISTENT_NODE", persistence: true, collector }, 503), "STALE");
assert.equal(persistentStatusDisposition({ deploymentState: "DEGRADED", modelAuthority: "BROWSER_FALLBACK", persistence: true, collector }, 503), null);
assert.equal(persistentStatusDisposition({ deploymentState: "DEGRADED", modelAuthority: "PERSISTENT_NODE", persistence: false, collector }, 503), null);
assert.equal(persistentStatusDisposition({ deploymentState: "DEGRADED", modelAuthority: "PERSISTENT_NODE", persistence: true, collector: null }, 503), null);

const cache = new LiquidationFieldTileCache<string>(12, 60_000);
const cacheA = metadataFor({ tileId: "9c0a5ea0-079e-4a19-bd00-5f7af0f02421" });
const cacheB = metadataFor({ tileId: "9c0a5ea0-079e-4a19-bd00-5f7af0f02422" });
assert.notEqual(liquidationFieldTileCacheKey(cacheA), liquidationFieldTileCacheKey(cacheB));
assert.equal(cache.set(cacheA, "a", 8), true);
assert.equal(cache.set(cacheB, "b", 8), true);
assert.equal(cache.get(cacheA), undefined, "bounded LRU must evict the oldest decoded tile");
assert.equal(cache.get(cacheB), "b");

const revisionCache = new LiquidationFieldTileCache<string>(64, 60_000);
const firstRevision = metadataFor({ tileId: "9c0a5ea0-079e-4a19-bd00-5f7af0f02423" });
const checksumRevision = { ...firstRevision, checksum: `sha256:${"2".repeat(64)}` };
assert.equal(revisionCache.set(firstRevision, "first", 8), true);
assert.equal(revisionCache.set(checksumRevision, "second", 8), true);
assert.equal(revisionCache.get(firstRevision), undefined, "a checksum change must evict the prior decoded tile revision immediately");
assert.equal(revisionCache.get(checksumRevision), "second");
assert.deepEqual(
  { entries: revisionCache.metrics().entries, bytes: revisionCache.metrics().bytes, evictions: revisionCache.metrics().evictions },
  { entries: 1, bytes: 8, evictions: 1 },
  "the cache must retain only the current checksum revision for a tile identity"
);

const pollCache = new LiquidationFieldTileCache<DecodedLiquidationFieldTile>(4 * 1024 * 1024, 60_000);
assert.equal(pollCache.set(decoded.metadata, decoded, decoded.decodedBytes), true);
assert.equal(pollCache.set(hotMicrotile.metadata, hotMicrotile, hotMicrotile.decodedBytes), true);
assert.equal(pollCache.get(decoded.metadata), decoded);
assert.equal(pollCache.get(hotMicrotile.metadata), hotMicrotile);
assert.deepEqual(
  { entries: pollCache.metrics().entries, hits: pollCache.metrics().hits, misses: pollCache.metrics().misses },
  { entries: 2, hits: 2, misses: 0 },
  "a repeated manifest cursor must reuse immutable root and microtile decodes without duplicating cache entries"
);

await certifyBrowserFallbackRecovery(gapped);
await certifyContractFailureStartsQuarantinedFallback();
await certifyRecoveryContractFailureRestoresFallback();
await certifyAccessFailureRemainsFailClosed();
await certifyPersistentMicrotileRefresh(prefixSnapshot, rootPlusMicrotile);
await certifyLiveEdgeRevisionRace();
await certifyMalformedManifestNumerics();

console.log(JSON.stringify({
  decision: "PASS",
  codecSchema: valid.metadata.schemaVersion,
  modelVersion: valid.metadata.modelVersion,
  gapMasked: true,
  historicalClip: true,
  fallbackRecovery: true,
  contractFailureFallback: true,
  accessFailureFailClosed: true,
  persistentMicrotileSeam: true,
  adversarialManifestRejected: true,
  liveEdgeRevisionRace: true,
  boundedCache: cache.metrics()
}, null, 2));

function buildEnvelope(options: {
  schemaVersion?: number;
  modelVersion?: string;
  tileVersion?: number;
  sourceCutoffTimestamp?: number;
  columns?: number;
  startTime?: number;
  timeStepMs?: number;
  globalScaleMultiplier?: number;
  omitCausalBounds?: boolean;
  invalidCausalBounds?: boolean;
  omitColumnScales?: boolean;
  invalidColumnScales?: boolean;
  omitConfirmedQuantitative?: boolean;
  invalidConfirmedNotional?: boolean;
  inconsistentConfirmedQuantitative?: boolean;
  canonicalHeader?: boolean;
  corruptInnerChecksum?: boolean;
} = {}) {
  const columns = options.columns ?? 3;
  const startTime = options.startTime ?? 1_000;
  const timeStepMs = options.timeStepMs ?? 1_000;
  const rows = 2;
  const cells = columns * rows;
  const columnScales = { longExposure: 1_000, shortExposure: 1_200, combinedExposure: 2_200 };
  const scaleMultiplier = options.globalScaleMultiplier ?? 1;
  const scales = {
    longExposure: columnScales.longExposure * scaleMultiplier,
    shortExposure: columnScales.shortExposure * scaleMultiplier,
    combinedExposure: columnScales.combinedExposure * scaleMultiplier
  };
  const parts: Buffer[] = [];
  const timestamps = Buffer.alloc(columns * 8);
  for (let index = 0; index < columns; index++) timestamps.writeDoubleLE(startTime + index * timeStepMs, index * 8);
  parts.push(timestamps);
  for (const codes of [
    [100, 500, 2_000, 8_000, 20_000, 60_000, 18_000, 48_000],
    [200, 600, 2_500, 9_000, 22_000, 62_000, 21_000, 51_000],
    [300, 900, 4_500, 17_000, 42_000, 65_000, 39_000, 64_000]
  ]) {
    const channel = Buffer.alloc(cells * 2);
    for (let index = 0; index < cells; index++) channel.writeUInt16LE(codes[index] ?? codes.at(-1)!, index * 2);
    parts.push(channel);
  }
  parts.push(Buffer.alloc(cells, 220));
  parts.push(Buffer.alloc(cells, 255));
  const confirmed = Buffer.alloc(cells);
  if (cells > 2) confirmed[2] = 90;
  if (cells > 3) confirmed[3] = 50;
  parts.push(confirmed);
  const lows = Buffer.alloc(columns * 4);
  const highs = Buffer.alloc(columns * 4);
  for (let index = 0; index < columns; index++) {
    lows.writeFloatLE(0, index * 4);
    highs.writeFloatLE(options.invalidCausalBounds ? 0 : Math.log1p(columnScales.combinedExposure), index * 4);
  }
  if (!options.omitCausalBounds) {
    parts.push(lows, highs);
    if (!options.omitColumnScales) {
      for (const [channelIndex, value] of [columnScales.longExposure, columnScales.shortExposure, columnScales.combinedExposure].entries()) {
        const encodedScales = Buffer.alloc(columns * 4);
        for (let column = 0; column < columns; column++) {
          encodedScales.writeFloatLE(options.invalidColumnScales && channelIndex === 0 && column === 0 ? 0 : value, column * 4);
        }
        parts.push(encodedScales);
      }
      if (!options.omitConfirmedQuantitative) {
        const confirmedNotional = Buffer.alloc(cells * 4);
        const confirmedCount = Buffer.alloc(cells * 2);
        for (let index = 0; index < cells; index++) {
          const notional = index === 2 ? 125_000 : index === 3 ? 50_000 : 0;
          confirmedNotional.writeFloatLE(options.invalidConfirmedNotional && index === 2 ? Number.NaN : notional, index * 4);
          confirmedCount.writeUInt16LE(
            options.inconsistentConfirmedQuantitative && index === 2 ? 0 : notional > 0 ? 1 : 0,
            index * 2
          );
        }
        parts.push(confirmedNotional, confirmedCount);
      }
    }
  }
  const payload = Buffer.concat(parts);
  const schemaVersion = options.schemaVersion ?? 2;
  const tileId = "9c0a5ea0-079e-4a19-bd00-5f7af0f02401";
  const header = {
    authority: "PERSISTENT_NODE",
    channelOrder: options.omitCausalBounds
      ? ["timestamps", "longExposure", "shortExposure", "combinedExposure", "confidence", "validity", "confirmedIntensity"]
      : options.omitColumnScales
        ? ["timestamps", "longExposure", "shortExposure", "combinedExposure", "confidence", "validity", "confirmedIntensity", "causalNormalizationLow", "causalNormalizationHigh"]
        : options.omitConfirmedQuantitative
          ? ["timestamps", "longExposure", "shortExposure", "combinedExposure", "confidence", "validity", "confirmedIntensity", "causalNormalizationLow", "causalNormalizationHigh", "longExposureScale", "shortExposureScale", "combinedExposureScale"]
          : ["timestamps", "longExposure", "shortExposure", "combinedExposure", "confidence", "validity", "confirmedIntensity", "causalNormalizationLow", "causalNormalizationHigh", "longExposureScale", "shortExposureScale", "combinedExposureScale", "confirmedNotional", "confirmedCount"],
    columns,
    endTime: startTime + (columns - 1) * timeStepMs,
    horizon: "3W",
    marketKind: "linear_perpetual",
    maxPrice: 101,
    minPrice: 100,
    modelVersion: options.modelVersion ?? BCLIF_MODEL_VERSION,
    priceStep: 1,
    rows,
    scales,
    schemaVersion,
    sourceCutoffTimestamp: options.sourceCutoffTimestamp ?? startTime + (columns - 1) * timeStepMs,
    sourceVersion: BCLIF_SOURCE_VERSION,
    startTime,
    symbol: "BTCUSDT",
    tileId,
    tileVersion: options.tileVersion ?? 1,
    timeStepMs,
    venue: "BYBIT"
  };
  const headerText = options.canonicalHeader === false ? JSON.stringify(header) : canonicalJson(header);
  const headerBytes = Buffer.from(headerText, "utf8");
  const compressed = gzipSync(payload, { mtime: 0 });
  const envelopeHeader = Buffer.alloc(52);
  envelopeHeader.write("BCLF", 0, "ascii");
  envelopeHeader.writeUInt16LE(schemaVersion, 4);
  envelopeHeader.writeUInt16LE(1, 6);
  envelopeHeader.writeUInt32LE(headerBytes.length, 8);
  envelopeHeader.writeUInt32LE(compressed.length, 12);
  envelopeHeader.writeUInt32LE(payload.length, 16);
  const payloadHash = createHash("sha256").update(payload).digest();
  (options.corruptInnerChecksum ? Buffer.alloc(32, 0x5a) : payloadHash).copy(envelopeHeader, 20);
  const envelope = Buffer.concat([envelopeHeader, headerBytes, compressed]);
  const metadata = metadataFor({
    tileId,
    columns,
    rows,
    startTime,
    endTime: header.endTime,
    timeStepMs,
    sourceCutoffTimestamp: header.sourceCutoffTimestamp,
    schemaVersion,
    modelVersion: header.modelVersion,
    tileVersion: header.tileVersion,
    checksum: `sha256:${createHash("sha256").update(envelope).digest("hex")}`,
    compressedBytes: envelope.length,
    scaleMetadata: scales
  });
  return { envelope, metadata };
}

function metadataFor(overrides: Partial<PersistentTileManifestMetadata> = {}): PersistentTileManifestMetadata {
  return {
    tileId: "9c0a5ea0-079e-4a19-bd00-5f7af0f02401",
    venue: "BYBIT",
    symbol: "BTCUSDT",
    horizon: "3W",
    startTime: 1_000,
    endTime: 3_000,
    minPrice: 100,
    maxPrice: overrides.rows ? 100 + overrides.rows - 1 : 101,
    timeStepMs: 1_000,
    priceStep: 1,
    columns: 3,
    rows: 2,
    modelVersion: BCLIF_MODEL_VERSION,
    schemaVersion: 2,
    tileVersion: 1,
    checksum: `sha256:${"1".repeat(64)}`,
    compressedBytes: 1_024,
    sourceCutoffTimestamp: 3_000,
    coverageQuality: "EXCELLENT",
    modelAuthority: "PERSISTENT_NODE",
    channelManifest: {},
    scaleMetadata: { combinedExposure: 2_200 },
    publishedAt: new Date(3_000).toISOString(),
    ...overrides
  };
}

function extendDecodedTile(tile: DecodedLiquidationFieldTile, overrides: Partial<PersistentTileManifestMetadata>): DecodedLiquidationFieldTile {
  const columns = overrides.columns ?? tile.metadata.columns;
  const rows = overrides.rows ?? tile.metadata.rows;
  const cells = columns * rows;
  const extendFloat = (source: Float32Array) => Float32Array.from({ length: cells }, (_, index) => source[index % source.length]!);
  const extendColumnFloat = (source: Float32Array) => Float32Array.from({ length: columns }, (_, index) => source[index % source.length]!);
  const extendByte = (source: Uint8Array) => Uint8Array.from({ length: cells }, (_, index) => source[index % source.length]!);
  return {
    ...tile,
    metadata: metadataFor({ ...tile.metadata, ...overrides, rows, columns }),
    timestamps: Float64Array.from({ length: columns }, (_, index) => 1_000 + index * 1_000),
    longExposure: extendFloat(tile.longExposure),
    shortExposure: extendFloat(tile.shortExposure),
    combinedExposure: extendFloat(tile.combinedExposure),
    normalizedIntensity: extendByte(tile.normalizedIntensity),
    confidence: extendByte(tile.confidence),
    validity: extendByte(tile.validity),
    confirmedIntensity: extendByte(tile.confirmedIntensity),
    confirmedNotional: extendFloat(tile.confirmedNotional),
    confirmedCount: Uint16Array.from({ length: cells }, (_, index) => tile.confirmedCount[index % tile.confirmedCount.length]!),
    causalNormalizationLow: tile.causalNormalizationLow ? extendColumnFloat(tile.causalNormalizationLow) : null,
    causalNormalizationHigh: tile.causalNormalizationHigh ? extendColumnFloat(tile.causalNormalizationHigh) : null,
    longExposureScale: extendColumnFloat(tile.longExposureScale),
    shortExposureScale: extendColumnFloat(tile.shortExposureScale),
    combinedExposureScale: extendColumnFloat(tile.combinedExposureScale)
  };
}

function sliceDecodedTileColumns(
  tile: DecodedLiquidationFieldTile,
  column: number,
  columns: number,
  overrides: Partial<PersistentTileManifestMetadata>
): DecodedLiquidationFieldTile {
  const rows = tile.metadata.rows;
  const cellStart = column * rows;
  const cellEnd = cellStart + columns * rows;
  const timestamp = tile.timestamps[column]!;
  const sliceFloat = (source: Float32Array) => source.slice(cellStart, cellEnd);
  const sliceByte = (source: Uint8Array) => source.slice(cellStart, cellEnd);
  const sliceColumnFloat = (source: Float32Array | null) => source ? source.slice(column, column + columns) : null;
  const metadata = metadataFor({
    ...tile.metadata,
    columns,
    startTime: timestamp,
    endTime: tile.timestamps[column + columns - 1]!,
    checksum: `sha256:${"3".repeat(64)}`,
    ...overrides
  });
  const result: DecodedLiquidationFieldTile = {
    ...tile,
    metadata,
    timestamps: tile.timestamps.slice(column, column + columns),
    longExposure: sliceFloat(tile.longExposure),
    shortExposure: sliceFloat(tile.shortExposure),
    combinedExposure: sliceFloat(tile.combinedExposure),
    normalizedIntensity: sliceByte(tile.normalizedIntensity),
    confidence: sliceByte(tile.confidence),
    validity: sliceByte(tile.validity),
    confirmedIntensity: sliceByte(tile.confirmedIntensity),
    confirmedNotional: sliceFloat(tile.confirmedNotional),
    confirmedCount: tile.confirmedCount.slice(cellStart, cellEnd),
    causalNormalizationLow: sliceColumnFloat(tile.causalNormalizationLow),
    causalNormalizationHigh: sliceColumnFloat(tile.causalNormalizationHigh),
    longExposureScale: tile.longExposureScale.slice(column, column + columns),
    shortExposureScale: tile.shortExposureScale.slice(column, column + columns),
    combinedExposureScale: tile.combinedExposureScale.slice(column, column + columns),
    decodedBytes: 0
  };
  result.decodedBytes = result.timestamps.byteLength
    + result.longExposure.byteLength
    + result.shortExposure.byteLength
    + result.combinedExposure.byteLength
    + result.normalizedIntensity.byteLength
    + result.confidence.byteLength
    + result.validity.byteLength
    + result.confirmedIntensity.byteLength
    + result.confirmedNotional.byteLength
    + result.confirmedCount.byteLength
    + (result.causalNormalizationLow?.byteLength ?? 0)
    + (result.causalNormalizationHigh?.byteLength ?? 0)
    + result.longExposureScale.byteLength
    + result.shortExposureScale.byteLength
    + result.combinedExposureScale.byteLength;
  return result;
}

function candleAt(time: number) {
  return { time, open: 100, high: 101, low: 99, close: 100, volume: 1 };
}

async function certifyMalformedManifestNumerics() {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: { hostname: "contract-test.invalid", search: "" },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis)
    }
  });
  const malformedCases = [
    { modelStart: false, modelEnd: [], sourceCutoffTimestamp: null, expected: "BCLIF_API_CONTRACT" },
    { modelStart: null, modelEnd: null, sourceCutoffTimestamp: "", expected: "BCLIF_API_CONTRACT" },
    { modelStart: null, modelEnd: null, sourceCutoffTimestamp: null, coverage: { trades: false }, expected: "BCLIF_COVERAGE" },
    { modelStart: 1_000, modelEnd: 3_000, sourceCutoffTimestamp: 2_000, expected: "BCLIF_SOURCE_CUTOFF" },
    {
      modelStart: null,
      modelEnd: null,
      sourceCutoffTimestamp: null,
      expected: "BCLIF_API_CONTRACT",
      liveEdge: { ...metadataFor(), tileVersion: true, publicationState: "STAGING" }
    }
  ];
  try {
    for (const malformed of malformedCases) {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://contract-test.invalid");
      const action = url.pathname.split("/").at(-1);
      if (action === "status") return jsonResponse({
        deploymentState: "LIVE",
        modelAuthority: "PERSISTENT_NODE",
        persistence: true,
        collector: { nodeId: "LIQUIDATION_INTELLIGENCE_NODE_01" }
      });
      if (action === "manifest") {
        const requestedStart = Number(url.searchParams.get("from"));
        const requestedEnd = Number(url.searchParams.get("to"));
        const coverage = {
          trades: 100,
          openInterest: 100,
          liquidations: 100,
          orderbook: 100,
          funding: 100,
          continuity: 100,
          ...(malformed.coverage || {})
        };
        return jsonResponse({
          deploymentState: "LIVE",
          modelAuthority: "PERSISTENT_NODE",
          persistence: true,
          sourceMode: "PERSISTENT_COLLECTOR",
          scope: {
            venue: "BYBIT",
            marketKind: "linear_perpetual",
            symbol: "BTCUSDT",
            horizon: "3W",
            requestedStart,
            requestedEnd,
            mode: "REPLAY"
          },
          modelStart: malformed.modelStart,
          modelEnd: malformed.modelEnd,
          sourceCutoffTimestamp: malformed.sourceCutoffTimestamp,
          quality: "EXCELLENT",
          coverage,
          gaps: [],
          updatedAt: requestedEnd,
          tiles: [],
          liveEdge: malformed.liveEdge ?? null
        });
      }
      throw new Error(`Unexpected BCLIF malformed-manifest route: ${url}`);
    }) as typeof fetch;
    const client = new PersistentLiquidationFieldClient({
      symbol: "BTCUSDT",
      settings: DEFAULT_LIQUIDATION_FIELD_SETTINGS,
      getCandles: () => [candleAt(1), candleAt(3)],
      getReplayActive: () => true,
      getAuthenticationToken: async () => "contract-token",
      fetchImpl
    });
      await assert.rejects(
        client.load(new AbortController().signal),
        (error: unknown) => contractCode(error, malformed.expected),
        "non-numeric manifest fields must fail closed instead of coercing to zero"
      );
    }
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

async function certifyLiveEdgeRevisionRace() {
  const now = Date.now();
  const startTime = Math.floor((now - 120_000) / 60_000) * 60_000;
  const first = buildEnvelope({ columns: 2, startTime, timeStepMs: 60_000 });
  const second = buildEnvelope({ columns: 3, startTime, timeStepMs: 60_000 });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: { hostname: "contract-test.invalid", search: "" },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis)
    }
  });
  let manifestCalls = 0;
  let tileCalls = 0;
  const requestedChecksums: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://contract-test.invalid");
    const action = url.pathname.split("/").at(-1);
    if (action === "status") return jsonResponse({
      deploymentState: "LIVE",
      modelAuthority: "PERSISTENT_NODE",
      persistence: true,
      collector: { nodeId: "LIQUIDATION_INTELLIGENCE_NODE_01" }
    });
    if (action === "manifest") {
      manifestCalls += 1;
      const selected = manifestCalls === 1 ? first : second;
      const requestedStart = Number(url.searchParams.get("from"));
      const requestedEnd = Number(url.searchParams.get("to"));
      return jsonResponse({
        deploymentState: "LIVE",
        modelAuthority: "PERSISTENT_NODE",
        persistence: true,
        sourceMode: "PERSISTENT_COLLECTOR",
        scope: {
          venue: "BYBIT",
          marketKind: "linear_perpetual",
          symbol: "BTCUSDT",
          horizon: "3W",
          requestedStart,
          requestedEnd,
          mode: url.searchParams.get("mode")
        },
        modelStart: selected.metadata.startTime,
        modelEnd: selected.metadata.endTime,
        sourceCutoffTimestamp: selected.metadata.sourceCutoffTimestamp,
        quality: "EXCELLENT",
        coverage: { trades: 100, openInterest: 100, liquidations: 100, orderbook: 100, funding: 100, continuity: 100 },
        gaps: [],
        updatedAt: selected.metadata.sourceCutoffTimestamp,
        tiles: [],
        liveEdge: { ...selected.metadata, publicationState: "STAGING" }
      });
    }
    if (action === "tile") {
      tileCalls += 1;
      const checksum = url.searchParams.get("checksum") || "";
      requestedChecksums.push(checksum);
      if (checksum === first.metadata.checksum) {
        return jsonResponse({ code: "TILE_REVISION_MISMATCH", message: "live edge advanced" }, 410);
      }
      assert.equal(checksum, second.metadata.checksum);
      return new Response(second.envelope, {
        status: 200,
        headers: { "content-type": "application/octet-stream", "content-length": String(second.envelope.byteLength) }
      });
    }
    throw new Error(`Unexpected BCLIF contract-test route: ${url}`);
  }) as typeof fetch;
  const controller = new AbortController();
  const currentOpenSeconds = Math.floor(now / 3_600_000) * 3_600;
  const client = new PersistentLiquidationFieldClient({
    symbol: "BTCUSDT",
    settings: DEFAULT_LIQUIDATION_FIELD_SETTINGS,
    getCandles: () => [candleAt(currentOpenSeconds - 3_600), candleAt(currentOpenSeconds)],
    getReplayActive: () => false,
    getAuthenticationToken: async () => "contract-token",
    fetchImpl
  });
  try {
    const result = await client.load(controller.signal);
    assert.equal(result.kind, "SNAPSHOT");
    if (result.kind === "SNAPSHOT") assert.equal(result.snapshot.header.columns, 3);
    assert.equal(manifestCalls, 2, "a raced STAGING object must trigger exactly one immediate manifest re-probe");
    assert.equal(tileCalls, 2);
    assert.deepEqual(requestedChecksums, [first.metadata.checksum, second.metadata.checksum]);
    assert.equal(client.metrics().entries, 1, "the superseded STAGING response must never enter the decoded cache");

    const repeated = await client.load(controller.signal);
    assert.equal(repeated.kind, "SNAPSHOT");
    assert.equal(tileCalls, 2, "an unchanged M2 cursor must reuse its verified decoded cache entry");
  } finally {
    controller.abort();
    client.clear();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

async function certifyPersistentMicrotileRefresh(
  finalizedRoot: LiquidationFieldSnapshot,
  rootPlusMicrotile: LiquidationFieldSnapshot
) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: { hostname: "contract-test.invalid", search: "" },
      setTimeout(callback: () => void) {
        const id = nextTimer++;
        timers.set(id, callback);
        return id;
      },
      clearTimeout(id: number) {
        timers.delete(id);
      }
    }
  });
  let loadCount = 0;
  let fallbackStarts = 0;
  let resolveMicrotile!: (result: PersistentLiquidationFieldLoadResult) => void;
  const microtileLoad = new Promise<PersistentLiquidationFieldLoadResult>((resolve) => {
    resolveMicrotile = resolve;
  });
  const snapshots: Array<LiquidationFieldSnapshot | null> = [];
  const persistent: PersistentLiquidationFieldAuthorityClient = {
    async load() {
      loadCount += 1;
      if (loadCount === 1) return {
        kind: "SNAPSHOT" as const,
        snapshot: finalizedRoot,
        collectorNodeId: "LIQUIDATION_INTELLIGENCE_NODE_01",
        freshness: "LIVE" as const,
        message: "finalized root"
      };
      return microtileLoad;
    },
    async probe() {
      throw new Error("persistent refresh must not probe browser-fallback recovery");
    },
    updateSettings() {
      return false;
    },
    clear() {}
  };
  const controller = new LiquidationFieldController({
    symbol: "BTCUSDT",
    settings: DEFAULT_LIQUIDATION_FIELD_SETTINGS,
    getCandles: () => [],
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onStatus: () => {},
    persistentClient: persistent,
    createBrowserFallback: () => ({
      async start() { fallbackStarts += 1; },
      updateSettings() {},
      dispose() {}
    })
  });
  try {
    await controller.start();
    assert.equal(snapshots.at(-1), finalizedRoot);
    assert.equal(timers.size, 1);
    fireNextTimer(timers);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(loadCount, 2);
    assert.equal(fallbackStarts, 0, "browser fallback must remain off while the persistent hot microtile is in flight");
    assert.equal(snapshots.at(-1), finalizedRoot, "the verified root remains visible until the microtile atlas is complete");
    resolveMicrotile({
      kind: "SNAPSHOT",
      snapshot: rootPlusMicrotile,
      collectorNodeId: "LIQUIDATION_INTELLIGENCE_NODE_01",
      freshness: "LIVE",
      message: "root plus hot microtile"
    });
    await drainAsyncControllerWork();
    assert.equal(snapshots.at(-1), rootPlusMicrotile);
    assert.equal(fallbackStarts, 0, "persistent hot-column polling may never open a second browser authority");
  } finally {
    controller.dispose();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

async function certifyBrowserFallbackRecovery(snapshot: LiquidationFieldSnapshot) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const windowMock = {
    location: { hostname: "contract-test.invalid", search: "" },
    setTimeout(callback: () => void) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    }
  };
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: windowMock });

  const events: string[] = [];
  const statuses: LiquidationFieldRuntimeStatus[] = [];
  const snapshots: Array<LiquidationFieldSnapshot | null> = [];
  let loadCount = 0;
  let probeCount = 0;
  let clearCount = 0;
  let fallbackStarts = 0;
  let fallbackDisposals = 0;
  const persistent: PersistentLiquidationFieldAuthorityClient = {
    async load(): Promise<PersistentLiquidationFieldLoadResult> {
      loadCount += 1;
      events.push(`persistent-load-${loadCount}`);
      if (loadCount === 1) {
        return { kind: "FALLBACK", reason: "NOT_DEPLOYED", message: "fixture fallback" };
      }
      return {
        kind: "SNAPSHOT",
        snapshot,
        collectorNodeId: "LIQUIDATION_INTELLIGENCE_NODE_01",
        freshness: "LIVE",
        message: "verified persistent recovery"
      };
    },
    async probe() {
      probeCount += 1;
      events.push(`persistent-probe-${probeCount}`);
      return probeCount >= 2;
    },
    updateSettings() {
      return false;
    },
    clear() {
      clearCount += 1;
    }
  };
  const fallbackFactory = () => {
    const handle: BrowserLiquidationFieldHandle = {
      async start() {
        fallbackStarts += 1;
        events.push("fallback-start");
      },
      updateSettings() {},
      dispose() {
        fallbackDisposals += 1;
        events.push("fallback-dispose");
      }
    };
    return handle;
  };
  const controller = new LiquidationFieldController({
    symbol: "BTCUSDT",
    settings: DEFAULT_LIQUIDATION_FIELD_SETTINGS,
    getCandles: () => [],
    onSnapshot: (value) => snapshots.push(value),
    onStatus: (status) => statuses.push(status),
    persistentClient: persistent,
    createBrowserFallback: fallbackFactory
  });
  try {
    await controller.start();
    assert.equal(fallbackStarts, 1);
    assert.equal(fallbackDisposals, 0);
    assert.equal(timers.size, 1, "browser fallback must schedule a bounded persistent status probe");

    fireNextTimer(timers);
    await drainAsyncControllerWork();
    assert.equal(probeCount, 1);
    assert.equal(fallbackDisposals, 0, "a failed probe must leave the sole browser authority running");
    assert.equal(timers.size, 1, "a failed probe must schedule the next bounded retry");

    fireNextTimer(timers);
    await drainAsyncControllerWork();
    assert.equal(probeCount, 2);
    assert.equal(loadCount, 2);
    assert.equal(fallbackDisposals, 1, "recovery must dispose the browser stream exactly once before persistent verification");
    assert.ok(events.indexOf("fallback-dispose") < events.indexOf("persistent-load-2"), "authority handoff must stop browser input before loading persistent tiles");
    assert.equal(fallbackStarts, 1, "a successful recovery must not create a duplicate browser stream");
    assert.equal(snapshots.at(-1), snapshot);
    assert.equal(statuses.at(-1)?.state, "LIVE");
    assert.equal(statuses.at(-1)?.authority, "PERSISTENT_NODE");
  } finally {
    controller.dispose();
    assert.equal(clearCount, 1);
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

async function certifyContractFailureStartsQuarantinedFallback() {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 1;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: { hostname: "contract-test.invalid", search: "" },
      setTimeout(callback: () => void, delay: number) {
        const id = nextTimer++;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id: number) {
        timers.delete(id);
      }
    }
  });
  let fallbackStarts = 0;
  let clearCount = 0;
  let fallbackReason = "";
  const persistent: PersistentLiquidationFieldAuthorityClient = {
    async load() {
      throw new LiquidationFieldTileContractError("BCLIF_OUTER_CHECKSUM", "fixture checksum rejection");
    },
    async probe() { return false; },
    updateSettings() { return false; },
    clear() { clearCount += 1; }
  };
  const controller = new LiquidationFieldController({
    symbol: "BTCUSDT",
    settings: DEFAULT_LIQUIDATION_FIELD_SETTINGS,
    getCandles: () => [],
    onSnapshot: () => {},
    onStatus: () => {},
    persistentClient: persistent,
    createBrowserFallback: () => ({
      async start(reason) {
        fallbackStarts += 1;
        fallbackReason = reason ?? "";
      },
      updateSettings() {},
      dispose() {}
    })
  });
  try {
    await controller.start();
    assert.equal(fallbackStarts, 1, "a rejected persistent tile must start exactly one independent browser authority");
    assert.equal(fallbackReason, "PERSISTENT_TILE_QUARANTINED:BCLIF_OUTER_CHECKSUM");
    assert.equal(clearCount, 1, "rejected persistent bytes must be evicted before browser fallback starts");
    assert.equal(timers.size, 1, "quarantined persistent authority must receive one bounded recovery probe");
    assert.equal([...timers.values()][0]?.delay, 5 * 60_000, "contract recovery must not churn the browser stream");
  } finally {
    controller.dispose();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

async function certifyRecoveryContractFailureRestoresFallback() {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 1;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: { hostname: "contract-test.invalid", search: "" },
      setTimeout(callback: () => void, delay: number) {
        const id = nextTimer++;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id: number) {
        timers.delete(id);
      }
    }
  });
  let loadCount = 0;
  let fallbackStarts = 0;
  let fallbackDisposals = 0;
  let clearCount = 0;
  const statuses: LiquidationFieldRuntimeStatus[] = [];
  const persistent: PersistentLiquidationFieldAuthorityClient = {
    async load(): Promise<PersistentLiquidationFieldLoadResult> {
      loadCount += 1;
      if (loadCount === 1) return { kind: "FALLBACK", reason: "NOT_DEPLOYED", message: "fixture fallback" };
      throw new LiquidationFieldTileContractError("BCLIF_LIVE_EDGE_GENERATION", "fixture generation rejection");
    },
    async probe() { return true; },
    updateSettings() { return false; },
    clear() { clearCount += 1; }
  };
  const controller = new LiquidationFieldController({
    symbol: "BTCUSDT",
    settings: DEFAULT_LIQUIDATION_FIELD_SETTINGS,
    getCandles: () => [],
    onSnapshot: () => {},
    onStatus: (status) => statuses.push(status),
    persistentClient: persistent,
    createBrowserFallback: () => ({
      async start() { fallbackStarts += 1; },
      updateSettings() {},
      dispose() { fallbackDisposals += 1; }
    })
  });
  try {
    await controller.start();
    const firstTimer = timers.entries().next().value as [number, { callback: () => void; delay: number }] | undefined;
    assert.ok(firstTimer);
    timers.delete(firstTimer[0]);
    firstTimer[1].callback();
    await drainAsyncControllerWork();
    assert.equal(fallbackStarts, 2, "failed persistent recovery must restore one fresh browser authority");
    assert.equal(fallbackDisposals, 1, "authority handoff must stop the former browser stream before verification");
    assert.equal(clearCount, 1, "failed persistent recovery must clear rejected tile state");
    assert.ok(!statuses.some((status) => status.state === "ERROR" || status.state === "UNAVAILABLE"));
    assert.equal(timers.size, 1, "restored fallback must retain one delayed recovery probe");
    assert.equal([...timers.values()][0]?.delay, 5 * 60_000);
  } finally {
    controller.dispose();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

async function certifyAccessFailureRemainsFailClosed() {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const timers = new Map<number, () => void>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: { hostname: "contract-test.invalid", search: "" },
      setTimeout(callback: () => void) {
        timers.set(1, callback);
        return 1;
      },
      clearTimeout() {
        timers.clear();
      }
    }
  });
  let fallbackStarts = 0;
  const statuses: LiquidationFieldRuntimeStatus[] = [];
  const controller = new LiquidationFieldController({
    symbol: "BTCUSDT",
    settings: DEFAULT_LIQUIDATION_FIELD_SETTINGS,
    getCandles: () => [],
    onSnapshot: () => {},
    onStatus: (status) => statuses.push(status),
    persistentClient: {
      async load() { throw new PersistentLiquidationFieldAccessError(403, "fixture access denial"); },
      async probe() { return false; },
      updateSettings() { return false; },
      clear() {}
    },
    createBrowserFallback: () => ({
      async start() { fallbackStarts += 1; },
      updateSettings() {},
      dispose() {}
    })
  });
  try {
    await controller.start();
    assert.equal(fallbackStarts, 0, "authentication and authorization failures must never open public fallback");
    assert.equal(statuses.at(-1)?.state, "UNAVAILABLE");
    assert.equal(statuses.at(-1)?.authority, "PERSISTENT_NODE");
    assert.equal(timers.size, 0);
  } finally {
    controller.dispose();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

function fireNextTimer(timers: Map<number, () => void>) {
  const next = timers.entries().next().value as [number, () => void] | undefined;
  assert.ok(next, "expected a scheduled controller timer");
  timers.delete(next[0]);
  next[1]();
}

async function drainAsyncControllerWork() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") return Object.fromEntries(
      Object.keys(item as Record<string, unknown>).sort().map((key) => [key, normalize((item as Record<string, unknown>)[key])])
    );
    return item;
  };
  return JSON.stringify(normalize(value));
}

function uuidFor(index: number) {
  return `9c0a5ea0-079e-4a19-bd00-${index.toString(16).padStart(12, "0")}`;
}

function toArrayBuffer(buffer: Buffer) {
  const copy = new Uint8Array(buffer.length);
  copy.set(buffer);
  return copy.buffer;
}

function contractCode(error: unknown, code: string) {
  return error instanceof LiquidationFieldTileContractError && error.code === code;
}
