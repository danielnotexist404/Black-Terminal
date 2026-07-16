# Implementation History

This file records what has been built so far and what must be recorded going forward.

## Current Git Milestones

Recent pushed commits:

- Current - Enforce runtime-connection scoping for private orders, positions and portfolio API synchronization.
- Current - Bring DOM Pro execution to venue-native Bybit parity with Spot/Futures and dynamic Conditional, Chase, TWAP, Iceberg and POV controls.
- Current - Replace Bybit's fixed validation notional with account-margin execution capacity.
- Current - Correct Bybit equity-allocation sizing and detect safety caps below venue minimums.
- Current - Add IMM operational readiness foundation.
- Current - Add supervised IMM depth worker.
- Current - Add IMM progressive tile prefetch.
- Current - Connect DOM depth memory to Black Core tiles.
- Current - Add IMM collector snapshot recovery.
- Current - Add IMM replay worker bridge.
- Current - Add IMM tiles and collector heartbeat.
- Current - Add IMM retention and alert surfaces.
- Current - Implement Black Core Market Depth Memory foundation.
- Current - Add DOM Pro+ depth memory provider foundation.
- Current - Stabilize DOM Pro+ heatmap drag and downside structure.
- Current - Fix DOM Pro+ profile domain scaffold and raw-depth curve.
- Current - Polish DOM Pro+ cockpit rendering and viewport controls.
- Current - Refine DOM Pro+ heatmap camera and remove artificial zoom-out limit.
- Current - Fix DOM Pro+ full price domain, buy walls, and depth diagnostics.
- Current - Build DOM Pro+ real price-domain liquidity camera.
- Current - Consolidate Vercel API route dispatchers for production deploy.
- Current - Bridge Black Terminal login to Supabase Auth for secure credential routes.
- Current - Remove hardcoded default admin bootstrap for clean user reset.
- Current - Expand registration phone country dial-code selector.
- Current - Add registration display name separate from login username.
- Current - Create confirmed Supabase Auth users server-side after Black Terminal verification.
- Current - Move email-confirmation blocking out of login and into Profile readiness.
- Current - Prevent normal sign-in from triggering Supabase confirmation email retries.
- Current - Redesign DOM Pro+ as institutional liquidity radar.
- Current - Implement Phase III Chapter VI DOM Pro+ cockpit.
- Current - Implement Phase IV professional network foundation.
- Current - Implement Phase III Chapter IV position lifecycle foundation.
- Current - Implement Hyperliquid execution relay routes.
- `6d57492` - Implement Phase III connectivity source of truth.
- `d34b423` - Implement Phase III OMS EMS foundation.
- `17e183b` - Implement Phase III portfolio role separation.
- `0fb6255` - Add protected app context menu and position actions.
- `5c7e93e` - Remove decorative portfolio data.
- `fc76dae` - Implement Black Core market data and execution foundation.
- `e327cf0` - Optimize topbar and sidebar layout for MacBook 13-inch and mobile viewports.
- `fe1777a` - Integrate Portfolio Manager, Copy Trading, Risk Engine, and Wallet connection modules.
- `c7d928e` - Give BlackGPT real-time OHLCV chart access with live candle buffer and precise price context.

## Vercel API Route Consolidation

Status: Implemented

Changed:

- Collapsed the six Hyperliquid relay API files into one dynamic Vercel function at `api/protocols/hyperliquid/[action].js`.
- Moved Hyperliquid route implementations into `server/protocols/hyperliquid-routes/`.
- Collapsed the Professional Network API files into dynamic dispatchers at `api/network/[resource].js` and `api/network/investment-groups/[groupId]/[action].js`.
- Moved Professional Network route implementations into `server/network/routes/`.
- Added `.vercel` to `.gitignore` so local Vercel project linkage is never committed.

Why:

- Vercel builds were passing, then failing while deploying outputs after the API surface expanded. The generated build output had 20 serverless functions; route consolidation reduces this to 10 functions while preserving endpoint URLs.

Validation:

- `npm run build` passes.
- `vercel build --yes` passes locally.
- Generated Vercel output now contains 10 API functions instead of 20.

## Phase III Chapter VII: Black Core Market Depth Memory

Status: Implemented infrastructure foundation

Changed:

- Added `server/market-depth` as the Black Core Market Depth Memory subsystem.
- Added server-side depth normalization, compression rollups, delta extraction, wall lifecycle detection, event generation, statistics, and replay reconstruction.
- Added a long-running collector worker entry at `scripts/market-depth-worker.js`, exposed through `npm run depth:worker`.
- Added collector adapters for Hyperliquid, Binance, Bybit, and OKX public depth streams.
- Added dynamic Vercel API route dispatcher at `api/market-depth/[action].js`.
- Added market-depth routes for replay, ingest, status, and walls.
- Added DOM Pro+ replay hydration from `/api/market-depth/replay`, with source labeling for Black Core, Supabase fallback, or local fallback memory.
- Added the platform-owned Supabase migration for snapshots, deltas, rollups, liquidity events, lifecycle walls, and statistics.
- Added market-memory alert extraction over liquidity events, wall lifecycle state, statistics, and feed diagnostics.
- Added retention pruning utilities, worker pruning loop, and protected `/api/market-depth/prune` route.
- Added collector packet-loss and reconnect diagnostics into depth statistics for incremental feeds.
- Added `/api/market-depth/tiles` for bounded Google-Maps-style replay cells with explicit multi-venue breakdown.
- Added collector heartbeat persistence through `market_depth_collector_status` and included collector status in `/api/market-depth/status`.
- Changed browser depth memory so Supabase writes are disabled by default. Local browser memory remains fallback-only, while Black Core replay is the authoritative path.
- Added the first DOM-side IMM aggregation worker bridge for shaping/culling Black Core replay points before they are merged into DOM Pro+ fallback memory.
- Added REST snapshot recovery hooks for Hyperliquid, Binance, Bybit, and OKX. The collector now recovers a snapshot after connection and after explicit sequence-gap detection.
- Changed DOM Pro+ depth-history hydration to request bounded `/api/market-depth/tiles` cells for the active camera range before falling back to broad replay hydration.
- Added padded tile-window prefetching so DOM Pro+ asks Black Core for adjacent liquidity cells around the current camera and keeps rendering culled to the visible viewport.
- Added `npm run depth:worker:supervise`, a persistent worker supervisor that restarts the depth collector after fatal stale-feed exits or process failures.
- Added worker stale-feed health checks controlled by `MARKET_DEPTH_FATAL_STALE_MS` and `MARKET_DEPTH_STARTUP_GRACE_MS`.
- Added normalized orderbook integrity validation before persistence, with optional audit records in `imm_integrity_events`.
- Added `imm_worker_heartbeats` support and an authoritative `server/imm/status-service.js` status model exposed through `GET /api/imm/status`.
- Added `npm run depth:verify` to check recent persisted depth, bid/ask rows, impossible values, wall symmetry, worker heartbeat freshness, and bounded replay windows.

Why:

