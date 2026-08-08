import type { BclifDecodedTile, BclifTileHorizon, BclifTileInput } from "../contracts.ts";
import type { BclifModelColumn } from "./tileBuilder.ts";
import { deterministicBclifTileId } from "./tileBuilder.ts";
import { BCLIF_ROLLUP_SOURCE_TILE_COUNTS } from "./multiHorizonRollup.ts";

const SIX_HOURS_MS = 6 * 60 * 60_000;
const MAX_OUTPUT_COLUMNS = 360;
const FACTORS: Readonly<Record<Exclude<BclifTileHorizon, "CUSTOM">, number>> = { "6H": 1, ...BCLIF_ROLLUP_SOURCE_TILE_COUNTS };
type TileLike = BclifTileInput | BclifDecodedTile;
type ColumnReference = { kind: "decoded"; tile: BclifDecodedTile; column: number } | { kind: "active"; value: BclifModelColumn };
interface LiveEdgeOptions {
  symbol: string;
  modelVersion: string;
  sourceVersion: string;
  minPrice: number;
  priceStep: number;
  rows: number;
  baseTimeStepMs: number;
  coverageQuality: BclifTileInput["coverageQuality"];
  createdAt?: number;
  priorLiveEdges?: ReadonlyMap<BclifTileHorizon, TileLike>;
}

/**
 * Incrementally extend one cumulative STAGING sidecar per public horizon.
 * Existing STAGING tiles are compact prefixes; only the two resident boundary
 * base tiles plus the active bucket are referenced for append alignment. This
 * bounds resident history and avoids cloning a month of 6H channels every
 * minute, while still tolerating a collector pause between publications.
 */
export function buildCumulativeLiveEdges(
  recentBaseTiles: readonly BclifDecodedTile[],
  activeColumns: readonly BclifModelColumn[],
  options: LiveEdgeOptions
) {
  const latest = activeColumns.at(-1)?.timestamp;
  if (latest === undefined) return new Map<BclifTileHorizon, BclifTileInput>();
  const references = new Map<number, ColumnReference>();
  for (const tile of recentBaseTiles) {
    if (tile.horizon !== "6H" || tile.symbol !== options.symbol || tile.rows !== options.rows || tile.minPrice !== options.minPrice || tile.priceStep !== options.priceStep || tile.timeStepMs !== options.baseTimeStepMs) continue;
    for (let column = 0; column < tile.columns; column += 1) {
      const timestamp = tile.channels.timestamps[column]!;
      if (timestamp <= latest) references.set(timestamp, { kind: "decoded", tile, column });
    }
  }
  for (const value of activeColumns) references.set(value.timestamp, { kind: "active", value });

  const output = new Map<BclifTileHorizon, BclifTileInput>();
  for (const [horizon, factor] of Object.entries(FACTORS) as Array<[Exclude<BclifTileHorizon, "CUSTOM">, number]>) {
    const horizonMs = factor * SIX_HOURS_MS;
    const bucketStart: number = Math.floor((latest - 1) / horizonMs) * horizonMs;
    const candidate = options.priorLiveEdges?.get(horizon);
    const prefix: TileLike | null = validPrefix(candidate, horizon, factor, bucketStart, latest, options) ? candidate! : null;
    if (prefix?.endTime === latest) {
      output.set(horizon, prefix);
      continue;
    }
    const groups: ColumnReference[][] = [];
    let groupEnd = prefix ? prefix.endTime + factor * options.baseTimeStepMs : bucketStart + factor * options.baseTimeStepMs;
    let started = Boolean(prefix);
    for (; groupEnd <= latest; groupEnd += factor * options.baseTimeStepMs) {
      const group: ColumnReference[] = [];
      for (let index = factor - 1; index >= 0; index -= 1) {
        const reference = references.get(groupEnd - index * options.baseTimeStepMs);
        if (!reference) { group.length = 0; break; }
        group.push(reference);
      }
      if (!group.length) {
        if (started) break;
        continue;
      }
      started = true;
      groups.push(group);
    }
    const totalColumns = (prefix?.columns ?? 0) + groups.length;
    if (totalColumns < 2) continue;
    if (totalColumns > MAX_OUTPUT_COLUMNS) throw new Error("BCLIF cumulative live edge exceeded its bounded output width");
    if (!groups.length && prefix) {
      output.set(horizon, prefix);
      continue;
    }
    output.set(horizon, extendPrefix(prefix, groups, factor, bucketStart, horizon, options));
  }
  return output;
}

export function horizonDurationMs(horizon: BclifTileHorizon) {
  if (horizon === "CUSTOM") throw new Error("CUSTOM has no fixed BCLIF staging bucket");
  return FACTORS[horizon] * SIX_HOURS_MS;
}

