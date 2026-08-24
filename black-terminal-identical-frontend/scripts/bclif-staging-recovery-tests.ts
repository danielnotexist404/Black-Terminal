import assert from "node:assert/strict";
import { buildBclifTile } from "../server/liquidation-intelligence/tiles/tileBuilder.ts";
import { encodeBclifTile } from "../server/liquidation-intelligence/tiles/tileCodec.ts";
import {
  BCLIF_LIVE_STAGING_HORIZONS,
  BclifTileRepository,
  selectNewestBclifStagingBucket
} from "../server/liquidation-intelligence/tiles/tileRepository.ts";
import { makeModelColumn, TEST_CADENCE_MS, TEST_MODEL_VERSION, TEST_SOURCE_VERSION } from "./bclif-test-fixtures.ts";

const SOURCE_ID = "00000000-0000-8000-8000-000000000001";
const NODE_ID = "LIQUIDATION_INTELLIGENCE_NODE_01";
const FENCE = { nodeId: NODE_ID, instanceId: "instance-staging-recovery", fencingEpoch: 7 };

function makeStagingTile(bucketStart: number, seed: number) {
  const columns = [
    makeModelColumn(bucketStart + TEST_CADENCE_MS, 8, seed),
    makeModelColumn(bucketStart + TEST_CADENCE_MS * 2, 8, seed + 1)
  ];
  return buildBclifTile(columns, {
    venue: "BYBIT",
    symbol: "BTCUSDT",
    marketKind: "linear_perpetual",
    horizon: "6H",
    authority: "PERSISTENT_NODE",
    modelVersion: TEST_MODEL_VERSION,
    sourceVersion: TEST_SOURCE_VERSION,
    coverageQuality: "HIGH",
    sourceCutoffTimestamp: columns.at(-1)!.timestamp,
    minPrice: 50_000,
    priceStep: 25,
    rows: 8,
    timeStepMs: TEST_CADENCE_MS,
    createdAt: columns.at(-1)!.timestamp
  });
}

function stagingRow(tile: ReturnType<typeof makeStagingTile>, objectPath: string) {
  const encoded = encodeBclifTile(tile);
  return {
    row: {
      id: tile.tileId,
      object_path: objectPath,
      checksum: encoded.objectChecksum,
      chunk_start: new Date(tile.startTime).toISOString(),
      chunk_end: new Date(tile.endTime).toISOString(),
      source_cutoff_at: new Date(tile.sourceCutoffTimestamp).toISOString(),
      coverage_quality: tile.coverageQuality,
      published_at: new Date(tile.createdAt).toISOString(),
      created_at: new Date(tile.createdAt).toISOString(),
      tile_version: tile.tileVersion,
      schema_version: tile.schemaVersion,
      model_version: tile.modelVersion,
      horizon: tile.horizon,
      publication_state: "STAGING"
    },
    bytes: encoded.bytes
  };
}

class StagingQuery {
  private horizon = "";
  private readonly rowsByHorizon: Readonly<Record<string, readonly any[]>>;
  private readonly requestedHorizons: string[];
  constructor(rowsByHorizon: Readonly<Record<string, readonly any[]>>, requestedHorizons: string[]) {
    this.rowsByHorizon = rowsByHorizon;
    this.requestedHorizons = requestedHorizons;
  }
  select() { return this; }
  eq(column: string, value: unknown) {
    if (column === "horizon") {
      this.horizon = String(value);
      this.requestedHorizons.push(this.horizon);
    }
    return this;
  }
  order() { return this; }
  limit() { return this; }
  then(resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) {
    return Promise.resolve({ data: [...(this.rowsByHorizon[this.horizon] || [])], error: null }).then(resolve, reject);
  }
}

function makeRepository(rowsByHorizon: Readonly<Record<string, readonly any[]>>, objects: ReadonlyMap<string, Uint8Array>, downloads: string[]) {
  const requestedHorizons: string[] = [];
  const supabase = {
    from(table: string) {
      assert.equal(table, "bclif_field_chunks");
      return new StagingQuery(rowsByHorizon, requestedHorizons);
    }
  };
  const objectStore = {
    async download(path: string) {
      downloads.push(path);
      const bytes = objects.get(path);
      if (!bytes) throw new Error(`Missing test object ${path}`);
      return bytes;
    }
  };
  return {
    repository: new BclifTileRepository(supabase, objectStore as any, SOURCE_ID, NODE_ID, FENCE),
    requestedHorizons
  };
}

const older = stagingRow(makeStagingTile(0, 1), "older-6h.bclif");
const current = stagingRow(makeStagingTile(6 * 60 * 60_000, 10), "current-6h.bclif");
const downloads: string[] = [];
const { repository, requestedHorizons } = makeRepository(
  { "6H": [older.row, current.row] },
  new Map([[older.row.object_path, older.bytes], [current.row.object_path, current.bytes]]),
  downloads
);
const restored = await repository.loadCurrentStaging("BTCUSDT", TEST_MODEL_VERSION);
assert.equal(restored.get("6H")?.tileId, current.row.id, "restart must restore the newest UTC bucket, not fail on an older incomplete bucket");
assert.deepEqual(downloads, [current.row.object_path], "stale buckets must neither replace nor poison the current live edge");
assert.deepEqual(requestedHorizons, [...BCLIF_LIVE_STAGING_HORIZONS], "each live horizon must be queried independently so stale rows cannot crowd out another horizon");

assert.throws(() => selectNewestBclifStagingBucket([
  current.row,
  { ...current.row, id: "00000000-0000-8000-8000-000000000099", object_path: "duplicate-current-6h.bclif" }
], "6H"), /multiple STAGING authorities for one 6H UTC bucket/, "same-bucket duplicate authority must still fail closed");

assert.throws(() => selectNewestBclifStagingBucket([{ ...current.row, chunk_start: "not-a-time" }], "6H"), /invalid timestamp/);

const corruptDownloads: string[] = [];
const corruptObjects = new Map<string, Uint8Array>([
  [older.row.object_path, older.bytes],
  [current.row.object_path, new Uint8Array([1, 2, 3])]
]);
const corruptRepository = makeRepository({ "6H": [older.row, current.row] }, corruptObjects, corruptDownloads).repository;
await assert.rejects(
  () => corruptRepository.loadCurrentStaging("BTCUSDT", TEST_MODEL_VERSION),
  /failed restart checksum verification/,
  "a corrupt current bucket must fail closed instead of silently falling back to stale data"
);
assert.deepEqual(corruptDownloads, [current.row.object_path]);

console.log("BCLIF staging recovery tests passed");
