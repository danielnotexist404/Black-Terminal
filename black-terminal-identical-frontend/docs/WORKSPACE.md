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
npm run perf:baseline
npm run perf:stress
```

`npm run check` runs TypeScript and Rust checks. Use it before packaging or larger refactors.
`npm run depth:worker:supervise` is the recommended local/persistent command for the Black Core Market Depth Memory collector because it restarts the worker after stale-feed exits or process failures.
`npm run depth:verify` checks persisted IMM data quality and returns a non-zero exit code on serious operational failures.
`npm run perf:baseline` writes the current Chapter IX performance footprint to `docs/performance/latest-baseline.md` and `.json`.
`npm run perf:stress` requires `PERF_STRESS_URL` and writes a long-session JSONL log under `docs/performance/`.

Bybit diagnostics and controlled live validation use:

```bash
BYBIT_MAINNET_VALIDATION_ENABLED=true
```

Keep it unset unless deliberately validating tiny live orders through the existing OMS/EMS/Risk path.

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

## Current Gaps

- Market data has a Black Core adapter foundation, but more venue paths still need production hardening.
- Exchange adapters are now certification-gated. Bybit is read-only account validation, most CEX venues are market-data-only, wallets are signer-only, and unsupported protocol/institutional adapters stay deferred until real implementations exist.
- Indicator execution is documented and typed but not implemented.
- Account trading has Vercel/Supabase and Bybit foundations, but more broker adapters and DEX protocol adapters are still required.
- Hyperliquid has a server relay and controlled mainnet validation guard, but production-ready status requires real testnet and small-order mainnet validation evidence.
- Chart rendering is custom, but candle geometry is still immediate-mode drawing rather than
  batched geometry.
- There are no automated tests yet for scale math, candle buffers, or protocol validation.
- Tauri permissions and content security should be tightened before external data or community
  content ships.
