# Architecture

## Current Shape

```text
React UI shell
  src/App.tsx
  src/components/*

Custom chart engine
  src/chart-engine/BlackChartEngine.ts
  src/chart-engine/data/CandleBuffer.ts
  src/chart-engine/types.ts

Native command layer
  src-tauri/src/lib.rs

Black Core platform services
  src/core/registerBlackCore.ts
  src/core/events/marketEvents.ts
  src/market-data/engine/marketDataEngine.ts
  src/connectivity/connectionManager.ts

Exchange and automation contracts
  src/market-data/types.ts
  src/market-data/exchangeRegistry.ts
  src/execution/types.ts
  src/automation/types.ts
```

The current code correctly keeps React as the surrounding application shell while PixiJS owns the
chart canvas. That is the right direction for high responsiveness because pointer movement,
crosshair rendering, candles, volume, heatmap overlays, and axes can update without forcing React
component rerenders.

## Target Layers

```text
App shell
  Navigation, layout, panels, settings, workspace management

Chart engine
  Rendering layers, view state, scale math, drawing primitives, hit testing

Market data pipeline
  Exchange adapters, websocket sessions, candle aggregation, replay buffers,
  normalized candles/trades/order books/funding/open interest/liquidations

Indicator runtime
  Python execution, sandbox policy, package policy, typed inputs/outputs

Strategy and alert engine
  Conditions, backtesting, webhook routing, execution simulation

Execution engine
  Account connections, order routing, positions, balances, risk checks, paper/live modes

Persistence
  Layouts, watchlists, templates, indicator parameters, local cache

Community
  Indicator metadata, reviews, signing, versioning, moderation hooks

Native platform shell
  Tauri commands, sidecars, filesystem permissions, packaging, updates
```

## Exchange Adapter Direction

Each exchange should be implemented behind `MarketDataAdapter`, then registered in the exchange
registry. Priority charting adapters are Binance, Bitfinex, OKX, Bybit, and Hyperliquid. The adapter
layer should also cover major venues such as Coinbase, Kraken, Bitstamp, Deribit, Bitget, KuCoin,
Gate.io, MEXC, and BitMEX.

Exchange-specific REST/WebSocket payloads must be normalized before reaching the chart engine:

- Candles
- Trades
- Order book snapshots and deltas
- Funding rates
- Open interest
- Liquidations where available
- Symbol metadata and precision rules

The chart engine should consume normalized app data only.

## IMM Operational Status Rule

Black Core owns Institutional Market Map operational truth.

The authoritative IMM status path is:

```text
Depth Worker
-> Orderbook Integrity Validator
-> Supabase Market Memory Tables
-> IMM Worker Heartbeats
-> server/imm/status-service.js
-> GET /api/imm/status
-> DOM Pro+ / Admin Surfaces
```

DOM Pro+ must consume this status instead of creating duplicate health state. The status service
normalizes worker health, feed freshness, sequence gaps, persistence evidence, replay readiness,
wall symmetry, integrity failures, and data quality into one status model.

DOM Pro+ displays this operational state in its IMM status strip while keeping viewport state local.
The heatmap, volume profile, and depth chart share one price-space camera. Follow mode, free-explore
mode, presets, wheel zoom, drag pan, and fit/center actions must all operate through that shared
camera rather than creating independent panel scales.

Operational records are platform-owned:

- `imm_worker_heartbeats`
- `imm_integrity_events`
- market-depth snapshots, deltas, rollups, walls, events, and statistics

Direct browser reads are intentionally blocked by RLS. Server routes and the worker use the service
role key.

## Performance Telemetry Rule

Black Core owns runtime performance telemetry.

The performance path is:

```text
Pixi chart ticker / DOM Pro render loop / browser PerformanceObserver
-> src/performance/performanceMonitor.ts
-> throttled performance.metric events
-> hidden Performance HUD
-> docs/performance baseline and stress reports
```

High-frequency frame samples stay in memory and are summarized into FPS, average frame time, p99
frame time, worst frame, dropped frames, long tasks, heap, DOM node count, and event-bus diagnostics.
Do not publish every market tick or animation frame into the event bus.

The Performance HUD is hidden by default and toggled with `Ctrl+Shift+P`. It exists for admin and
engineering profiling, not as part of the normal trading surface.

## Python Indicator Runtime Direction

Python should not run inside the React UI thread. Treat indicators as isolated jobs with a stable
input/output protocol:

- Input: symbol, timeframe, candle arrays, optional order-book snapshots, and user parameters.
- Output: typed plots, markers, alerts, diagnostics, and optional debug metadata.
- Execution: background worker or native-side runtime, with cancellation and time limits.
- Security: no file, network, or process access by default for community indicators.
- Portability: keep the indicator contract independent from any single Python embedding strategy.

For desktop MVP, a managed Python sidecar is the simplest route. For iPad and iPhone, packaging and
sandbox restrictions need a dedicated validation spike before relying on native Python libraries.

Python indicators should not directly place live trades. They should return plots, markers, alerts,
and signals. The strategy engine can consume those signals and decide whether an action is allowed.

## Trading and Automation Direction

Authenticated trading should be isolated from chart rendering, indicator execution, and generic
webhook handling:

- Store API keys outside React state and browser local storage.
- Default to read-only and paper trading before live order placement.
- Require explicit scopes for account reads, order placement, cancellation, and modification.
- Run every automated order through a risk guard.
- Keep full logs for trigger, action, decision, exchange response, and timestamp.
- Treat inbound webhooks as untrusted until signed and validated.

## Developer Mainnet Validation Rule

Mainnet validation is a controlled developer workflow, not a bypass.

