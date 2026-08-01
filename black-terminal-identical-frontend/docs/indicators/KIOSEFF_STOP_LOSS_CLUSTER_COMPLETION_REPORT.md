# Kioseff Stop Loss Clustering Completion Report

**Date:** 2026-07-28  
**Durable key:** `volatilityHeatmap`  
**Status:** Implementation complete, parity pending reference certification  
**Baseline commit:** `0f6b9a4c40eda1d97e0986e4a27997d8297dbeb0f`

## 1. Executive implementation summary

Black Terminal now calculates Stop Loss Clustering in a dedicated Web Worker using a renderer-free,
transactional TypeScript port of both original models: `Absorbtion Extremes` and
`Volatility-At-Entry`. VAE supports both `Lower` and `Higher (Heavy)` granularities. The engine
consumes ordered same-venue intrabars, uses authoritative exchange tick metadata, retains active and
violated state, rolls current-bar revisions back to the last committed checkpoint, and emits a
stable canonical snapshot for PixiJS and React.

The implementation is not called fully identical because approved TradingView reference snapshots
have not been supplied.

## 2. Root causes corrected

- The visible chart formerly used a main-thread TypeScript approximation.
- A separate Python approximation was disconnected from the chart and could not establish parity.
- Neither path consumed the exact ordered one-minute/configured-LTF arrays required by the Pine
  models.
- The market contract did not carry authoritative decimal tick size.
- Current-bar mutations were irreversible.
- Violated clusters, qCurves, pane values, summaries, ratios, alerts, and both original models were
  not represented by one canonical state.
- The settings panel was fixed/nonfunctional and exposed the wrong runtime identity.

## 3. Architecture implemented

`venue metadata/history → deterministic normalization/grouping → quality gate → transactional
worker → canonical snapshot/hash → Pixi render adapter + React overlays`

Calculation contains no React, PixiJS, DOM, Canvas, or screen-coordinate state. The general chart
may retain its own cross-exchange history fallback, but the Kioseff path explicitly refuses it.

## 4. Files created

- `THIRD_PARTY_NOTICES.md`
- `reference/pine/kioseff-stop-loss-clustering-v6.pine`
- Three Kioseff indicator audit/implementation/completion documents
- Eleven Kioseff test/benchmark scripts
- `src/market-data/symbolMetadata.ts`
- 29 dedicated files under `src/modules/kioseff-stop-loss-clustering/`
- Fixture README and JSON schema under `tests/fixtures/kioseff-stop-loss-clustering/`

The exact list is available from `git ls-files` in the final commit.

## 5. Files modified

- `package.json`
- `src/App.tsx`
- `src/chart-engine/BlackChartEngine.ts`
- `src/chart-engine/types.ts`
- `src/components/AdminPanel.tsx`
- `src/components/IndicatorLibrary.tsx`
- `src/components/PixiBlackChart.tsx`
- `src/components/UpgradePanel.tsx`
- `src/features/premium.ts`
- Binance, Bybit, and OKX market-data adapters
- `src/market-data/engine/marketDataEngine.ts`
- `src/market-data/types.ts`
- `src/styles/theme.css`
- `docs/README.md`, `docs/PYTHON_INDICATORS.md`, and `docs/IMPLEMENTATION_HISTORY.md`

No OMS, EMS, broker routing, credentials, execution, DOM Pro, A.I.F., portfolio, investor,
messaging, social, Obsidian, migration, or unrelated indicator code was changed.

## 6. Files retired

None were deleted. `VolatilityHeatmapModel.ts`,
`builtin-python-indicators/volatility_at_entry_clusters.py`, and its Python test remain
unreferenced pending TradingView certification. They are not calculation fallbacks.

## 7. Settings migration behavior

`KioseffSettingsV1` preserves Pine defaults and every original input. Existing workspace schema 3
loads unchanged, preserves `volatilityHeatmap` visibility and entitlement, ignores the obsolete
period for calculation, and initializes missing Kioseff values from Pine defaults. Settings are
saved only through the existing versioned workspace snapshot flow.

