# Historical Liquidity Heatmap Correction

## Status

Root-cause audit and implementation completed on 2026-07-22. The web renderer, dedicated API, storage schema and standalone collector image are release-ready. Production activation remains blocked until an always-on container runtime is provisioned for `Dockerfile.book-heatmap-worker`; Vercel is request/response infrastructure and cannot own the continuous Bybit WebSocket. The implementation therefore does not claim live historical coverage yet.

## Confirmed reason the first result displayed only present-time liquidity

The first rebuilt Book Heatmap had two independent paths:

1. Browser-local live L2 snapshots entered `PixiBlackChart`, were compacted by `bookHeatmapWorker`, retained by `OrderBookHeatmapModel`, and rendered by `BlackChartEngine`.
2. Historical cells were requested from authenticated `/api/market-depth/tiles`, which reads `market_depth_rollups` in Supabase.

Those paths were not joined by a deployed persistent Bybit collector. The browser path stops when the tab closes and does not write history. The server history path returned no Bybit cells for the requested production window. Because the previous renderer truthfully refused to stretch the newest snapshot backward, only the current right-edge profile was visible.

The immediate visual fallback therefore exposed a real architectural absence: the product had current-book state but no continuously collected Bybit time dimension.

## Audited old data path

### Browser live Bybit path

- Source: `wss://stream.bybit.com/v5/public/linear` for perpetuals.
- Topic: `orderbook.200.BTCUSDT` for the BTC linear perpetual.
- REST fallback: `GET https://api.bybit.com/v5/market/orderbook?category=linear&symbol=BTCUSDT&limit=200` once per second after stream failure.
- Depth: 200 bid and 200 ask levels for linear perpetuals.
- Snapshot/delta application: the browser adapter clears its bid/ask maps on a Bybit `snapshot`, applies subsequent `b`/`a` updates, and deletes zero-size levels.
- Integrity limitation: the browser adapter records `u` and `seq` but does not prove a contiguous Bybit sequence before emitting a reconstructed book.
- Worker ownership: `bookHeatmapWorker` compacts emitted full-book observations into transferable price/bid-notional/ask-notional triples. It does not persist them.
- Capture cadence: the model accepts the live stream and retains a frame at a bounded cadence (500 ms default).
- Price bucketing: the compaction processor derives a bounded bucket size from the received price range and level density.
- Notional: certified base quantity is multiplied by bucket price before intensity aggregation.
- Persistence: browser memory only; default 1,200-frame bounded ring. Closing the browser discards it.
- Renderer input: `OrderBookHeatmapModel.cells(...)` returns observed live cells plus any authenticated historical cells.

### Existing server collector path

- Entrypoint: `npm run depth:worker:supervise` starts `scripts/market-depth-supervisor.js`, which supervises `scripts/market-depth-worker.js`.
- Bybit source: the same public linear WebSocket and `orderbook.200` topic, plus a REST 200-level recovery snapshot.
- Default configured market: `hyperliquid:perpetual:BTCUSDT` when `MARKET_DEPTH_SYMBOLS` is absent.
- Persistent runtime requirement: repository documentation correctly states that this process must run outside Vercel serverless.
- Current production container gap: `Dockerfile.black-cloud` copies and starts only `scripts/black-cloud-execution-worker.js`; it does not include or start the market-depth worker.
- Current Vercel configuration gap: the production project exposes no `MARKET_DEPTH_SYMBOLS` variable. Vercel remains unsuitable for a continuous exchange WebSocket even if that variable is added.

### Confirmed correctness defects in the old server collector

The old Bybit collector parser forwards each WebSocket `b`/`a` packet directly as a `baseSample`. It does not maintain local bid and ask maps, distinguish snapshot from delta, or apply zero-size deletion before storage. `MarketDepthMemoryEngine` consequently normalizes a delta packet as though it were a complete order book.

The collector's gap diagnostic may start asynchronous snapshot recovery, but the same unverified packet is still passed to `engine.ingest`. Recovery is not a state gate. The existing status vocabulary (`connecting`, `open`, `error`, `closed`) also cannot express snapshot loading, synchronization, a detected gap or resynchronization.

These behaviors make the old Bybit rollups unsuitable as certified historical full-book frames even if the worker is running.

### Existing storage/query path

- Raw snapshots: `market_depth_snapshots`, throttled to one row per 30 seconds.
- Derived deltas: `market_depth_deltas`.
- Price/time rollups: `market_depth_rollups` at 1s, 10s and 1m.
- Statistics and worker health: `market_depth_statistics`, `market_depth_collector_status`, `imm_worker_heartbeats`.
- Retention: raw 6 hours, 1s 3 days, 10s 21 days, 1m 180 days by default.
- Historical API: `/api/market-depth/tiles` reads the selected rollup resolution.
- Topology defect: the tile builder sorts rows by liquidity/gravity strength, truncates to at most 5,000 cells, then sorts the survivors by time. Missing weaker cells are indistinguishable from absent frames, so the response is not a complete bounded time × price field.
- Coverage defect: the response echoes requested `from`/`to`; it does not report earliest/latest stored frames, continuity, gaps or collector state.

## Old versus corrected architecture

