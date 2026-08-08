import type { BclifDecodedTile, BclifTileHorizon, BclifTileInput } from "../contracts.ts";
import { deterministicBclifTileId } from "./tileBuilder.ts";

/**
 * Deterministically concatenate finalized tiles and optionally aggregate
 * adjacent time columns. Exposure is summed (never averaged), confidence is
 * conservative, and a validity gap remains a gap. Confirmed event notional
 * and count are quantitatively summed before the display intensity is derived
 * from prior columns only.
 */
export function compactBclifTiles(
  source: readonly BclifDecodedTile[],
  options: {
    tileId?: string;
    tileVersion?: number;
    targetHorizon?: BclifTileHorizon;
    timeFactor?: number;
    createdAt?: number;
    normalizationWarmup?: readonly (readonly number[])[];
  } = {}
): BclifTileInput {
  if (!source.length) throw new Error("BCLIF compaction requires source tiles");
  const tiles = [...source].sort((a, b) => a.startTime - b.startTime || a.tileId.localeCompare(b.tileId));
  const base = tiles[0]!;
  for (let index = 0; index < tiles.length; index += 1) validateCompatible(base, tiles[index]!, index ? tiles[index - 1] : undefined);
  const sourceColumns = tiles.reduce((sum, tile) => sum + tile.columns, 0);
  const factor = Math.max(1, Math.floor(options.timeFactor ?? 1));
  if (sourceColumns % factor !== 0) throw new Error("BCLIF compaction factor must divide the source column count exactly");
  const outputColumns = sourceColumns / factor;
  const rows = base.rows;
  const cells = outputColumns * rows;
  const timestamps = new Float64Array(outputColumns);
  const longExposure = new Float32Array(cells);
  const shortExposure = new Float32Array(cells);
  const combinedExposure = new Float32Array(cells);
  const confidence = new Uint8Array(cells);
  const validity = new Uint8Array(cells);
  const confirmedIntensity = new Uint8Array(cells);
  const confirmedNotional = new Float32Array(cells);
  const confirmedCount = new Uint16Array(cells);
  const preserveBounds = factor === 1 && tiles.every((tile) => tile.channels.causalNormalizationLow.length === tile.columns && tile.channels.causalNormalizationHigh.length === tile.columns);
  const causalNormalizationLow = new Float32Array(outputColumns);
  const causalNormalizationHigh = new Float32Array(outputColumns);
  const sourceColumnsFlat = tiles.flatMap((tile) => Array.from({ length: tile.columns }, (_, column) => ({ tile, column })));

  for (let outputColumn = 0; outputColumn < outputColumns; outputColumn += 1) {
    const group = sourceColumnsFlat.slice(outputColumn * factor, (outputColumn + 1) * factor);
    timestamps[outputColumn] = group.at(-1)!.tile.channels.timestamps[group.at(-1)!.column]!;
    if (preserveBounds) {
      causalNormalizationLow[outputColumn] = group.at(-1)!.tile.channels.causalNormalizationLow[group.at(-1)!.column]!;
      causalNormalizationHigh[outputColumn] = group.at(-1)!.tile.channels.causalNormalizationHigh[group.at(-1)!.column]!;
    }
    for (let row = 0; row < rows; row += 1) {
      const target = outputColumn * rows + row;
      let minConfidence = 255;
      let allValid = true;
      let confirmedNotionalSum = 0;
      let confirmedCountSum = 0;
      for (const item of group) {
        const sourceIndex = item.column * rows + row;
        longExposure[target] = longExposure[target]! + item.tile.channels.longExposure[sourceIndex]!;
        shortExposure[target] = shortExposure[target]! + item.tile.channels.shortExposure[sourceIndex]!;
        combinedExposure[target] = combinedExposure[target]! + item.tile.channels.combinedExposure[sourceIndex]!;
        minConfidence = Math.min(minConfidence, item.tile.channels.confidence[sourceIndex]!);
        allValid &&= item.tile.channels.validity[sourceIndex] === 1;
        confirmedNotionalSum += item.tile.channels.confirmedNotional[sourceIndex]!;
        confirmedCountSum += item.tile.channels.confirmedCount[sourceIndex]!;
      }
      if (confirmedCountSum > 65_535) throw new Error("BCLIF confirmed-event count exceeds lossless Uint16 rollup bound");
      confidence[target] = minConfidence;
      validity[target] = allValid ? 1 : 0;
      confirmedNotional[target] = confirmedNotionalSum;
      confirmedCount[target] = confirmedCountSum;
    }
  }
  deriveConfirmedIntensity(confirmedNotional, confirmedIntensity, outputColumns, rows);
  if (!preserveBounds) recomputeCausalBounds(
    combinedExposure,
    validity,
    outputColumns,
    rows,
    causalNormalizationLow,
    causalNormalizationHigh,
    64,
    options.normalizationWarmup
  );
  verifyExposureConservation(tiles, longExposure, shortExposure, combinedExposure);
  verifyConfirmedConservation(tiles, confirmedNotional, confirmedCount);
  // Tile version is a reader/codec compatibility version, not a publication
  // revision counter. Corrections and live-edge revisions are identified by
  // immutable checksum/object path and source cutoff while all current API
  // and client readers intentionally support tileVersion=1 only.
  const tileVersion = options.tileVersion ?? 1;
  if (tileVersion !== 1 || tiles.some((tile) => tile.tileVersion !== 1)) throw new Error("Unsupported BCLIF tile compatibility version");
  const targetHorizon = options.targetHorizon ?? base.horizon;
  return {
    tileId: options.tileId || deterministicBclifTileId({
      authority: base.authority,
      horizon: targetHorizon,
      modelVersion: base.modelVersion,
      sourceVersion: base.sourceVersion,
      startTime: timestamps[0]!,
      endTime: timestamps.at(-1)!,
      symbol: base.symbol,
      tileVersion
    }),
    tileVersion,
    venue: base.venue,
    symbol: base.symbol,
    marketKind: base.marketKind,
    horizon: targetHorizon,
    authority: base.authority,
    modelVersion: base.modelVersion,
    sourceVersion: base.sourceVersion,
    coverageQuality: worstQuality(tiles.map((tile) => tile.coverageQuality)),
    startTime: timestamps[0]!,
    endTime: timestamps.at(-1)!,
    sourceCutoffTimestamp: Math.max(...tiles.map((tile) => tile.sourceCutoffTimestamp)),
    minPrice: base.minPrice,
    maxPrice: base.maxPrice,
    timeStepMs: base.timeStepMs * factor,
    priceStep: base.priceStep,
    columns: outputColumns,
    rows,
    createdAt: options.createdAt ?? Date.now(),
    channels: { timestamps, longExposure, shortExposure, combinedExposure, confidence, validity, confirmedIntensity, confirmedNotional, confirmedCount, causalNormalizationLow, causalNormalizationHigh }
  };
}

