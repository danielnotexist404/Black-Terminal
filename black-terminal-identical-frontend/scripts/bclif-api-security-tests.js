import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  BCLIF_BUCKET_ID,
  bclifDeferredPayload,
  isDeferredBclifInfrastructureError,
  normalizeBclifRouteError,
  parseBclifAction,
  parseBclifScope,
  parseTileChecksum,
  parseTileId,
  sanitizeTileMetadata,
  validateTileObjectPath,
  verifyTileChecksum
} from "../server/liquidation-intelligence/api/contracts.js";
import { loadVerifiedBclifTile, readBclifCoverage, readBclifManifest, readBclifStatus } from "../server/liquidation-intelligence/api/service.js";
import { assertIdentityPolicy } from "../server/security/securityMiddleware.js";
import bclifApiHandler from "../api/liquidation-intelligence/[action].js";

const tileId = "a3d7b9c1-2e44-4b75-8f90-123456789abc";
const bytes = Buffer.from("deterministic-bclif-object-bytes", "utf8");
const digest = crypto.createHash("sha256").update(bytes).digest("hex");
const checksum = `sha256:${digest}`;
const startMs = 1785888000000;
const path = `v2/BYBIT/linear_perpetual/BTCUSDT/1D/${startMs}/${tileId}-${digest}.bclif`;

assert.equal(parseBclifAction("manifest.js"), "manifest");
assert.throws(() => parseBclifAction("../../storage"), hasCode("BCLIF_ROUTE_NOT_FOUND"));
assert.equal(parseTileId(tileId.toUpperCase()), tileId);
assert.throws(() => parseTileId("../../objects"), hasCode("INVALID_TILE_ID"));
assert.equal(parseTileChecksum(checksum.toUpperCase()), checksum);
assert.throws(() => parseTileChecksum("sha256:wrong"), hasCode("INVALID_TILE_CHECKSUM"));

const scope = parseBclifScope({ venue: "bybit", marketKind: "linear_perpetual", symbol: "btcusdt", horizon: "1d" });
assert.deepEqual(scope, { venue: "BYBIT", marketKind: "linear_perpetual", symbol: "BTCUSDT", horizon: "1D", mode: null, from: null, to: null });
assert.throws(() => parseBclifScope({ venue: "binance" }), hasCode("INVALID_VENUE"));
assert.throws(() => parseBclifScope({ symbol: "../BTCUSDT" }), hasCode("INVALID_SYMBOL"));
assert.throws(() => parseBclifScope({ horizon: "2Y" }), hasCode("INVALID_HORIZON"));
assert.throws(() => parseBclifScope({ from: startMs }), hasCode("INVALID_TIME_RANGE"));
assert.throws(() => parseBclifScope({}, { requireRange: true }), hasCode("INVALID_TIME_RANGE"));
const historicalRangeStart = Date.now() - 92 * 86400000;
assert.throws(() => parseBclifScope({ from: Date.now() - 60_000, to: Date.now() }, { requireRange: true, requireMode: true }), hasCode("INVALID_REQUEST_MODE"));
assert.throws(() => parseBclifScope({ mode: "live", from: historicalRangeStart, to: historicalRangeStart + 60_000 }, { requireRange: true, requireMode: true }), hasCode("INVALID_TIME_RANGE"));
assert.doesNotThrow(() => parseBclifScope({ mode: "live", from: Date.now() - 60_000, to: Date.now() }, { requireRange: true, requireMode: true }));
assert.doesNotThrow(() => parseBclifScope({ from: historicalRangeStart, to: historicalRangeStart + 90 * 86400000 }));
assert.throws(() => parseBclifScope({ from: historicalRangeStart, to: historicalRangeStart + 91 * 86400000 }), hasCode("INVALID_TIME_RANGE"));
const boundedScope = { ...scope, mode: "LIVE", from: startMs - 60_000, to: startMs + 120_000 };

