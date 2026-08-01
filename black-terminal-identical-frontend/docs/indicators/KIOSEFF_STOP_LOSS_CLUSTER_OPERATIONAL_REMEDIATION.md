# Kioseff Stop Loss Clustering Operational Remediation

**Date:** 2026-08-01

**Configuration:** Bybit linear perpetual · BTCUSDT · 1H · 5,000 bars · VAE Lower · 1m

**Status:** Live data/worker/render pipeline verified; authenticated visual acceptance remains operator-gated

## 1. Exact first broken pipeline stage

The first failed stage was aggregate intrabar coverage, after all one-minute pages had already
downloaded and grouped and before the worker request. Calling `Math.min(...times)` and
`Math.max(...times)` with approximately 300,000 timestamps exceeded the JavaScript argument/call
stack limit and raised `RangeError: Maximum call stack size exceeded`.

## 2. Root cause

The coverage aggregator materialized every intrabar timestamp and spread the entire array into two
function calls. The exception escaped before a `KioseffHistoryResult` existed. The UI catch path
therefore had neither a constructed coverage object nor worker/render output.

The aggregator now computes the first and last timestamp in a bounded iterative pass. Source
hashing was also changed from giant `flatMap`/joined arrays to streaming FNV-1a updates so the same
5K configuration does not create another avoidable large argument/allocation path.

The final validation also exposed a minute-rollover race: request-range construction and grouping
previously sampled the clock separately. The coordinator now freezes one request timestamp for the
entire immutable generation, so a long pagination run cannot invent one additional required minute.

## 3. Why the old UI showed 0/0

The exception occurred before coverage was returned, so the old generic unavailable diagnostic
filled absent `expected` and `actual` values with zero. The remediation defines
`IntrabarCoverage`, carries it through the coordinator/UI, and reserves a genuine 0/0 state for
`missing-request-range`.

## 4. Bybit request behavior

The selected adapter, symbol metadata, and query must all agree on `bybit`, `BTCUSDT`, and
`perpetual`. Bybit uses `/v5/market/kline`, category `linear`, interval `1`, integer-second
application timestamps converted to millisecond REST parameters, and a maximum page size of 1,000.
Pages are requested in bounded groups of six, sorted chronologically, deduplicated
deterministically, retried on explicit rate-limit responses, aborted on supersession, and limited
by a 20-second per-page timeout.

## 5. Timestamp and request-range behavior

Captured Bybit millisecond rows are normalized once to integer seconds. Millisecond application
timestamps and non-minute-aligned intrabars are rejected explicitly. The range starts at the
earliest retained chart-bar open and ends at the last closed one-minute boundary inside the
current chart bar. The current hour is partial and valid; the still-forming minute is not treated
as deterministic history.

## 6. Grouping and coverage behavior

Each minute is assigned to exactly one UTC chart-open bucket using integer-second floor semantics.
Values are ascending. Duplicate, revised/conflicting, missing, and out-of-order timestamps remain
observable. Coverage now reports requested, complete, partial, and empty chart bars; expected and
received intrabars; required/received boundaries; and interval anomaly counts. A provisional final
hour does not fail the closed-history quality gate.

## 7. Progressive warmup and cancellation

Recent pages are fetched first. Deterministic milestones at 100, 500, 1,000, 2,500, and the target
chart-bar count produce labeled warmup snapshots. Each expansion receives a new immutable
`sourceVersion`; the worker is reset and rebuilt atomically rather than merging differently
versioned state. Symbol, timeframe, settings, and effect teardown abort superseded requests.

## 8. Worker delivery

The versioned worker client sends grouped chart bars with nested intrabars, authoritative metadata,
model/granularity/settings, source version, generation, and each bar's closed/provisional identity.
Telemetry records sent/received chart bars and intrabars plus cluster, pane, diagnostic, timing, and
stale-envelope details.

## 9. Render handoff

The canonical snapshot is stored in React and passed to `BlackChartEngine.setKioseffState`. The
dedicated Kioseff Pixi container is separate from liquidation heatmap clearing and redraws through
the normal chart draw path. Renderer metrics expose active/violated zones, pane points, geometry
commands, pooled labels, and container visibility in development.

## 10. Loading state and diagnostics

The fixed ten-second outcome was removed. The UI now reports metadata, chart history, intrabar
history, grouping, worker startup, calculation, rendering, warmup, ready, unavailable, and error
states with real counts. A development-only inspector exposes all source, range, coverage, worker,
canonical, render, generation, diagnostic, and timing fields.

## 11. Full Pine settings and migration

The dedicated panel exposes both models and every original Absorbtion, Time-Scaled Volatility, and
optional field. Pine timeframe values (`1`, `3`, `5`, `15`, `30`, `60`, `240`) map to application
timeframes; unsupported choices are disabled. Heavy/data-cost guidance and scroll behavior are
included. Workspace schema 4 preserves visibility and entitlement, retains the legacy period in
raw workspace data but never reads it for calculation, safely seeds a legacy color once, and fills
all missing fields from Pine defaults.

## 12. Live pipeline evidence

The final read-only public Bybit trace fetched 5,000 hourly candles and 299,991 one-minute candles,
created 5,000 grouped inputs (4,999 complete plus one partial, zero missing), sent all 5,000 chart
bars and 299,991 intrabars to the worker, emitted 398 active clusters and 5,000 pane points, and
built 19,504 render geometry commands in 30.037 seconds. Counts vary slightly with the live
provisional hour.

The captured JSONL evidence is
`docs/indicators/evidence/kioseff-live-bybit-5k-2026-08-01.jsonl`.

## 13. Regression coverage

The operational suite covers the captured Bybit fixture; venue/category and timestamp-unit
rejection; no-range semantics; 59:00/00:00 grouping; the 300,000-intrabar stack regression; partial
current-hour coverage; nonzero worker delivery and render emission; actual legacy workspace
migration; all settings/defaults/conditional groups; model-switch preservation; and settings in a
versioned worker payload. Existing suites cover duplicate/revised/missing/UTC boundaries, stale
generations, both engines, render smoke, and browser/Tauri fixture parity.

## 14. Validation results

- `npm run test:kioseff`: pass (12 suites)
- `npm run build`: pass
- TypeScript: pass
- Security contracts: 27 pass
- Production asset audit: pass, no provider secrets
- Liquidation heatmap regression: pass
- A.I.F. deterministic suite: pass
- Live Bybit 5K pipeline: pass through canonical render model

## 15. Manual browser status

The local and production public landing pages load without an accessible terminal session. The
available in-app browser is stopped at secure access, so authenticated settings screenshots,
visible Pixi acceptance, reload persistence, and interactive pan/zoom checks are not claimed in
this record. They require the operator to sign in to the in-app browser. This does not affect the
captured live REST/worker/render-model verification.

## 16. Remaining parity blockers

Approved TradingView golden snapshots/current-bar revisions remain absent, so exact external Pine
reference certification is still pending. Authenticated browser visual acceptance and a long
mount/unmount soak remain release evidence tasks. Native Tauri compilation still depends on the
host GTK/pkg-config prerequisites documented in the completion report.

## 17. Release identity

The final Git commit and production deployment identity are recorded in the release handoff after
the commit is created and pushed.
