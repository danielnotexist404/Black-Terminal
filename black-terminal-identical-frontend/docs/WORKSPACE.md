# Workspace Setup

## Local Toolchain Observed

- Node: v22.18.0
- npm: 11.5.2
- Rust: 1.94.0
- Cargo: 1.94.0
- Python: 3.13.13

## First Run

```bash
npm install
npm run dev
```

Liquidation Intelligence verification:

```bash
npm run test:liquidation-heatmap
npm run test:bclif-operational-clarity
npm run test:bclif-persistence-security
npm run test:bclif-client-contracts
npm run test:bclif-collector-contracts
npm run benchmark:bclif-operational
npm run benchmark:bclif-collector
npm run test:bclif-visual
npm run typecheck
npm run build
```

The deterministic visual fixture is localhost-only, query-gated, and labeled `SYNTHETIC_TEST`; normal runtime requires a Bybit linear symbol and public network access. Chapter III-C2 owns 21 full-resolution baselines (seven truth/display cases at three viewports). Golden generation is deliberately non-passing until a later normal comparison promotes the manifest to `CERTIFIED`. Collector build/deploy/status/drain/restart/rollback/certify/soak commands and their host prerequisites are listed in `liquidation/BCLIF_DEPLOYMENT_RUNBOOK.md`. Neither BCLIF migration is applied by an npm or deployment command.

Open the Vite URL shown in the terminal for browser development.

For the native desktop shell:

```bash
npm run tauri:dev
```

## Checks

```bash
npm run typecheck
npm run check:rust
npm run check
npm run depth:worker
npm run depth:worker:supervise
npm run depth:verify
npm run bybit:private-stream
npm run bybit:private-stream:supervise
npm run bybit:private-stream:status
npm run verify:bybit-infrastructure
npm run perf:baseline
npm run perf:stress
npm run test:performance
npm run perf:soak -- --hours=1
npm run test:bybit-certification
npm run certify:bybit-mainnet
npm run test:phase5-chapter2
npm run test:persistent-connectivity
npm run security:verify-migrations
npm run test:kioseff
npm run benchmark:kioseff
```

`npm run check` runs TypeScript and Rust checks. Use it before packaging or larger refactors.
`npm run test:phase5-chapter2` runs the Black Cloud, broker, follower, mandate, reconciliation, and
persistent-connectivity contract suites. These are local contracts, not live broker certification.

For a testnet worker, provision `.env.black-cloud` from `.env.black-cloud.example` through the host's
secret manager, then build `Dockerfile.black-cloud` or use `docker-compose.black-cloud.yml`. Readiness
is `GET /health/ready`; Prometheus metrics are `GET /metrics`. Never expose the health port publicly
without TLS, authentication, and network controls.
`npm run depth:worker:supervise` is the recommended local/persistent command for the Black Core Market Depth Memory collector because it restarts the worker after stale-feed exits or process failures.
`npm run depth:verify` checks persisted IMM data quality and returns a non-zero exit code on serious operational failures.
`npm run perf:baseline` writes the current Chapter XIV performance footprint to `docs/performance/latest-baseline.md` and `.json`.
`npm run perf:stress` requires `PERF_STRESS_URL` and writes a long-session JSONL log under `docs/performance/`.
`npm run test:performance` verifies registration, cleanup, coalescing and retention invariants.
`npm run perf:soak -- --hours=1` launches a local production preview, exercises safe cockpit interactions, and writes a JSONL report without submitting orders.
`npm run test:kioseff` runs data, Pine-kernel, canonical-state, engine, worker, parity-harness,
rendering, platform, and operational regression contracts. It proves deterministic internal behavior;
it does not approve TradingView parity. `npm run benchmark:kioseff` exercises the bounded worker path.

## Kioseff Parity Workspace State