assert.equal(validateTileObjectPath(path, { schemaVersion: 2, symbol: "BTCUSDT", horizon: "1D", startMs, tileId, checksum }), path);
for (const invalid of [
  `tiles/${path}`,
  path.replace("/BYBIT/", "/bybit/"),
  path.replace("/BTCUSDT/", "/btcusdt/"),
  path.replace("/1D/", "/2Y/"),
  path.replace(`/${tileId}-`, "/../../"),
  `${path}.gz`,
  path.replace(digest, digest.toUpperCase())
]) {
  assert.throws(() => validateTileObjectPath(invalid), hasCode("INVALID_TILE_PATH"), invalid);
}
assert.throws(() => validateTileObjectPath(path, { symbol: "ETHUSDT" }), hasCode("TILE_PATH_METADATA_MISMATCH"));
assert.equal(verifyTileChecksum(bytes, checksum), true);
assert.throws(() => verifyTileChecksum(Buffer.from("tampered"), checksum), hasCode("TILE_CHECKSUM_MISMATCH"));

const safeTile = sanitizeTileMetadata(tileRow());
assert.equal(Object.hasOwn(safeTile, "objectPath"), false);
assert.equal(Object.hasOwn(safeTile, "object_path"), false);
assert.equal(safeTile.tileId, tileId);
assert.equal(safeTile.checksum, checksum);

assert.equal(isDeferredBclifInfrastructureError({ code: "PGRST205" }), true);
assert.equal(isDeferredBclifInfrastructureError({ code: "42P01" }), true);
assert.equal(isDeferredBclifInfrastructureError({ code: "XX000", message: "unrelated" }), false);
assert.equal(normalizeBclifRouteError(new Error("Missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.")).code, "PERSISTENCE_CONTROL_PLANE_UNAVAILABLE");
assert.equal(normalizeBclifRouteError(Object.assign(new Error("forbidden"), { statusCode: 403, code: "FORBIDDEN" })).code, "FORBIDDEN");

const unavailable = bclifDeferredPayload(scope);
assert.equal(unavailable.deploymentState, "NOT_DEPLOYED");
assert.equal(unavailable.modelAuthority, "BROWSER_FALLBACK");
assert.equal(unavailable.persistence, false);
assert.deepEqual(unavailable.tiles, []);

const identity = {
  role: "user",
  status: "online",
  productTier: "retail",
  permissions: new Set(),
  allowedIndicators: new Set(["liquidationHeatmap"])
};
assert.doesNotThrow(() => assertIdentityPolicy(identity, { indicator: "liquidationHeatmap" }));
assert.throws(() => assertIdentityPolicy({ ...identity, allowedIndicators: new Set() }, { indicator: "liquidationHeatmap" }), hasCode("INDICATOR_ENTITLEMENT_REQUIRED"));
assert.doesNotThrow(() => assertIdentityPolicy({ ...identity, role: "admin", allowedIndicators: new Set() }, { indicator: "liquidationHeatmap" }));
assert.throws(() => assertIdentityPolicy({ ...identity, status: "suspended" }, { indicator: "liquidationHeatmap" }), hasCode("ACCOUNT_SUSPENDED"));

const deferredStatus = await readBclifStatus(makeSupabase({
  tables: { bclif_collector_nodes: { data: null, error: { code: "PGRST205", message: "schema cache miss" } } }
}));
assert.equal(deferredStatus.httpStatus, 200);
assert.equal(deferredStatus.payload.deploymentState, "NOT_DEPLOYED");

const missingBucketCoverage = await readBclifCoverage(makeSupabase({
  bucket: { data: null, error: { statusCode: 404, message: "Bucket not found" } }
}), boundedScope);
assert.equal(missingBucketCoverage.httpStatus, 200);
assert.equal(missingBucketCoverage.payload.sourceMode, "UNAVAILABLE");
assert.equal(missingBucketCoverage.payload.coverage.trades, null);