function validateCompatible(base: BclifDecodedTile, tile: BclifDecodedTile, previous?: BclifDecodedTile) {
  for (const key of ["venue", "symbol", "marketKind", "horizon", "modelVersion", "sourceVersion", "rows", "minPrice", "maxPrice", "priceStep", "timeStepMs"] as const) {
    if (base[key] !== tile[key]) throw new Error(`BCLIF compaction mismatch: ${key}`);
  }
  if (previous && tile.startTime !== previous.endTime + base.timeStepMs) throw new Error("BCLIF compaction refuses overlaps or continuity gaps");
}

function verifyExposureConservation(source: readonly BclifDecodedTile[], ...outputs: Float32Array[]) {
  const sourceArrays = ["longExposure", "shortExposure", "combinedExposure"] as const;
  for (let channel = 0; channel < sourceArrays.length; channel += 1) {
    const sourceSum = source.reduce((total, tile) => total + sum(tile.channels[sourceArrays[channel]!]), 0);
    const outputSum = sum(outputs[channel]!);
    const tolerance = Math.max(1e-4, Math.abs(sourceSum) * 2e-6);
    if (Math.abs(sourceSum - outputSum) > tolerance) throw new Error(`BCLIF compaction changed ${sourceArrays[channel]} total exposure`);
  }
}

