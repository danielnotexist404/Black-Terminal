import { createHash } from "node:crypto";
import type { BclifTileHorizon, BclifTileInput } from "../contracts.ts";

export interface BclifModelColumn {
  timestamp: number;
  longExposure: Float32Array;
  shortExposure: Float32Array;
  combinedExposure?: Float32Array;
  confidence: Uint8Array;
  validity: Uint8Array;
  confirmedIntensity: Uint8Array;
  confirmedNotional: Float32Array;
  confirmedCount: Uint16Array;
  causalNormalizationLow?: number;
  causalNormalizationHigh?: number;
}

export interface BclifTileBuildOptions {
  tileId?: string;
  tileVersion?: number;
  venue: "BYBIT";
  symbol: string;
  marketKind: "linear_perpetual";
  horizon: BclifTileHorizon;
  authority: BclifTileInput["authority"];
  modelVersion: string;
  sourceVersion: string;
  coverageQuality: BclifTileInput["coverageQuality"];
  sourceCutoffTimestamp: number;
  minPrice: number;
  priceStep: number;
  rows: number;
  timeStepMs: number;
  createdAt?: number;
}

/**
 * Assemble already-finalized chronological model columns into a fixed-grid
 * tile. It never resamples or consults a later column, which makes the output
 * prefix stable under future append.
 */
export function buildBclifTile(columns: readonly BclifModelColumn[], options: BclifTileBuildOptions): BclifTileInput {
  if (!columns.length) throw new Error("Cannot finalize an empty BCLIF tile");
  if (!Number.isSafeInteger(options.rows) || options.rows < 1 || options.rows > 1_024) throw new Error("Invalid BCLIF tile rows");
  if (!(options.timeStepMs > 0) || !(options.priceStep > 0) || !(options.minPrice > 0)) throw new Error("Invalid BCLIF tile grid");
  const ordered = [...columns].sort((a, b) => a.timestamp - b.timestamp);
  const cells = ordered.length * options.rows;
  const timestamps = new Float64Array(ordered.length);
  const longExposure = new Float32Array(cells);
  const shortExposure = new Float32Array(cells);
  const combinedExposure = new Float32Array(cells);
  const confidence = new Uint8Array(cells);
  const validity = new Uint8Array(cells);
  const confirmedIntensity = new Uint8Array(cells);
  const confirmedNotional = new Float32Array(cells);
  const confirmedCount = new Uint16Array(cells);
  const hasCausalBounds = ordered.every((column) => Number.isFinite(column.causalNormalizationLow) && Number.isFinite(column.causalNormalizationHigh));
  if (options.authority === "PERSISTENT_NODE" && !hasCausalBounds) {
    throw new Error("Persistent BCLIF tile columns require causal normalization bounds");
  }
  const causalNormalizationLow = hasCausalBounds ? new Float32Array(ordered.length) : new Float32Array();
  const causalNormalizationHigh = hasCausalBounds ? new Float32Array(ordered.length) : new Float32Array();

  for (let columnIndex = 0; columnIndex < ordered.length; columnIndex += 1) {
    const column = ordered[columnIndex]!;
    const expectedTimestamp = ordered[0]!.timestamp + columnIndex * options.timeStepMs;
    if (column.timestamp !== expectedTimestamp) throw new Error("BCLIF tile columns must use a contiguous fixed UTC cadence");
    requireColumnLength(column.longExposure, options.rows, "longExposure");
    requireColumnLength(column.shortExposure, options.rows, "shortExposure");
    if (column.combinedExposure) requireColumnLength(column.combinedExposure, options.rows, "combinedExposure");
    requireColumnLength(column.confidence, options.rows, "confidence");
    requireColumnLength(column.validity, options.rows, "validity");
    requireColumnLength(column.confirmedIntensity, options.rows, "confirmedIntensity");
    requireColumnLength(column.confirmedNotional, options.rows, "confirmedNotional");
    requireColumnLength(column.confirmedCount, options.rows, "confirmedCount");
    const offset = columnIndex * options.rows;
    for (let row = 0; row < options.rows; row += 1) {
      const target = offset + row;
      const long = finiteNonNegative(column.longExposure[row]!, "long exposure");
      const short = finiteNonNegative(column.shortExposure[row]!, "short exposure");
      const combined = column.combinedExposure
        ? finiteNonNegative(column.combinedExposure[row]!, "combined exposure")
        : long + short;
      timestamps[columnIndex] = column.timestamp;
      longExposure[target] = long;
      shortExposure[target] = short;
      combinedExposure[target] = combined;
      confidence[target] = column.confidence[row]!;
      validity[target] = column.validity[row]! ? 1 : 0;
      confirmedIntensity[target] = column.confirmedIntensity[row]!;
      confirmedNotional[target] = finiteNonNegative(column.confirmedNotional[row]!, "confirmed notional");
      const eventCount = column.confirmedCount[row]!;
      if (!Number.isSafeInteger(eventCount) || eventCount < 0 || eventCount > 65_535) throw new Error("Invalid BCLIF confirmed event count");
      confirmedCount[target] = eventCount;
    }
    if (hasCausalBounds) {
      const low = Number(column.causalNormalizationLow);
      const high = Number(column.causalNormalizationHigh);
      if (!(high > low)) throw new Error("Invalid causal normalization bounds");
      causalNormalizationLow[columnIndex] = low;
      causalNormalizationHigh[columnIndex] = high;
    }
  }
  const startTime = timestamps[0]!;
  const endTime = timestamps.at(-1)!;
  const createdAt = options.createdAt ?? Date.now();
  if (options.sourceCutoffTimestamp < endTime || options.sourceCutoffTimestamp > createdAt + 3_000) {
    throw new Error("BCLIF source cutoff must be between tile end and creation time");
  }
  const tileVersion = options.tileVersion ?? 1;
  return {
    tileId: options.tileId || deterministicBclifTileId({
      authority: options.authority,
      horizon: options.horizon,
      modelVersion: options.modelVersion,
      sourceVersion: options.sourceVersion,
      startTime,
      endTime,
      symbol: options.symbol,
      tileVersion
    }),
    tileVersion,
    venue: options.venue,
    symbol: options.symbol,
    marketKind: options.marketKind,
    horizon: options.horizon,
    authority: options.authority,
    modelVersion: options.modelVersion,
    sourceVersion: options.sourceVersion,
    coverageQuality: options.coverageQuality,
    startTime,
    endTime,
    sourceCutoffTimestamp: options.sourceCutoffTimestamp,
    minPrice: options.minPrice,
    maxPrice: options.minPrice + options.priceStep * Math.max(1, options.rows - 1),
    timeStepMs: options.timeStepMs,
    priceStep: options.priceStep,
    columns: ordered.length,
    rows: options.rows,
    createdAt,
    channels: {
      timestamps,
      longExposure,
      shortExposure,
      combinedExposure,
      confidence,
      validity,
      confirmedIntensity,
      confirmedNotional,
      confirmedCount,
      causalNormalizationLow,
      causalNormalizationHigh
    }
  };
}

export function deterministicBclifTileId(identity: Record<string, string | number>) {
  const digest = createHash("sha256")
    .update(Object.keys(identity).sort().map((key) => `${key}=${identity[key]}`).join("\n"))
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function requireColumnLength(value: ArrayLike<number>, rows: number, name: string) {
  if (value.length !== rows) throw new Error(`BCLIF ${name} column length must be ${rows}`);
}

function finiteNonNegative(value: number, name: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid BCLIF ${name}`);
  return value;
}