| Concern | Old | Corrected target |
|---|---|---|
| Live browser | Current full-book display | Optional `Current Book Profile`, never historical authority |
| Persistent collection | Undeployed and defaulted away from Bybit | Always-on Bybit collector independent of browser/Vercel |
| Delta integrity | Delta packets treated as books | Snapshot-gated local reconstruction with gap/resync states |
| Persistence | Sparse JSON snapshots plus lossy rollups | Five-minute compressed binary frame chunks plus indexed coverage metadata |
| Historical query | Strongest-cell truncation | Dedicated topology-preserving `/api/market-depth/historical-tiles` route with explicit missing columns |
| Rendering | Per-observation Pixi rectangles/current profile | Bounded typed matrix uploaded as a GPU raster/texture |
| Camera | Shared chart camera | Same shared chart camera; data LOD selected independently |
| Missing data | Empty message/current fallback | Transparent gaps plus requested/available/continuity status |

## Non-negotiable truth boundary

- A current snapshot is never copied into an earlier timestamp.
- A gap is transparent and reported, never interpreted as zero liquidity.
- Only sequence-verified full-book frames may enter certified historical storage.
- Available duration is computed from stored frames, not copied from the requested horizon.
- DOM Pro+ source, state, camera, workers, tests and styling are outside this correction.

## Corrected collector and storage

`scripts/book-heatmap-history-worker.js` owns `HistoricalLiquidityCollector` in a standalone Node 22 process. It subscribes to Bybit linear `orderbook.1000`, waits for a WebSocket snapshot, maintains independent bid and ask maps, applies zero-size deletion, validates monotonic `u`, `seq` and source time, and closes/reconnects for a new snapshot after an integrity failure. Its externally reported states are `STARTING`, `SNAPSHOT_LOADING`, `SYNCHRONIZING`, `LIVE`, `GAP_DETECTED`, `RESYNCING`, `DEGRADED` and `FAILED`.

The working stream may arrive every 200–250 ms. Persistence is cadence-limited to one frame per second. Frames contain the top 1,000 reconstructed levels, adaptive price buckets, quantity and quote notional. Adaptive bucketing is bounded to at most approximately 512 price rows across the observed book span.

`book_heatmap_depth_chunks` stores up to 300 one-second frames per five-minute row as `gzip-json-v1` `bytea`. The collector updates the active chunk every five seconds, deduplicates reconnect snapshots within the same second, and prunes chunks older than 72 hours. This avoids one JSON database row per depth frame. `book_heatmap_collector_coverage` stores state, timestamps, frame/gap counts, last sequence and heartbeat metadata. Both tables have RLS enabled, no client grants, and service-role-only access. Migration `202607220001_historical_liquidity_heatmap.sql` is applied to the linked production Supabase project.

Worst-case bounds are explicit: 300 frames/chunk, 1,000 source levels/side, approximately 512 adaptive price buckets/frame, 864 chunks for the 72-hour retention window, and 1,000 chunks maximum per API request. The route independently downsamples to at most 1,024 time samples and 40,000 returned sparse cells. Future 5s/15s/1m archival chunks can extend retention without changing the client contract.

## Matrix and renderer

The default mode is `Historical Liquidity`; `Current Book Profile` and `Combined` remain separate. The client requests the dedicated authenticated route and builds a bounded `Float32Array` matrix with separate bid/ask planes, a maximum of 1,024 columns and 512 rows, plus an observed-column mask. Missing columns remain transparent; the current snapshot is never copied into history.

One Pixi sprite backed by one canvas/GPU texture renders the entire field beneath candles. Camera time/price projection comes from the existing Black Chart view, so pan, zoom, resize, replay and magnet movement do not create a second camera. Under pressure, the server reduces temporal sampling and the renderer caps texture resolution; neither changes the chart camera.

Thermal is the default palette and matches the requested structural appearance: purple low-intensity background, blue/cyan/green intermediate liquidity and yellow walls. Institutional and Blood Red remain available. A vertical notional legend renders at the left edge.

## Coverage and truth behavior

The API returns earliest/latest frame timestamps, requested and available duration, frame count, continuity, explicit gaps and collector state. The settings/status UI shows venue state, available versus requested history, continuity and returned cell count. If no history exists, it says so and draws transparent history; it does not silently substitute the current profile.

## Verification evidence

- `npm run test:book-heatmap-history`: passed snapshot gating, incremental deltas, zero deletion, regression-triggered resync, truthful gaps, persistent/moved wall topology and bounded matrix tests.
- Existing Book Heatmap model and recorded venue-fixture suites: passed.
- Performance gate at 12,000 synthetic 200-level snapshots: 0.1053 ms average processing, 57.46 ms bounded cell build, 3,177 rendered cells, 600-frame live ring and 12.9 MB retained heap delta.
- Authenticated visual regression: 12/12 captures passed at 1920×1080, including continuous Thermal field, persistent/short/moved/withdrawn/absorbed walls, free-camera alignment, zoom alignment and separate current-profile mode.
- DOM Pro panel and shared-camera certification suites: passed with zero DOM Pro+ source changes.
- `npm run build`: passed TypeScript, 27 route security contracts, production Vite build and secret audit.
- `npm run security:verify-migrations`: passed 26/26 required tables against linked production Supabase.
- DOM Pro+ source paths changed: zero. Its `/api/market-depth/tiles` implementation was restored byte-for-byte and remains separate from the new heatmap route.

## Deployment status

Supabase schema: deployed. Vercel/frontend: not pushed from this correction yet. Persistent collector: packaged in `Dockerfile.book-heatmap-worker`, but no always-on container provider is configured in the available Vercel/Supabase environment. Production must not report `LIVE` until that container is running with `VITE_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, and fresh frames/heartbeats are verified after the browser and workstation are closed.