const measuredCoverageRow = {
  horizon: "1D",
  requested_start: new Date(boundedScope.from).toISOString(),
  requested_end: new Date(boundedScope.to).toISOString(),
  model_start: new Date(startMs).toISOString(),
  model_end: new Date(startMs + 60_000).toISOString(),
  trade_coverage_percent: 88,
  open_interest_coverage_percent: 100,
  liquidation_coverage_percent: 75,
  orderbook_coverage_percent: 65,
  funding_coverage_percent: 100,
  model_continuity_percent: 100,
  missing_intervals: [{ start: startMs + 10_000, end: startMs + 20_000, missingSources: ["TRADE"] }],
  quality: "HIGH",
  source_mode: "PERSISTENT_COLLECTOR",
  model_authority: "PERSISTENT_NODE",
  source_cutoff_at: new Date(boundedScope.to).toISOString(),
  coverage_version: 1,
  updated_at: new Date(boundedScope.to).toISOString()
};
const exactCoverage = await readBclifCoverage(makeSupabase({
  tables: {
    bclif_sources: { data: [sourceRow()], error: null },
    bclif_coverage: { data: measuredCoverageRow, error: null }
  }
}), boundedScope);
assert.equal(exactCoverage.payload.coverage.trades, 88);
assert.equal(exactCoverage.payload.quality, "HIGH");
assert.deepEqual(
  exactCoverage.payload.gaps.filter((gap) => gap.missingSources.includes("MODEL_FRAME")),
  [
    { start: boundedScope.from, end: startMs, missingSources: ["MODEL_FRAME", "OPEN_INTEREST"] },
    { start: startMs + 60_000, end: boundedScope.to, missingSources: ["MODEL_FRAME", "OPEN_INTEREST"] }
  ]
);
const differentWindow = { ...boundedScope, from: boundedScope.from + 1 };
const mismatchedCoverage = await readBclifCoverage(makeSupabase({
  tables: {
    bclif_sources: { data: [sourceRow()], error: null },
    bclif_coverage: { data: measuredCoverageRow, error: null }
  }
}), differentWindow);
assert.equal(mismatchedCoverage.payload.persistence, true);
assert.equal(mismatchedCoverage.payload.modelAuthority, "PERSISTENT_NODE");
assert.equal(mismatchedCoverage.payload.coverage.trades, null);
assert.equal(mismatchedCoverage.payload.coverage.openInterest, null);
assert.equal(mismatchedCoverage.payload.sourceCutoffTimestamp, null);
assert.equal(mismatchedCoverage.payload.quality, "INSUFFICIENT");
assert.equal(mismatchedCoverage.payload.modelStart, null);
assert.equal(mismatchedCoverage.payload.modelEnd, null);
assert.deepEqual(mismatchedCoverage.payload.gaps, [{
  start: differentWindow.from,
  end: differentWindow.to,
  missingSources: [
    "TRADE_COVERAGE_UNKNOWN",
    "LIQUIDATION_COVERAGE_UNKNOWN",
    "OPEN_INTEREST_COVERAGE_UNKNOWN",
    "BOOK_FRAME_COVERAGE_UNKNOWN",
    "FUNDING_COVERAGE_UNKNOWN"
  ]
}]);