- DOM Pro+ should become one visualization of Black Core market memory instead of being responsible for building all historical liquidity memory in the browser.
- Black Terminal needs a server-owned IMM foundation that Scanner, BlackGPT, Strategy Lab, Replay, and future automation can consume without duplicating orderbook logic.

Validation:

- Server modules pass `node --check`.
- `npm run build` must pass before push.

Remaining:

- The collector must run in a persistent worker/runtime with `npm run depth:worker:supervise`. Vercel serverless cannot own continuous WebSocket collection.
- Checksum validation and deeper venue-specific delta reconciliation remain future work.
- Admin operations panel, DOM Pro+ user status indicator, deterministic tests, and load tests remain future work.
- The remaining live DOM aggregation path still needs full worker migration.
- DOM Pro+ now consumes tile cells for visible market memory and prefetches adjacent camera windows. Minimap/navigator streaming remains future work.

## Phase III Chapter VI: DOM Pro+

Status: Implemented frontend foundation with institutional liquidity radar redesign

Changed:

- Added Black Core module registry and window/dock manager scaffolding.
- Added DOM Pro+ as a detachable/expanded module.
- Added shared Market Data Engine subscription multiplexing for orderbook and trade streams.
- Added shared DOM Feed Store consumed by compact DOM and DOM Pro+.
- Removed fake compact DOM liquidity fallback.
- Added DOM Aggregation Engine with bucket multipliers from 1x through 1000x, DOM modes, visible range settings, wall detection, pulling/stacking, absorption heuristic, iceberg probability heuristic, liquidity delta, heatmap history, CVD input tracking, metrics, and render diagnostics.
- Reworked DOM Pro+ away from a fast scalper micro-DOM into a slower institutional cockpit.
- Added heatmap horizons for 2H, 6H, 12H, 24H, 3D, and 1W.
- Added institutional defaults: 250x buckets, +/-2% visible range, 24H heatmap horizon, persistent heatmap memory, lower visual FPS, and larger significant-liquidity filters.
- Added ranked wall persistence with age, persistence percentage, distance from price, and first-pass liquidity migration detection.
- Added a historical OHLCV macro radar layer through the existing Market Data Engine candle cache/fetch path.
- Added macro bands for POC, supply, and demand structure across a wider historical range. These bands are derived market-structure zones, not fake live orderbook levels.
- Redesigned the central heatmap to render broad red/gray/white horizontal liquidity bands with a price scale and current-price line.
- Redesigned CVD into a larger heuristic CVD panel with current/session delta, aggressive buy/sell percentages, trend label, and a thicker curve.
- Added persistent local DOM settings per workspace and symbol.
- Added DOM Pro+ panels for aggregated ladder, DOM-aligned volume profile, liquidity heatmap, wall detection, trade tape, metrics, depth chart, liquidity flow delta, CVD, diagnostics, and quick execution.
- DOM quick execution routes through the existing `submitOrder` OMS/EMS path.
- Compact DOM can open DOM Pro+ from a right-click/header menu and hides while DOM Pro+ is open.
- Detached browser mode opens a popout window fed by the parent workspace over `BroadcastChannel`, so the child window does not open duplicate exchange feeds.
- Detached popout quick execution sends order intents back to the parent workspace for OMS/EMS/Risk routing.
- Detached popout renders parent-fed CVD data, and the compact DOM menu can open DOM Pro+ directly into settings.
- Fixed DOM Pro+ cockpit grid placement so the main panel fills the remaining window height instead of leaving bottom dead space.
- Expanded the bottom cockpit row so the Execution panel is visible and scrolls internally when content exceeds available space.
- Added heatmap viewport controls: wheel zoom, vertical drag/pan, Shift + wheel pan, double-click reset, Reset View, and hover readouts.
- Replaced the bounded viewport with a shared price-space camera for heatmap, volume profile, and depth chart alignment.
- Added Current, 1H, 6H, 12H, 24H, 3D, and Fit camera presets.
- Removed the old minimum zoom-out behavior so users can inspect wider liquidity maps up to institutional/macro scale.
- Kept panning user-controlled without snapping back to current price except when explicitly centering the market.
- Fixed a bucket-domain bug where wide ranges could retain only higher-price ask buckets and cut off bid/buy liquidity below current price.
- Changed heatmap memory and wall detection to select bid and ask candidates separately, preserving buy walls below market and sell walls above market.
- Restored the cumulative depth chart with current price as the center reference and separate bid/ask cumulative curves.
- Added DOM diagnostics for raw levels, aggregated buckets, wall counts, shared domain bounds, rendered rows, and depth points.
- Added a real price-domain camera with center price, domain min/max, zoom factor, mode, and explicit camera domain.
- Added camera range presets for +/-1%, +/-2%, +/-5%, +/-10%, +/-20%, and Full Data.
- Expanded aggregation retention for wide/full ranges so camera navigation has retained bid/ask buckets instead of only visible ladder rows.
- Added depth-chart fallback to raw orderbook levels and one-sided source warnings.
- Added hard diagnostics for selected range, computed domain, camera domain, best bid/ask, mid, min/max side prices, total bid/ask size, and exact failure reason.
- Updated liquidity-flow delta scaling with p95 clamp and square-root scaling to prevent giant block artifacts.
- Scoped the central heatmap to the selected visible range so institutional mode shows balanced buy/sell radar around current price instead of drifting only toward distant upside history.
- Aligned Volume Profile with the heatmap viewport and added hover inspection.
- Changed Volume Profile rendering from sparse populated rows into a full camera-domain scaffold with a continuous outline, right-side price scale, and zero-volume rows hidden instead of collapsing the visible range.
- Changed the depth chart to use raw L2 bid/ask levels before aggregated buckets, map the shared price camera horizontally, extend available cumulative curves to the visible domain edges, and keep explicit sparse-source warnings.
- Added historical structure ribbons inside the heatmap from the shared profile so downside/upside higher-timeframe zones remain visible when panning beyond shallow live L2 depth.
- Throttled heatmap drag panning with `requestAnimationFrame` and removed the stale drag-ref read that could blank the browser while dragging.
- Added a Black Depth History Store that samples raw L2 bid/ask levels, compresses them into persistent wall-memory buckets, stores them locally per venue/symbol, and hydrates/upserts Supabase `market_depth_memory` when the migration is applied.
- Changed live wall detection and heatmap memory to consume raw L2 wall candidates before 1000x rendering buckets, preventing large bucket compression from hiding buy walls below price.
- Added heatmap depth-memory bands and explicit `Collecting Depth History` coverage zones so empty regions communicate missing depth history while accumulating real observations over time.
- Slowed heuristic CVD with 15M/1H/4H/12H/24H horizons, EMA smoothing, and sample intervals.
- Replaced the block-style depth chart with a cumulative bid/ask market-depth curve.
- Replaced liquidity flow blocks with rolling time-bucket histogram bars using percentile outlier scaling.
- Added render-cost frame skipping and a high-load diagnostic warning.

Why:

