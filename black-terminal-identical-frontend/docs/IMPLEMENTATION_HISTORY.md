# Implementation History

This file records what has been built so far and what must be recorded going forward.

## Current Git Milestones

Recent pushed commits:

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