- Production calculation: dedicated TypeScript Web Worker; Python is offline validation-only.
- Active mode: `pine-compatibility`; `black-core-enhanced` is present but fail-closed.
- Fixture source contract: `tests/fixtures/kioseff-stop-loss-clustering/`.
- TradingView approval boundary: `tests/golden/kioseff/manifest.json`.
- Current certification: `pending-reference`; no approved TradingView golden snapshots exist.
- Camera pan/zoom affects projection and optional display-domain selection only, never worker input.
- Use the collapsed Kioseff parity diagnostics panel to record venue, symbol, timeframes, coverage,
  engine/source versions, settings/data/cluster hashes, rebuild time, and readiness state.

Bybit diagnostics and controlled live validation use:

```bash
BYBIT_MAINNET_VALIDATION_ENABLED=true
BYBIT_MAINNET_VALIDATION_ADMIN_EMAILS=owner@example.com
BYBIT_MAINNET_ALLOWED_CONNECTIONS=<exchange_accounts.id>
BYBIT_MAINNET_ALLOWED_SYMBOLS=BTCUSDT
BYBIT_MAINNET_MAX_NOTIONAL_USD= # optional; unset uses live account-margin capacity
```

The validation enablement and allowlists remain deliberate production controls. Keep a positive notional value only when an operator-wide ceiling is required; an unset value delegates sizing to synchronized available margin, venue rules and per-account risk controls through the existing OMS/EMS/Risk path.
Persistent Bybit private streams also need:

```bash
BYBIT_PRIVATE_STREAM_RUNTIME_ENABLED=true
BYBIT_STREAM_ACCOUNT_ID=<exchange_accounts.id>
BYBIT_STREAM_SYMBOL=BTCUSDT
npm run bybit:private-stream:supervise
```

The live certification runner is operator-only:

```bash
BYBIT_CERTIFY_ACCOUNT_ID=<exchange_accounts.id>
BYBIT_CERTIFY_API_BASE_URL=https://<deployment-host>
BYBIT_CERTIFY_USER_TOKEN=<short-lived-user-jwt>
BYBIT_CERTIFY_SYMBOL=BTCUSDT
npm run certify:bybit-mainnet
```

Do not run it as CI. It requires typed `LIVE BYBIT MAINNET` activation, typed `LIVE` before exposure-changing stages, and can submit real mainnet orders.

Before running it, verify infrastructure:

```bash
npm run verify:bybit-infrastructure
npm run bybit:private-stream:status
```

For controlled Hyperliquid live validation, keep mainnet disabled unless the relay environment is
intentionally configured:

```bash
HYPERLIQUID_RELAY_ENABLED=true
HYPERLIQUID_MAINNET_VALIDATION_ENABLED=true
```

The browser still requires session-scoped Developer Mainnet Validation Mode before any mainnet order
can pass through the Hyperliquid protocol adapter.

## Packaging

```bash
npm run tauri:build
```

The app currently targets desktop packaging through Tauri. Mobile packaging should be treated as a
separate milestone because Python indicator execution, local storage, and background networking
need platform-specific validation.

## Directory Guide

```text
src/
  App.tsx                     Main application layout
  chart-engine/               PixiJS chart engine and candle types
  components/                 React panels around the chart
  automation/                 Strategy and webhook automation contracts
  data/                       Mock market data
  execution/                  Account and order execution contracts
  indicator-runtime/          Shared indicator protocol types
  lib/                        Frontend integration helpers
  market-data/                Exchange adapter contracts and registry

src-tauri/
  src/lib.rs                  Tauri command layer

docs/
  README.md                   Documentation index and update rules
  PROJECT_BRIEF.md            Product intent and principles
  PLATFORM_BUILD_MANUAL.md    End-to-end platform build manual
  IMPLEMENTATION_HISTORY.md   Chronological engineering record
  ARCHITECTURE.md             Current and target architecture
  EXCHANGE_AUTOMATION.md      Exchange data, trading, and webhook strategy plan
  PYTHON_INDICATORS.md        Indicator runtime contract
  SUPABASE_MIGRATIONS.md      Supabase schema migration ledger
  ROADMAP.md                  Suggested milestone sequence

examples/
  indicators/python/          Example Python indicator scripts
```

## Chapter XIII Workspace State