const ledgerCoverageRow = {
  ...measuredCoverageRow,
  requested_start: new Date(boundedScope.from).toISOString(),
  requested_end: new Date(boundedScope.to).toISOString(),
  source_intervals: {
    TRADE: [
      { start: boundedScope.from, end: startMs },
      { start: startMs + 30_000, end: boundedScope.to }
    ],
    LIQUIDATION: [{ start: boundedScope.from, end: boundedScope.to }],
    OPEN_INTEREST: [{ start: boundedScope.from, end: boundedScope.to }],
    BOOK_FRAME: [{ start: boundedScope.from, end: boundedScope.to }],
    FUNDING: [{ start: boundedScope.from, end: boundedScope.to }]
  },
  coverage_version: 2
};
const requestedSubwindow = { ...boundedScope, from: startMs - 30_000, to: startMs + 60_000 };
const derivedCoverage = await readBclifCoverage(makeSupabase({
  tables: {
    bclif_sources: { data: [sourceRow()], error: null },
    bclif_coverage: { data: ledgerCoverageRow, error: null }
  }
}), requestedSubwindow);
assert.equal(derivedCoverage.payload.coverage.trades, 66.667);
assert.equal(derivedCoverage.payload.coverage.openInterest, 100);
assert.equal(derivedCoverage.payload.coverage.continuity, 100);
assert.equal(derivedCoverage.payload.modelStart, requestedSubwindow.from);
assert.equal(derivedCoverage.payload.modelEnd, requestedSubwindow.to);
assert.equal(derivedCoverage.payload.sourceCutoffTimestamp, requestedSubwindow.to);
assert.equal(derivedCoverage.payload.quality, "HIGH");
assert.deepEqual(derivedCoverage.payload.gaps, [
  { start: startMs, end: startMs + 30_000, missingSources: ["TRADE"] }
]);

const knownEmptyLiquidation = await readBclifCoverage(makeSupabase({
  tables: {
    bclif_sources: { data: [sourceRow()], error: null },
    bclif_coverage: {
      data: {
        ...ledgerCoverageRow,
        source_intervals: { ...ledgerCoverageRow.source_intervals, LIQUIDATION: [] }
      },
      error: null
    }
  }
}), requestedSubwindow);
assert.equal(knownEmptyLiquidation.payload.coverage.liquidations, 0, "known absence inside the retained ledger is measured zero transport coverage");
assert.ok(knownEmptyLiquidation.payload.gaps.some((gap) => gap.missingSources.includes("LIQUIDATION")));

const outsideLedgerScope = { ...boundedScope, from: boundedScope.from - 30_000, to: startMs + 30_000 };
const outsideLedgerCoverage = await readBclifCoverage(makeSupabase({
  tables: {
    bclif_sources: { data: [sourceRow()], error: null },
    bclif_coverage: { data: ledgerCoverageRow, error: null }
  }
}), outsideLedgerScope);
assert.deepEqual(outsideLedgerCoverage.payload.coverage, {
  trades: null,
  openInterest: null,
  liquidations: null,
  orderbook: null,
  funding: null,
  continuity: null
});
assert.equal(outsideLedgerCoverage.payload.quality, "INSUFFICIENT");
assert.equal(outsideLedgerCoverage.payload.modelStart, boundedScope.from);
assert.equal(outsideLedgerCoverage.payload.modelEnd, outsideLedgerScope.to);
assert.deepEqual(outsideLedgerCoverage.payload.gaps[0], {
  start: outsideLedgerScope.from,
  end: boundedScope.from,
  missingSources: [
    "TRADE_COVERAGE_UNKNOWN",
    "LIQUIDATION_COVERAGE_UNKNOWN",
    "OPEN_INTEREST_COVERAGE_UNKNOWN",
    "BOOK_FRAME_COVERAGE_UNKNOWN",
    "FUNDING_COVERAGE_UNKNOWN"
  ]
});