function validPrefix(
  tile: TileLike | undefined,
  horizon: Exclude<BclifTileHorizon, "CUSTOM">,
  factor: number,
  bucketStart: number,
  latest: number,
  options: LiveEdgeOptions
) {
  return Boolean(tile
    && tile.horizon === horizon
    && tile.symbol === options.symbol
    && tile.modelVersion === options.modelVersion
    && tile.sourceVersion === options.sourceVersion
    && tile.authority === "PERSISTENT_NODE"
    && tile.tileVersion === 1
    && tile.rows === options.rows
    && tile.minPrice === options.minPrice
    && tile.priceStep === options.priceStep
    && tile.timeStepMs === factor * options.baseTimeStepMs
    && tile.startTime > bucketStart
    && tile.endTime <= latest
    && tile.endTime <= bucketStart + horizonDurationMs(horizon));
}

function extendPrefix(
  prefix: TileLike | null,
  groups: readonly (readonly ColumnReference[])[],
  factor: number,
  bucketStart: number,
  horizon: Exclude<BclifTileHorizon, "CUSTOM">,
  options: LiveEdgeOptions
): BclifTileInput {
  const prefixColumns = prefix?.columns ?? 0;
  const columns = prefixColumns + groups.length;
  const rows = options.rows;
  const cells = columns * rows;
  const timestamps = new Float64Array(columns);
  const longExposure = new Float32Array(cells);
  const shortExposure = new Float32Array(cells);
  const combinedExposure = new Float32Array(cells);
  const confidence = new Uint8Array(cells);
  const validity = new Uint8Array(cells);
  const confirmedIntensity = new Uint8Array(cells);
  const confirmedNotional = new Float32Array(cells);
  const confirmedCount = new Uint16Array(cells);
  const causalNormalizationLow = new Float32Array(columns);
  const causalNormalizationHigh = new Float32Array(columns);
  if (prefix) {
    timestamps.set(prefix.channels.timestamps);
    longExposure.set(prefix.channels.longExposure);
    shortExposure.set(prefix.channels.shortExposure);
    combinedExposure.set(prefix.channels.combinedExposure);
    confidence.set(prefix.channels.confidence);
    validity.set(prefix.channels.validity);
    confirmedIntensity.set(prefix.channels.confirmedIntensity);
    confirmedNotional.set(prefix.channels.confirmedNotional);
    confirmedCount.set(prefix.channels.confirmedCount);
    causalNormalizationLow.set(prefix.channels.causalNormalizationLow);
    causalNormalizationHigh.set(prefix.channels.causalNormalizationHigh);
  }
  const expected = { long: 0, short: 0, combined: 0, confirmedNotional: 0, confirmedCount: 0 };
  for (let appended = 0; appended < groups.length; appended += 1) {
    const column = prefixColumns + appended;
    const group = groups[appended]!;
    timestamps[column] = timestampOf(group.at(-1)!);
    if (factor === 1) {
      causalNormalizationLow[column] = scalarOf(group[0]!, "causalNormalizationLow");
      causalNormalizationHigh[column] = scalarOf(group[0]!, "causalNormalizationHigh");
    }
    for (let row = 0; row < rows; row += 1) {
      const target = column * rows + row;
      let minimumConfidence = 255;
      let allValid = true;
      let count = 0;
      for (const reference of group) {
        const long = cellOf(reference, "longExposure", row);
        const short = cellOf(reference, "shortExposure", row);
        const combined = cellOf(reference, "combinedExposure", row);
        const notional = cellOf(reference, "confirmedNotional", row);
        const eventCount = cellOf(reference, "confirmedCount", row);
        longExposure[target] = longExposure[target]! + long;
        shortExposure[target] = shortExposure[target]! + short;
        combinedExposure[target] = combinedExposure[target]! + combined;
        confirmedNotional[target] = confirmedNotional[target]! + notional;
        count += eventCount;
        minimumConfidence = Math.min(minimumConfidence, cellOf(reference, "confidence", row));
        allValid &&= cellOf(reference, "validity", row) === 1;
        expected.long += long;
        expected.short += short;
        expected.combined += combined;
        expected.confirmedNotional += notional;
        expected.confirmedCount += eventCount;
      }
      if (count > 65_535) throw new Error("BCLIF confirmed-event count exceeds lossless Uint16 rollup bound");
      confidence[target] = minimumConfidence;
      validity[target] = allValid ? 1 : 0;
      confirmedCount[target] = count;
      if (factor === 1) confirmedIntensity[target] = cellOf(group[0]!, "confirmedIntensity", row);
    }
  }
  if (factor > 1) {
    deriveConfirmedIntensity(confirmedNotional, confirmedIntensity, columns, rows, prefixColumns);
    deriveCausalBounds(combinedExposure, validity, columns, rows, causalNormalizationLow, causalNormalizationHigh, prefixColumns);
  }
  verifyAppendedConservation(expected, prefixColumns * rows, longExposure, shortExposure, combinedExposure, confirmedNotional, confirmedCount);
  const tileId = deterministicBclifTileId({ liveEdge: 1, bucketStart, horizon, modelVersion: options.modelVersion, sourceVersion: options.sourceVersion, symbol: options.symbol });
  return {
    tileId,
    tileVersion: 1,
    venue: "BYBIT",
    symbol: options.symbol,
    marketKind: "linear_perpetual",
    horizon,
    authority: "PERSISTENT_NODE",
    modelVersion: options.modelVersion,
    sourceVersion: options.sourceVersion,
    coverageQuality: options.coverageQuality,
    startTime: timestamps[0]!,
    endTime: timestamps.at(-1)!,
    sourceCutoffTimestamp: timestamps.at(-1)!,
    minPrice: options.minPrice,
    maxPrice: options.minPrice + options.priceStep * Math.max(1, rows - 1),
    timeStepMs: options.baseTimeStepMs * factor,
    priceStep: options.priceStep,
    columns,
    rows,
    createdAt: options.createdAt ?? Date.now(),
    channels: { timestamps, longExposure, shortExposure, combinedExposure, confidence, validity, confirmedIntensity, confirmedNotional, confirmedCount, causalNormalizationLow, causalNormalizationHigh }
  };
}

