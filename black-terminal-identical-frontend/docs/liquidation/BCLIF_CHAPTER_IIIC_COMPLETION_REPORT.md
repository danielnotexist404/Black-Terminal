# BCLIF Chapter III-C Completion Report

## Completion state

**State A**

```text
REPOSITORY COMPLETE
PERSISTENT HOST NOT PROVIDED
COLLECTOR NOT DEPLOYED
MIGRATION NOT APPLIED
BROWSER FALLBACK ACTIVE
```

This is a repository-readiness result, not a production-persistence claim. No dedicated `LIQUIDATION_INTELLIGENCE_NODE_01` or `IMM_NODE_01` was supplied. The Raspberry Pi reserved for Black Cloud execution was deliberately excluded. Both BCLIF Supabase migrations (`202608050001` and `202608050002`) were inspected and tested as source but were not applied. Therefore no persistent historical coverage, live collector uptime, long soak, production calibration, or complete 3W history exists yet.

## Revision and deployment record

| Field | Result |
| --- | --- |
| Directive baseline named by Chapter III-C | `bc42ffe` |
| Actual repository starting commit | `921c7a2f9d50b204e61a2f67e402571f3fd4c7e9` |
| Implementation commit | Recorded in the final handoff after the immutable commit is created |
| Final handoff commit | Recorded in the final handoff; a Git commit cannot embed its own content-derived SHA |
| Production frontend deployment | **NOT DEPLOYED OR VERIFIED BY THIS CHAPTER** |
| Persistent collector deployment | **NOT DEPLOYED** |
| Persistent analytics host | **NOT PROVIDED** |
| Collector image reference / digest | **UNAVAILABLE — IMAGE NOT BUILT** |
| Docker / Compose execution | **NOT RUN — DOCKER TOOLING UNAVAILABLE** |
| Current persistent model generation | `BCLIF_MODEL_V4_CAUSAL` |
| Persistent source generation | `BYBIT_V5_PUBLIC_2026_08` |
| Tile schema / codec | schema `2`, tile version `1`, `gzip-v1` |

## Delivered repository surfaces

Collector source lives under `server/liquidation-intelligence/`, with the executable entry point at `scripts/bclif-collector-worker.ts`. It includes collector lifecycle and loopback health, official public-source adapters, canonical normalization, durable spool/batching, source offsets and deduplication, checkpoint/event/object repositories, the shared cohort/exposure runtime, calibration storage/runtime, multi-horizon live-edge construction, tile codec/repository/compaction/retention, metrics, and structured redacted logging.

The stable service identity is `LIQUIDATION_INTELLIGENCE_NODE_01` by configuration; every process start receives a new instance ID and must acquire a database-issued fencing epoch. Node registration is separate from lease acquisition. Repository writes carry the active writer instance and fencing epoch, and database triggers fail closed when the lease is missing, expired, or superseded.

The package includes `Dockerfile.liquidation-intelligence`, `docker-compose.liquidation-intelligence.yml`, `.env.liquidation-intelligence.example`, preflight/deploy/certification/soak scripts, and a dedicated Node 22 TypeScript configuration. These artifacts target linux/amd64 and linux/arm64 without broker or Black Cloud secrets. Packaging support is not equivalent to a built, exercised, or deployed multi-architecture image.

## Source and historical-memory status

| Source / capability | Repository implementation | Runtime result |
| --- | --- | --- |
| Public trades | Bybit V5 public trade WebSocket; exchange ID/timestamp/side/price/quantity/notional; reconnect-overlap dedup | Packaged; **not collecting** |
| Confirmed liquidations | Bybit all-liquidation WebSocket; deterministic identity; canonical archive separate from estimated exposure | Packaged; **not collecting** |
| Order book | Snapshot/delta reconstruction, update-ID validation, gap resync, bounded periodic frames | Packaged; **not collecting** |
| Open interest | Chronological official REST pagination, unit normalization, progress offsets, live observations | Packaged; backfill **not run** |
| Funding / mark / index / basis | Official REST/ticker context with independent freshness | Packaged; **not collecting** |
| Long/short ratio | Official historical/context adapter with availability timestamps | Packaged; **not collecting** |
| Instrument / risk tiers | Current official metadata snapshots; no fabricated historical risk-tier series | Packaged; **not collecting** |