- The right-side DOM needed to become a professional order-flow cockpit without opening duplicate exchange WebSocket feeds or bypassing OMS/EMS.
- Black Terminal must distinguish real market structure from decorative/fake liquidity.

Validation:

- `npm run build` passes.

Remaining:

- Detached browser popout requires the parent workspace to remain open because the parent owns feed subscriptions and execution context.
- Worker/Rust aggregation offload remains future work.
- No Supabase migration is required until DOM layouts/settings need server persistence.

## Phase IV Professional Network Foundation

Status: Implemented foundation

Changed:

- Added `PROFILE` and `INVESTMENT GROUPS` to the main sidebar.
- Implemented Professional Profile with avatar/banner upload scaffolding, profile editing, Research Feed composer, own posts, followed research feed, follower/following lists, published indicator scaffolding, published strategy scaffolding, opt-in performance disclosure, and group membership views.
- Implemented Investment Groups discovery with Enterprise/Admin creation gate, six-step create wizard, password-hash-only protected group handling, group detail tabs, join requests, owner/admin review, and Trading Room channels.
- Added professional network capabilities to the existing role/capability model.
- Added server-side permission helpers and API scaffolds for profile, posts, follows, groups, join requests, request review, and group messages.
- Updated Portfolio Manager Investment Groups tab with owned/joined/discovery groups and retail versus enterprise tool status.
- Added the Phase IV Supabase migration ledger for profiles, follows, posts, published tools, investment groups, stats, members, join requests, messages, and notifications.

Why:

- Black Terminal needs a professional trading identity and investment discovery layer before allocation, group reputation, and verified manager analytics can be safely built.
- The system must avoid generic social mechanics and fake performance while preparing trust, permission, and governance rails.

Validation:

- `npm run typecheck` passes after the Phase IV module and route integration.

Remaining:

- Apply the Phase IV Supabase migration and connect the frontend pages to the API routes.
- Add verified exchange performance feeds and admin moderation workflows.
- Connect Investment Groups to future Allocation Engine rules without bypassing OMS, EMS, Risk, or execution audit.

## Foundation

Status: Implemented

Changed:

- Created a Vite, React, TypeScript frontend.
- Replaced embedded charting dependency direction with a custom PixiJS chart engine.
- Added Tauri desktop shell support.
- Added project docs for product brief, architecture, workspace setup, exchange automation, Python indicators, and roadmap.

Why:

- Black Terminal needs a terminal-grade chart and workflow foundation rather than a generic prebuilt chart widget.
- React stays responsible for shell and controls while PixiJS handles high-frequency rendering.

Validation:

- Frontend builds through `npm run build`.
- Tauri commands remain isolated under `src-tauri/`.

## Chart Engine

Status: Implemented foundation, still evolving

Changed:

- Added `src/chart-engine/BlackChartEngine.ts`.
- Added candle buffers, heatmap models, volume profile model, viewport handling, crosshair behavior, indicators, overlays, and price/time axis rendering.
- Added the `PixiBlackChart` React bridge.

Why:

- The chart is the product center and must support professional overlays, heatmaps, replay, execution markers, and dense interaction.

Remaining:

- Continue optimizing draw batching, worker-side aggregation, replay depth, and tests for scale math and buffers.

## Market Data And Black Core Phase II

Status: Implemented foundation

Changed:

- Added Black Core event and service infrastructure.
- Added Market Data Engine facade.
- Added market cache, aggregation utilities, WebSocket manager, normalized market contracts, and exchange adapter registry.
- Added exchange adapters for major venues and catalog support for Binance, Bitfinex, OKX, Bybit, Hyperliquid, Coinbase, Kraken, Bitstamp, Deribit, Bitget, KuCoin, Gate.io, MEXC, and BitMEX.

Why:

- Chart, scanner, strategy lab, portfolio, alerts, and execution modules must consume normalized data rather than exchange-specific payloads.

Docs:

- `BLACK_CORE_PHASE2.md`
- `ARCHITECTURE.md`

## Portfolio Manager Phase I

Status: Implemented foundation

Changed:

- Added `src/modules/portfolio-manager/`.
- Added portfolio snapshot, account, balances, position, risk, copy trading, and order domain modules.
- Added Vercel/Supabase API routes for portfolio snapshot, exchange account connect/delete, execution order, and cancel.
- Added secure credential boundary.

Why:

- Black Terminal needed account, portfolio, risk, and execution primitives before becoming a professional trading desk.

Remaining:

- Continue replacing mock/read-only paths with venue-specific secure adapters.
- Keep credential persistence behind backend or native secure storage.

Docs:

- `PORTFOLIO_MANAGER_PHASE1.md`

## Decorative Data Removal

Status: Implemented

Changed:

- Removed fake open positions and decorative portfolio manager data.
- Empty states now communicate no live positions, no open orders, or no synchronized portfolio data.

Why:

- Institutional trading workflows must not display fictional balances, orders, or exposures.

## Protected Application Context Menu And Position Actions

Status: Implemented

Changed:

- Disabled browser context menu behavior inside the application.
- Added right-click position actions for close, reverse, and TP/SL modification workflows.

Why:

- The terminal should behave like a protected trading application, not a normal webpage.
- Position management needs direct contextual actions.

## Phase III Chapter 1: Architecture And Role Separation

Status: Implemented

Changed:

- Positions became the owner of execution connectivity and live position workflow.
- Portfolio Manager became the owner of capital management, analytics, investment groups, and role-based portfolio views.
- Product tiers and capability gates were introduced.

Why:

- Execution and capital management are separate systems. Combining them creates duplicated state and unsafe order paths.

Docs:

- `PHASE3_CHAPTER1_ARCHITECTURE.md`

## Phase III Chapter 2: OMS / EMS Foundation

Status: Implemented

Changed:

- Added normalized execution request and report contracts.
- Added OMS lifecycle service.
- Added EMS validation, risk, allocation hook, broker routing, reports, and audit.
- Added Unified Execution Ticket as the shared order entry surface.
- Extended browser execution payloads with source, destination, sizing method, leverage, margin mode, TP/SL, reduce-only, post-only, and TIF.

Why:

- All manual, automated, AI, strategy, replay, and allocation-driven execution must pass through one execution pipeline.

Docs:

- `PHASE3_CHAPTER2_OMS_EMS.md`

## Phase III Chapter 3: Connectivity Framework

Status: Implemented runtime foundation

Changed:

- Added `src/connectivity/`.
- Added Black Core Connection Manager as the runtime source of truth for connected accounts.
- Added centralized exchange adapter wrapper.
- Added MetaMask and Phantom wallet adapters.
- Added capability detection, health, permissions, diagnostics, heartbeat, events, and in-memory audit buffer.
- Refactored Positions to connect and disconnect through the Connection Manager.
- Refactored Unified Execution Ticket to subscribe to active Connection Manager diagnostics.
- Refactored Broker Router to resolve account routing through the Connection Manager.

Why:

- Positions and the Unified Execution Ticket previously had separate account sources. Wallet connections could appear in Positions while the ticket still said to connect a broker.
- MetaMask futures appeared broken because wallet signer capability and DEX perpetual execution capability were not separated.