const legacyTile = {
  ...tileRow(),
  id: "b4e8c0d2-3f55-4c86-9a01-23456789abcd",
  model_version: "BCLIF_MODEL_V3_LEGACY",
  schema_version: 1
};
const stagingTile = {
  ...tileRow(),
  id: "c5f9d1e3-4066-4d97-8b12-3456789abcde",
  publication_state: "STAGING",
  object_path: path.replace(tileId, "c5f9d1e3-4066-4d97-8b12-3456789abcde")
};
const manifestSupabase = makeSupabase({
  tables: {
    bclif_sources: { data: [sourceRow()], error: null },
    bclif_coverage: { data: measuredCoverageRow, error: null },
    bclif_field_chunks: { data: [tileRow(), legacyTile, stagingTile], error: null },
    bclif_tile_supersessions: { data: [], error: null }
  }
});
const manifest = await readBclifManifest(manifestSupabase, boundedScope);
assert.deepEqual(manifest.payload.tiles.map((entry) => entry.tileId), [tileId]);
assert.equal(manifest.payload.liveEdge.tileId, stagingTile.id);
assert.equal(manifest.payload.liveEdge.horizon, "1D");
assert.equal(manifest.payload.liveEdge.publicationState, "STAGING");
assert.equal(Object.hasOwn(manifest.payload.liveEdge, "object_path"), false);
assert.ok(manifestSupabase.queryLog.filter((entry) => entry.table === "bclif_field_chunks" && entry.method === "gte" && entry.args[0] === "chunk_end").length >= 2, "FINALIZED and STAGING overlap queries must include the authorized left-edge lattice column");
const replayManifest = await readBclifManifest(manifestSupabase, { ...boundedScope, mode: "REPLAY" });
assert.equal(replayManifest.payload.liveEdge, null, "replay manifests must remain finalized-only");
const staleWriterManifest = await readBclifManifest(makeSupabase({
  tables: {
    bclif_sources: { data: [{ ...sourceRow(), writer_instance_id: "instance-new-5678", active_instance_id: "instance-new-5678", fencing_epoch: 8 }], error: null },
    bclif_coverage: { data: measuredCoverageRow, error: null },
    bclif_field_chunks: { data: [tileRow(), stagingTile], error: null },
    bclif_tile_supersessions: { data: [], error: null }
  }
}), boundedScope);
assert.equal(staleWriterManifest.payload.liveEdge, null, "a live edge from a fenced-out writer must not be exposed");
await assert.rejects(
  () => readBclifManifest(makeSupabase({
    tables: {
      bclif_sources: { data: [sourceRow()], error: null },
      bclif_coverage: { data: measuredCoverageRow, error: null },
      bclif_field_chunks: { data: [tileRow()], error: null },
      bclif_tile_supersessions: { data: null, error: { code: "PGRST205", message: "schema cache miss" } }
    }
  }), boundedScope),
  hasCode("BCLIF_INFRASTRUCTURE_UNAVAILABLE"),
  "an unavailable supersession ledger must fail closed"
);
for (const expected of [
  ["model_version", "BCLIF_MODEL_V5_AUTHENTIC_EXPOSURE"],
  ["schema_version", 2],
  ["tile_version", 1],
  ["compression", "gzip-v1"],
  ["model_authority", "PERSISTENT_NODE"]
]) {
  assert.ok(manifestSupabase.queryLog.some((entry) => entry.table === "bclif_field_chunks" && entry.method === "eq" && entry.args[0] === expected[0] && entry.args[1] === expected[1]), `manifest query must pin ${expected[0]}`);
}

const missingBucketStatus = await readBclifStatus(makeSupabase({
  bucket: { data: null, error: { statusCode: 404, message: "Bucket not found" } },
  tables: { bclif_collector_nodes: { data: [{
    node_id: "LIQUIDATION_INTELLIGENCE_NODE_01",
    current_instance_id: "instance-12345678",
    environment: "PRODUCTION",
    region: "eu",
    deployment_commit: "921c7a2",
    model_version: "BCLIF_MODEL_V5_AUTHENTIC_EXPOSURE",
    fencing_epoch: 7,
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    status: "LIVE",
    lifecycle_state: "LIVE",
    started_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
    source_freshness: {}
  }], error: null } }
}));
assert.equal(missingBucketStatus.httpStatus, 200);
assert.equal(missingBucketStatus.payload.deploymentState, "STORAGE_NOT_DEPLOYED");

