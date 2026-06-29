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
```

`npm run check` runs TypeScript and Rust checks. Use it before packaging or larger refactors.

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
  PROJECT_BRIEF.md            Product intent and principles
  ARCHITECTURE.md             Current and target architecture
  EXCHANGE_AUTOMATION.md      Exchange data, trading, and webhook strategy plan
  PYTHON_INDICATORS.md        Indicator runtime contract
  ROADMAP.md                  Suggested milestone sequence

examples/
  indicators/python/          Example Python indicator scripts
```

## Current Gaps

- Market data is still mocked.
- Exchange adapters are typed and documented but not wired to live REST/WebSocket streams yet.
- Indicator execution is documented and typed but not implemented.
- Account trading and automation are typed and documented but not implemented.
- Chart rendering is custom, but candle geometry is still immediate-mode drawing rather than
  batched geometry.
- There are no automated tests yet for scale math, candle buffers, or protocol validation.
- Tauri permissions and content security should be tightened before external data or community
  content ships.