Findings:

- MetaMask is a wallet signer and does not report perpetual order or leverage capability.
- Futures require a protocol/venue adapter such as Hyperliquid, GMX, dYdX, or another perpetual DEX adapter.
- No regional/provider restriction was found in the app flow.

Docs:

- `PHASE_III_CONNECTIVITY_INVESTIGATION.md`

## Documentation System

Status: Implemented

Changed:

- Added this implementation history.
- Added documentation index.
- Added platform build manual.
- Added Supabase migration ledger.
- Added rule that future changes must update docs before a phase is considered complete.

Why:

- Black Terminal is now large enough that architecture decisions cannot live only in chat or commits.

## Phase III Chapter 4: Position Lifecycle Engine

Status: Implemented runtime foundation

Changed:

- Added Black Core Position Manager.
- Added managed position lifecycle types, protection orders, timeline events, health metrics, notes, and tags.
- EMS now promotes filled execution reports into managed positions.
- Positions workspace syncs portfolio positions into Position Manager.
- Chart context menu now switches between execution actions and position lifecycle actions depending on active symbol exposure.
- Chart renders entry, TP, SL, trailing, and liquidation lines for managed positions.
- Draggable protection lines update Position Manager and publish lifecycle events.
- Unified Execution Ticket supports TP/SL/trailing-stop position presets.
- Added protocol framework and Hyperliquid protocol adapter.
- Active broker/protocol connection now scopes the top market selector to the linked venue's market universe.

Why:

- Positions must become first-class managed objects after execution.
- Wallets are signers, not exchanges. Hyperliquid and future perpetual DEXes need protocol adapters behind wallet signing.

Remaining:

- Add persistent Supabase position lifecycle tables.
- Add backend position lifecycle API routes.
- Add server-side Hyperliquid signing/order relay.
- Sync real protocol positions, balances, orders, funding, fees, and fills.

Docs:

- `PHASE3_CHAPTER4_POSITION_LIFECYCLE.md`

## Phase III Chapter 5: Hyperliquid Server-Side Execution Relay

Status: Implemented route foundation, pending Supabase migration application and testnet validation

Changed:

- Added Hyperliquid SDK and `viem` local-account signing support.
- Added server relay helper for encrypted agent credentials, metadata validation, nonce RPC usage, order signing, cancel, modify, close-position, and account sync.
- Added Vercel API routes:
  - `/api/protocols/hyperliquid/connect`
  - `/api/protocols/hyperliquid/order`
  - `/api/protocols/hyperliquid/cancel`
  - `/api/protocols/hyperliquid/modify`
  - `/api/protocols/hyperliquid/close-position`
  - `/api/protocols/hyperliquid/sync`
- Updated Hyperliquid onboarding to require MetaMask identity plus an authorized agent/API wallet.
- Updated Connection Manager to ingest backend-created protocol connections as the single runtime source of truth.
- Updated Protocol Router and EMS broker routing so ready Hyperliquid protocol accounts execute through OMS -> EMS -> Protocol Router -> relay.
- Updated Unified Execution Ticket and position TP/SL actions to route Hyperliquid orders through the protocol execution path.
- Added testnet-first behavior and fail-closed mainnet requirements.

Why:

- MetaMask alone is only identity/signing context. Live Hyperliquid futures execution requires server-side agent-wallet signing against the Hyperliquid `/exchange` endpoint.
- The frontend must never sign protocol trading actions with raw private keys or store agent credentials in browser storage.

Validation:

- `npm run build` must pass before this chapter is pushed.

Remaining:

- Apply the Chapter V Supabase migration.
- Configure server environment variables.
- Validate testnet connect, order, cancel, modify, close-position, and sync flows with an approved Hyperliquid agent wallet.
- Keep mainnet disabled until testnet flow is confirmed end to end.

## Phase III Chapter 8: IMM Polish And Professional UX

Status: Implemented and build validated

Changed:

- Added DOM Pro+ workspace presets for Scalper, Intraday, Institutional, and Macro.
- Added persistent camera controls for Center, Fit, Follow, and Explore.
- Added keyboard shortcuts for centering, fitting, follow mode, reset, heatmap, profile, depth chart, and overlay close.
- Added `showDepthChart`, `followMarket`, `freeExplore`, and `workspacePreset` to local DOM Pro settings.
- Added an IMM status strip that consumes `/api/imm/status` and summarizes worker state, replay quality, wall counts, active camera domain, FPS, heartbeat age, and persistence age.

Why:

- DOM Pro+ needs to behave like professional desk software: the trader controls the camera, understands data quality at a glance, and can switch between operating styles without manually tuning every setting.

Validation:

- `npm run build`

Remaining:

- Add inertia/momentum panning.
- Add user-resizable panel geometry with local persistence.
- Expand wall and heatmap tooltips with full reliability metadata.
- Add automated interaction tests for camera/preset keyboard behavior.

Docs:

- `PHASE3_CHAPTER8_IMM_POLISH.md`

## Phase III Chapter 9: Black Core Performance And Long-Session Stability

Status: Instrumentation foundation implemented and build validated

Changed:

- Expanded the Black Core performance monitor with FPS, frame time, p99, worst frame, dropped frames, long tasks, heap, DOM node, and event-bus diagnostics.
- Added a hidden Performance HUD toggled by `Ctrl+Shift+P`.
- Connected Pixi chart and DOM Pro+ render metrics into the shared monitor.
- Throttled high-frequency metric publishing to prevent telemetry from creating an event storm.
- Added event-bus listener and publish diagnostics.
- Hardened DOM Pro feed cleanup so stopped entries ignore late async fallback responses.
- Added `npm run perf:baseline` and `npm run perf:stress`.
- Generated `docs/performance/latest-baseline.md` and `docs/performance/latest-baseline.json`.

Why:

- Chapter IX requires measurement before optimization. The platform now has the runtime instrumentation needed to compare long-session behavior before and after deeper Pixi, worker, and DOM optimizations.

Validation:

- `npm run build`
- `npm run perf:baseline`

Remaining:

- Run an actual 12-hour browser session and store before/after HUD snapshots.
- Add browser automation for UI long-session profiling once a browser test dependency is approved.
- Move more IMM analytics into workers.
- Add Pixi draw-call and GPU-resource diagnostics.
- Add object pooling for frequently recreated chart and DOM Pro primitives.

Docs:

- `PHASE3_CHAPTER9_PERFORMANCE.md`
- `docs/performance/latest-baseline.md`

## DOM Pro+ Ladder, CVD, And Depth Chart Refinement

Status: Implemented and build validated

Changed:

- Aggregated DOM Ladder now uses an adaptive display step from the active camera domain and raw orderbook levels instead of reusing the large institutional heatmap aggregation bucket.
- DOM Ladder now separates rows above and below the mid-price block.
- CVD now renders candle-style delta bodies, wicks, value-axis labels, and a close trace.
- Depth Chart now renders bid/ask cumulative step curves from mid price outward and avoids filling sparse source data into solid rectangular blocks.

