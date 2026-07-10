# Platform Build Manual

This document explains how Black Terminal is built today and how its major systems fit together.

## Stack

- Frontend: React 18, TypeScript, Vite.
- Rendering: custom PixiJS chart engine.
- Desktop shell: Tauri 2 with Rust command hooks.
- Backend runtime: Vercel API routes under `api/`.
- Database and auth: Supabase.
- Icons and UI primitives: lucide-react plus project CSS in `src/styles/`.
- Package baseline: Node 20+, npm 10+.

## Boot Flow

1. `src/main.tsx` imports the global theme and calls `registerBlackCoreServices()`.
2. `src/core/registerBlackCore.ts` registers Black Core services and connectivity adapters.
3. `src/App.tsx` mounts the terminal shell, navigation, chart workspace, scanner, strategy lab, positions, and portfolio manager surfaces.
4. `src/components/PixiBlackChart.tsx` owns the chart React bridge and creates `BlackChartEngine`.
5. `src/chart-engine/BlackChartEngine.ts` owns canvas rendering, chart layers, indicators, viewport state, and chart interaction.

## Black Core

Black Core is the platform layer that keeps major systems from talking to each other through ad hoc UI state.

Core files:

- `src/core/blackCore.ts` - shared event bus and service registry exports.
- `src/core/registerBlackCore.ts` - startup registration for core services.
- `src/core/events/marketEvents.ts` - typed event map for market, portfolio, execution, performance, and connectivity events.
- `src/core/services/serviceRegistry.ts` - runtime service lookup.
- `src/core/platform/platform.ts` - runtime platform boundary.
- `src/core/secureCredentialStore.ts` - credential handoff boundary for secure storage.

Registered services include market data, connections, broker framework, wallet framework, portfolio state, orders, notifications, and performance monitoring.

## Chart Engine

The chart is custom rendered through PixiJS rather than TradingView Lightweight Charts.

Key areas:

- `src/chart-engine/` - rendering engine, candle buffer, heatmap models, volume profile models, and shared chart types.
- `src/components/PixiBlackChart.tsx` - React wrapper, toolbar integration, chart event handling, and execution ticket entry point.
- `src/market-data/engine/marketDataEngine.ts` - facade used by chart-facing code to retrieve normalized adapter data.

The intended rule is simple: React owns layout and controls; PixiJS owns high-frequency chart rendering.

## Market Data

Market data is normalized behind adapter contracts.

Key areas:

- `src/market-data/types.ts` - normalized exchange, symbol, candle, trade, order book, funding, open interest, and transport types.
- `src/market-data/marketCatalog.ts` - supported venue catalog.
- `src/market-data/engine/` - Black Core Market Data Engine facade.
- `src/market-data/cache/` - normalized market cache.
- `src/market-data/websocket/` - shared WebSocket manager.
- `src/market-data/adapters/` - venue-specific adapter implementations.

The chart and UI should consume normalized market data only. Venue-specific payload shape belongs inside adapters.

## Connectivity

Phase III introduced the Black Core Connection Manager as the single runtime source of truth for connected accounts.

Key areas:

- `src/connectivity/types.ts` - universal connection, health, permission, capability, and adapter contracts.
- `src/connectivity/connectionManager.ts` - register, connect, disconnect, reconnect, heartbeat, diagnostics, subscriptions, and event publishing.
- `src/connectivity/connectionEvents.ts` - connection event model.
- `src/connectivity/connectionAudit.ts` - in-memory audit buffer.
- `src/connectivity/registerConnectivity.ts` - adapter registration.
- `src/connectivity/adapters/` - centralized exchange and wallet adapters.

Consumers must subscribe to the Connection Manager instead of owning duplicate broker or wallet account state.

Current consumers:

- Positions connection panel.
- Unified Execution Ticket account selector.
- Broker Router account resolution.
- Future portfolio statistics, allocation engine, and investment groups.

## Execution

Execution is split into OMS, EMS, broker routing, and API execution bridge.

Key areas:

- `src/execution/types.ts` - normalized execution request, order lifecycle, sizing, destination, and report contracts.
- `src/execution/omsService.ts` - internal order creation and lifecycle state transitions.
- `src/execution/emsService.ts` - validation, risk decision, allocation hook, broker routing, reports, and audit publishing.
- `src/execution/brokerRouter.ts` - resolves execution route through the Black Core Connection Manager.
- `src/execution/components/UnifiedExecutionTicket.tsx` - shared execution ticket.
- `api/execution/order.js` - Vercel execution endpoint.
- `api/execution/cancel.js` - Vercel cancel endpoint.