- Venue-native execution schemas: `src/execution/venueExecutionSchema.ts`
- Execution algorithm truth registry: `src/execution/executionAlgorithmRegistry.ts`
- Deterministic ticket tests: `scripts/venue-execution-tests.js`
- Bybit Market, Limit, Conditional, Chase Limit, TWAP, Iceberg and POV controls are schema-driven and venue-native.
- Active Bybit strategies synchronize through REST and can be stopped from the execution ticket; private strategy events are normalized for the future persistent worker.
- Runtime/certification controls are collapsed under the Positions connection panel.
- No Chapter XIII Supabase migration is required.

## Current Gaps

Chapter XIV performance workflow:

- Admin `Ctrl+Shift+P` opens the optional Performance HUD. Capture reports contain metrics only and no secrets.
- Keep `VITE_ALLOW_SIMULATED_MARKET_FALLBACK` unset in production; set it only in an explicit simulation environment.
- One-hour and longer soak reports live under `docs/performance/` and must be interpreted alongside the documented hardware/runtime context.

- Market data has a Black Core adapter foundation, but more venue paths still need production hardening.
- Exchange adapters are certification-gated. Bybit has venue-native order routing but remains partially certified pending live evidence; most CEX venues are market-data-only, wallets are signer-only, and unsupported protocol/institutional adapters stay deferred.
- Indicator execution is documented and typed but not implemented.
- Account trading has Vercel/Supabase and Bybit certification foundations, but Bybit is not production-certified until the private-stream worker and tiny live validation evidence are recorded. More broker adapters and DEX protocol adapters are still required.
- Hyperliquid has a server relay and controlled mainnet validation guard, but production-ready status requires real testnet and small-order mainnet validation evidence.
- Chart rendering is custom, but candle geometry is still immediate-mode drawing rather than
  batched geometry.
- Bybit adapter certification has deterministic tests. Scale math, candle buffers, and broader protocol validation still need automated tests.
- Tauri permissions and content security should be tightened before external data or community
  content ships.
# DOM Pro Workspace Presets

Scalper, Intraday, Institutional, and Macro now coordinate per-panel presets through the DOM panel registry. Selecting a global preset changes panel defaults once; subsequent panel-cog changes are retained as explicit user overrides for that workspace/symbol.
# A.I.F. Workspace State

A.I.F. settings use `bt_aif_settings:<workspace>:<venue-symbol-timeframe>`. Bounded node/event research memory uses `bt_aif_memory:<workspace>:<venue-symbol-timeframe>`. Removing or hiding the indicator suspends rendering and disposes the dedicated worker; persisted preferences remain for the next mount.

Settings schema version 4 persists the automatic calculation horizon, structural-zone controls, and value-area appearance. New workspaces default to 20,000 completed bars; supported presets are 2,000, 5,000, 10,000, 20,000, 50,000 and 100,000 bars plus a bounded custom value. Camera transform state is transient and is never persisted as analytical state.

Chapter I-C adds `bt_aif_zone_memory:<workspace>:<venue-symbol-timeframe>`. Zone memory is capped at 48 records; node/event memory is capped at 120/180 records. Both retry compact snapshots and fail soft when local storage is full, so persistence pressure never disables the indicator. Settings are higher priority: on quota pressure, disposable A.I.F. research caches are pruned and the selected mode is retried so it survives reload. Built-in presets do not modify HDLX; custom A.I.F. preset JSON is stored under `bt_aif_custom_preset`.

# DOM Pro Runtime State

DOM settings remain scoped by workspace and market key. Performance mode persists with the existing settings record; adaptive quality and interaction mode are transient. Panel settings writes are debounced and fail soft under storage pressure. Heatmap, worker, tooltip and watchdog diagnostics are bounded runtime state and are not restored as workspace analytics.

DOM Pro layout uses normalized split ratios under `bt:dom-pro-layout:v1:<workspace>:<window>`. Auto-save writes only after resize ends. Custom presets use `bt:dom-pro-layout-preset:<workspace>:<name>`. Collapse and split ratios persist; temporary maximize state does not. This is browser workspace preference data and requires no Supabase table.

