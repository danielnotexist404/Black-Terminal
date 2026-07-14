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
```

`npm run check` runs TypeScript and Rust checks. Use it before packaging or larger refactors.
`npm run depth:worker:supervise` is the recommended local/persistent command for the Black Core Market Depth Memory collector because it restarts the worker after stale-feed exits or process failures.
`npm run depth:verify` checks persisted IMM data quality and returns a non-zero exit code on serious operational failures.
`npm run perf:baseline` writes the current Chapter XIV performance footprint to `docs/performance/latest-baseline.md` and `.json`.
`npm run perf:stress` requires `PERF_STRESS_URL` and writes a long-session JSONL log under `docs/performance/`.
`npm run test:performance` verifies registration, cleanup, coalescing and retention invariants.
`npm run perf:soak -- --hours=1` launches a local production preview, exercises safe cockpit interactions, and writes a JSONL report without submitting orders.

Bybit diagnostics and controlled live validation use:

```bash
BYBIT_MAINNET_VALIDATION_ENABLED=true
BYBIT_MAINNET_VALIDATION_ADMIN_EMAILS=owner@example.com
BYBIT_MAINNET_ALLOWED_CONNECTIONS=<exchange_accounts.id>
BYBIT_MAINNET_ALLOWED_SYMBOLS=BTCUSDT
BYBIT_MAINNET_MAX_NOTIONAL_USD=5
```

Keep these unset unless deliberately validating tiny live orders through the existing OMS/EMS/Risk path.
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

Settings schema version 3 persists the automatic calculation horizon and structural-zone controls. New workspaces default to 20,000 completed bars; supported presets are 2,000, 5,000, 10,000, 20,000, 50,000 and 100,000 bars plus a bounded custom value. Camera transform state is transient and is never persisted as analytical state.

Chapter I-C adds `bt_aif_zone_memory:<workspace>:<venue-symbol-timeframe>`. Zone memory is capped at 160 records and reconciles small profile-bucket shifts without changing research identity. The original node/event memory remains separately bounded. Built-in presets do not modify HDLX; custom A.I.F. preset JSON is stored under `bt_aif_custom_preset`.