Only source history actually offered by the venue is eligible for backfill. Historical OI, funding, ratios, and mark/index context never fabricate old trades, books, liquidations, or risk-tier state. An OI value fetched later is a baseline and cannot create an as-if-live historical cohort delta.

Canonical events are first fsynced to a bounded local spool, then admitted to deterministic compressed event chunks. Durable identities include venue, symbol, source version and source-specific identity (trade ID; liquidation timestamp/side/price/size hash; interval/frame identity). Reconnect and replay overlaps are rejected through the durable deduplication index. Raw order-book deltas are not retained indefinitely.

## Checkpoints and restart recovery

Periodic, post-backfill, and graceful-shutdown checkpoints contain the cohort state, normalizer state, processed event IDs, source offsets, last consumed live OI observation, coverage intervals, and the active unfinalized tile. Publication uses immutable object bytes plus checksum-verified metadata.

Recovery is chronological and source-cutoff bounded: acquire writer authority, load and verify the latest compatible checkpoint, restore offsets/dedup/state, replay only later archived events, reconcile live sources, obtain acknowledged subscriptions and a valid book snapshot/live OI observation, produce an as-of frame, then become `LIVE`. Checkpoint cutoffs cannot advance ahead of durable event chunks. A stale writer cannot finalize a tile or checkpoint. The repository adversarial recovery tests are local deterministic tests; no real-host restart certification is claimed.

## Tiles, storage, retention, and coverage

The shared high-resolution state builds cumulative `6H`, `12H`, `1D`, `3D`, `1W`, `3W`, and `1M` numerical tiles. Finalized objects are immutable; a correction creates new checksummed bytes and an explicit supersession record. `STAGING` is a live-edge publication state, never historical finality. Tile version remains `1`; object/checksum/source-cutoff revisions distinguish successive live-edge content.

The schema-2 codec stores recoverable long, short, combined, confidence, validity, confirmed-notional, confirmed-count, and display channels. It uses a versioned bounded little-endian envelope, canonical metadata, deterministic gzip, SHA-256 integrity, length limits, and corruption rejection. The client requests an exact manifest generation and checksum, bounds decompression/cache memory, rejects model/schema/source ambiguity, and stitches only aligned time/price grids.

The migration creates a private `bclif-field-chunks` object bucket plus service-only metadata, checkpoint, event, coverage, calibration, supersession, retention, node/instance and fencing contracts. Authenticated users never enumerate raw objects; protected API routes authenticate, check `allowed_indicators`, validate venue/symbol/horizon/range/mode, rate-limit, and return only exact authorized manifests or checksum-bound tile access. Direct storage paths and service credentials remain server-side.

Retention is mark-then-sweep and fenced. It excludes active/staging/manifestable/checkpoint-required objects, verifies a finalized replacement checksum and bounded decode before superseded deletion, and records retryable deletion work. No retention job was run because the schema and collector are inactive.

Coverage is calculated only for the exact requested interval. Missing intervals remain explicit gaps; absent history is `null`/`UNAVAILABLE` or `INSUFFICIENT`, never zero exposure. Current active persistent coverage is **UNAVAILABLE**.

## Client authority and fallback

The client priority is persistent tiles/live edge, then browser-session fallback, with deterministic fixtures limited to tests. A single generation authority is selected for a range: `PERSISTENT_NODE`, `BROWSER_FALLBACK`, `REPLAY`, or `TEST_FIXTURE`. Persistent and browser cohort fields are never silently merged. Manifest/tile races trigger a bounded re-probe; corrupted, stale, misaligned, or generation-mismatched tiles are not rendered.

Because the collector is not deployed, the current production behavior remains visibly labeled:

```text
COLLECTOR: BROWSER SESSION
PERSISTENCE: OFF
HISTORY: BUILDS ONLY WHILE THIS CHART IS OPEN
```

Deferred infrastructure returns a truthful non-500 state (`NOT_DEPLOYED` / `UNAVAILABLE`); unauthenticated proprietary access remains `401`, and an actually stale deployed node is `503`.

## Verification and evidence

