export interface BclifTimestampedColumn {
  timestamp: number;
}

export interface BclifRecoveredActiveBucket<T extends BclifTimestampedColumn> {
  columns: T[];
  bucketStart: number | null;
  droppedColumns: number;
  droppedBuckets: number;
}

export interface BclifActiveColumnTransition {
  disposition: "APPEND" | "STALE";
  closeBucketWith: number[];
  initializeCurrentWith: number[];
}

/**
 * A column stamped exactly at a UTC bucket boundary closes the preceding
 * bucket. This is the same convention used by the tile builder.
 */
export function bclifBaseBucketStart(timestamp: number, horizonMs: number) {
  assertPositiveInteger(timestamp, "column timestamp");
  assertPositiveInteger(horizonMs, "base horizon");
  return Math.floor((timestamp - 1) / horizonMs) * horizonMs;
}

/**
 * Legacy checkpoints could contain more than one six-hour bucket. Keep only
 * the newest bucket: older buckets already have immutable STAGING/FINALIZED
 * publications and must never be bridged into the current UTC bucket.
 */
export function recoverLatestActiveBucket<T extends BclifTimestampedColumn>(
  columns: readonly T[],
  cadenceMs: number,
  horizonMs: number
): BclifRecoveredActiveBucket<T> {
  validateCadence(cadenceMs, horizonMs);
  if (!columns.length) return { columns: [], bucketStart: null, droppedColumns: 0, droppedBuckets: 0 };
  assertStrictCadence(columns.map((column) => column.timestamp), cadenceMs, "checkpoint active tile");
  const bucketStarts = columns.map((column) => bclifBaseBucketStart(column.timestamp, horizonMs));
  const newestBucketStart = bucketStarts.at(-1)!;
  const firstNewestIndex = bucketStarts.findIndex((bucketStart) => bucketStart === newestBucketStart);
  const recovered = columns.slice(firstNewestIndex);
  assertSingleBoundedBucket(recovered.map((column) => column.timestamp), cadenceMs, horizonMs, "recovered active tile");
  return {
    columns: [...recovered],
    bucketStart: newestBucketStart,
    droppedColumns: firstNewestIndex,
    droppedBuckets: new Set(bucketStarts.slice(0, firstNewestIndex)).size
  };
}

/**
 * Plans a causal append without ever manufacturing an unbounded multi-bucket
 * gap. A recovered old bucket is closed with explicit missing columns, then
 * the incoming bucket is initialized independently. Entire empty buckets are
 * not synthesized.
 */
export function planActiveColumnTransition(
  activeTimestamps: readonly number[],
  incomingTimestamp: number,
  cadenceMs: number,
  horizonMs: number
): BclifActiveColumnTransition {
  validateCadence(cadenceMs, horizonMs);
  assertPositiveInteger(incomingTimestamp, "incoming column timestamp");
  const incomingBucketStart = bclifBaseBucketStart(incomingTimestamp, horizonMs);
  if (!activeTimestamps.length) {
    return {
      disposition: "APPEND",
      closeBucketWith: [],
      initializeCurrentWith: timestamps(incomingBucketStart + cadenceMs, incomingTimestamp, cadenceMs)
    };
  }

  assertSingleBoundedBucket(activeTimestamps, cadenceMs, horizonMs, "active tile");
  const activeBucketStart = bclifBaseBucketStart(activeTimestamps[0]!, horizonMs);
  const expected = activeTimestamps.at(-1)! + cadenceMs;
  if (incomingTimestamp < expected || incomingBucketStart < activeBucketStart) {
    return { disposition: "STALE", closeBucketWith: [], initializeCurrentWith: [] };
  }
  if (incomingBucketStart === activeBucketStart) {
    return {
      disposition: "APPEND",
      closeBucketWith: [],
      initializeCurrentWith: timestamps(expected, incomingTimestamp, cadenceMs)
    };
  }

  const activeBucketEnd = activeBucketStart + horizonMs;
  return {
    disposition: "APPEND",
    closeBucketWith: timestamps(expected, activeBucketEnd + cadenceMs, cadenceMs),
    initializeCurrentWith: timestamps(incomingBucketStart + cadenceMs, incomingTimestamp, cadenceMs)
  };
}

export function assertSingleBoundedBucket(
  timestampsToCheck: readonly number[],
  cadenceMs: number,
  horizonMs: number,
  label = "active tile"
) {
  validateCadence(cadenceMs, horizonMs);
  if (!timestampsToCheck.length) return;
  assertStrictCadence(timestampsToCheck, cadenceMs, label);
  const bucketStart = bclifBaseBucketStart(timestampsToCheck[0]!, horizonMs);
  const targetColumns = horizonMs / cadenceMs;
  if (timestampsToCheck.length > targetColumns) throw new Error(`BCLIF ${label} exceeds its bounded UTC bucket`);
  for (const timestamp of timestampsToCheck) {
    if (bclifBaseBucketStart(timestamp, horizonMs) !== bucketStart) throw new Error(`BCLIF ${label} crosses a UTC bucket boundary`);
  }
}

function assertStrictCadence(values: readonly number[], cadenceMs: number, label: string) {
  for (let index = 0; index < values.length; index += 1) {
    const timestamp = values[index]!;
    assertPositiveInteger(timestamp, `${label} timestamp`);
    if (index > 0 && timestamp !== values[index - 1]! + cadenceMs) throw new Error(`BCLIF ${label} is not strictly cadence ordered`);
  }
}

function validateCadence(cadenceMs: number, horizonMs: number) {
  assertPositiveInteger(cadenceMs, "column cadence");
  assertPositiveInteger(horizonMs, "base horizon");
  if (horizonMs % cadenceMs !== 0) throw new Error("BCLIF base horizon is not divisible by column cadence");
}

function assertPositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid BCLIF ${label}`);
}

function timestamps(startInclusive: number, endExclusive: number, cadenceMs: number) {
  const values: number[] = [];
  for (let timestamp = startInclusive; timestamp < endExclusive; timestamp += cadenceMs) values.push(timestamp);
  return values;
}
