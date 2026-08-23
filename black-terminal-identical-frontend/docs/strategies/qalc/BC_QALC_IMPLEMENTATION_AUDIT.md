# BC-QALC Implementation Audit

Audit baseline: `97767f7cc52d5a5dcbe3b92cf5315990677ae7ac` on the VPS integration branch.

| Platform area | Evidence | Classification | BC-QALC decision |
| --- | --- | --- | --- |
| DOM Pro depth display | `src/modules/dom-pro/marketDepthMemoryClient.ts`, `src/modules/dom-pro/depthHistoryStore.ts` | REUSE for read-only context | It consumes aggregated depth tiles, not a lossless cross-process L2 event stream. It cannot be the QALC sequencer source. |
| Browser Bybit trades | `src/market-data/adapters/bybit.ts` | DEPRECATE as a strategy-runtime source | Browser lifetime and arrival time are unsuitable for persistent Paper automation. No browser data is used by QALC. |
| BCLIF public collector | `server/liquidation-intelligence/collector/worker.ts` | EXTEND in a later shared-gateway chapter | It already subscribes to Bybit trades and L200 depth, but exposes BCLIF-specific derived/chunked state rather than a versioned raw-event fan-out contract. Reusing its current output would lose QALC queue semantics. |
| BCLIF book reconstructor | `server/liquidation-intelligence/sources/bybitOrderBook.ts` | REUSE concepts; do not share mutable state | Its lifecycle is collector-specific. QALC uses an independently tested atomic book until a process-independent canonical stream exists. |
| Market-depth persistence | `server/market-depth`, `supabase/migrations/202607190001_phase5_security_imm_foundation.sql` | REUSE for slow context only | Relational snapshots/rollups are not the event hot path. |
| Structural CVD | DOM Pro and indicator calculation paths | REUSE as an optional later filter | QALC calculates exchange-native taker-signed event CVD from `publicTrade`; it does not substitute candle direction. |
| Bybit private streams | `scripts/bybit-private-stream-supervisor.js` | BLOCKER for any future Live chapter | Not consumed by the current Research worker. Live order/execution reconciliation remains out of scope. |
| OMS / execution API | `server/routes/execution/order.js` | REUSE only in a future separately certified Live chapter | The QALC package contains no import or call into this mutation path. |
| EMS / PositionManager | `src/execution/emsService.ts`, `src/positions/positionManager.ts` | REUSE only for future Live authority | QALC Paper inventory remains isolated and cannot mutate account positions. |
| Strategy Automation Paper ledger | `server/strategy-automation`, `supabase/migrations/202608220001_black_core_strategy_automation.sql` | EXTEND later | The existing candle/alert workflow is not an event-level queue simulator, so QALC keeps a distinct native engine and metadata boundary. |
| Event replay | `server/event-alpha/replay.js`, chart replay code | REWRITE for QALC event semantics | Existing replay does not reproduce every L2/trade event. `server/qalc/replay.ts` reuses the live engine state machine. |
| PostgreSQL / Supabase | self-hosted Supabase migrations and Black Cloud API | REUSE | Only configuration/run/archive/audit metadata belongs in PostgreSQL. Raw events stay in bounded compressed files. |
| Redis / event bus | No reusable Redis/Valkey service or canonical raw L2 fan-out contract in the audited compose | MISSING | The Research deployment uses one QALC socket per symbol, never one per browser or strategy. A global BCLIF/DOM/QALC gateway remains pending. |
| Rust hot path | Rust exists only under `src-tauri`; there is no server-side Rust market-data runtime | MISSING | Node is accepted provisionally because the 20k-event p99 benchmark passes. Soak/resource certification is still required. |
| VPS containers | `infra/black-cloud/docker-compose.yml` | EXTEND | A portless, unprivileged, capped `qalc-worker` Research profile and read-only API state mount are added. |
| Monitoring | Existing Docker health/logging plus QALC telemetry file | EXTEND | QALC records bounded p50/p95/p99/max timing samples and fail-loud state; centralized alerting remains pending. |

## Audit conclusion

There is no existing lossless, process-independent canonical raw Bybit L2/trade bus that QALC can consume without changing event semantics. The initial Research capture therefore uses exactly one QALC public socket per symbol, shared by that symbol's QALC feature/replay/archive consumers. It does **not** open one socket per strategy or browser. This is an explicit temporary limitation: before any Shadow or Live certification, BCLIF, DOM Pro and QALC should converge on a separately versioned canonical market gateway and bounded fan-out transport.

The existing OMS, EMS, broker vault, private streams and PositionManager remain untouched and authoritative. QALC has no live broker mutation path.
