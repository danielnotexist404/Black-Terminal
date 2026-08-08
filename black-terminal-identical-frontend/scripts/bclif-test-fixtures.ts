import type { BclifCanonicalEvent, BclifOpenInterestPoint, BclifTileInput } from "../server/liquidation-intelligence/contracts.ts";
import { canonicalEvent } from "../server/liquidation-intelligence/normalization/canonicalEnvelope.ts";
import { buildBclifTile, type BclifModelColumn } from "../server/liquidation-intelligence/tiles/tileBuilder.ts";

export const TEST_MODEL_VERSION = "BCLIF_MODEL_TEST_V1";
export const TEST_SOURCE_VERSION = "BYBIT_PUBLIC_TEST_V1";
export const TEST_CADENCE_MS = 60_000;

export function makeModelColumn(timestamp: number, rows = 8, seed = timestamp / TEST_CADENCE_MS): BclifModelColumn {
  const longExposure = new Float32Array(rows);
  const shortExposure = new Float32Array(rows);
  const combinedExposure = new Float32Array(rows);
  const confidence = new Uint8Array(rows);
  const validity = new Uint8Array(rows);
  const confirmedIntensity = new Uint8Array(rows);
  const confirmedNotional = new Float32Array(rows);
  const confirmedCount = new Uint16Array(rows);
  for (let row = 0; row < rows; row += 1) {
    const long = (seed + 1) * (row + 1) * 17;
    const short = (seed + 2) * (rows - row) * 11;
    longExposure[row] = long;
    shortExposure[row] = short;
    combinedExposure[row] = long + short;
    confidence[row] = 96 + ((seed + row) % 150);
    validity[row] = 1;
    if ((seed + row) % 19 === 0) {
      confirmedNotional[row] = (seed + 1) * 1_000;
      confirmedCount[row] = 1;
      confirmedIntensity[row] = 180;
    }
  }
  return {
    timestamp,
    longExposure,
    shortExposure,
    combinedExposure,
    confidence,
    validity,
    confirmedIntensity,
    confirmedNotional,
    confirmedCount,
    causalNormalizationLow: Math.log1p(seed + 1),
    causalNormalizationHigh: Math.log1p((seed + 1) * rows * 100)
  };
}

export function makeColumns(count: number, rows = 8, start = TEST_CADENCE_MS) {
  return Array.from({ length: count }, (_, index) => makeModelColumn(start + index * TEST_CADENCE_MS, rows, index + 1));
}

export function makeTile(columns = 4, rows = 8, authority: BclifTileInput["authority"] = "PERSISTENT_NODE") {
  const values = makeColumns(columns, rows);
  const endTime = values.at(-1)!.timestamp;
  return buildBclifTile(values, {
    venue: "BYBIT",
    symbol: "BTCUSDT",
    marketKind: "linear_perpetual",
    horizon: "6H",
    authority,
    modelVersion: TEST_MODEL_VERSION,
    sourceVersion: TEST_SOURCE_VERSION,
    coverageQuality: "HIGH",
    sourceCutoffTimestamp: endTime,
    minPrice: 50_000,
    priceStep: 25,
    rows,
    timeStepMs: TEST_CADENCE_MS,
    createdAt: endTime
  });
}

export function makeOpenInterest(availableAt: number, singleSideOpenInterest: number): BclifOpenInterestPoint {
  return {
    timestamp: availableAt,
    receivedTimestamp: availableAt,
    availableAt,
    availabilityMode: "LIVE_OBSERVATION",
    interval: "ticker",
    singleSideOpenInterest,
    bothSidesOpenInterest: singleSideOpenInterest * 2,
    unit: "BASE",
    sourceVersion: TEST_SOURCE_VERSION
  };
}

export function makeCanonicalEvent(index: number, kind: "TRADE" | "LIQUIDATION" = "TRADE"): BclifCanonicalEvent {
  const timestamp = 1_700_000_000_000 + index;
  return canonicalEvent({
    eventId: `TEST:${kind}:${index}`,
    kind,
    symbol: "BTCUSDT",
    exchangeTimestamp: timestamp,
    receivedTimestamp: timestamp + 5,
    sourceVersion: TEST_SOURCE_VERSION,
    payload: { index, test: true }
  });
}

export function assertFloatArrayClose(actual: ArrayLike<number>, expected: ArrayLike<number>, relativeTolerance = 4e-4) {
  if (actual.length !== expected.length) throw new Error(`Array length mismatch ${actual.length} !== ${expected.length}`);
  for (let index = 0; index < actual.length; index += 1) {
    const left = Number(actual[index]);
    const right = Number(expected[index]);
    const tolerance = Math.max(1e-5, Math.abs(right) * relativeTolerance);
    if (Math.abs(left - right) > tolerance) throw new Error(`Float mismatch at ${index}: ${left} !== ${right} (tol=${tolerance})`);
  }
}