function sum(values: Float32Array) { let result = 0; for (const value of values) result += value; return result; }
function verifyConfirmedConservation(source: readonly BclifDecodedTile[], notional: Float32Array, count: Uint16Array) {
  const sourceNotional = source.reduce((total, tile) => total + sum(tile.channels.confirmedNotional), 0);
  const outputNotional = sum(notional);
  const tolerance = Math.max(0.01, Math.abs(sourceNotional) * 2e-6);
  if (Math.abs(sourceNotional - outputNotional) > tolerance) throw new Error("BCLIF compaction changed confirmed liquidation notional");
  const sourceCount = source.reduce((total, tile) => total + sumUint16(tile.channels.confirmedCount), 0);
  if (sourceCount !== sumUint16(count)) throw new Error("BCLIF compaction changed confirmed liquidation event count");
}
function sumUint16(values: Uint16Array) { let result = 0; for (const value of values) result += value; return result; }
function deriveConfirmedIntensity(notional: Float32Array, output: Uint8Array, columns: number, rows: number) {
  const history: number[][] = [];
  for (let column = 0; column < columns; column += 1) {
    const prior = history.flat().sort((left, right) => left - right);
    const scale = Math.max(50_000, prior.length ? Math.expm1(quantile(prior, 0.995)) : 0);
    const current: number[] = [];
    for (let row = 0; row < rows; row += 1) {
      const index = column * rows + row;
      const value = notional[index]!;
      output[index] = Math.round(255 * Math.sqrt(Math.min(1, value / scale)));
      if (value > 0) current.push(Math.log1p(value));
    }
    history.push(current);
    if (history.length > 64) history.shift();
  }
}
function recomputeCausalBounds(
  exposure: Float32Array,
  validity: Uint8Array,
  columns: number,
  rows: number,
  lows: Float32Array,
  highs: Float32Array,
  trailingColumns = 64,
  warmup: readonly (readonly number[])[] = []
) {
  if (warmup.length >= trailingColumns || warmup.some((column) => column.some((value) => !Number.isFinite(value) || value < 0))) {
    throw new Error("Invalid BCLIF causal-normalization warmup");
  }
  const history: number[][] = warmup.map((column) => [...column].sort((a, b) => a - b));
  let lastLow = 0;
  let lastHigh = 1e-6;
  for (let column = 0; column < columns; column += 1) {
    const values: number[] = [];
    for (let row = 0; row < rows; row += 1) {
      const index = column * rows + row;
      if (validity[index] && exposure[index]! > 0) values.push(Math.log1p(exposure[index]!));
    }
    history.push(values);
    if (history.length > trailingColumns) history.shift();
    const window = history.flat().sort((a, b) => a - b);
    if (window.length) {
      lastLow = quantile(window, 0.03);
      lastHigh = Math.max(lastLow + 1e-6, quantile(window, 0.997));
    }
    lows[column] = lastLow;
    highs[column] = lastHigh;
  }
}
function quantile(sorted: readonly number[], q: number) {
  const position = Math.max(0, Math.min(sorted.length - 1, q * (sorted.length - 1)));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return (sorted[lower] ?? 0) * (1 - (position - lower)) + (sorted[upper] ?? 0) * (position - lower);
}
function worstQuality(values: BclifTileInput["coverageQuality"][]) {
  const order = ["INSUFFICIENT", "LOW", "MIXED", "HIGH", "EXCELLENT"] as const;
  return values.reduce((worst, value) => order.indexOf(value) < order.indexOf(worst) ? value : worst, "EXCELLENT" as BclifTileInput["coverageQuality"]);
}
