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
```

- Worker reads `MARKET_DEPTH_SYMBOLS`, defaulting to `hyperliquid:perpetual:BTCUSDT`.
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
- Added DOM Pro+ client hydration from `/api/market-depth/replay`.
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
- Vercel APIs can replay stored market memory and accept authenticated external ingest, but a separate worker/runtime must run the collector continuously.
- Packet-loss detection is available for incremental feeds and stored in depth statistics. When an explicit sequence gap is detected, the collector attempts REST snapshot recovery. Full checksum reconciliation remains a follow-up.
- Replay currently reads compressed rollups and active walls. It does not yet stream tiled map chunks or minimap navigator data.
- The tile API exposes bounded map cells; DOM Pro+ still consumes replay hydration first and can be moved to tile streaming in a follow-up.
- Web Worker aggregation is started for Black Core replay shaping. The remaining large DOM live aggregation path still needs full worker migration.

## Next Work

- Deploy the collector as a persistent worker outside Vercel serverless.
- Add venue-specific checksum validation and deeper delta reconciliation.
- Add deployment automation for the retention pruning route if the collector worker is not always running.
- Add tile-based replay windows for Google-Maps-style zoom/pan.
- Move the rest of DOM live aggregation, CVD shaping, and depth chart construction to the IMM worker bridge.
- Feed market-memory alerts into Scanner, BlackGPT, and Notifications.
