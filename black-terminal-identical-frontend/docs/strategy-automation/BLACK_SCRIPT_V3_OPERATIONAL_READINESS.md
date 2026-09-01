# Black Script v3 operational-readiness record

Date: 2026-09-01

## Current verdict

The repository implementation is code-complete for deterministic Black Script v3 execution to direct Bybit futures accounts with `pyramiding=1`. Replay, Backtest and Black Cloud use the same stateful strategy runtime. The server worker pins the owned source version, evaluates confirmed candles, writes one fenced generation and all target commands atomically, and delegates broker mutations to the credential-owning execution worker.

This is not yet a production certification or a Mainnet green light. The new migration has not been applied to the production database, the release has not been deployed to the VPS, and no Bybit Demo canary order has proven the complete venue lifecycle with real credentials. Mainnet validation must remain a separate, explicitly authorized tiny-funds step after Demo evidence passes.

## Implemented execution contract

- Confirmed-bar, non-repainting evaluation with a restart-safe engine checkpoint.
- TradingView-style four-tick historical path, optional complete lower-timeframe Bar Magnifier coverage, and a conservative stop-first mode.
- Market, limit, stop-market and stop-limit entries.
- Market closes and close-then-enter reversals.
- Independent partial exits and bracket expansion into equal-size reduce-only OCO legs.
- OCO sibling resize after a partial fill and cancellation after a complete fill, with scheduled repair when a private-stream event is missed.
- Full-position native Bybit stop/trailing protection.
- Target-specific equity sizing, available-margin bounding, instrument precision, leverage limits, risk mandates and environment isolation.
- Durable deterministic client order IDs, ambiguous-submission lookup, exact ownership checks, retry/reconciliation and version/lease fences.
- Per-target broker-fill barriers. The shared strategy clock cannot continue past an unsettled entry, close, reversal or OHLC-triggered resting fill.
- Up to nine independently synchronized direct broker bindings.
- Browser-closed execution through the Strategy Automation and Black Cloud workers after deployment.

## Deliberately blocked scope

- Black Script Investment Group fanout.
- Black Script Spot execution.
- Partial-position trailing stops.
- Pyramiding above one for direct broker execution.
- Unrestricted Python. Black Script is a bounded deterministic Python/Pine-like DSL; it does not execute imports, network calls, files, processes, recursion or arbitrary packages.
- Tick-perfect TradingView parity when only OHLC or lower-timeframe bars exist. Exact exchange ticks, latency, liquidity, fees and venue fill ordering cannot be reconstructed from candle data.
- Production and Mainnet certification until the deployment and canary stages below are recorded.

## Required release sequence

1. Commit the reviewed source and publish an immutable release SHA.
2. Apply and verify every repository migration, including `202609010001_black_script_cloud_artifacts.sql`, against PostgreSQL.
3. Deploy the frontend, API, Strategy Automation worker, Demo execution worker and connection supervisor from the same SHA.
4. Keep Mainnet execution disabled. Connect one Bybit Demo account with trade-only permissions and no transfer/withdrawal permissions.
5. Run a minimum-size canary covering long entry, all configured partial exits, full close, short entry, reversal, cancel, amend, worker restart and missed-websocket reconciliation.
6. Confirm database orders/fills, Bybit order history, positions, audit events and target synchronization agree for every step.
7. Soak Demo through multiple naturally generated signals with the browser closed.
8. Only after a signed Demo evidence bundle passes, request separate authorization for a minimum-notional Mainnet canary. Never promote Demo evidence alone into a claim of Mainnet certainty.

## Release gates run locally

- `npm run test:strategy-lab-release`
- `npm run build`
- `npm run typecheck`
- `git diff --check`
- JavaScript syntax checks for both cloud workers

These gates provide deterministic offline evidence. They do not substitute for PostgreSQL migration execution, deployed worker health, real credential permissions or exchange acknowledgements.