const degradedStatus = await readBclifStatus(makeSupabase({
  tables: { bclif_collector_nodes: { data: [{
    node_id: "LIQUIDATION_INTELLIGENCE_NODE_01",
    current_instance_id: "instance-degraded-1234",
    environment: "PRODUCTION",
    region: "eu",
    deployment_commit: "921c7a2",
    model_version: "BCLIF_MODEL_V5_AUTHENTIC_EXPOSURE",
    fencing_epoch: 7,
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    status: "DEGRADED",
    lifecycle_state: "TRADES_STALE",
    started_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
    source_freshness: { tradesAgeMs: 180000 }
  }], error: null } }
}));
assert.equal(degradedStatus.httpStatus, 200);
assert.equal(degradedStatus.payload.deploymentState, "DEGRADED");
assert.equal(degradedStatus.payload.modelAuthority, "PERSISTENT_NODE");
assert.equal(degradedStatus.payload.persistence, true);

const expiredLeaseStatus = await readBclifStatus(makeSupabase({
  tables: { bclif_collector_nodes: { data: [{
    node_id: "LIQUIDATION_INTELLIGENCE_NODE_01",
    current_instance_id: "instance-expired-1234",
    fencing_epoch: 9,
    lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
    environment: "PRODUCTION",
    region: "eu",
    deployment_commit: "921c7a2",
    model_version: "BCLIF_MODEL_V5_AUTHENTIC_EXPOSURE",
    status: "LIVE",
    lifecycle_state: "LIVE",
    started_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
    source_freshness: {}
  }], error: null } }
}));
assert.equal(expiredLeaseStatus.httpStatus, 503);
assert.equal(expiredLeaseStatus.payload.deploymentState, "TEMPORARILY_UNAVAILABLE");
assert.equal(expiredLeaseStatus.payload.persistence, true);
assert.equal(expiredLeaseStatus.payload.modelAuthority, "PERSISTENT_NODE");

const authorityNode = (instanceId, epoch) => ({
  node_id: `LIQUIDATION_INTELLIGENCE_NODE_${String(epoch).padStart(2, "0")}`,
  current_instance_id: instanceId,
  fencing_epoch: epoch,
  lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
  environment: "PRODUCTION",
  region: "eu",
  deployment_commit: "921c7a2",
  model_version: "BCLIF_MODEL_V5_AUTHENTIC_EXPOSURE",
  status: "LIVE",
  lifecycle_state: "LIVE",
  started_at: new Date().toISOString(),
  last_heartbeat_at: new Date().toISOString(),
  source_freshness: {}
});
await assert.rejects(
  () => readBclifStatus(makeSupabase({ tables: { bclif_collector_nodes: { data: [authorityNode("instance-a-1234", 1), authorityNode("instance-b-1234", 2)], error: null } } })),
  hasCode("BCLIF_NODE_AUTHORITY_AMBIGUOUS")
);

const tile = tileRow();
const tileSupabase = makeSupabase({
  tables: {
    bclif_field_chunks: { data: tile, error: null },
    bclif_sources: { data: [sourceRow()], error: null },
    bclif_tile_supersessions: { data: [], error: null }
  },
  download: { data: new Blob([bytes], { type: "application/octet-stream" }), error: null }
});
const loaded = await loadVerifiedBclifTile(tileSupabase, boundedScope, tileId, checksum);
assert.deepEqual(loaded.bytes, bytes);
assert.equal(loaded.metadata.checksum, checksum);
assert.equal(tileSupabase.downloadedPath, path);
assert.equal(tileSupabase.downloadedBucket, BCLIF_BUCKET_ID);

