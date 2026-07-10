# Phase III IMM Operational Readiness

Status: foundation implemented, production validation in progress.

## Objective

The Institutional Market Map must be measurable before it becomes intelligent.

This sprint adds the first operational trust layer:

```text
Depth Worker
-> Integrity Validation
-> Supabase Persistence
-> Worker Heartbeat
-> IMM Status Service
-> Verification Command
-> DOM Pro+ / Admin Surfaces
```

The browser remains a viewer. Black Core owns status, integrity, persistence evidence, and replay readiness.

## Implemented

- Added normalized orderbook integrity validation before depth samples are compressed or persisted.
- Invalid books are rejected before persistence.
- Integrity failures and warnings can be written to `imm_integrity_events`.
- Added richer collector diagnostics:
  - last persisted time
  - rejected update count
  - duplicate update count
  - invalid book count
  - snapshot rebuild count
  - last integrity failure
- Added `imm_worker_heartbeats` support beside the existing collector status table.
- Worker heartbeat defaults to 10 seconds and is constrained to the 5-15 second readiness window through `MARKET_DEPTH_HEARTBEAT_INTERVAL_MS`.
- Added authoritative status service:

```text
server/imm/status-service.js
```

- Added health endpoint:

```text
GET /api/imm/status
```

- Added optional verbose diagnostics gated by `IMM_ADMIN_STATUS_TOKEN` and `x-imm-admin-token`.
- Added verification command:

```bash
npm run depth:verify
```

The verification command checks recent rollups, bid/ask rows, impossible values, expected resolutions, wall symmetry, worker heartbeat freshness, and bounded replay windows.
- DOM Pro+ now includes a compact IMM status strip that polls `/api/imm/status` and displays worker state, replay confidence, wall symmetry, camera range, FPS, heartbeat age, and persistence age.

## Status Model

The IMM status service returns:

- `overallStatus`
- `workerStatus`
- `ingestionStatus`
- `persistenceStatus`
- `replayStatus`
- `wallEngineStatus`
- `websocketStatus`
- current venue, market kind, and symbol
- worker instance id and uptime
- last message, persist, and snapshot timestamps
- sequence gap and reconnect counts
- active buy/sell wall counts
- events in the last minute
- storage and ingestion latency
- stale duration
- integrity and rejected-update counters
- quality scores
- errors and warnings

Statuses are normalized to:

- `healthy`
- `degraded`
- `reconnecting`
- `stale`
- `unavailable`
- `misconfigured`
- `error`

## Runtime Commands

```bash
npm run depth:worker
npm run depth:worker:supervise
npm run depth:verify
```

Use `depth:worker:supervise` for persistent runtime deployment. Use `depth:verify` after the worker has been running long enough to write market-memory rows.

## Required SQL

Apply the Supabase migration section:

```text
2026-07-10 - IMM Operational Readiness Tables
```

It creates:

- `imm_worker_heartbeats`
- `imm_integrity_events`

Direct browser access is intentionally blocked by RLS.

## Known Limits

- Snapshot/delta reconciliation is started through sequence-gap detection and snapshot recovery, but full venue checksum validation remains future work.
- Admin operations controls are not implemented yet.
- DOM Pro+ has an initial user-facing IMM status strip; admin-grade controls and deeper drilldown remain future work.
- Deterministic tests and load tests still need dedicated fixtures and scripts.
- Event outcome labeling for machine-learning datasets is not implemented yet.

## Production Readiness

Current state: measurable foundation.

The system can now answer whether the worker is alive, whether storage has recent data, whether bid/ask rollups exist, whether wall detection is symmetric, whether integrity events are occurring, and whether recent replay windows are bounded.

It is not yet a fully certified production IMM until checksum reconciliation, deterministic tests, load tests, admin controls, and user-facing status are complete.