Why:

- 500x/1000x institutional heatmap buckets could collapse the ladder into one row.
- The previous CVD summary line hid useful structure.
- The previous depth fill could look like two large blocks when the source had sparse or heavily aggregated depth points.

Validation:

- `npm run build`

Docs:

- `PHASE3_CHAPTER6_DOM_PRO.md`

## DOM Pro+ Depth And CVD Camera Decoupling

Status: Implemented and build validated

Changed:

- Depth Chart no longer consumes the Liquidity Heatmap camera domain.
- Depth Chart now resolves a separate market-centered L2 domain from raw bid/ask depth around current price.
- CVD now falls back to real trade-sequence candles when the pre-bucketed CVD series is too sparse.
- CVD stats now consume the candle fallback when the smoothed series has insufficient samples.

Why:

- Heatmap wheel zoom and Full Data exploration were crushing the depth curve into a vertical spike.
- CVD could collapse into a single unreadable candle when the venue supplied only a short recent trade tape window.
- Depth and CVD are diagnostic panels, while the heatmap/profile pair are the free macro liquidity camera.

Validation:

- `npm run build`

Docs:

- `PHASE3_CHAPTER6_DOM_PRO.md`

## DOM Pro+ CVD Camera And Depth Projection Fix

Status: Implemented and build validated

Changed:

- Added CVD candle-duration and visible-candle settings.
- Expanded CVD horizons to 3D and 1W.
- Added an independent CVD camera with Live/Fit controls, mouse-wheel zoom, horizontal drag pan, and double-click reset.
- CVD rendering now uses the camera-selected candle window instead of always forcing the latest compressed sequence.
- Depth Chart now uses adaptive L2 rank projection when available live depth is too narrow for the market-centered price range.

Why:

- The CVD panel was visually better but still too fast and noisy for structural reading.
- The user needed the same style of mouse navigation inside CVD that exists in the Liquidity Heatmap.
- The depth curve was centered but still compressed when the exchange only supplied a narrow live L2 range.

Validation:

- `npm run build`

Docs:

- `PHASE3_CHAPTER6_DOM_PRO.md`

## DOM Pro+ CVD Visibility And Depth Controls

Status: Implemented and build validated

Changed:

- Moved CVD horizon, Live, Fit, and camera readout controls from the CVD panel into the DOM Pro settings panel.
- Restored the CVD panel to stats plus chart content so the oscillator remains visible.
- Added Depth Levels, Depth Smooth, and Depth Curve settings.
- Depth Chart now uses a side-normalized projection where bids extend to the left edge and asks extend to the right edge.
- Depth smoothing groups adjacent L2 levels before cumulative rendering to reduce noisy stair-stepping.

Why:

- CVD controls were consuming too much of the small panel and hiding the oscillator.
- Depth needed user-tunable noise reduction and fuller use of the chart panel width.

Validation:

- `npm run build`

Docs:

- `PHASE3_CHAPTER6_DOM_PRO.md`

## Phase III Chapter X Audit And Live Readiness

Status: Implemented and build validated

Changed:

- Audited the major Phase I/II/III/IV foundation systems and recorded completion state in `PHASE3_CHAPTER10_AUDIT_AND_LIVE_READINESS.md`.
- Added session-scoped Developer Mainnet Validation Mode.
- Enforced live-mainnet gating in Unified Execution Ticket, DOM Pro+ quick execution, Positions execution dock, and the Hyperliquid protocol adapter.
- Routed protocol orders from the Positions execution dock through OMS -> EMS -> Risk -> Broker Router -> Protocol Router instead of the direct portfolio API path.
- Updated the Hyperliquid relay server gate to prefer `HYPERLIQUID_MAINNET_VALIDATION_ENABLED=true` for controlled mainnet validation.

Why:

- Mainnet confirmation existed during Hyperliquid onboarding, but execution also needed an explicit per-session developer opt-in before real orders could be submitted.
- The platform needed a written audit that distinguishes complete systems from foundation-level work, placeholders, read-only adapters, and validation-blocked live execution.

Validation:

- `npm run build`

Docs:

- `PHASE3_CHAPTER10_AUDIT_AND_LIVE_READINESS.md`
- `ARCHITECTURE.md`
- `PLATFORM_BUILD_MANUAL.md`
- `WORKSPACE.md`
- `SUPABASE_MIGRATIONS.md`

## Hyperliquid MetaMask Connector Flow

Status: Implemented

Changed:

- MetaMask wallet selection now defaults to the Hyperliquid protocol connection instead of Uniswap.
- Hyperliquid can connect MetaMask as the master wallet/signing identity without requiring an agent key first.
- Adding an agent key upgrades the same Hyperliquid connector flow into relay execution onboarding.
- Mainnet relay onboarding still requires explicit mainnet confirmation and the Chapter X Developer Mainnet Validation Mode for actual orders.

Why:

- In Black Terminal, MetaMask should behave as the signer wallet for the Hyperliquid chart/protocol workflow. Users should not have to manually choose Hyperliquid after choosing MetaMask.

Validation:

- `npm run build`

## Phase III Chapter XI Universal Connectivity Foundation

Status: Implemented and build validated

Changed:

- Added `src/connectivity/venueRegistry.ts` as the machine-readable adapter certification matrix.
- Added normalized connection vocabulary for execution mode, network, and readiness.
- Gated centralized exchange adapters through certification records.
- Positions connection wizard now shows truthful support mode, readiness, products, limitations, and mainnet certification state.
- Removed Hyperliquid from the CEX broker path by filtering CEX options through the certification matrix.
- Added GMX, dYdX, Vertex, and Drift as deferred protocol entries instead of executable placeholders.
- Prevented uncertified exchanges from storing credentials through both frontend adapter logic and the Vercel API route.
- Removed local mock credential fallback for real exchanges when secure server validation fails.
- Added Run Diagnostics in the execution dock for connection mode, readiness, auth, stream, trading, and limitation state.
- Added `swap` to the normalized market kind vocabulary.

Why:

- Black Terminal must not imply that every listed venue can execute live orders.
- Venue logos and public candles are not enough; every connection must report a truthful state: full-live, read-only, market-data-only, signer-only, unavailable, or deferred.

Validation:

- `npm run build`

Docs:

- `PHASE3_CHAPTER11_UNIVERSAL_CONNECTIVITY.md`
- `ARCHITECTURE.md`
- `PLATFORM_BUILD_MANUAL.md`
- `WORKSPACE.md`
- `SUPABASE_MIGRATIONS.md`

## Phase III Chapter XII Exchange Certification Start

Status: Implemented and build validated

Changed:

- Added Bybit diagnostics primitives for server time, instrument metadata, balances, positions, and open orders.
- Added authenticated `/api/exchange-accounts/diagnostics` route.
- Persisted diagnostics into Chapter XI operational tables when available.
- Wired Positions `Run Diagnostics` to the server diagnostics route for centralized exchange accounts.
- Added Bybit cancel and modify adapter primitives.
- Updated Bybit cancel flow so accepted venue orders attempt venue cancellation before local OMS cancellation.
- Added Bybit live-execution fail-closed gate: `BYBIT_MAINNET_VALIDATION_ENABLED=true` plus explicit mainnet confirmation are required.

