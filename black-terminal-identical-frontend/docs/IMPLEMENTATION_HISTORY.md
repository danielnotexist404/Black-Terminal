# Implementation History

This file records what has been built so far and what must be recorded going forward.

## Current Git Milestones

Recent pushed commits:

- Current - Polish DOM Pro+ cockpit rendering and viewport controls.
- Current - Consolidate Vercel API route dispatchers for production deploy.
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
- Scoped the central heatmap to the selected visible range so institutional mode shows balanced buy/sell radar around current price instead of drifting only toward distant upside history.
- Aligned Volume Profile with the heatmap viewport and added hover inspection.
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
