# Phase III Chapter VII - Black Core Market Depth Memory

Status: implemented infrastructure foundation.

## Objective

Black Terminal is moving DOM Pro+ from a current-orderbook cockpit into an Institutional Market Map.

The core rule is:

```text
Exchange depth feeds
-> Black Core Depth Collector
-> Depth Normalizer
-> Depth Compression Engine
-> Market Depth Memory
-> Supabase time-series storage
-> Replay API
-> DOM Pro+ / Scanner / BlackGPT / Strategy Lab
```

The browser must become a viewer of market memory, not the owner of long-term market memory.

## Implemented

- Added server-side `server/market-depth` subsystem:
  - depth type helpers
  - venue/sample normalizer
  - depth compression engine
  - wall lifecycle engine
  - storage writer
  - replay reader
  - long-running collector worker
- Added `MarketDepthMemoryEngine` that accepts normalized orderbook samples, compresses them, stores rollups, emits deltas, tracks wall lifecycle, and writes statistics.
- Added a dedicated worker entry:

```bash
npm run depth:worker
npm run depth:worker:supervise
npm run depth:verify
```

- Worker reads `MARKET_DEPTH_SYMBOLS`, defaulting to `hyperliquid:perpetual:BTCUSDT`.
- `depth:worker:supervise` is the recommended persistent deployment command. It restarts the collector if the worker exits after stale feed detection, runtime failures, or process errors.
- Worker supports collector adapters for:
  - Hyperliquid
  - Binance
  - Bybit
  - OKX
- Added Vercel API dispatcher:

```text
/api/market-depth/replay
/api/market-depth/ingest
/api/market-depth/status
/api/market-depth/walls
/api/market-depth/alerts
/api/market-depth/prune
/api/market-depth/tiles
```

- Added replay API that selects a resolution automatically and returns normalized depth memory points, active walls, events, and statistics.
- Added tile API for Google-Maps-style loading. It returns bounded time/price cells and supports multi-venue combined responses with explicit per-venue breakdowns.
- Added token-protected external ingest route using `MARKET_DEPTH_INGEST_TOKEN`.
- Added token-protected retention pruning route using `MARKET_DEPTH_MAINTENANCE_TOKEN` or `MARKET_DEPTH_INGEST_TOKEN`.
- Added alert extraction API that converts liquidity events, active walls, depth imbalances, liquidity vacuums, spoof suspicion, gravity zones, and feed degradation into normalized market-memory alerts.
- Added REST snapshot recovery hooks for Hyperliquid, Binance, Bybit, and OKX. The collector now recovers snapshots after connection and after explicit sequence-gap detection.
- Added normalized orderbook integrity validation. Invalid books are rejected before persistence and can be audited through `imm_integrity_events`.
- Added richer worker heartbeat support through `imm_worker_heartbeats`.
- Added authoritative IMM status endpoint at `/api/imm/status`.
- Added `npm run depth:verify` for operational validation of persisted market memory.
- Added DOM Pro+ client hydration from `/api/market-depth/replay`.
- DOM Pro+ now requests bounded `/api/market-depth/tiles` cells for the active camera range before falling back to replay hydration.
- DOM Pro+ pads tile requests around the active camera range so adjacent liquidity cells are preloaded for smoother map-style pan/zoom.
- Added a DOM-side IMM aggregation worker bridge for Black Core replay shaping/culling. If Worker construction fails, it falls back to the same shaping logic on the main thread.
- DOM Pro+ still keeps local browser depth memory as a fallback when the backend tables, worker, or API are unavailable.
- Browser-built depth memory no longer writes back to Supabase by default. Set `VITE_DOM_DEPTH_BROWSER_SYNC=true` only for legacy debugging.
- DOM Pro+ diagnostics now label depth memory source as:
  - `BLACK-CORE`
  - `SUPABASE`
  - `LOCAL`

## Storage Model

The Supabase migration creates platform-owned tables:

- `market_depth_snapshots`
- `market_depth_deltas`
- `market_depth_rollups`
- `market_liquidity_events`
- `market_liquidity_walls`
- `market_depth_statistics`

These are not per-user records. They are Black Core market-memory records.

Direct browser access is intentionally blocked by RLS. Read/write access should flow through server routes or the collector worker using the service role.

## Runtime Environment

Required for API and worker:

```text
SUPABASE_URL or VITE_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Required only for external HTTP ingest:

```text
MARKET_DEPTH_INGEST_TOKEN
```

Optional maintenance:

```text
MARKET_DEPTH_MAINTENANCE_TOKEN
MARKET_DEPTH_PRUNE_INTERVAL_MS
MARKET_DEPTH_HEARTBEAT_INTERVAL_MS=10000
MARKET_DEPTH_FATAL_STALE_MS=600000
MARKET_DEPTH_STARTUP_GRACE_MS=120000
MARKET_DEPTH_WORKER_RESTART_BASE_MS=1500
MARKET_DEPTH_WORKER_RESTART_MAX_MS=60000
MARKET_DEPTH_VERIFY_FRESHNESS_MS=900000
MARKET_DEPTH_VERIFY_MIN_ROLLUPS=5
MARKET_DEPTH_RETENTION_RAW_HOURS=6
MARKET_DEPTH_RETENTION_DELTA_HOURS=6
MARKET_DEPTH_RETENTION_1S_DAYS=3
MARKET_DEPTH_RETENTION_10S_DAYS=21
MARKET_DEPTH_RETENTION_1M_DAYS=180
MARKET_DEPTH_COLLECTOR_ID=primary-depth-worker
VITE_DOM_DEPTH_BROWSER_SYNC=false
VITE_DOM_DEPTH_LEGACY_HYDRATE=true
```

Optional:

```text
MARKET_DEPTH_SYMBOLS=hyperliquid:perpetual:BTCUSDT,binance:perpetual:BTCUSDT,bybit:perpetual:BTCUSDT,okx:perpetual:BTC-USDT-SWAP
```

## Current Limits

- The worker is a long-running Node process. Vercel serverless functions cannot continuously own exchange WebSocket sessions.
- Vercel APIs can replay stored market memory and accept authenticated external ingest, but a separate worker/runtime must run the collector continuously. Use `npm run depth:worker:supervise` in that runtime.
- Packet-loss detection is available for incremental feeds and stored in depth statistics. When an explicit sequence gap is detected, the collector attempts REST snapshot recovery. Full checksum reconciliation remains a follow-up.
- `/api/imm/status` is the authoritative backend status surface. DOM Pro+ and future admin panels should consume it rather than building duplicate status state.
- Replay reads compressed rollups and active walls. DOM Pro+ uses bounded tile cells first for the active camera window, then falls back to replay hydration.
- The tile API exposes bounded map cells. DOM Pro+ now prefetches padded adjacent camera windows, while minimap/navigator windows remain follow-up work.
- Web Worker aggregation is started for Black Core replay shaping. The remaining large DOM live aggregation path still needs full worker migration.

## Next Work

- Deploy `npm run depth:worker:supervise` in a persistent worker/runtime outside Vercel serverless.
- Add venue-specific checksum validation and deeper delta reconciliation.
- Add admin IMM operations panel and user-facing IMM status indicator.
- Add deployment automation for the retention pruning route if the collector worker is not always running.
- Add minimap/navigator windows for Google-Maps-style zoom/pan.
- Move the rest of DOM live aggregation, CVD shaping, and depth chart construction to the IMM worker bridge.
- Feed market-memory alerts into Scanner, BlackGPT, and Notifications.