Why:

- Chapter XII begins converting the truth layer into real adapter certification workflows.
- Bybit can now be measured as an account-verified/read-only adapter without pretending it is production execution certified.

Validation:

- `npm run build`

Docs:

- `PHASE3_CHAPTER12_EXCHANGE_CERTIFICATION.md`
- `ARCHITECTURE.md`
- `PLATFORM_BUILD_MANUAL.md`
- `WORKSPACE.md`
- `SUPABASE_MIGRATIONS.md`

## Phase III Chapter XII Bybit Certification Layer

Status: Implemented and build validated. Production certification remains blocked by required live validation evidence.

Changed:

- Added Bybit private WebSocket client and private-stream worker for orders, executions, positions, and wallet updates.
- Added private-stream heartbeat, reconnect, resubscribe, stale detection, diagnostics, and event normalization.
- Added Bybit snapshot plus stream reconciliation service and `/api/exchange-accounts/sync`.
- Added metadata-backed validation for tick size, quantity step, minimum quantity, minimum notional, max quantity, leverage, margin mode, and time in force.
- Added Bybit live order gate with account allowlist, symbol allowlist, max notional, browser mainnet mode, and per-order `LIVE` confirmation.
- Added admin-only `/api/exchange-accounts/mainnet-validation` to explicitly enable or disable controlled validation on an allowlisted Bybit account.
- Added order-management routes for cancel-all, modify, close, reverse, partial close, TP/SL/trailing protection, leverage, margin mode, and position mode.
- Routed DOM Pro+ centralized exchange quick orders through the server portfolio execution API instead of the local mock broker.
- Added deterministic Bybit certification tests.
- Added `ws` as a direct runtime dependency.

Why:

- One complete certified adapter is more valuable than multiple partial adapters.
- Bybit needed live-stream reconciliation and explicit live-validation controls before any production certification claim could be truthful.

Validation:

- `npm run test:bybit-certification`
- `npm run build`

Remaining:

- Run `npm run bybit:private-stream` in a persistent worker runtime with real allowlisted credentials.
- Record tiny live validation for market, limit, cancel, modify, close, TP/SL, reconnect, and reconciliation before promoting Bybit to production-certified.

## Phase III Chapter XII-B Bybit Mainnet Operational Certification

Status: Certification runner implemented. Live certification is blocked in this environment until real Bybit/Supabase runtime env is provided.

Changed:

- Added `npm run certify:bybit-mainnet`.
- Added `scripts/bybit-mainnet-certification-runner.js`.
- Added `docs/BYBIT_MAINNET_CERTIFICATION_REPORT.md`.
- Added server-backed broker adapter so centralized exchange UI submissions flow through local OMS, EMS, Risk, Broker Router, then authenticated server execution.
- Updated Unified Execution Ticket, Portfolio execution dock, DOM Pro+, and position actions to avoid direct CEX execution shortcuts.
- Runner performs preflight, requires typed `LIVE`, pauses between exposure-changing steps, records evidence, writes the final report, and returns non-zero unless certification is complete.

Why:

- Chapter XII-B is production validation, not feature expansion.
- Bybit cannot be promoted until real private-stream runtime, tiny live order flow, and reconciliation evidence exist.

Validation:

- Pending live runtime validation.

Remaining:

- Provide real allowlisted account env, start the Bybit private-stream worker, run `npm run certify:bybit-mainnet`, and review persisted evidence before updating the venue registry.

## Phase III Chapter XII-C Bybit Mainnet Activation Checkpoint

Status: Operational activation tooling implemented. Bybit remains blocked for live certification until real runtime evidence is produced.

Changed:

- Added `.env.bybit-mainnet.example`.
- Added `docs/BYBIT_MAINNET_ENVIRONMENT_SETUP.md`.
- Added `server/exchanges/bybit-certification.js` deterministic certification evaluator.
- Added `npm run verify:bybit-infrastructure`.
- Added `npm run bybit:private-stream:supervise`.
- Added `npm run bybit:private-stream:status`.
- Added `GET /api/exchange-accounts/bybit-runtime-status`.
- Added Bybit runtime/certification panel inside the Positions execution dock.
- Updated the Bybit private-stream worker with duplicate-event suppression, reconnect-triggered reconciliation, and supervisor-safe runtime health.
- Updated the certification runner to print preflight checks, require `LIVE BYBIT MAINNET` for activation, require `LIVE` for exposure-changing steps, block unexpected existing exposure by default, persist certification evidence rows, and compute a deterministic final decision.
- Updated Bybit credential onboarding to reject withdrawal-enabled keys and return an explicit connection result.
- Consolidated exchange-account and execution API routes behind catch-all Vercel handlers so production deploys stay under the Hobby plan 12-function limit while preserving existing URL paths.
- Linked and deployed the local worktree to `danielnotexist404s-projects/black-terminal`.

Why:

- Chapter XII-C is about operational proof, not adding another partially wired adapter.
- Certification must be computed from runtime checks and persisted evidence, not manually inferred from code completion.
- Vercel serverless function count is an infrastructure boundary; route consolidation keeps the architecture deployable without changing the OMS/EMS/Risk path.

Validation:

- `npm run test:bybit-certification`
- `npm run build`
- Vercel production deployment `dpl_CjnB7H8V6E6oWasz93hCUj6aSeQ4` reached `READY` and was aliased to `https://www.black-terminal.live`.

Remaining:

- Add `SUPABASE_SERVICE_ROLE_KEY` to Vercel production/preview. It is still missing and blocks authenticated server routes.
- After connecting Bybit, add the created `exchange_accounts.id` to `BYBIT_MAINNET_ALLOWED_CONNECTIONS`.
- Start the persistent Bybit private-stream worker outside Vercel.
- Run `npm run certify:bybit-mainnet -- --interactive` with a real allowlisted Bybit account.
- Keep `src/connectivity/venueRegistry.ts` partial until the certification report and Supabase evidence show every mandatory stage passed.

## 2026-07-12 - Proprietary Feature Gatekeeping

Status: Implemented.

Changed:

- Added `proprietary.domPro` and `proprietary.hdlxProfile` to the shared capability registry.
- Gated DOM Pro+ to Enterprise/Admin accounts and disabled the PRO+ compact DOM launcher for unauthorized users.
- Split the full DOM Pro+ cockpit into a lazy entitlement-loaded chunk.
- Kept HDLX Profile controlled by Admin role or explicit Admin Panel `volumeProfile` grant.
- Added workspace and live-poll sanitizers so revoked HDLX access cannot persist through saved chart state.
- Added `product_tier` and `permissions` persistence support for `bt_users`.
- Added Admin Panel product-tier controls for retail, professional, and enterprise users.

Why:

- Retail accounts must not access proprietary DOM Pro+ or HDLX Profile surfaces.
- Admins need a clean way to grant Enterprise DOM Pro+ access without making a user an admin.
- HDLX Profile remains founder/admin-controlled unless explicitly granted.

Validation:

- `npm run build`

Remaining:

- For true source secrecy, move proprietary calculations and classifiers behind server-side workers/private API routes. Browser-side JavaScript should be treated as inspectable even when entitlement-gated.

## 2026-07-12 - Bybit Vercel Region Correction

Status: Implemented.

Changed:

- Added `vercel.json` and pinned serverless functions to `fra1` (Frankfurt).
- Preserved upstream Bybit HTTP status, endpoint, and runtime-region diagnostics during credential validation.
- Added an explicit message when Bybit returns HTTP 403 because the execution backend is running in a restricted region.
- Added automatic failover between Bybit's official `api.bybit.com` and `api.bytick.com` mainnet hosts.
- Added safe server-side diagnostics for upstream failures without logging API credentials.
- Confirmed live Bybit credential authentication and isolated the remaining failure to Supabase snapshot persistence.
- Replaced conflict-target-dependent snapshot upserts with authoritative account-scoped balance and position replacement.
- Preserved authenticated Bybit connections in a degraded state when optional initial snapshot persistence fails instead of deleting the account and credential.
- Replaced Unified Execution Ticket zero-value account placeholders with live Bybit Unified Account equity, available balance, initial margin, order-value, required-margin, fee, and remaining-balance data.
- Added 25/50/75/100 percent collateral sizing controls and blocked submissions above venue-reported available collateral in both the ticket and server route.
- Added owner-confirmed Bybit trading activation that revalidates venue trade permissions and rejects withdrawal-enabled keys.
- Limited Bybit ticket controls to certified market/limit orders and quantity/USD sizing instead of displaying unimplemented algorithms.
- Corrected USD-value sizing so Bybit receives metadata-aligned base quantity rather than treating a USD amount as contracts.

Why:

- Vercel deployed the Bybit credential route to its default `iad1` region in Washington, D.C.
- Bybit rejects API traffic from US IP addresses, so valid credentials could never complete validation from that deployment.
- The regional HTTP 403 was previously normalized into an opaque HTTP 502 in the connection modal.

Validation:

- `npm run test:bybit-certification`
- `npm run build`
- Verify the production function region is `fra1` with `vercel inspect`.

## 2026-07-12 - Venue-Native Bybit Execution Ticket

Status: Implemented.

Changed:

- Replaced the generic Bybit execution matrix and duplicate live-mode controls with a compact Bybit-native order ticket.
- Added Spot/Futures, Limit/Market/Conditional, Buy/Sell or Long/Short, quantity/order-value sizing, collateral slider, TP/SL, Post-Only, Reduce-Only, Cross/Isolated, leverage, and GTC/IOC/FOK controls according to venue support.
- Made connection and reconciliation derive trading readiness directly from Bybit API-key permissions plus server symbol/notional policy.
- Existing read-only Bybit records are repaired automatically during authenticated reconciliation when the key and server policy permit trading.
- Kept OMS, EMS, Risk, Broker Router, server metadata validation, collateral checks, audit logging, and normalized reports in the execution path.

Validation:

- `npm run test:bybit-certification`
- `npm run build`

## 2026-07-12 - Chapter XIII Venue-Native Execution Architecture

Status: Implemented.

Changed:

- Added normalized `VenueExecutionSchema` providers and a truthful execution algorithm registry.
- Made the Bybit ticket product-, capability-, account- and instrument-aware.
- Added live Bybit account info, instrument rules, position mode, margin mode and risk metrics to reconciliation.
- Added metadata-valid quantity/equity sizing, conditional trigger sources, compact account metrics and cost/risk preview.
- Moved runtime/certification controls out of Unified Ticket and DOM Pro into collapsed connection administration.
- Replaced the obsolete symbol-level UTA margin call with Bybit V5 account-level margin mode.
- Removed silent leverage mutation from ordinary order placement; margin and leverage changes are explicit server actions.
- Registered Scaled Order as unavailable until a supervised persistent Black Core worker exists.

## 2026-07-13 - Chapter XIII Bybit Readiness And Native Strategies

Status: Implemented.

Changed:

- Fixed production account synchronization failure caused by calling `.catch()` directly on a Supabase query builder.
- Applied the safe best-effort query wrapper to reconciliation and execution audit writes.
- Integrated Bybit V5-native Chase Limit, TWAP, Iceberg and POV strategy creation through OMS, EMS, Risk and the existing server adapter.
- Added native strategy REST synchronization, private WebSocket event normalization and authenticated strategy stop routing.
- Replaced the misleading pre-sync `UNAVAILABLE` badge with explicit `SYNCING`, `SYNC FAILED`, `BLOCKED` and `TRADING READY` states.
- Activated the production Bybit mainnet policy with venue-validated wildcard symbols and a 5 USDT maximum order-notional safety cap.
- Consolidated permission and execution-policy evaluation into snapshot reconciliation so Portfolio, Connections and Unified Ticket consume the same readiness state.

Validation:

- `npm run test:venue-execution`
- `npm run test:bybit-certification`
- `npm run build`

## 2026-07-13 - Chapter XIV Performance And Long-Session Hardening

Status: Implemented and one-hour soak validated.

Changed:

- Expanded Black Core telemetry with frame percentiles, long tasks, memory, stream, queue, resource and execution spans.
- Added an Admin-only capture HUD and deterministic resource ownership counters.
- Moved DOM aggregation into a bounded worker and added stale-result rejection to DOM and IMM workers.
- Coalesced broad market events and chart camera redraws without reducing raw adapter accuracy.
- Added shared account snapshot deduplication, bounded histories, hidden-tab suspension and hardened reconnect ownership.
- Isolated simulated chart candles from production live-data failures.
- Added deterministic performance tests and a safe production soak harness that never submits orders.

Validation:

- `npm run typecheck`
- `npm run test:performance`
- `npm run test:venue-execution`
- `npm run test:bybit-certification`
- `npm run build`
- Final one-hour cockpit soak passed all readiness, heap, DOM, resource and frame thresholds across 120 samples.

Remaining:

- Full chart dirty layers, batched candle geometry and transferable DOM matrices remain profiling-led future work.
- No 4h, 8h or 12h pass is claimed.

## Future Work Log

Use this format for every future phase, chapter, or major bug sprint.

```md
## YYYY-MM-DD - Title

Status:

Changed:
- ...

Why:
- ...

Files / Systems:
- ...

Validation:
- ...

Remaining:
- ...
```
# 2026-07-13 - Phase III Final DOM Pro Refinement

- Added a versioned ten-panel settings registry with migration, presets, per-workspace/symbol persistence, reset, and save-as-default behavior.
- Added panel header cogs, accessible viewport-safe popovers, live panel controls, data-quality badges, and collapsed diagnostics.
- Added the centralized panel cadence scheduler without adding subscriptions, workers, or per-panel timers.
- Stabilized structural depth, wall lifecycle/order, heuristic CVD, DOM metrics, aggregated tape, and clipped flow delta.
- Added deterministic DOM Pro panel tests and retained the Chapter XIV performance regression suite.
- Captured 14 visual-regression states and passed the full one-hour cockpit soak with all bounded-resource checks green.

