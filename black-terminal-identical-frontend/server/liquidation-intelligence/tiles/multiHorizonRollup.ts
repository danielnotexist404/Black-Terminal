import type { BclifDecodedTile, BclifTileHorizon, BclifTileInput } from "../contracts.ts";
import { compactBclifTiles } from "./tileCompactor.ts";

export const BCLIF_ROLLUP_SOURCE_TILE_COUNTS: Readonly<Record<Exclude<BclifTileHorizon, "6H" | "CUSTOM">, number>> = {
  "12H": 2,
  "1D": 4,
  "3D": 12,
  "1W": 28,
  "3W": 84,
  "1M": 120
};
const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;

/**
 * Derive every longer horizon from the same immutable 6H source-tile stream.
 * No horizon runs a second cohort engine and the final-in-group timestamp keeps
 * each rollup causal.
 */
export function buildAvailableHorizonRollups(
  sourceTiles: readonly BclifDecodedTile[],
  options: { createdAt?: number } = {}
): Map<BclifTileHorizon, BclifTileInput> {
  const unique = new Map<string, BclifDecodedTile>();
  for (const tile of sourceTiles) {
    if (tile.horizon !== "6H") continue;
    const key = `${tile.startTime}:${tile.endTime}`;
    const current = unique.get(key);
    if (!current || tile.tileVersion > current.tileVersion || (tile.tileVersion === current.tileVersion && tile.sourceCutoffTimestamp > current.sourceCutoffTimestamp)) unique.set(key, tile);
  }
  const ordered = [...unique.values()]
    .filter((tile) => tile.horizon === "6H")
    .sort((a, b) => a.startTime - b.startTime || a.tileId.localeCompare(b.tileId));
  const output = new Map<BclifTileHorizon, BclifTileInput>();
  for (const [horizon, required] of Object.entries(BCLIF_ROLLUP_SOURCE_TILE_COUNTS) as Array<[Exclude<BclifTileHorizon, "6H" | "CUSTOM">, number]>) {
    if (ordered.length < required) continue;
    const horizonMs = required * SIX_HOURS_MS;
    const latest = ordered.at(-1)!;
    const bucketStart = Math.floor((latest.endTime - 1) / horizonMs) * horizonMs;
    const bucketEnd = bucketStart + horizonMs;
    const selected = ordered.filter((tile) => tile.startTime >= bucketStart && tile.endTime <= bucketEnd);
    if (selected.length !== required || selected[0]!.startTime !== bucketStart + selected[0]!.timeStepMs || selected.at(-1)!.endTime !== bucketEnd) continue;
    if (selected.some((tile, index) => index > 0 && tile.startTime !== selected[index - 1]!.endTime + tile.timeStepMs)) continue;
    const before = ordered.filter((tile) => tile.endTime < selected[0]!.startTime);
    output.set(horizon, compactBclifTiles(selected, {
      targetHorizon: horizon,
      timeFactor: required,
      tileVersion: Math.max(...selected.map((tile) => tile.tileVersion)),
      createdAt: options.createdAt,
      normalizationWarmup: buildWarmup(before, required, selected[0]!.rows, 63)
    }));
  }
  return output;
}

function buildWarmup(tiles: readonly BclifDecodedTile[], factor: number, rows: number, maximumColumns: number) {
  const raw = tiles.flatMap((tile) => Array.from({ length: tile.columns }, (_, column) => ({ tile, column })));
  const usable = raw.slice(-(maximumColumns * factor));
  const skip = usable.length % factor;
  const aligned = usable.slice(skip);
  const output: number[][] = [];
  for (let index = 0; index < aligned.length; index += factor) {
    const group = aligned.slice(index, index + factor);
    const values: number[] = [];
    for (let row = 0; row < rows; row += 1) {
      let combined = 0;
      let valid = true;
      for (const item of group) {
        const sourceIndex = item.column * rows + row;
        combined += item.tile.channels.combinedExposure[sourceIndex]!;
        valid &&= item.tile.channels.validity[sourceIndex] === 1;
      }
      if (valid && combined > 0) values.push(Math.log1p(combined));
    }
    output.push(values);
  }
  return output;
}