## 8. Data provenance behavior

Binance uses `PRICE_FILTER.tickSize`/`LOT_SIZE.stepSize`; Bybit uses
`priceFilter.tickSize`/`lotSizeFilter.qtyStep`; OKX uses `tickSz`/`lotSz`. Values remain decimal
strings. The history coordinator requests the configured LTF from the selected adapter only,
normalizes time and revisions, groups exact UTC fixed-duration buckets, detects gaps/conflicts, and
creates an immutable source version. No tick default or synthetic candle exists.

## 9. Worker lifecycle behavior

Messages carry request ID, generation, source version, engine version, and settings version. The
client supports reset, batch calculation, cancellation, supersession rejection, deterministic
errors, pending cleanup, timing, and disposal. Closed state is committed; an open bar is always
replayed from that committed state using its full replacement candle/intrabar array.

## 10. Pine semantic utilities implemented

Explicit `na`/`nz`, finite handling, sign, equality/overlap, history, ATR/RMA, SMA, change,
nearest-rank percentile, median, duplicate-aware searches, sorted insertion, negative indexing,
slice/insert/push/unshift/shift/remove, timeframe/day change, timestamp lookup, market-aware bar
distance, decimal tick indexing, and stable float comparison.

## 11. Absorbtion engine coverage

Custom IQZZ, two independent call-site states, directional LTF volume, violation-first mutation,
volume transfer/subtraction, tick/ATR geometry, active/old records, typical-move similarity,
timestamp qCurves, X-ray/intensity metadata, pane data, alerts, summary, and ratios are implemented.

## 12. VAE lower coverage

Exactly 18 factors, ordered one-minute creation-before-removal, one-time
`SMA(chart ATR(14),50)/4` width freeze, parallel level/active/removed cells, boundary extension,
start search, overwriteable history, daily gaps, 2,500-cell pruning, alternating display selection,
top-five/p95/hot/nearest/totals, pane, alerts, summary, and ratios are implemented.

## 13. VAE higher coverage

Exactly 18 factors, integer tick maps and sorted keys, same-intrabar creation-before-removal,
timing-conditioned removed retention, descending crossed-key removal, daily gaps,
25,000→20,000 pruning, 495/450 display aggregation, top-five/p95/hot/nearest/totals, pane, alerts,
summary, and ratios are implemented.

## 14. Rendering coverage

The dedicated renderer batches geometry into six Graphics objects with explicit clipping,
deterministic layer order, price/time transforms, pooled labels, active/violated geometry, qCurves,
X-ray, hot glows, VAE weak/strong zones, history, and pane output. Pure render selection cannot
mutate canonical hashes.

## 15. Pane/table/ratio coverage

The snapshot includes hit circles, radiating flags, VAE average lines, zero activation data,
nearest-side prices/volumes, Absorbtion typical moves, VAE side percentages, active/violated totals,
and 20-block ratio positions. Invalid/unavailable percentages remain `null`.

## 16. Alert coverage

Both exact titles/messages are emitted:

- `Large Buy-Stop Cluster Triggered`
- `Large Sell-Stop Cluster Triggered`

State records the last alert time per side, and transactional replay removes superseded provisional
alerts before final execution.

## 17. Test inventory

- fixture/license contract
- authoritative metadata
- deterministic intrabar data
- Pine kernel
- canonical state/settings/hash
- both engines/both VAE granularities
- wick/daily-gap/pruning edges
- transactional worker/races/reload
- first-divergence parity harness
- render-model invariance
- browser/Tauri transport parity
- 1,000–20,000-bar performance benchmark

## 18. Test results

`npm run test:kioseff` passes all Kioseff suites. `npm run build` passes TypeScript, 27 security
contracts, Vite production compilation, and the 19-asset secret audit. The existing large main
bundle warning remains non-fatal. The Kioseff worker is emitted separately at 41.75 kB minified.

## 19. Golden fixture status

No TradingView reference snapshots are available. The schema refuses to certify an empty reference,
and the harness returns `pending-reference`/`fixture-incompleteness`, never pass.