# 2026-07-14 - Phase IV Chapter I A.I.F.

- Added the native proprietary Auction Intelligence Framework without changing HDLX.
- Added long-history paging through venue adapters, truthful coverage, worker calculation, bounded cache, five production profile lenses, structural node/stability/confluence extraction, projected LVNs, auction events, CHoB lifecycle, optional IMM boundary, chart overlay, settings, summary and timeline.
- Added deterministic A.I.F. tests, a frozen HDLX fixture, 5k-100k bar benchmarks, and Chapter XIV performance gates.
- Absorption remains intentionally blocked until classified flow and persistent depth are available.

# 2026-07-14 - Phase IV Chapter I-A A.I.F. Hotfix

- Removed the detached profile percentage scale and bound all A.I.F. price geometry to the Black chart engine's authoritative transform.
- Added transform revision publication through the existing RAF draw, plot clipping, linear/log transform utilities, and camera-only geometry invalidation.
- Added automatic latest-completed-candle initialization, a 20,000-bar factory horizon, history exhaustion fallback, and persisted horizon presets/custom input.
- Added deterministic transform/anchor/culling coverage and a browser regression proving exact vertical-pan synchronization without analytical recalculation.
- Re-ran A.I.F., Black Core performance, 100,000-bar benchmark, visual regression, and production build gates. No Supabase migration is required.

# 2026-07-14 - Phase IV Chapter I-C A.I.F. Structural LVN Zones

- Replaced isolated future-LVN center lines with formally detected, merged, ranked and lifecycle-aware bounded auction zones.
- Added a neutral structural-zone numerical primitive, A.I.F. stability/projection logic, persistent zone identity, timeline references, chart-native strips, detailed zone metadata and tooltip inspection.
- Rebuilt A.I.F. controls around HDLX-proven profile ergonomics while leaving HDLX source and behavior unchanged.
- Added settings schema v3, presets, import/export, normalization modes, deterministic zone/settings/lifecycle tests, visual regression and 5k-100k performance coverage.
- Build and targeted verification passed. No Supabase migration is required; a fresh one-hour A.I.F.-active soak remains a release-evidence follow-up.

# 2026-07-14 - A.I.F. Profile Switching And Storage Hotfix

- Made A.I.F. settings and research-memory persistence fail-soft under browser quota pressure so storage cannot interrupt worker results or profile switching.
- Reduced browser research snapshots and added compact retry behavior while preserving in-memory calculation.
- Added HDLX-style value-area color and opacity controls and browser assertions for Volume, Delta, TPO, Volatility and Pressure switching.
- Added priority settings persistence that prunes only disposable A.I.F. research caches under quota pressure, then retries the selected mode so reload cannot silently restore an older profile.
- Moved profile-specific controls and truthful data-source descriptions into the open Profile group; menu state, worker output and persisted state are now verified together.

# 2026-07-14 - DOM Pro Final Performance Recovery

- Reproduced the live cockpit freeze with deterministic DOM, Macro, settings, camera, mount and A.I.F. scenarios; baseline p95 reached 354.1 ms while 4,444 DOM nodes accumulated.
- Replaced per-cell React heatmap rendering with one culled canvas and master dirty-frame scheduler.
- Added delta-only reverse worker messages, transferable typed depth inputs, bounded client heatmap history and complete backpressure telemetry.
- Added incremental CVD buckets, safe panel cadences, offscreen/hidden suspension, interaction priority, A.I.F. yielding, adaptive visual quality and a freeze watchdog.
- Added DOM/A.I.F. smoke and long-soak commands plus deterministic panel/performance regression coverage.
- No Supabase migration is required.

# 2026-07-14 - DOM Pro Resizable Workspace And Compact Execution

- Replaced the rigid six-column cockpit geometry with a versioned root/upper/bottom split model, draggable keyboard-accessible separators, constraints, collapse, maximize, factory layouts, custom presets and debounced workspace persistence.
- Set the default bottom row to a compact 30% and made Depth Chart, Liquidity Flow Delta and Execution independently resizable.
- Rebuilt DOM execution as a container-responsive venue-schema ticket with compact Order Type and TIF selectors, separate leverage, account-backed Equity Allocation, live margin/fee/balance preview and existing OMS/EMS/Risk routing.
- Corrected the missing stats-grid track that clipped camera controls and moved wall labels inside measured/clipped liquidity strips.
- Added deterministic layout/presentation tests and expanded browser visual regression states. No Supabase migration is required.

# 2026-07-15 - Bybit External Open-Order Synchronization Hotfix

- Replaced chart-symbol-only open-order reads with paginated account-wide linear/spot snapshots and explicit category health.
- Added deterministic external-order identities, canonical REST/private-stream normalization and verified-empty safety in Black Core order state.
- Corrected the private worker so order updates trigger reconciliation.
- Added account-wide Orders fields, source badges, freshness, manual refresh and current-symbol chart lines.
- Added deterministic synchronization tests and a read-only live certification harness. Live evidence remains operator-gated.

# 2026-07-15 - Bybit Canonical Order Synchronization Hotfix II

- Added one canonical order key across REST reconciliation, portfolio API, Black Core, Orders and chart rendering.
- Added repeated-cursor protection, page/snapshot deduplication, venue-version precedence and duplicate diagnostics.
- Corrected the chart overlay's 44px host-origin displacement while retaining the authoritative linear/log price transform.
- Added a shared chart/table management menu with authenticated Modify, Cancel and inspection; existing-order Chase remains capability-gated because Bybit does not attach native Chase to a standard order.
- Added deterministic identity, stale-update, account-isolation, chart-alignment and menu regression tests. No Supabase migration is required.

# 2026-07-15 - Bybit Duplicate Connection And Disconnect Hotfix

- Identified repeated Supabase account insertion, not page duplication, as the remaining four-row production cause.
- Canonicalized Bybit connections by venue account identity and collapsed legacy credential-duplicate accounts before synchronization and portfolio totals.
- Replaced the empty CEX disconnect adapter with authenticated server deletion and immediate Black Core cleanup.
- Added authoritative account-set pruning and complete sign-out cleanup so disconnected orders cannot remain in Orders or on the chart.
- Made subsequent connects idempotent through deterministic credential references. No Supabase migration is required.

# 2026-07-16 - DOM Pro Aggregated Ladder Depth Repair

- Decoupled the Aggregated DOM Ladder from the Heatmap macro camera, which had collapsed the live venue book into one oversized price bucket in Macro and Full Data views.
- Rebuilt the ladder around actual venue order-book coverage with balanced bid/ask bins, robust queue-size normalization, best-level markers and quantity-backed depth bars.
- Removed duplicate source/bucket accumulation and replaced unavailable opposite-side quantities with an explicit empty state. No other DOM Pro panel or analytical pipeline changed.