type CellChannel = "longExposure" | "shortExposure" | "combinedExposure" | "confidence" | "validity" | "confirmedIntensity" | "confirmedNotional" | "confirmedCount";
function timestampOf(reference: ColumnReference) { return reference.kind === "active" ? reference.value.timestamp : reference.tile.channels.timestamps[reference.column]!; }
function cellOf(reference: ColumnReference, channel: CellChannel, row: number) {
  return reference.kind === "active" ? (reference.value[channel] as ArrayLike<number>)[row]! : (reference.tile.channels[channel] as ArrayLike<number>)[reference.column * reference.tile.rows + row]!;
}
function scalarOf(reference: ColumnReference, channel: "causalNormalizationLow" | "causalNormalizationHigh") {
  const value = reference.kind === "active" ? reference.value[channel] : reference.tile.channels[channel][reference.column];
  if (!Number.isFinite(value)) throw new Error("BCLIF live edge lacks causal normalization metadata");
  return Number(value);
}

function deriveConfirmedIntensity(notional: Float32Array, output: Uint8Array, columns: number, rows: number, startColumn: number) {
  const history: number[][] = [];
  for (let column = Math.max(0, startColumn - 64); column < startColumn; column += 1) history.push(logValues(notional, null, column, rows));
  for (let column = startColumn; column < columns; column += 1) {
    const prior = history.flat().sort((left, right) => left - right);
    const scale = Math.max(50_000, prior.length ? Math.expm1(quantile(prior, 0.995)) : 0);
    for (let row = 0; row < rows; row += 1) {
      const index = column * rows + row;
      output[index] = Math.round(255 * Math.sqrt(Math.min(1, notional[index]! / scale)));
    }
    history.push(logValues(notional, null, column, rows));
    if (history.length > 64) history.shift();
  }
}

function deriveCausalBounds(exposure: Float32Array, validity: Uint8Array, columns: number, rows: number, lows: Float32Array, highs: Float32Array, startColumn: number) {
  const history: number[][] = [];
  for (let column = Math.max(0, startColumn - 63); column < startColumn; column += 1) history.push(logValues(exposure, validity, column, rows));
  let lastLow = startColumn ? lows[startColumn - 1]! : 0;
  let lastHigh = startColumn ? highs[startColumn - 1]! : 1e-6;
  for (let column = startColumn; column < columns; column += 1) {
    history.push(logValues(exposure, validity, column, rows));
    if (history.length > 64) history.shift();
    const window = history.flat().sort((left, right) => left - right);
    if (window.length) {
      lastLow = quantile(window, 0.03);
      lastHigh = Math.max(lastLow + 1e-6, quantile(window, 0.997));
    }
    lows[column] = lastLow;
    highs[column] = lastHigh;
  }
}

function logValues(values: Float32Array, validity: Uint8Array | null, column: number, rows: number) {
  const output: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    const index = column * rows + row;
    if ((validity === null || validity[index]) && values[index]! > 0) output.push(Math.log1p(values[index]!));
  }
  return output;
}
function verifyAppendedConservation(expected: { long: number; short: number; combined: number; confirmedNotional: number; confirmedCount: number }, offset: number, long: Float32Array, short: Float32Array, combined: Float32Array, notional: Float32Array, count: Uint16Array) {
  for (const [label, source, target, absolute] of [
    ["long exposure", expected.long, sum(long, offset), 1e-4],
    ["short exposure", expected.short, sum(short, offset), 1e-4],
    ["combined exposure", expected.combined, sum(combined, offset), 1e-4],
    ["confirmed liquidation notional", expected.confirmedNotional, sum(notional, offset), 0.01]
  ] as const) if (Math.abs(source - target) > Math.max(absolute, Math.abs(source) * 2e-6)) throw new Error(`BCLIF live-edge aggregation changed ${label}`);
  if (expected.confirmedCount !== sum(count, offset)) throw new Error("BCLIF live-edge aggregation changed confirmed liquidation event count");
}
function sum(values: ArrayLike<number>, start = 0) { let total = 0; for (let index = start; index < values.length; index += 1) total += values[index]!; return total; }
function quantile(sorted: readonly number[], q: number) {
  const position = Math.max(0, Math.min(sorted.length - 1, q * (sorted.length - 1)));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return (sorted[lower] ?? 0) * (1 - (position - lower)) + (sorted[upper] ?? 0) * (position - lower);
}
