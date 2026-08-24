import assert from "node:assert/strict";
import {
  assertSingleBoundedBucket,
  bclifBaseBucketStart,
  planActiveColumnTransition,
  recoverLatestActiveBucket
} from "../server/liquidation-intelligence/collector/activeTileContinuity.ts";

const minute = 60_000;
const sixHours = 6 * 60 * minute;
const firstBucket = Date.UTC(2026, 7, 21, 0, 0, 0, 0);
const secondBucket = firstBucket + sixHours;
const currentBucket = Date.UTC(2026, 7, 24, 18, 0, 0, 0);

const legacyColumns = Array.from({ length: 711 }, (_, index) => ({ timestamp: firstBucket + (index + 1) * minute, marker: index }));
const recovered = recoverLatestActiveBucket(legacyColumns, minute, sixHours);
assert.equal(recovered.columns.length, 351, "the newest interrupted six-hour bucket must be retained");
assert.equal(recovered.columns[0]!.timestamp, secondBucket + minute);
assert.equal(recovered.columns.at(-1)!.timestamp, secondBucket + 351 * minute);
assert.equal(recovered.droppedColumns, 360, "a complete legacy predecessor bucket must not remain active");
assert.equal(recovered.droppedBuckets, 1);
assert.equal(recovered.suppressReplayPublicationThrough, secondBucket + sixHours, "legacy replay must not republish the repaired checkpoint bucket");
assert.equal(bclifBaseBucketStart(secondBucket, sixHours), firstBucket, "the boundary column closes the preceding bucket");
assert.equal(bclifBaseBucketStart(secondBucket + minute, sixHours), secondBucket);

const rollover = planActiveColumnTransition(
  recovered.columns.map((column) => column.timestamp),
  currentBucket + 5 * 60 * minute,
  minute,
  sixHours
);
assert.equal(rollover.disposition, "APPEND");
assert.equal(rollover.discardActiveBucket, true, "a multi-bucket gap must abandon stale unverifiable active data");
assert.deepEqual(rollover.closeBucketWith, [], "stale coverage must never be manufactured or published");
assert.equal(rollover.initializeCurrentWith.length, 299, "only the incoming UTC bucket may be initialized; skipped days must not be synthesized");
assert.equal(rollover.initializeCurrentWith[0], currentBucket + minute);
assert.equal(rollover.initializeCurrentWith.at(-1), currentBucket + 299 * minute);

const sameBucket = planActiveColumnTransition(
  [currentBucket + minute, currentBucket + 2 * minute],
  currentBucket + 5 * minute,
  minute,
  sixHours
);
assert.deepEqual(sameBucket.closeBucketWith, []);
assert.deepEqual(sameBucket.initializeCurrentWith, [currentBucket + 3 * minute, currentBucket + 4 * minute]);

const adjacentRollover = planActiveColumnTransition(
  recovered.columns.map((column) => column.timestamp),
  secondBucket + sixHours + 5 * minute,
  minute,
  sixHours
);
assert.equal(adjacentRollover.discardActiveBucket, false);
assert.deepEqual(
  adjacentRollover.closeBucketWith,
  Array.from({ length: 9 }, (_, index) => secondBucket + (352 + index) * minute),
  "an adjacent interrupted bucket can be closed with explicit missing columns"
);

const duplicate = planActiveColumnTransition([currentBucket + minute], currentBucket + minute, minute, sixHours);
assert.equal(duplicate.disposition, "STALE");
assert.throws(
  () => assertSingleBoundedBucket(legacyColumns.map((column) => column.timestamp), minute, sixHours),
  /exceeds its bounded UTC bucket|crosses a UTC bucket boundary/
);
assert.throws(
  () => recoverLatestActiveBucket([{ timestamp: firstBucket + minute }, { timestamp: firstBucket + 3 * minute }], minute, sixHours),
  /not strictly cadence ordered/
);

console.log(JSON.stringify({
  decision: "PASS",
  legacyColumns: legacyColumns.length,
  retainedColumns: recovered.columns.length,
  replayPublicationSuppressedThrough: new Date(recovered.suppressReplayPublicationThrough!).toISOString(),
  adjacentClosedMissingColumns: adjacentRollover.closeBucketWith.length,
  staleBucketDiscarded: rollover.discardActiveBucket,
  synthesizedSkippedBuckets: 0
}, null, 2));