Architecture rule: manual trading, chart trading, strategy execution, replay execution, AI execution, and capital allocation must route through the same OMS / EMS architecture. No parallel execution path should be added.

## Portfolio And Positions

Phase III separated live execution from capital management.

Positions:

- Owns broker and wallet connectivity UI.
- Owns live positions and orders surface.
- Owns the execution dock.
- Feeds connections into the Black Core Connection Manager.

Portfolio Manager:

- Owns capital management, portfolio statistics, risk, performance, and investment group discovery.
- Consumes real synchronized portfolio/account data.
- Must not own broker connection state or submit direct exchange orders.

Key files:

- `src/modules/portfolio-manager/components/PortfolioManagerPage.tsx`
- `src/portfolio/`
- `src/positions/`
- `src/risk/`
- `src/copyTrading/`

Chapter IV adds the Black Core Position Manager:

- `src/positions/positionManager.ts`
- `src/positions/types.ts`

Position Manager owns active positions, protection state, timeline, health, notes, and tags. Filled
EMS reports are promoted into managed positions. UI surfaces must consume this manager rather than
creating independent position lifecycle state.

## Backend And Supabase

Backend code is hosted as Vercel API routes and shared server helpers.

Routes:

- `api/exchange-accounts/connect.js` - creates account records and stores credential references.
- `api/exchange-accounts/[accountId].js` - deletes connected accounts.
- `api/portfolio/snapshot.js` - loads accounts, balances, positions, orders, and risk controls.
- `api/execution/order.js` - validates and places/simulates orders.
- `api/execution/cancel.js` - cancels execution orders.

Server helpers:

- `server/portfolio-api.js` - Supabase auth, validation, account loading, and risk helpers.
- `server/exchanges/bybit.js` - Bybit synchronization and order placement bridge.
- `server/market-depth/` - Black Core Market Depth Memory, compression, wall lifecycle, replay, tiles, alerts, retention, and collector diagnostics.
- `scripts/market-depth-worker.js` - long-running exchange depth collector.
- `scripts/market-depth-supervisor.js` - persistent supervisor that restarts the depth worker after fatal stale-feed exits or process failures.

Expected Supabase domains:

- Users and sessions through Supabase Auth.
- Exchange accounts and encrypted credential references.
- Balances, positions, execution orders, risk controls, and audit logs.
- Connectivity connection registry and connectivity audit events for Phase III persistence.

All SQL migrations must be logged in `SUPABASE_MIGRATIONS.md`.

The market-depth collector must run outside Vercel serverless because it owns continuous exchange WebSocket sessions. Use `npm run depth:worker:supervise` in a persistent Node runtime and configure `SUPABASE_SERVICE_ROLE_KEY`, `MARKET_DEPTH_SYMBOLS`, and the market-depth retention/stale-feed environment variables.

## Wallets And DEXes

Wallet adapters currently connect browser wallets and report wallet signer capabilities.

MetaMask and Phantom are not perpetual execution venues by themselves. They can sign transactions, but futures execution requires a protocol adapter such as Hyperliquid, GMX, dYdX, or another perpetual DEX router.

Capability detection controls the UI:

- Wallet signer only: wallet connected, router required for execution.
- Centralized exchange: spot, limit, conditional, leverage, positions, balances, orders, and private/public streams depending on adapter support.
- Future DEX adapter: should report swap and/or perpetual capabilities only when real protocol execution is implemented.

Protocol framework files:

- `src/protocols/types.ts`
- `src/protocols/protocolRouter.ts`
- `src/protocols/hyperliquidAdapter.ts`
- `src/protocols/registerProtocols.ts`

Hyperliquid is registered as a protocol adapter behind MetaMask signing. The adapter reports
perpetual capabilities but live order placement remains blocked until the server-side signing and
order relay is implemented.

## Security Boundaries

- Never store plain API secrets in frontend localStorage.
- Browser UI receives account status and credential references, not raw secrets.
- Withdrawal permissions should be warned against and rejected where possible.
- Live order placement must pass through backend auth, permission checks, risk checks, and audit.
- Webhooks and strategy automation must be treated as untrusted until signed and validated.

## Local Commands

```bash
npm install
npm run dev
npm run typecheck
npm run build
npm run depth:worker
npm run depth:worker:supervise
npm run check:rust
npm run check
npm run tauri:dev
npm run tauri:build
```

## Definition Of Done For Future Platform Work

- Code is implemented through the correct architectural layer.
- No duplicate source of truth is introduced.
- TypeScript build passes.
- Relevant docs are updated.
- Supabase migrations are recorded when schema changes.
- Git commit explains the architectural change, not only the UI symptom.