| Gate | Result |
| --- | --- |
| TypeScript and collector TypeScript | **PASS** — frontend `tsc --noEmit` and strict collector project both completed locally |
| Production build and secret audit | **PASS** — Vite production build, security contracts, and built-asset secret audit completed locally |
| API authentication, entitlement, validation, rate-limit and path contracts | **PASS** — local deterministic contract run; not a hosted runtime test |
| Migration source contracts | **PASS** — local static contract run; neither migration applied |
| Runtime RLS | **NOT RUN** — no migration was applied to a Supabase project |
| Runtime private-storage policy | **NOT RUN** — no bucket/policy was activated or exercised |
| Codec/corruption, recovery, order-book, no-lookahead and client/cache contracts | **PASS** — local deterministic contracts; not live-host restart evidence |
| Visual screenshots | **SKIP / BLOCKED / NOT RUN AFTER V2_HIRES CHANGE** |
| SSIM / perceptual comparison | **SKIP / BLOCKED / NOT RUN**; baselines explicitly stale |
| Multi-architecture container execution | **NOT BUILT OR TESTED** |
| One/five/ten-symbol resource benchmark | **MEASURED_KERNEL_ONLY** — local synthetic CPU/array/codec evidence; host-capacity claim `NONE` |
| Soak | `0 ms` (`0 h`) — **NOT RUN** |

The repository visual harness owns fixed 1920×1080, 2560×1440 and 3840×2160 cases, but the existing golden set is marked stale. The harness returns `SKIP`, never `PASS`, until reviewed regeneration succeeds. No screenshot or similarity result has been fabricated.

No-lookahead contracts freeze every historical column at its source cutoff and compare the prefix before and after future events are appended. Future OI, liquidations, order books, outcomes, survival, or final-window normalization may not rewrite an earlier column.

The local benchmark ran on Node `v22.23.1`, Linux `7.0.0-28-generic` x86_64, an Intel i7-7700K, and 15.53 GiB system RAM. For 1 / 5 / 10 synthetic symbols across seven horizons at 512 rows and 360 base columns, full tile-generation p50/p95/p99 was `1306.07/1306.07/1306.07 ms`, `1300.17/1344.89/1344.89 ms`, and `1297.79/1506.32/1506.32 ms` respectively. Incremental-append p50/p95/p99 was `29.99/29.99/29.99 ms`, `28.72/30.58/30.58 ms`, and `30.46/43.78/43.78 ms`. Process CPU user/system time was `2882.74/151.11 ms`, `12815.73/598.21 ms`, and `27706.63/1246.30 ms`. Exact candidate-revision arrays were 6.97 / 34.86 / 69.73 MiB. Conservative structural steady-state upper bounds were 36.96 / 184.82 / 369.64 MiB, while publication-peak upper bounds were 62.84 / 314.21 / 628.42 MiB. Observed process RSS deltas were 81.59 / 35.51 / 32.28 MiB and are allocator/run-order observations, not additive capacity guarantees. Estimated compressed bytes per complete synthetic revision were 912,073 / 4,560,365 / 9,120,730 bytes.

These numbers certify only the deterministic kernel harness. Real network throughput, durable storage growth, queue delay, checkpoint/object-store recovery, multi-architecture behavior, and host capacity remain **NOT MEASURED / NOT CERTIFIED**. No production traffic or 1 h/6 h/24 h soak evidence exists.

## Calibration and cascade status

Predictions are immutable deterministic identities bound to their source/model cutoff, side, price/notional range, confidence and context. Outcomes are one-per-prediction and can only use later observed evidence. Sample count is currently **0** because no persistent collector is running. Hit/false-positive/price/timing/confidence metrics therefore remain unavailable, and missed-event rate must remain `null`/scaffolded until event-centric evaluation has qualifying observations.

Cascade model state: **SCAFFOLDED**. It is not calibrated or certified, and no mature-looking probability, precision, or recall is shown.

## Remaining limitations and activation gate

State B requires a dedicated non-execution analytics host, reviewed environment/secrets, an immutable container image, database backup/rollback approval, migration application and runtime RLS/storage tests, collector deployment, source synchronization, verified health/metrics, and observed history accumulation. State C additionally requires complete verified 3W coverage, real restart and visual certification, and calibration accumulation. State D requires every formal production gate.

Exact account liquidation prices, cross-margin collateral, private account positions, complete venue-wide historical liquidations/order books, guaranteed reaction zones, and calibrated cascade probabilities remain unsupported claims.

Black Cloud broker connectivity, OMS, EMS, live-order execution, `PositionManager`, investor mandates, Investment Group fan-out, Obsidian, HDLX, RADAP, Kioseff, and DOM Pro calculation engines were not modified by this chapter.
