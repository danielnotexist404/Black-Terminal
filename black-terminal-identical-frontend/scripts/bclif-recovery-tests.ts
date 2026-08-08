import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BclifEventBatcher } from "../server/liquidation-intelligence/collector/eventBatcher.ts";
import { BclifLocalEventSpool, BclifSpoolQuota } from "../server/liquidation-intelligence/collector/localSpool.ts";
import { validateCheckpointState } from "../server/liquidation-intelligence/state/checkpointRepository.ts";
import { BCLIF_MAX_COVERAGE_INTERVALS_PER_SOURCE } from "../server/liquidation-intelligence/state/coverageRepository.ts";
import { bclifArchivedEventIdentity, type BclifEventChunkRepository } from "../server/liquidation-intelligence/state/eventChunkRepository.ts";
import type { BclifEventDeduplicator } from "../server/liquidation-intelligence/state/eventDeduplication.ts";
import { assertReplacementCoversSupersededTile } from "../server/liquidation-intelligence/tiles/retention.ts";
import { makeCanonicalEvent, makeOpenInterest, TEST_MODEL_VERSION, TEST_SOURCE_VERSION } from "./bclif-test-fixtures.ts";

const temporary = await mkdtemp(join(tmpdir(), "bclif-recovery-"));
try {
  const quota = await BclifSpoolQuota.create(temporary, 4 * 1024 * 1024);
  const spool = new BclifLocalEventSpool(temporary, "BTCUSDT", quota);
  await spool.initialize();
  const later = makeCanonicalEvent(2);
  const earlier = makeCanonicalEvent(1);
  await spool.put([later, earlier]);
  const usedOnce = quota.usage().bytes;
  await spool.put([earlier]);
  assert.equal(quota.usage().bytes, usedOnce, "idempotent spool writes must not reserve quota twice");
  assert.deepEqual((await spool.recover()).map((event) => event.eventId), [earlier.eventId, later.eventId], "restart replay must be chronological");
  assert.equal(await spool.acknowledge([earlier]), 1);
  assert.deepEqual((await spool.recover()).map((event) => event.eventId), [later.eventId]);
  await spool.acknowledge([later]);
  assert.equal(quota.usage().bytes, 0);

  let attempts = 0;
  const persisted: string[] = [];
  const retryRepository = {
    async publish(_kind: string, events: readonly { eventId: string }[]) {
      attempts += 1;
      if (attempts === 1) throw new Error("simulated pre-publication failure");
      persisted.push(...events.map((event) => event.eventId));
    }
  } as unknown as BclifEventChunkRepository;
  const durableDedup = { async commit() {} } as unknown as BclifEventDeduplicator;
  const retryBatcher = new BclifEventBatcher(retryRepository, 64 * 1024, 60_000, durableDedup);
  retryBatcher.add([earlier]);
  await assert.rejects(retryBatcher.drain(), /simulated pre-publication failure/);
  assert.equal(retryBatcher.pendingEvents(), 1, "an uncommitted archive batch must remain retryable");
  await retryBatcher.drain();
  assert.equal(attempts, 2);
  assert.deepEqual(persisted, [earlier.eventId]);

  let publishedAttempts = 0;
  let dedupAttempts = 0;
  const publishedRepository = {
    async publish() { publishedAttempts += 1; }
  } as unknown as BclifEventChunkRepository;
  const failingDedup = {
    async commit() { dedupAttempts += 1; throw new Error("simulated post-publication dedup failure"); }
  } as unknown as BclifEventDeduplicator;
  const publicationBoundary = new BclifEventBatcher(publishedRepository, 64 * 1024, 60_000, failingDedup);
  publicationBoundary.add([later]);
  await assert.rejects(publicationBoundary.drain(), /post-publication dedup failure/);
  assert.equal(publicationBoundary.pendingEvents(), 0, "a published immutable chunk must not be queued for duplicate publication");
  await publicationBoundary.drain();
  assert.equal(publishedAttempts, 1, "post-publication recovery must reconcile archives rather than republish them");
  assert.equal(dedupAttempts, 1);

  const sharedTrade = makeCanonicalEvent(3, "TRADE");
  const sharedLiquidation = { ...makeCanonicalEvent(3, "LIQUIDATION"), dedupKey: sharedTrade.dedupKey };
  assert.notEqual(
    bclifArchivedEventIdentity(sharedTrade),
    bclifArchivedEventIdentity(sharedLiquidation),
    "archive reconciliation identity must include event kind as well as the dedup hash"
  );

  const superseded = retentionTile({
    id: "00000000-0000-8000-8000-000000000001",
    object_path: "v2/BYBIT/linear_perpetual/BTCUSDT/6H/1000/00000000-0000-8000-8000-000000000001-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bclif",
    horizon: "6H",
    chunk_start: new Date(1_000).toISOString(),
    chunk_end: new Date(2_000).toISOString(),
    source_cutoff_at: new Date(2_000).toISOString()
  });
  const coveringReplacement = retentionTile({
    id: "00000000-0000-8000-8000-000000000002",
    object_path: "v2/BYBIT/linear_perpetual/BTCUSDT/1D/500/00000000-0000-8000-8000-000000000002-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.bclif",
    horizon: "1D",
    time_step_ms: 240_000,
    chunk_start: new Date(500).toISOString(),
    chunk_end: new Date(2_500).toISOString(),
    source_cutoff_at: new Date(2_500).toISOString()
  });
  assert.doesNotThrow(() => assertReplacementCoversSupersededTile(superseded, coveringReplacement));
  for (const mutation of [
    { id: superseded.id },
    { object_path: superseded.object_path },
    { model_version: "BCLIF_MODEL_V3_LEGACY" },
    { tile_version: 2 },
    { horizon: "1M" },
    { time_step_ms: 999_999 },
    { chunk_start: new Date(1_001).toISOString() },
    { chunk_end: new Date(1_999).toISOString() },
    { source_cutoff_at: new Date(1_999).toISOString() }
  ]) {
    assert.throws(() => assertReplacementCoversSupersededTile(superseded, { ...coveringReplacement, ...mutation }));
  }

  const cursor = makeOpenInterest(120_000, 1_000);
  const checkpoint: any = {
    schemaVersion: 1,
    modelVersion: TEST_MODEL_VERSION,
    sourceVersion: TEST_SOURCE_VERSION,
    venue: "BYBIT",
    symbol: "BTCUSDT",
    timestamp: 125_000,
    sourceCutoffTimestamp: 120_000,
    cohortState: { cohorts: [], particles: [] },
    normalizerState: {},
    confirmedIntensityState: null,
    instrumentRules: { venue: "BYBIT", symbol: "BTCUSDT", sourceVersion: TEST_SOURCE_VERSION, riskTiers: [] },
    lastConsumedOpenInterest: cursor,
    sourceOffsets: [],
    processedEventIds: [],
    activeFrame: null,
    activeTile: null,
    coverageIntervals: {}
  };
  assert.equal(validateCheckpointState(checkpoint), checkpoint);
  assert.throws(() => validateCheckpointState({ ...checkpoint, lastConsumedOpenInterest: { ...cursor, availableAt: 120_001, receivedTimestamp: 120_001 } }), /consumed OI cursor/);
  const withoutCursor = { ...checkpoint };
  delete withoutCursor.lastConsumedOpenInterest;
  assert.throws(() => validateCheckpointState(withoutCursor), /missing its consumed OI cursor/);
  assert.throws(() => validateCheckpointState({
    ...checkpoint,
    coverageIntervals: {
      TRADE: Array.from({ length: BCLIF_MAX_COVERAGE_INTERVALS_PER_SOURCE + 1 }, (_, index) => ({ start: index * 2, end: index * 2 + 1 }))
    }
  }), /checkpoint coverage state/, "checkpoints must reject coverage state larger than the live in-memory bound");

  console.log(JSON.stringify({ decision: "PASS", spoolReplay: "chronological", prePublicationRetry: attempts, postPublicationRepublishCount: publishedAttempts, checkpointOiCursor: "verified" }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function retentionTile(overrides: Record<string, unknown>): Record<string, any> {
  return {
    source_id: "00000000-0000-8000-8000-000000000001",
    publication_state: "FINALIZED",
    checksum: `sha256:${"a".repeat(64)}`,
    schema_version: 2,
    tile_version: 1,
    model_version: TEST_MODEL_VERSION,
    price_min: 50_000,
    price_max: 75_575,
    price_step: 25,
    rows: 1_024,
    time_step_ms: 60_000,
    model_authority: "PERSISTENT_NODE",
    ...overrides
  };
}
