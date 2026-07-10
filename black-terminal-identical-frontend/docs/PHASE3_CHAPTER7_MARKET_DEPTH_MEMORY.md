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
```

- Added replay API that selects a resolution automatically and returns normalized depth memory points, active walls, events, and statistics.
- Added token-protected external ingest route using `MARKET_DEPTH_INGEST_TOKEN`.
- Added DOM Pro+ client hydration from `/api/market-depth/replay`.
- DOM Pro+ still keeps local/browser depth memory as a fallback when the backend tables, worker, or API are unavailable.
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

Optional:

```text
MARKET_DEPTH_SYMBOLS=hyperliquid:perpetual:BTCUSDT,binance:perpetual:BTCUSDT,bybit:perpetual:BTCUSDT,okx:perpetual:BTC-USDT-SWAP
```

## Current Limits

- The worker is a long-running Node process. Vercel serverless functions cannot continuously own exchange WebSocket sessions.
- Vercel APIs can replay stored market memory and accept authenticated external ingest, but a separate worker/runtime must run the collector continuously.
- Packet-loss recovery is adapter-ready but still first-pass. Full exchange sequence repair needs venue-specific snapshot reconciliation.
- Replay currently reads compressed rollups and active walls. It does not yet stream tiled map chunks or minimap navigator data.
- Web Worker aggregation inside the browser remains future work; the server compression layer is now in place first.

## Next Work

- Deploy the collector as a persistent worker outside Vercel serverless.
- Add venue-specific sequence recovery and checksum validation.
- Add retention pruning jobs:
  - raw hours
  - 1s days
  - 10s weeks
  - 1m months
  - wall/events permanent
- Add tile-based replay windows for Google-Maps-style zoom/pan.
- Feed market-memory alerts into Scanner, BlackGPT, and Notifications.