Hyperliquid mainnet orders can be submitted only when all of the following are true:

- The selected connection is a Hyperliquid protocol connection from the Black Core Connection Manager.
- MetaMask/master wallet is connected.
- The server has an encrypted active agent credential for the account.
- Hyperliquid agent authorization validates.
- Metadata is loaded.
- Nonce state is ready.
- The relay is enabled.
- The selected network is mainnet.
- The account reports trading permission.
- The user enabled session-scoped Developer Mainnet Validation Mode by typing the explicit confirmation phrase.
- Server env explicitly enables mainnet validation with `HYPERLIQUID_MAINNET_VALIDATION_ENABLED=true`.

The browser switch is stored only in `sessionStorage` and is off by default. It only allows the existing
OMS -> EMS -> Risk -> Broker Router -> Protocol Router -> Relay path to proceed. It must never create
a second execution path.

## Phase III Connection Rule

The Black Core Connection Manager is the single runtime source of truth for connected accounts.

The following modules must consume connection diagnostics from it instead of keeping independent
broker or wallet account stores:

- Positions
- Unified Execution Ticket
- OMS / EMS routing
- Broker Router
- Portfolio Statistics
- Allocation Engine
- Investment Groups

Wallets such as MetaMask and Phantom are signer connections. They do not become futures venues until
a protocol adapter reports executable perpetual capabilities.

## Phase III Chapter XI Venue Certification Rule

Every visible venue must have a truthful certification record.

Certification records live in `src/connectivity/venueRegistry.ts` and classify each venue as:

- full-live
- read-only
- market-data-only
- signer-only
- unavailable

The connection UI, adapters, and server credential routes must consume this truth layer. A venue may
not store credentials, show execution-ready status, or expose order controls unless its certification
and dynamic connection state both allow that capability.

Public candles are not account connectivity. Read-only account sync is not order execution. Wallet
signature capability is not derivatives execution. Unsupported actions must fail closed with an
explicit reason.

Chapter XII expands the certification workflow for Bybit. Bybit now has server diagnostics,
metadata-backed venue validation, private-stream client architecture, snapshot reconciliation,
server-backed order placement, order management, TP/SL protection, explicit leverage/margin/position
mode controls, and deterministic certification tests. These capabilities still do not make Bybit
production-certified. Certification requires a long-running private-stream worker, reconnect
reconciliation evidence, and recorded tiny-order mainnet validation in the Chapter XI validation
ledger.

Bybit controlled validation fails closed unless the server env enables it, the account and symbol are
allowlisted, the max notional is configured, an admin explicitly enables the account, the browser
session enables Developer Mainnet Validation Mode, and each live action carries the `LIVE`
confirmation. Normal order placement must never silently switch margin or position mode.

Chapter XII-B adds the operator certification runner. `npm run certify:bybit-mainnet` verifies
preflight, private-stream health, account snapshots, metadata, and allowlists before any live order.
It then executes the certification sequence one step at a time through the deployed API and records
evidence. The venue registry must not be promoted until this report and Supabase evidence prove the
full path. Browser submissions now route centralized-exchange orders through local OMS, EMS, Risk,
and Broker Router before the server-backed Bybit execution adapter is called.

Chapter XII-C adds operational activation tooling around that runner. The Bybit private-stream worker
must run as a supervised persistent process, while Vercel serverless routes expose non-secret runtime
status by reading Supabase health snapshots. Certification decisions are deterministic and live in
`server/exchanges/bybit-certification.js`; a venue can only become certified when mandatory stages and
persisted evidence pass. `.env.bybit-mainnet.example` and `docs/BYBIT_MAINNET_ENVIRONMENT_SETUP.md`
define the production environment boundary. No browser or chart component may bypass the existing
OMS -> EMS -> Risk -> Broker Router -> server route flow.

Vercel deploys on the Hobby plan, so API entrypoints are consolidated where route families share an
execution domain. `api/exchange-accounts/[...path].js` and `api/execution/[...path].js` preserve the
existing external URLs while delegating to server-owned route modules under `server/routes/`. This
keeps the function count below the platform limit without introducing alternate execution paths.

## Proprietary Feature Entitlements

Black Terminal gates proprietary modules through the shared capability registry:

- DOM Pro+ requires `proprietary.domPro`, available to Enterprise and Admin accounts.
- HDLX Profile requires Admin access or an explicit Admin Panel grant for the `volumeProfile` indicator.
- Saved workspaces are sanitized on load and during live permission polling so revoked proprietary indicators turn off automatically.
- The DOM Pro+ cockpit component is code-split and mounted only after the entitlement check passes.

Client-side gating prevents normal retail access and accidental feature exposure. Truly secret
algorithms must continue moving behind server-side workers or private API routes because any
browser-delivered JavaScript should be treated as inspectable by a determined user.

## Phase III Position Rule

OMS owns orders.

EMS owns execution.

Position Manager owns positions.

Protection relationships belong to Position Manager, not OMS. A take-profit, stop-loss, trailing
stop, break-even level, or future OCO group is position lifecycle state even when one or more
exchange orders are required to enforce it.

## Near-Term Engineering Decisions

- Keep `src/chart-engine` framework-independent except for PixiJS.
- Move exchange-specific code into adapters instead of the chart component.
- Keep account/execution adapters separate from market-data adapters.
- Keep Python indicators as analysis modules; strategy automation decides whether to trade.
- Keep generated market data and sample indicators under `examples/`.
- Add real tests once scale math, candle aggregation, and indicator protocol become shared code.
- Prefer typed arrays for large candle/history buffers when the mock feed is replaced.