const liveTileSupabase = makeSupabase({
  tables: {
    bclif_field_chunks: { data: stagingTile, error: null },
    bclif_sources: { data: [sourceRow()], error: null },
    bclif_tile_supersessions: { data: [], error: null }
  },
  download: { data: new Blob([bytes], { type: "application/octet-stream" }), error: null }
});
const loadedLive = await loadVerifiedBclifTile(liveTileSupabase, boundedScope, stagingTile.id, checksum);
assert.equal(loadedLive.metadata.publicationState, "STAGING");
assert.equal(loadedLive.metadata.horizon, "1D");
assert.equal(liveTileSupabase.downloadedPath, stagingTile.object_path);
const staleChecksum = `sha256:${"0".repeat(64)}`;
await assert.rejects(
  () => loadVerifiedBclifTile(liveTileSupabase, boundedScope, stagingTile.id, staleChecksum),
  hasCode("TILE_REVISION_MISMATCH")
);
const replayLiveTileSupabase = makeSupabase({
  tables: {
    bclif_field_chunks: { data: stagingTile, error: null },
    bclif_sources: { data: [sourceRow()], error: null }
  },
  download: { data: new Blob([bytes], { type: "application/octet-stream" }), error: null }
});
await assert.rejects(
  () => loadVerifiedBclifTile(replayLiveTileSupabase, { ...boundedScope, mode: "REPLAY" }, stagingTile.id, checksum),
  hasCode("TILE_NOT_FOUND")
);
assert.equal(replayLiveTileSupabase.downloadedPath, null);
for (const expected of [
  ["model_version", "BCLIF_MODEL_V5_AUTHENTIC_EXPOSURE"],
  ["schema_version", 2],
  ["tile_version", 1],
  ["compression", "gzip-v1"],
  ["model_authority", "PERSISTENT_NODE"]
]) {
  assert.ok(tileSupabase.queryLog.some((entry) => entry.method === "eq" && entry.args[0] === expected[0] && entry.args[1] === expected[1]), `tile query must pin ${expected[0]}`);
}

for (const mutation of [
  { model_version: "BCLIF_MODEL_V3_LEGACY" },
  { schema_version: 1 },
  { tile_version: 2 },
  { compression: "gzip-v0" },
  { model_authority: "REPLAY" }
]) {
  const mixedGenerationSupabase = makeSupabase({
    tables: {
      bclif_field_chunks: { data: { ...tile, ...mutation }, error: null },
      bclif_sources: { data: [sourceRow()], error: null }
    }
  });
  await assert.rejects(
    () => loadVerifiedBclifTile(mixedGenerationSupabase, boundedScope, tileId, checksum),
    hasCode("TILE_NOT_FOUND"),
    `unsupported tile generation must fail closed: ${JSON.stringify(mutation)}`
  );
  assert.equal(mixedGenerationSupabase.downloadedPath, null);
}

const oldReplayScope = { ...boundedScope, mode: "REPLAY", to: startMs + 30_000 };
const outOfScopeSupabase = makeSupabase({
  tables: {
    bclif_field_chunks: { data: tile, error: null },
    bclif_sources: { data: [sourceRow()], error: null },
    bclif_tile_supersessions: { data: [], error: null }
  },
  download: { data: new Blob([bytes], { type: "application/octet-stream" }), error: null }
});
await assert.rejects(
  () => loadVerifiedBclifTile(outOfScopeSupabase, oldReplayScope, tileId, checksum),
  hasCode("TILE_NOT_IN_MANIFEST_SCOPE")
);
assert.equal(outOfScopeSupabase.downloadedPath, null, "out-of-range tile must be rejected before private storage access");

const boundaryScope = { ...boundedScope, from: startMs + 60_000, to: startMs + 120_000 };
const boundaryTileSupabase = makeSupabase({
  tables: {
    bclif_field_chunks: { data: tile, error: null },
    bclif_sources: { data: [sourceRow()], error: null },
    bclif_tile_supersessions: { data: [], error: null }
  },
  download: { data: new Blob([bytes], { type: "application/octet-stream" }), error: null }
});
const boundaryTile = await loadVerifiedBclifTile(boundaryTileSupabase, boundaryScope, tileId, checksum);
assert.equal(boundaryTile.metadata.tileId, tileId);
assert.equal(boundaryTileSupabase.downloadedPath, path, "a tile ending at the request start carries the authorized inclusive lattice column");

const corruptTileSupabase = makeSupabase({
  tables: {
    bclif_field_chunks: { data: tile, error: null },
    bclif_sources: { data: [sourceRow()], error: null },
    bclif_tile_supersessions: { data: [], error: null }
  },
  download: { data: new Blob([Buffer.from("tampered-object-with-same-length!!")]), error: null }
});
await assert.rejects(() => loadVerifiedBclifTile(corruptTileSupabase, boundedScope, tileId, checksum), (error) => ["TILE_LENGTH_MISMATCH", "TILE_CHECKSUM_MISMATCH"].includes(error.code));