DOM Pro panel settings schema v3 stores Ladder camera and live-coverage presentation under the existing workspace/market key. Camera range itself remains runtime viewport state. In Shared mode, Ladder, Profile and Heatmap receive one `DomProPriceCamera`; reconnect updates depth without replacing the user camera.
# Canonical Order Interaction

Positions Orders and chart overlays derive from the same keyed Black Core order state. Right-click either representation for the shared order-management menu. Chart price lines retain their market price through pan, zoom and linear/log scale changes because screen coordinates are derived from the live chart transform.

# Professional Center Workspace State

Professional Center routes are stored in the URL hash rather than browser-local duplicate profile state. Shareable routes preserve feed, profile handle/tab, individual post and conversation context. Canonical profile, feed and message data remains in Supabase; only transient composer fields, optimistic state and current in-memory entities live in the browser.

Realtime subscriptions are limited to the active conversation and authenticated notification stream and are disposed on navigation. Professional media object URLs used during local preview must be revoked by their owning editor component; persisted media is always represented by an expiring signed URL.

# Black Cloud Workspace State

Black Cloud connection health, lifecycle, control state, mandates, follower plans and incidents are server state. Portfolio Manager refreshes the authenticated status endpoint every 15 seconds while visible and every 60 seconds while hidden. It must not persist or infer execution authority locally. Pause, resume and emergency-stop always call the control plane. Browser disconnect, tab closure and desktop shutdown do not stop a provisioned cloud worker.

Chapter II-D adds safe node health to the same authenticated payload: stable node ID, stale-aware status, heartbeat age, deployment commit, connection/strategy counts, queue depth and clock state. Hostname/IP, image internals, keys and raw cryptographic state remain server-only. The UI reports `OFFLINE` after 45 seconds without heartbeat even if the last database status was `READY`.

## RADAP persistence

Workspace snapshots persist the versioned `auctionProfileSettings` object independently from visibility. The legacy internal key is deliberately retained so the RADAP rename never invalidates an existing workspace. Opening an older workspace migrates missing fields to safe Black Core defaults. Presentation-only edits do not change the calculation hash; engine, scope, source, grid, value-area, and node edits do. Strategy consumers should store the immutable profile version and boundaries rather than a mutable rolling reference.

BC-MEAP 2.0 adds persisted block construction, presentation, cell text/border, normalization, color lifecycle, render budgets, structural density, and zone-extension settings. Legacy aggregate workspaces migrate to the safe Dynamic Blocks + Key Levels presentation and Net CVD where applicable.

Runtime matrix state is not duplicated in local storage. The worker rebuilds it from canonical bars/trades and immutable settings. The chart retains the returned session snapshot array in memory so historical sessions remain visible; the latest snapshot alone supplies legend and diagnostics.

The built-in preset buttons update the same scoped settings record:

- Original Pine;
- CVD Session;
- CVD Macro Matrix;
- Macro Structure;
- TPO Session.

## BCLIF Persistent Workspace State

BCLIF presentation settings remain versioned browser workspace preferences. Historical events, source offsets, cohorts, checkpoints, tiles, coverage, and calibration are never stored in workspace state. When the protected collector is available, the client holds only a bounded verified in-memory tile cache keyed by venue, symbol, horizon, tile/model/schema version, and checksum.

Workspace restoration cannot override entitlement or model authority. A revoked user cannot reactivate BCLIF from an older workspace. Persistent-node history and browser-session history are never merged; browser fallback is visibly marked persistence off and is discarded with the session. The deterministic fixture is available only in explicit local test mode.

Chapter III-C3 settings schema 3 persists provenance visibility, cohort birth markers, OI materiality method/floors, and isolated/cross/unknown contribution caps. These are model/presentation preferences only; cohort inventory, lifecycle events, mass ledgers, source offsets, canonical OI intervals, and field tiles remain runtime or protected collector state. Chart timeframe and viewport are never persisted as model inputs. Provenance mode is disabled by default.