## 20. First-divergence status

The harness stops on the first bar/state path difference and distinguishes missing input, quality
rejection, incomplete reference, exact state, float, and rendering-only classes. Exact fields
include IDs, integer keys, sizes, ordering, times, flags, and generations. Non-integer numeric
tolerance is absolute `1e-9` plus relative `1e-9`.

## 21. Performance results

- Higher 1,000: 46.583 ms
- Higher 2,500: 51.572 ms
- Higher 5,000: 83.034 ms
- Higher 10,000: 173.973 ms
- Higher 20,000: 274.844 ms
- Lower 5,000: 110.959 ms
- One post-warmup commit: 22.850 ms
- Twenty provisional replays: 254.915 ms total
- One hundred granularity resets: 3.712 ms

## 22. Memory/resource results

The higher 20,000-bar observed heap delta was 22,876,656 bytes. Its full snapshot payload was
6,239,719 bytes. Renderer ownership is fixed at six Graphics/two Containers. The original 120-text
limit recorded here was raised to Pine's 496-label capacity by the 2026-08-01 parity restoration;
texts remain pooled and reused. Client disposal clears messages/listeners and terminates the worker.

## 23. Browser/Tauri results

Browser/Tauri normalized fixture hash matches at `bd4b5e61600c0620`. The accessible browser smoke
had no console errors. The authenticated chart requires operator credentials for visual acceptance.
`cargo check` reached native GTK bindings but the host lacks `pkg-config` and GObject/GIO discovery;
this is an environment blocker, not a project Rust diagnostic.

## 24. Licensing/attribution actions

The complete supplied Pine source is preserved with its MPL-2.0 header and KioseffTrading copyright.
Translated algorithm files contain MPL notices. `THIRD_PARTY_NOTICES.md` records attribution,
modification, covered-source location, distribution source-availability obligations, non-endorsement,
and the remaining formal legal review.

## 25. Known unavoidable differences

- TradingView golden output is absent, so exact reference equality is unmeasured.
- Production certification currently covers Binance, Bybit, and OKX crypto market metadata.
- Browser chart visuals require an authenticated operator session.
- Native Tauri compilation requires host GTK/pkg-config packages.
- Rendering batches equivalent geometry rather than allocating every Pine drawing object.

## 26. Remaining certification blockers

1. Supply approved TradingView bar-by-bar snapshots/current-bar revisions for both models and both
   VAE granularities.
2. Run the authenticated browser visual matrix and long mount/unmount soak.
3. Install host native Tauri prerequisites and rerun `npm run check:rust`.
4. Complete formal MPL covered-file/source-delivery legal review.
5. Approve measured CPU, payload, and memory budgets.
6. Only then delete the retained approximation sources.

## 27. Exact manual verification steps

1. `npm install`
2. `npm run test:kioseff`
3. `npm run benchmark:kioseff`
4. `npm run build`
5. Install Linux `pkg-config`, GTK/GObject/GIO/WebKit prerequisites, then run `npm run check:rust`.
6. Start `npm run dev`, sign in, open the Indicator Library, and enable
   **Stop Loss Clustering (Kioseff)**.
7. Verify both models and both VAE granularities on Binance, Bybit, and OKX.
8. Confirm source mismatch/incomplete history produces the structured unavailable panel.
9. Compare chart-bar and current-revision exports against approved TradingView fixture snapshots.
10. Pan, zoom, resize, switch model/granularity/symbol/timeframe, reload the workspace, and compare
    canonical hashes.
11. Run repeated mount/unmount and live-revision soak while observing worker/listener/Text counts.
12. After all gates pass, remove the three retained approximation files and update this report.

## 28. Git diff summary

The final diff introduces the dedicated Kioseff module, tests, fixtures, source/notices, symbol
metadata, worker/render/UI integration, versioned settings migration, and documentation. It removes
the old chart-engine import/calculation path but deliberately does not delete the retained
approximation sources.

## 29. Final commit hash

Recorded in the final repository handoff after the implementation commit is created.