const savedEnvironment = Object.fromEntries(["SUPABASE_URL", "VITE_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].map((key) => [key, process.env[key]]));
try {
  delete process.env.SUPABASE_URL;
  delete process.env.VITE_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const unauthenticated = responseRecorder();
  await bclifApiHandler({ method: "GET", query: { action: "status" }, headers: {} }, unauthenticated);
  assert.equal(unauthenticated.statusCode, 401);
  const unavailableControlPlane = responseRecorder();
  const previousConsoleError = console.error;
  console.error = () => undefined;
  try {
    await bclifApiHandler({ method: "GET", query: { action: "status" }, headers: { authorization: "Bearer test-token" } }, unavailableControlPlane);
  } finally {
    console.error = previousConsoleError;
  }
  assert.equal(unavailableControlPlane.statusCode, 503);
  assert.equal(unavailableControlPlane.body.code, "PERSISTENCE_CONTROL_PLANE_UNAVAILABLE");
} finally {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

console.log("BCLIF API security contracts passed: entitlement, deferred infrastructure, exact requested-window coverage, strict paths, bounded tile retrieval, and SHA-256 verification.");

function tileRow() {
  return {
    id: tileId,
    source_id: "source-1",
    model_version: "BCLIF_MODEL_V5_AUTHENTIC_EXPOSURE",
    horizon: "1D",
    chunk_start: new Date(startMs).toISOString(),
    chunk_end: new Date(startMs + 60000).toISOString(),
    columns: 1,
    rows: 1,
    price_min: 60000,
    price_max: 70000,
    compression: "gzip-v1",
    checksum,
    compressed_bytes: bytes.byteLength,
    schema_version: 2,
    tile_version: 1,
    time_step_ms: 60000,
    price_step: 10,
    source_cutoff_at: new Date(startMs + 60000).toISOString(),
    coverage_quality: "HIGH",
    model_authority: "PERSISTENT_NODE",
    channel_manifest: { exposure: "float32" },
    scale_metadata: { exposureMax: 1 },
    publication_state: "FINALIZED",
    published_at: new Date(startMs + 60000).toISOString(),
    writer_instance_id: "instance-active-1234",
    fencing_epoch: 7,
    bucket_id: BCLIF_BUCKET_ID,
    object_path: path
  };
}

function sourceRow() {
  return {
    id: "source-1",
    active_instance_id: "instance-active-1234",
    writer_instance_id: "instance-active-1234",
    fencing_epoch: 7
  };
}

function makeSupabase(options = {}) {
  const client = {
    downloadedBucket: null,
    downloadedPath: null,
    queryLog: [],
    from(table) {
      return fluent(options.tables?.[table] || { data: [], error: null }, client.queryLog, table);
    },
    storage: {
      getBucket: async () => options.bucket || { data: { id: BCLIF_BUCKET_ID, public: false }, error: null },
      from(bucket) {
        client.downloadedBucket = bucket;
        return {
          async download(objectPath) {
            client.downloadedPath = objectPath;
            return options.download || { data: null, error: { statusCode: 404, message: "Object missing" } };
          }
        };
      }
    }
  };
  return client;
}

function fluent(result, queryLog = [], table = "") {
  const proxy = new Proxy({}, {
    get(_target, property) {
      if (property === "then") return Promise.resolve(result).then.bind(Promise.resolve(result));
      if (property === "maybeSingle" || property === "single") return async () => result;
      return (...args) => {
        queryLog.push({ table, method: String(property), args });
        return proxy;
      };
    }
  });
  return proxy;
}

function hasCode(expected) {
  return (error) => error?.code === expected;
}

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end(value) { this.body = value; return this; }
  };
}
