# Kioseff Stop Loss Clustering Parity Audit

**Status:** Engineering audit only — no implementation authorized  
**Audit date:** 2026-07-28  
**Target:** `Stop Loss Clustering (Breakouts) [Kioseff Trading]`, Pine Script v6  
**Original author:** © KioseffTrading  
**Source license:** Mozilla Public License 2.0  
**Existing Black Terminal identity:** `volatilityHeatmap` / “VAE Clusters”

## 1. Executive summary

Black Terminal does not currently contain a faithful implementation of the supplied Kioseff indicator.
The indicator shown as “VAE Clusters” is calculated by
`src/chart-engine/heatmap/VolatilityHeatmapModel.ts` on the browser main thread. It implements a
stateless, chart-timeframe approximation of only part of the Pine “Volatility-At-Entry” model. A
separate, larger Python file exists at
`src/builtin-python-indicators/volatility_at_entry_clusters.py`, but it is not connected to the chart
or to a Python runtime. It also introduces substantial behavior that is absent from the Pine source.

The supplied Pine is a path-dependent, intrabar state machine with two selectable models:

1. **Absorbtion Extremes** — a custom ATR zigzag, independent buy/sell persistent state, directional
   lower-timeframe volume transfer, wick violations, retained historical clusters, curved projections,
   typical-move statistics, pane triggers, tables, and ratio summaries.
2. **Volatility-At-Entry** — ordered one-minute intrabar execution, 18 volatility projection factors,
   two distinct granularity algorithms, active and removed stores, daily-gap removal, pruning,
   percentile/hot-cluster selection, pane triggers, tables, and ratio summaries.

The platform can reproduce many visual forms with existing PixiJS and React primitives. The blockers
are data and execution semantics, not basic drawing:

- no ordered one-minute intrabar arrays are supplied to chart indicators;
- no arbitrary lower-timeframe history request exists;
- symbol metadata has no reliable minimum tick;
- several venues use cross-exchange historical fallback while retaining venue-native realtime;
- the visible VAE runs on chart bars, not one-minute intrabars;
- current-bar recalculation has neither Pine-style rollback nor a committed/provisional state split;
- the active calculation runs synchronously on the main thread and has no cancellation/version guard;
- removed clusters and the entire Absorbtion model are absent.

**Recommendation:** preserve the registry/persistence key `volatilityHeatmap`, migrate its user-facing
name and settings to the Kioseff indicator, and replace its calculation completely with one shared,
MPL-attributed engine containing both original model modes. Do not keep the current TypeScript or
Python approximation as a silent fallback. This is recommendation **A: in-place implementation
replacement while preserving the registry ID**, with a settings-schema migration. A new public ID or
two separate indicator entries would unnecessarily break layouts and obscure that the Pine exposes
the models as one indicator.

**Decision:** no-go for parity implementation until the platform provides deterministic ordered
one-minute intrabars, authoritative `minTick`, source provenance, and a committed/provisional
incremental execution contract. Visual prototyping could begin earlier, but it must not be labeled
parity.

## 2. Audit scope and evidence

### 2.1 Repository root

The operative application is:

`_github_push_worktree_phase3_connectivity/black-terminal-identical-frontend`

The audit used that clean Git worktree rather than similarly named snapshots elsewhere in the parent
folder. No application, configuration, registry, migration, test, or indicator source was changed.
This document is the only repository write.

### 2.2 Documentation reviewed

The audit reviewed the root `README.md`, the documentation index, project brief, platform build
manual, architecture, Black Core phase documentation, workspace guide, implementation history,
roadmap, Python-indicator contract, exchange automation and adapter standards, performance baselines
and results, memory/render audits, DOM Pro worker/render/camera documents, A.I.F. engine/data-quality/
benchmark/render documents, security/deployment documents, and the Phase 3–5 engineering records.
All Markdown files under the repository root and `docs/` were enumerated; documents relevant to chart,
data, runtime, persistence, workers, performance, desktop/browser, testing, and deployment were read
and checked against code. The Obsidian protocol documents are product-adjacent and do not participate
in this indicator path.

The most directly relevant documents are:

- `README.md`
- `docs/README.md`
- `docs/PROJECT_BRIEF.md`
- `docs/ARCHITECTURE.md`
- `docs/BLACK_CORE_PHASE2.md`
- `docs/PLATFORM_BUILD_MANUAL.md`
- `docs/IMPLEMENTATION_HISTORY.md`
- `docs/ROADMAP.md`
- `docs/WORKSPACE.md`
- `docs/PYTHON_INDICATORS.md`
- `docs/EXCHANGE_AUTOMATION.md`
- `docs/EXCHANGE_ADAPTER_STANDARD.md`
- `docs/MEMORY_LEAK_AUDIT.md`
- `docs/REACT_RENDER_AUDIT.md`
- `docs/PERFORMANCE_BASELINE_CHAPTER14.md`
- `docs/PERFORMANCE_RESULTS_CHAPTER14.md`
- `docs/DOM_PRO_RENDER_PIPELINE.md`
- `docs/DOM_PRO_WORKER_BACKPRESSURE.md`
- `docs/DOM_PRO_SHARED_PRICE_CAMERA.md`
- `docs/PHASE3_CHAPTER1_ARCHITECTURE.md`
- `docs/PHASE3_CHAPTER7_MARKET_DEPTH_MEMORY.md`
- `docs/PHASE3_CHAPTER9_PERFORMANCE.md`
- `docs/PHASE3_CHAPTER14_PERFORMANCE_STABILITY.md`
- `docs/PHASE4_CHAPTER1_AIF_LONG_HORIZON_PROFILE_ENGINE.md`
- `docs/PHASE4_CHAPTER1A_AIF_PRICE_SYNCHRONIZATION.md`
- `docs/AIF_DATA_QUALITY_PROVENANCE.md`
- `docs/AIF_BENCHMARKS.md`
- `docs/PYTHON_INDICATORS.md`
- `docs/OFFLINE_EXECUTION_CERTIFICATION.md`
- `docs/PHASE5_CHAPTER1_SECURITY_FORTRESS.md`

Documentation is not treated as proof. For example, the root README still lists live exchange streams,
worker aggregation, and an indicator plugin loader as “next upgrades,” while portions of exchange
streaming and A.I.F. workers now exist. Conversely, registry capability declarations overstate
`liveCandles` for adapters that actually expose only trades.

### 2.3 Pine source reviewed

The supplied attachment contains 1,786 Pine lines following the user’s introductory line. Pine
locations below use attachment line numbers, including that introductory line. The script declaration
is therefore at attachment line 6. The audit treats that source as the sole behavioral specification.

## 3. Repository architecture findings

Black Terminal is a React/Vite/TypeScript shell around a custom PixiJS chart. Black Core provides
events, services, permissions, module registration, scheduling, and platform services, but the
existing VAE path is not registered as an independently scheduled Black Core computation.

The relevant boundaries are:

- **Application and persistence:** `src/App.tsx`
- **Indicator discovery/settings UI:** `src/components/IndicatorLibrary.tsx`,
  `src/components/PixiBlackChart.tsx`
- **Market orchestration:** `src/components/PixiBlackChart.tsx`
- **Market facade/cache:** `src/market-data/engine/marketDataEngine.ts`,
  `src/market-data/cache/marketCache.ts`
- **Venue adapters:** `src/market-data/adapters/*.ts`
- **Chart state and rendering:** `src/chart-engine/BlackChartEngine.ts`
- **Actual VAE calculation:** `src/chart-engine/heatmap/VolatilityHeatmapModel.ts`
- **Disconnected Python experiment:**
  `src/builtin-python-indicators/volatility_at_entry_clusters.py`
- **Draft generic Python contract:** `src/indicator-runtime/types.ts`,
  `docs/PYTHON_INDICATORS.md`
- **Reusable worker precedent:** `src/modules/aif/workers/aifWorkerClient.ts`,
  `src/modules/aif/workers/aifWorker.ts`

The chart owns a bounded `CandleBuffer` and renders retained-mode Pixi containers with immediate-mode
`Graphics` redraws. Indicator state is heterogeneous: many conventional indicators calculate in the
chart engine, A.I.F. uses a Web Worker and a React/HTML overlay, and the VAE approximation is a
main-thread model.

## 4. Existing VAE identity, settings, and lifecycle

### 4.1 Registration and identity

`src/components/IndicatorLibrary.tsx:65` registers:

- key: `volatilityHeatmap`
- title: `Volatility-At-Entry Clusters`
- group: `Liquidity`
- type: `Overlay`
- runtime label: `Python`
- period key: `volatilityHeatmap`
- UI range: 5–300
- premium: true

The runtime label is inaccurate. The visible result comes from the TypeScript model imported by
`src/chart-engine/BlackChartEngine.ts:10`; the Python file has no application import.

Other identities are inconsistent:

- chart row: “VAE Clusters” (`src/components/PixiBlackChart.tsx:1734`);
- administrator entitlement: “Volatility Heatmap”
  (`src/components/AdminPanel.tsx:44`);
- premium feature label: “Volatility Heatmap” (`src/features/premium.ts:5`);
- Python metadata ID: `volatility_at_entry_clusters`
  (`src/builtin-python-indicators/volatility_at_entry_clusters.py:1288`).

The durable UI/persistence identifier is `volatilityHeatmap`.

### 4.2 Defaults and settings

`src/App.tsx` defines:

- visible by default: `false`;
- period: `34`;
- visual color: green;
- visual intensity: `86`;
- allowed for normal users in `DEFAULT_ALLOWED`;
- premium gating through `VITE_BLACK_TERMINAL_PREMIUM !== "false"`.

The chart settings popover exposes:

- Visible;
- Length;
- Color;
- Intensity;
- a fixed, nonfunctional model select containing only
  “Volatility-At-Entry stop clusters.”

The popover applies a generic length range of 2–500, which disagrees with the library range of 5–300.
The period has no counterpart in the Pine inputs. Missing settings include both-model selection,
Absorbtion lower timeframe, x-ray, intensity mode, active/old display limits, typical-move forcing,
VAE granularity, factor base timeframe, colors, historical clusters, size labels, and ratio meter.

### 4.3 Persistence and reset behavior

- Visibility is stored globally as `bt_visible_indicators_v1`.
- A saved workspace captures visibility, periods, visual settings, advanced settings, symbol,
  timeframe, chart type, and layout at schema version 3.
- Workspace snapshots are stored in local storage and, for signed-in users, synchronized through the
  existing user record.
- Period and visual changes are not separately auto-persisted; they persist when a workspace is saved.
- Calculation state, active clusters, removed clusters, and warmup source are not serialized.
- Symbol, exchange, timeframe, or history-depth changes destroy and recreate `BlackChartEngine`.
- Visibility/settings changes call `setIndicatorState` and recompute without remounting the chart.
- Reload reconstructs output from whatever history the new fetch returns; deterministic equivalence is
  not guaranteed by persisted data or source revision.

### 4.4 Feature flags and coupling

`src/features/premium.ts` is the only dedicated feature gate. Access is enabled unless
`VITE_BLACK_TERMINAL_PREMIUM` is exactly `"false"`. Entitlement arrays in `App.tsx`,
`AdminPanel.tsx`, landing/upgrade components, and Supabase migrations contain the durable key.

There is no parity, experimental-engine, model, or per-venue-quality flag. Couplings include:

- user/admin `allowedIndicators`;
- upgrade plan payloads;
- workspace schemas;
- chart-engine `VisibleIndicators`, `IndicatorPeriods`, and visual settings types;
- the heatmap layer shared with liquidation visuals;
- history/replay behavior in `PixiBlackChart`;
- Supabase defaults containing the key.

## 5. Exact existing VAE dependency graph

```text
User selects exchange/symbol/timeframe/history depth
  └─ src/App.tsx
      └─ <PixiBlackChart ... visibleIndicators/periods/visuals>
          ├─ getMarketDataEngineAdapter(exchange)
          │   └─ MarketDataEngine facade
          │       ├─ venue adapter REST getHistoricalCandles()
          │       ├─ venue adapter subscribeCandles() when implemented
          │       ├─ venue adapter subscribeTrades()/REST recent trades
          │       └─ MarketCache (copy of candles/trades/ticker)
          ├─ fetchHistoryWindow()
          │   ├─ paginates chart-timeframe OHLCV
          │   └─ may substitute another exchange for history
          ├─ live candle path → BlackChartEngine.upsertCandle()
          └─ trade/ticker path → BlackChartEngine.ingestTrade()
              └─ CandleBuffer (maximum 20,000 chart candles)
                  └─ BlackChartEngine.setHeatmapSource()
                      └─ VolatilityHeatmapModel.setSource(candles, period)
                          ├─ cache signature check
                          └─ buildCells() over ≤12,000 chart candles
                              └─ VolatilityHeatmapCell[]
                                  └─ BlackChartEngine.drawVolatilityHeatmap()
                                      ├─ price: yForPrice()
                                      ├─ time/index: xForIndex()
                                      ├─ Pixi Graphics on heatmapLayer
                                      └─ Pixi Text labels on heatmapLayer
                                          └─ GPU canvas pixels
```

The Python file and `src/indicator-runtime/types.ts` are outside this graph.

## 6. Market-data findings

### 6.1 Historical acquisition

`PixiBlackChart.fetchHistoryWindowFrom()` pages the selected chart timeframe. Per-request venue limits
are approximately 1,000 for Binance/Bybit and 300 for OKX. Results are sorted, deduplicated by bar-open
time, and sliced to the requested depth. The history selector offers 1K, 2.5K, 5K, 10K, and 20K.
`CandleBuffer` caps retained chart candles at 20,000.

There is no parallel one-minute history load for higher-timeframe chart bars. Loading 10,000 15-minute
bars produces 10,000 15-minute OHLCV records, not ordered arrays of 150,000 one-minute records.
Consequently `calc_bars_count=10000` can be approximated for chart bars only, not for the Pine’s
lower-timeframe requests.

If selected-venue history fails, `fetchFallbackHistoryWindow()` tries other venues. Several adapters
(Hyperliquid, Coinbase, Kraken, Bitfinex) explicitly delegate history to Binance/Bybit. Realtime may
then be sourced from the selected venue. This is acceptable as a visible continuity fallback but is
not acceptable for deterministic TradingView parity unless provenance is explicit and the fixture
uses the same source.

### 6.2 Realtime acquisition and aggregation

Binance exposes native candle updates. Bybit and OKX chart paths generally synthesize chart candles
from trades because those adapters do not implement `subscribeCandles`. A stale candle stream also
causes trade synthesis.

`BlackChartEngine.ingestTrade()`:

- computes `bucket = floor(time / timeframeSeconds) * timeframeSeconds`;
- ignores out-of-order buckets older than the current bar;
- mutates current OHLCV for the same bucket;
- creates the next bar with the prior close as open;
- does not synthesize intervening missing bars.

`PixiBlackChart` deduplicates only the latest 2,500 trade IDs. A ticker heartbeat can be ingested with
zero quantity when all other activity is stale.

`CandleAggregationEngine` exists but is not the direct chart aggregation path. It divides
`TradeTick.time` by 1,000 even though adapters and the chart use seconds, creating a unit mismatch if
that class is used with current adapter ticks.

### 6.3 Data contract

`Candle` contains only time, open, high, low, close, and volume. It has no:

- source venue/provenance;
- closed/provisional flag;
- revision/sequence;
- session/day identifier;
- constituent intrabars;
- missing-bar marker;
- exchange-native/local aggregation marker.

`MarketSymbol` has optional price and quantity precision and minimum notional, but no tick size.
Adapter symbol discovery often supplies only decimal precision or nothing. Static catalog symbols do
not carry authoritative filters. Decimal precision is not a safe substitute for an exchange tick
step.

### 6.4 Capability answers

| Capability | Verified status | Evidence/consequence |
|---|---|---|
| Ordered 1m intrabars per chart bar | **Missing** | No field/API carries constituent candles |
| Arbitrary lower-timeframe requests | **Missing** | `CandleQuery` has one timeframe; indicators cannot issue nested requests |
| Historical 1m beyond visible range | **Missing for indicators** | paging loads chart timeframe only |
| 10,000 chart-bar warmup | **Partial** | selectable and buffer supports it; venue paging/fallback may return less |
| `request.security_lower_tf()` equivalent | **Missing** | no ordered array result or chart-bar grouping |
| Chronological intrabar processing | **Missing contract** | only chart bars/trade arrivals; no canonical historical arrays |
| Multiple current-bar updates | **Supported** | candle upsert and trade synthesis mutate current bar |
| Deterministic rebuild after reload | **Partial/unsafe** | stateless rebuild exists, source/history revision is not persisted |
| Exchange vs local OHLCV distinction | **Missing** | same `Candle` type and no provenance |
| Missing-bar handling | **Missing** | no explicit fill or marker |
| UTC boundaries | **Partial** | epoch bucket floor is UTC-like; exchange sessions are not modeled |
| Daily boundary/gap semantics | **Missing for indicator** | no `timeframe.change("1D")`; current TS removes every opening gap |
| Authoritative `syminfo.mintick` | **Missing** | no `tickSize` in `MarketSymbol` |
| Symbol type | **Partial** | `marketKind` exists, not Pine `syminfo.type`; crypto inference is possible |
| Exact bar-open timestamps | **Mostly supported** | REST adapter timestamps are normalized to seconds; local bucket semantics differ |
| Tick-safe price indexing | **Missing** | current grid derives from price/ATR |
| Realtime rollback/provisional state | **Missing** | no committed snapshot/current-bar replay contract |

### 6.5 Browser versus desktop

REST calls use `marketDataFetchJson()`:

- Tauri first invokes the restricted native `publicMarketGet` bridge and falls back to browser fetch;
- localhost browser development maps supported venues through Vite proxy routes;
- other browser contexts use direct fetch, subject to CORS/network behavior.

The indicator receives no transport provenance. A future parity loader must normalize browser and
desktop responses identically and test both paths.

## 7. Indicator-runtime findings

### 7.1 Actual VAE runtime

`VolatilityHeatmapModel` is:

- main-thread;
- stateless full-series recomputation;
- limited to the last 12,000 chart candles;
- independent of viewport for calculation, but returns a display subset;
- recalculated on accepted candle/trade updates when its signature changes;
- not worker-based;
- not serializable;
- not cancellable;
- not incremental;
- not capable of current-bar rollback.

The cache signature is:

`period:length:first.time:last.time:last.close:last.volume`

It omits the last open/high/low and every interior candle field. A high/low-only current-bar mutation
or an interior backfill correction can leave stale cells. There is no monotonic data version.

`visibleCells()` ignores its price-range parameters. Calculation itself does not depend on pan/zoom,
which is good, but selection is permanently reduced to at most 495 clusters nearest the final close.

### 7.2 Current TypeScript algorithm

The model:

1. calculates Wilder-like ATR(14) on chart candles;
2. freezes a grid from `SMA(ATR, 50)/4`, but at a hardcoded first-ready index and with price fallback;
3. calculates the 18 `sqrt(tf/1) × {1,1.5,2}` factors;
4. processes one chart candle as if it were one Pine lower-timeframe candle;
5. removes crossed clusters before creating new projections;
6. removes every opening gap, not only a daily gap;
7. calculates inverted signed volume from chart-bar close change;
8. adds to `ceil(level/gridSize)` buckets;
9. deletes violated state;
10. prunes active buckets above 2,500;
11. selects 495 nearest price buckets;
12. classifies hot buckets from p95 and a top-five threshold;
13. emits only active cells.

The Pine VAE creates projections and then checks violations for each ordered one-minute intrabar. This
order alone makes the current output non-equivalent. Pine higher granularity uses
`floor(level / syminfo.mintick)` maps; Pine lower granularity uses a frozen sorted boundary array.
The TypeScript model is neither.

### 7.3 Disconnected Python implementation

`volatility_at_entry_clusters.py` contains an incremental class and 14 unit tests, but no caller in
the application. `docs/PYTHON_INDICATORS.md` explicitly describes the Python sidecar as a future
milestone.

The file is not a dormant faithful conversion. It adds:

- bid/ask enhancement;
- delta and spread filters;
- percentile-based strength scores;
- zone merging;
- signal cooldowns;
- scanner records and “monster” signals;
- configurable ATR/factors/tick/grid modes;
- strong-intrabar requirements;
- a 20-bar default lookback.

Those behaviors are not in the supplied Pine. It implements only VAE-like logic, not Absorbtion
Extremes. It can accept optional intrabars, but no production input supplies them. Its fallback
processes the chart candle as an intrabar. Its grid centers zones around `floor(level/grid)` and merges
neighbors rather than matching either Pine granularity. Its gap check runs on every bar. It retains a
removed list internally but returns a filtered/merged presentation unlike Pine’s two stores.

### 7.4 Worker precedent

A.I.F. demonstrates a usable worker client with:

- generation numbers;
- source-version validation;
- cancellation by resolving superseded work to `null`;
- bounded cache;
- worker termination and pending-request cleanup.

That implementation is full-recompute oriented and throttles current-bar recomputation by five
seconds. It is a precedent for message lifecycle, not a drop-in solution for Pine rollback. The
Kioseff engine needs committed closed-bar state plus replayable provisional intrabars.

## 8. Renderer findings

### 8.1 Existing VAE render path

`BlackChartEngine.drawVolatilityHeatmap()` draws cells on `heatmapLayer`:

- one `Graphics` object is cleared/rebuilt;
- zones extend from their calculated index to the right plot boundary;
- hot zones receive a core line and two faint parallel lines;
- up to 60 hot volume labels are `Text` children;
- label y-positions are deconflicted by eight pixels;
- labels are destroyed and recreated on draw.

Layer order is:

1. grid;
2. watermark;
3. heatmap;
4. volume;
5. candles;
6. indicators;
7. drawings;
8. alert graphics/text;
9. axes;
10. crosshair.

Thus VAE zones render below candles and conventional indicators. Destruction clears label arrays,
cancels animation frames, disconnects observers/listeners, destroys the Pixi application tree, and
clears resource gauges.

### 8.2 Reusable capabilities

| Pine visual | Current capability | Assessment |
|---|---|---|
| Horizontal/extended lines | Pixi `Graphics.moveTo/lineTo`; manual dashes exist | Direct |
| Rectangular zones | Pixi `Graphics.rect` | Direct |
| Gradient-like zones | repeated strips/rectangles already used | Direct, but batch carefully |
| Text labels/tooltips | Pixi `Text`; React can provide richer tooltip | Direct |
| Text outline/glow | layered text/lines possible; no dedicated primitive | Small primitive/style addition |
| qCurve polyline | arbitrary line segments exist | New curve render-model primitive needed |
| Dashed qCurve | manual dash routines exist only for simple lines | New polyline dash utility needed |
| Pane averages/triggers | indicator panes and circles already exist | Extend pane contract |
| Radiating circular plots | circles and layered alpha are available | Direct after pane series support |
| Summary table | React overlay pattern exists in A.I.F. | Prefer React |
| Ratio meter | React/CSS grid is appropriate | New component |
| X-ray background | zone strips possible | Direct, bounded |
| Time-based endpoints | engine is primarily index-based | Need canonical timestamp→x mapping |
| Clipping | plot bounds are manually checked | Add explicit clip discipline for new layers |

### 8.3 Performance and resource risk

The Pine can request up to 500 boxes, labels, and lines, plus 100 polylines. Its Absorbtion gradients
can create hundreds of boxes during every last-bar redraw. A literal object-per-Pine-object port would
cause churn.

The replacement should calculate a renderer-independent serializable model, then draw batched geometry
with stable containers:

- a bounded `Graphics` batch for cluster fills/lines;
- a bounded text pool rather than destroy/recreate;
- a separate indicator pane layer;
- React components for tables/settings;
- explicit maximums matching Pine’s display rules;
- no calculation triggered by zoom/pan;
- transform-only redraw on camera interaction.

Existing cleanup is adequate for the current model but needs tests for any new text/HTML/worker
resources.

## 9. Pine semantic audit

### 9.1 Global execution contract and inputs

The declaration at attachment line 6 specifies Pine v6, `overlay=false`,
`calc_bars_count=10000`, `dynamic_requests=true`, and maximum drawing counts. Many price visuals use
`force_overlay=true`; pane plots remain in the indicator pane.

Inputs at lines 15–34 define:

- model: “Absorbtion Extremes” or “Volatility-At-Entry”;
- Absorbtion x-ray, intensity, active and old cluster limits, LTF, colors, and typical-move behavior;
- VAE higher/lower granularity, scaling timeframe, colors, historical clusters, size labels;
- ratio meter.

No input equivalent to Black Terminal’s “Length 34” exists.

### 9.2 Custom types and collection semantics

Lines 36–112 define `swingData`, `volTime`, drawing records, bar history, VAE state/draw structures,
off-chart summary state, lower-granularity arrays, and similarity arrays. Correct conversion requires:

- mutable records with reference semantics;
- maps keyed by integer tick index;
- sorted arrays with Pine’s leftmost/rightmost binary-search behavior;
- negative indices (`get(-1)`, `get(-2)`);
- exact mutation order for insert/unshift/push/shift/remove;
- Pine `na`/`nz` behavior rather than JavaScript/Python truthiness;
- history references to series values and mutable `chart.point` objects.

Collection order is observable and cannot be replaced with unordered “equivalent” aggregation.

### 9.3 IQZZ and `chart.point` history

`IQZZ()` at lines 127–183 is a custom state machine, not a conventional library zigzag:

- ATR threshold is `ta.atr(14) * 2`;
- function-local `var` arrays and `dir` persist;
- `updatePivot()` mutates the two-point array;
- `pointPrev[1]` uses Pine history semantics on a `chart.point` series;
- direction continues by updating the current extreme;
- reversal occurs only after a two-ATR move and inequality guard;
- a prior pivot is appended when the historical point price differs;
- pivot price/time arrays grow persistently.

The single call creates one pivot stream shared by both subsequent model-side calls. A port must
validate TradingView’s exact reference/history behavior with fixtures, particularly on realtime bars
where the current extreme can repaint.

### 9.4 qCurve

`qCurve()` at lines 185–238:

- locates a cluster time and following pivot by binary search;
- falls back to current low/time when no next pivot exists;
- computes a quadratic coefficient but raises normalized progress to 2.5 and squares the result,
  yielding a fifth-power-shaped path;
- clamps by direction;
- uses bar timestamps;
- makes a dashed overlay polyline;
- retains at most 50 curves;
- changes the end range for live curves.

This is calculation output as well as rendering geometry; it must not be approximated by a straight
line if parity is claimed.

### 9.5 Absorbtion Extremes

`getClusterPoints(side)` at lines 525–595 is called separately for sell and buy sides. Its local
`var` values persist independently per call site, creating two independent cluster/old/pivot-fill
stores.

Per chart execution:

1. `request.security_lower_tf(tickerid, ltfGran, volume * sign(close-close[1]))` returns ordered LTF
   values.
2. Only the target sign is summed for each side.
3. The bar sum is unshifted into that side’s `pivotFills`.
4. Wick violations are checked before new pivot-cluster creation:
   - sell-side (“Down”) cluster violates when current high reaches `P2`;
   - buy-side (“Up”) cluster violates when current low reaches `P2`.
5. Violated records move from active to old via remove then unshift, receive `vioT`, contribute to
   stop-hit output, and store the subsequent intrabar move.
6. If active and pivot-fill data remain, the newest fill is added to the most recent active cluster.
7. On a new IQZZ pivot, side direction is tested from the last two pivot prices.
8. Bar distance uses elapsed milliseconds for crypto and bar index/binary search for other symbols.
9. `pivotFills.slice(0, barsDiff).sum()` becomes the new cluster volume.
10. Level begins one `mintick` beyond the historical swing wick.
11. Zone width is current execution-time `ATR(14)/4`, extending away from price.
12. The transferred recent volume is subtracted from the previous active cluster.
13. The new cluster is unshifted and `pivotFills` is cleared.

Important non-obvious behavior:

- directional volume is not inverted in this model;
- the ATR used for zone width is current, not explicitly indexed to pivot time;
- violations are chart-bar wick based, while volume input is LTF;
- active and old arrays remain separate and ordered;
- buy and sell calls must not share local state.

`gradBox()` and `lastBarDrawSwingMethod()` at lines 240–451 and 620–671 rebuild display objects only on
the last bar. They:

- select recent active and old clusters using four limits;
- sum active/removed volumes;
- calculate logarithmic volume similarities and subsequent moves;
- draw multi-strip gradients, layered glow lines, labels, qCurves, optional x-ray and intensity;
- expose nearest displayed cluster price/volume;
- update a pulse label from IQZZ direction.

`findTypical()` at lines 821–865 derives typical move results from log-volume neighbors. In normal
mode, the 75th percentile of adjacent sorted log-volume distances establishes the similarity window.
Forced mode chooses the nearest size. Edge/index behavior requires fixture confirmation.

### 9.6 Volatility-At-Entry shared behavior

`req()` at lines 866–868 returns one-minute ATR(14), inverted signed volume, HLC3, low, and high.
`timeScaled()` at line 870 always requests `"1"` minute data. The `timeScaledVolaIn` input affects the
factor baseline through `sq()`, not the requested data timeframe.

The 18 factors are:

`sqrt([1,5,15,30,60,240] / t0) × [1,1.5,2]`

Each intrabar:

- signed volume is `volume * sign(close-close[1]) * -1`;
- direction is the sign of that result;
- projected price is `HLC3 + ATR(14) * factor * direction`;
- volume is distributed across 18 projections;
- cluster creation and violation are interleaved in chronological intrabar order.

The model also retains chart-bar high/low/time history for start-time searches.

### 9.7 VAE higher granularity

The higher mode uses:

- active `map<int, volTime>` keyed by `floor(projected / mintick)`;
- sorted active key array;
- equivalent removed map/key array.

For each intrabar it:

1. adds projected volume to tick keys;
2. finds all active keys inside intrabar low–high;
3. sums stop hits by signed volume;
4. moves older active records into the removed store;
5. removes active keys even when a newly created same-chart-bar record is not retained as removed;
6. prunes above 25,000 keys down to 20,000 from the price-furthest side;
7. applies additional removal for gaps only on `timeframe.change("1D")`.

At the last bar, active and removed price ranges are each divided into display bins (495 active,
450 removed). Tick records are aggregated into those bins. Start/end times are derived from recorded
bar overlaps.

### 9.8 VAE lower granularity

The lower mode freezes `SMA(chart ATR(14), 50)/4` once at first availability. It initializes a sorted
boundary array around the open and never recalculates the bin width.

For each ordered one-minute intrabar:

1. extend boundaries to contain intrabar and projected prices;
2. locate projection buckets with Pine binary-search semantics;
3. add signed volume/18 to active buckets;
4. locate every bucket crossed by intrabar low–high;
5. copy active volume/time into the parallel removed bucket;
6. add stop-hit totals;
7. zero the active bucket and stamp its time;
8. prune boundary/data arrays to 2,500 from a close-dependent side;
9. find creation/start time for added boundaries by scanning up to 1,000 recorded chart bars;
10. on daily gaps, copy/zero buckets through the gap range.

Removed lower-mode storage is one parallel record per price cell and may be overwritten by later
violations. This differs from an append-only event log.

### 9.9 Hot clusters, historical rendering, and summaries

At `barstate.islast`, the Pine:

- chooses up to 495 lower-mode cells around current price or 495 aggregate high-mode bins;
- tracks a five-element top-cluster array;
- computes nearest-rank p95 for active and removed display volumes;
- considers top-five threshold for hot presentation;
- draws active boxes extended right;
- optionally draws size labels;
- draws up to five hot clusters as paired glow lines (10 line slots);
- selects the nearest hot buy below close and sell above close;
- optionally draws removed history;
- accumulates active and removed buy/sell totals.

The summary table reports nearest price, volume, and percent of active side total for VAE, or typical
move for Absorbtion. The ratio meter computes active dominance and removed-side ratios and draws
20-block gradients. Division-by-zero/`na` behavior must follow Pine rather than being silently clamped.

### 9.10 Pane values and alerts

Both models write stop-hit outputs into `offChart`. Nonzero hits are appended to persistent arrays.
The pane computes:

- Absorbtion: 75th-percentile sell hit and 25th-percentile buy hit, then 50-period SMA;
- VAE: 50-period SMA of current stop-hit series;
- circle plots for nonzero hits;
- radiating layered circles when hit output crosses the model-specific threshold;
- glowing VAE average lines.

Two `alertcondition`s and matching once-per-bar `alert()` calls fire from `radiateB` and `radiateS`.
The current Black Terminal VAE returns neither pane series nor these alert events.

### 9.11 Realtime/repainting implications

Pine recalculates the open chart bar while `var` state, series history, dynamic LTF arrays, swing
extremes, drawings, and alerts interact. TradingView normally rolls an open-bar execution back to the
last committed state before recalculating with the latest intrabar set. A Black Terminal incremental
engine must emulate that with:

- a committed state after each closed chart bar;
- a provisional clone for the open bar;
- replacement/replay of that chart bar’s ordered intrabars;
- once-per-bar alert de-duplication;
- no irreversible mutation from an earlier provisional update.

Appending every websocket update to one mutable state would overcount projections, violations, and
pivot fills.

## 10. Pine-to-Black-Terminal requirement matrix

| Pine behavior | Pine location | Required capability | Existing implementation | Current VAE behavior | Status | Severity | Required change | Affected files | Test needed |
|---|---|---|---|---|---|---|---|---|---|
| Two model modes | inputs 15; branches 1526/1548 | model setting and two engines | fixed VAE select | VAE-like only | Missing | Critical | add schema and both state machines | App, chart UI, new engine | model golden fixtures |
| 10k warmup | line 6 | deterministic 10k chart bars | selectable 10k/20k | ≤12k available bars | Partial | High | quality gate and exact history loader | Pixi chart, loader | short-history rejection |
| Ordered LTF arrays | lines 531, 876 | grouped chronological intrabars | none | chart candle substituted | Missing | Critical | intrabar service/contract | market data, engine types | ordering fixture |
| Arbitrary Absorbtion LTF | line 531 | setting-driven LTF fetch | none | absent | Missing | Critical | nested timeframe request | loader/settings | 1m/3m parity |
| VAE always requests 1m | lines 866–876 | 1m ATR/OHLCV arrays | none | chart timeframe ATR/OHLCV | Incorrect | Critical | one-minute history/realtime feed | market data/new engine | HTF fixture |
| Function-local `var` per call site | lines 525–529 | independent buy/sell state | no Absorbtion engine | absent | Missing | Critical | explicit state objects | new engine | state-isolation test |
| IQZZ point history | lines 116–183 | Pine series/reference emulation | adaptive swing is unrelated | absent | Missing | Critical | literal IQZZ port + fixture | new engine | first pivot divergence |
| Repainting current swing | IQZZ | provisional rollback | none | stateless rebuild masks only VAE | Missing | Critical | committed/provisional state | runtime/worker | repeated open-bar updates |
| Directional Absorbtion volume | 531–548 | LTF close-change sign | none | inverted chart volume | Incorrect | Critical | model-specific sign rules | new engine | signed-volume fixture |
| Recent swing volume transfer | 518–593 | ordered mutation/slices | none | absent | Missing | Critical | literal mutation order | new engine | pivot transfer fixture |
| Wick violation | 483–516 | chart high/low checks | range overlap | active buckets deleted | Partial | High | model-specific violation | new engine | boundary equality |
| Preserve violated Absorbtion records | 495/510 | active→old store | none | deleted | Missing | Critical | old store | new engine/model | snapshot lifecycle |
| Mintick swing offset | 577–585 | authoritative tick | unavailable | derived grid | Incorrect | Critical | `tickSize` metadata | types/adapters | nondecimal tick |
| Current ATR/4 swing zone | 532/584 | exact ATR history semantics | chart ATR exists elsewhere | unrelated frozen grid | Incorrect | High | literal ATR state | new engine | ATR warmup/`na` |
| qCurve | 185–238 | time polyline render model | only generic lines | absent | Missing | Medium | curve geometry primitive | renderer | geometry snapshot |
| Typical move | 821–865 | sorted logs/percentile | none | absent | Missing | High | exact statistics | new engine | tie/edge fixtures |
| 18 factors | 686–690, 880s | exact float factors | present | present with t0 fixed at 1 | Partial | Medium | setting-driven `t0` | new engine/settings | factor vector |
| Inverted VAE signed volume | line 868 | LTF close-to-close | TS sign formula | chart close-to-close | Partial | Critical | calculate per 1m sequence | new engine | flat-close fixture |
| Interleaved create/remove | VAE intrabar loops | exact operation order | remove before create per chart bar | reversed/coarsened | Incorrect | Critical | literal event loop | new engine | first divergent intrabar |
| Higher tick maps | 912 onward | integer tick key map | `ceil(level/grid)` map | wrong key/width | Incorrect | Critical | floor by tick | new engine | negative/decimal prices |
| Lower frozen bin width | 1014 onward | once-only chart ATR SMA/4 | approximate freeze at index 49 | globally derived, different init | Incorrect | Critical | exact boundary arrays | new engine | reload/bin identity |
| Pine binary searches | collection methods | left/right exact semantics | JS sort/map approximation | nearest slice | Incorrect | High | tested search utilities | new engine/utils | duplicates/bounds |
| Active and removed datasets | VAE state types | dual stores | active only | removed deleted | Missing | Critical | serialize both | new engine/model | lifecycle snapshot |
| Daily-only gap removal | `timeframe.change("1D")` | UTC/day boundary | no session marker | every bar opening gap | Incorrect | High | canonical day transition | normalizer/engine | midnight fixture |
| Higher pruning 25k→20k | 724–737 | price-side pruning | 2.5k with top40 protection | invented behavior | Incorrect | Medium | literal cap/order | new engine | cap boundary |
| Lower pruning to 2.5k | 738–744 | parallel-array removal | active map 2.5k | different data/order | Incorrect | Medium | literal parallel arrays | new engine | invariant/property test |
| Top-five hot threshold | topClusters logic | signed/abs exact selection | global p95/top5 | threshold differs | Partial | High | reproduce per display dataset | new engine | ties/zeros |
| p95 nearest rank | last-bar section | Pine nearest rank | helper matches common formula | uses all active, not Pine bins | Partial | High | apply to exact arrays | new engine | rank fixtures |
| Nearest hot side | active draw loop | hot-only below/above | selects 495 nearest; labels hot | no canonical nearest output | Incorrect | High | explicit summary fields | new engine/model | no-side case |
| Removed historical lines | `showHist` blocks | end/start time geometry | generic line possible | absent | Missing | Medium | removed render entries | renderer | geometry snapshot |
| Pane hit circles | 1560 onward | pane series + markers | general pane primitives exist | absent | Missing | High | canonical pane output | renderer | series snapshot |
| Tables and ratio meter | 1650 onward | overlay panels | React precedent exists | absent | Missing | Medium | dedicated React panels | components | DOM snapshot |
| Alerts once per bar | 1782 onward | event contract/de-dupe | generic alerts exist | no VAE alerts | Missing | High | engine events + alert bridge | automation/chart | repeated update test |
| Last-bar-only drawings | many `barstate.islast` | calculate state separately from view | draw on every chart redraw | active cells only | Partial | Medium | stable render model | engine/renderer | pan invariance |
| Exact time endpoints | `xloc.bar_time` | timestamp→x | internal index mapper | index-only cells | Partial | High | public time transform | chart engine | gap timestamp test |
| Symbol crypto branch | 565–568 | Pine symbol type | market kind only | absent model | Partial | Medium | normalized asset class | metadata | crypto/noncrypto |
| Current-bar rollback | Pine runtime semantics | committed/provisional replay | none | full rebuild with incomplete input | Missing | Critical | runtime state protocol | worker/runtime | rollback fixture |
| Source-consistent history/live | implicit TradingView feed | one canonical venue | fallback may mix venues | mixed silently | Incorrect | Critical | parity provenance gate | history loader | source mismatch |
| Calculation independent of viewport | semantic requirement | full history state | model calculates full retained source | independent | Exact match | Low | preserve | new engine | zoom/pan invariance |
| MPL notice/attribution | header lines 2–4 | file-level notices/source availability | repo has no target notice yet | absent | Missing | High | license headers/docs/review | new source/docs | distribution checklist |

Rows that depend on exact TradingView output—especially `chart.point` history, realtime rollback,
`time("", negative offset)`, duplicate binary-search behavior, `na` propagation, and display-array edge
cases—remain **Unknown pending fixture** until exported reference fixtures are supplied.

## 11. Proven mismatch root causes

### 11.1 Ranked root causes

1. **Critical — the required one-minute intrabar data does not exist in the chart indicator path.**  
   Pine lines 531 and 870–876 depend on `request.security_lower_tf`. The platform passes only
   chart-timeframe `Candle[]`. `VolatilityHeatmapModel.buildCells()` processes one chart candle per
   loop. On any timeframe above one minute, projection, ATR, signed volume, creation/removal order,
   and timestamps diverge immediately.

2. **Critical — the visible algorithm is not the Pine algorithm.**  
   `VolatilityHeatmapModel.ts` uses a single grid map keyed by
   `ceil(level/gridSize)`, removes before creating, deletes violations, and emits only active nearest
   cells. Pine provides two model modes and two distinct VAE granularities with different stores and
   mutation order.

3. **Critical — authoritative minimum tick is absent.**  
   Pine uses `syminfo.mintick` for Absorbtion offsets and higher VAE keys.
   `MarketSymbol` contains precision but no tick step. TS invents a price/ATR grid; Python defaults to
   `0.01`. Symbols with steps such as 0.5, 0.05, 0.0005, or non-power-of-ten ticks cannot match.

4. **Critical — Pine current-bar transactional semantics are absent.**  
   No runtime restores closed-bar state and replays the latest intrabar array. A literal incremental
   port would overcount on every websocket revision. The stateless TS rebuild avoids accumulation but
   cannot reproduce path-dependent IQZZ/pivot and intrabar state without the full input.

5. **Critical — data provenance can change between history and realtime.**  
   `PixiBlackChart.fetchFallbackHistoryWindow()` and delegated adapters can provide Binance history
   for another selected venue, followed by selected-venue trades. TradingView comparisons are invalid
   unless both sides use identical normalized data.

6. **Critical — the Absorbtion Extremes model is wholly missing.**  
   There is no IQZZ, independent side state, transfer logic, typical move, qCurve, x-ray, or old swing
   store in either visible TS or disconnected Python.

7. **High — violated state is deleted.**  
   TS `removeCrossed()` deletes map entries. Pine retains old Absorbtion records and VAE removed
   records, uses them in totals, historical drawings, ratio meter, and later statistics.

8. **High — daily gaps are implemented as all opening gaps.**  
   TS `removeGapThrough()` runs for every chart candle. Pine VAE gates gap processing with
   `timeframe.change("1D")`.

9. **High — cache invalidation is incomplete.**  
   The TS signature omits current open/high/low and interior data. Valid market updates can leave
   stale pixels.

10. **High — display selection changes semantics.**  
    TS selects 495 raw buckets nearest final close, then calculates visual fields from a different
    population. Pine higher mode aggregates a full min/max range into 495 bins; lower mode alternates
    around a binary-search close index and preserves signed cell ordering.

11. **High — the Python tests certify invented behavior, not parity.**  
    Tests cover bid/ask scoring, strong filters, cooldowns, spread suppression, and simplified grid
    behavior. There are no TradingView golden fixtures, first-divergence reports, removed-state
    snapshots, Absorbtion tests, current-bar rollback tests, or renderer tests.

12. **Medium — execution is synchronous and unversioned.**  
    Every accepted update can rebuild up to 12,000 bars on the main thread. There is no worker
    backpressure, cancellation, or authoritative source version.

### 11.2 Items investigated but not root causes

- **Wrong VAE signed-volume inversion:** the TS formula includes the Pine `*-1`, so its sign formula is
  structurally correct. Its input timeframe is wrong.
- **Visible-window reset:** calculation uses retained candles, not only the viewport. Pan/zoom does not
  reset state.
- **Shared buy/sell state:** the current VAE has no Absorbtion sides; the problem is missing model, not
  accidental sharing. A replacement must create separate call-site-equivalent states.
- **Worker race:** current VAE has no worker, so no existing worker race exists. Main-thread stalls and
  lack of cancellation are the actual risks.

## 12. Missing infrastructure

Parity requires these platform additions before the old implementation is removed:

1. `SymbolMetadata` with authoritative `tickSize`, asset class, timezone/session policy, and provenance.
2. A lower-timeframe history loader that retrieves normalized 1m OHLCV over the entire chart warmup.
3. Deterministic grouping of ordered 1m records into exact chart-bar-open buckets.
4. A realtime 1m stream/reconciler even when the visible chart uses another timeframe.
5. Missing/duplicate/out-of-order policies with diagnostic quality flags.
6. Closed versus provisional chart/intrabar revisions.
7. A worker protocol with source version, generation, cancellation, and disposal.
8. Committed/provisional indicator state snapshots.
9. Canonical Pine utilities for `na`, `nz`, ATR, SMA, nearest-rank percentile, binary search, array
   mutation order, and time boundary changes.
10. A serializable calculation model that contains active and violated state and does not contain
    Pixi objects.
11. Timestamp-based chart transform access for time gaps and future endpoints.
12. Pane/table/ratio render contracts and alert-event bridging.

## 13. Replacement and migration recommendation

### 13.1 Chosen option

Choose **A: in-place implementation replacement while preserving registry ID**.

Keep:

- `volatilityHeatmap` as the entitlement, workspace, and visible-indicator key;
- existing saved visibility;
- existing premium access behavior unless product requirements change.

Change:

- display name to “Stop Loss Clustering (Breakouts) [Kioseff Trading]” or a shorter UI name with full
  attribution in details;
- runtime label to the actual runtime;
- settings schema to both Pine models;
- calculation and rendering completely.

Migrate:

- old `period: 34` has no Pine meaning; preserve it in old snapshots but ignore it after migration and
  record a schema-version migration;
- visual color/intensity can seed equivalent Pine color/intensity fields where meaning is safe;
- absent settings receive Pine defaults;
- any old computed cells are discarded and rebuilt.

Do not:

- create two public indicators; the source is one indicator with a model setting;
- silently fall back to the old approximation when intrabars/tick metadata are unavailable;
- label the disconnected Python implementation as parity;
- overload the liquidation heatmap or order-book infrastructure.

If required inputs are unavailable, show a deterministic “Kioseff indicator unavailable” diagnostic
with the exact missing capability/source. A clearly labeled degraded preview may be a separate future
product decision, not parity mode.

### 13.2 Why not the alternatives

- **B, new ID plus alias:** adds migration complexity without technical benefit. The durable current
  ID is suitable and can safely host a complete replacement.
- **C, umbrella indicator:** semantically describes the Pine, but is effectively the same as option A
  if done behind the current ID. No new umbrella ID is needed.
- **D, separate indicators:** diverges from the original settings/model contract and duplicates
  settings, panels, attribution, and entitlement behavior.

## 14. Proposed implementation architecture

This is a repository-specific target architecture, not implementation authorization.

```text
KioseffHistoryCoordinator
  ├─ selected venue chart bars (10,000 target)
  ├─ selected venue 1m bars covering the same exact interval
  ├─ authoritative SymbolMetadata.tickSize
  ├─ provenance/quality report
  └─ ChartBarInput[] { chart candle, ordered intrabars[] }
        ↓ structured-clone / transferable arrays
KioseffWorkerClient
  ├─ generation + sourceVersion
  ├─ closed-bar checkpoint
  ├─ provisional current-bar replay
  ├─ reset(symbol/timeframe/settings/source)
  └─ dispose/cancel
        ↓
KioseffParityEngine (no DOM/Pixi)
  ├─ shared Pine math/collection/time utilities
  ├─ IQZZ state
  ├─ AbsorbtionSellState
  ├─ AbsorbtionBuyState
  ├─ VaeHigherState
  ├─ VaeLowerState
  └─ canonical KioseffRenderModel
        ├─ activeClusters[]
        ├─ violatedClusters[]
        ├─ qCurves[]
        ├─ paneSeries/events
        ├─ nearest clusters/totals/typical move
        ├─ table/ratio data
        └─ diagnostics/provenance
              ↓
Kioseff Pixi layers + pane renderer + React tables/settings
```

The engine should use integer tick indices for higher mode and exact input floats where Pine does.
All canonical records must include timestamps and stable deterministic IDs. Pixi objects must never
enter calculation state or worker messages.

## 15. Canonical serializable parity model

A suitable test/runtime contract is:

```ts
type KioseffSnapshot = {
  schemaVersion: 1;
  engineVersion: string;
  model: "absorbtion-extremes" | "volatility-at-entry";
  granularity?: "higher" | "lower";
  symbol: {
    exchange: string;
    rawSymbol: string;
    assetClass: string;
    tickSize: string;
  };
  timeframe: string;
  sourceVersion: string;
  committedThrough: number | null;
  provisionalBarTime: number | null;
  activeClusters: CanonicalCluster[];
  violatedClusters: CanonicalCluster[];
  qCurves: CanonicalCurve[];
  outputs: {
    buyStopsHit: number | null;
    sellStopsHit: number | null;
    buyStopsAverage: number | null;
    sellStopsAverage: number | null;
    nearestBuy: CanonicalNearest | null;
    nearestSell: CanonicalNearest | null;
    activeBuyTotal: number;
    activeSellTotal: number;
    violatedBuyTotal: number;
    violatedSellTotal: number;
    typicalBuyMove: number | null;
    typicalSellMove: number | null;
    radiateBuy: boolean;
    radiateSell: boolean;
  };
  pane: CanonicalPanePoint[];
  alerts: CanonicalAlertEvent[];
  diagnostics: CanonicalDiagnostic[];
};

type CanonicalCluster = {
  id: string;
  side: "buy-stop" | "sell-stop";
  state: "active" | "violated";
  signedVolume: number;
  price: number;
  priceLow: number;
  priceHigh: number;
  tickIndex: number | null;
  creationTime: number;
  startTime: number | null;
  violationTime: number | null;
  endTime: number | null;
  strength: "strong" | "weak" | null;
  hot: boolean;
  sourceCount: number;
};
```

Snapshots must use deterministic sort rules and either decimal strings or a documented float
tolerance. IDs must derive from model/side/price-key/creation sequence, not array position after
render filtering.

## 16. Testing and parity strategy

### 16.1 Fixture package

Each fixture must contain:

- exact normalized chart OHLCV;
- exact ordered one-minute OHLCV grouped by chart bar;
- source timestamps before normalization;
- symbol tick size, asset class, venue, and timezone/session policy;
- chart timeframe;
- Pine inputs;
- warmup start/end;
- historical final snapshots;
- a sequence of current-bar revisions;
- TradingView-exported expected outputs and internal debug operands where obtainable.

Required scenarios:

- 1m, 5m, 15m, 1h, and 1d charts;
- both Pine models;
- VAE higher and lower granularity;
- crypto and a noncrypto fixture;
- decimal and non-power-of-ten tick sizes;
- flat LTF closes;
- missing minute, duplicate minute, and out-of-order delivery;
- UTC daily transition with and without gap;
- cluster creation and same-intrabar violation;
- equality at wick/zone/tick boundaries;
- pruning thresholds;
- p95/top-five ties and zero volumes;
- no buy/no sell nearest result;
- IQZZ reversal and provisional extreme replacement.

### 16.2 Differential harness

For every chart bar:

1. initialize both engines from the same empty state;
2. feed identical chart candle and intrabars;
3. compare canonical active/violated stores after every intrabar where reference data permits;
4. stop at first divergence;
5. report bar time/index, intrabar time/index, collection operation, and before/after operands;
6. log ATR, signed volume, factor, projected price, tick key/bucket index, binary-search indices,
   removed range, top-five array, percentile, nearest-cluster candidates, and IQZZ state.

The harness must distinguish:

- expected floating tolerance;
- missing source input;
- algorithm divergence;
- render filtering difference.

### 16.3 Test layers

1. **Pine utility unit tests:** `na/nz`, history, ATR/SMA, percentiles, searches, array operations.
2. **Engine golden tests:** both models and granularity modes from normalized fixtures.
3. **Intrabar differential tests:** first-divergent-intrabar reporting.
4. **Realtime rollback tests:** repeated revisions equal one final historical execution.
5. **Reload determinism:** serialized input → identical canonical snapshot and hash.
6. **Reset tests:** symbol/timeframe/model/settings changes leave no prior state.
7. **Worker consistency:** worker and direct test execution produce identical snapshots.
8. **Race tests:** superseded generation can never replace a newer result.
9. **Render-model snapshots:** geometry/data, not only screenshots.
10. **Visual regression:** both panes, tables, zoom levels, DPI, resize, and dark theme.
11. **Zoom/pan invariance:** canonical state hash remains unchanged.
12. **Resource tests:** worker, Text, listener, timer, and container counts return to baseline.
13. **Performance benchmarks:** historical warmup, per-closed-bar update, provisional replay, render.
14. **Browser/Tauri parity:** normalized fixture path returns the same input hash.

Existing Python tests may remain as historical evidence while the approximation exists, but they must
not be counted as Kioseff parity certification.

### 16.4 Acceptance tolerances

- integer tick indices, collection sizes/order, timestamps, flags, and alert counts: exact;
- cluster volumes derived from integer/decimal fixture volumes: exact where representable, otherwise a
  documented tight tolerance;
- ATR/projection floats: tolerance derived from Pine serialization precision, never screen pixels;
- render geometry: deterministic numeric tolerance;
- screenshot comparison: secondary only.

## 17. Performance risks

| Risk | Cause | Mitigation/measurement |
|---|---|---|
| Large warmup payload | 10k chart bars plus up to millions of 1m bars | compact typed arrays, coverage limits, provenance, benchmark |
| Full recompute on every tick | path-dependent current bar | closed checkpoint + replay only provisional bar |
| Main-thread stalls | map/array/pruning and display aggregation | dedicated worker |
| Structured-clone cost | nested JS objects | transferable typed arrays or packed messages |
| Higher-map growth | 25k active/removed keys | exact Pine pruning, invariant tests |
| Absorbtion drawing explosion | gradient strips/glow/curves | batched Graphics, strict visible limits |
| Text churn | up to hundreds of labels | stable bounded pool |
| Worker races | rapid symbol/settings changes | generation/source version and termination |
| Mixed data revisions | history backfill during live execution | immutable source version and atomic reset |
| Memory leaks | workers, React overlays, Pixi children | resource gauges and mount/unmount soak |

Performance optimization must not change mutation order, bucket identity, pruning order, percentile
population, or realtime semantics. Establish correctness first with fixture-sized data, then optimize
behind canonical snapshot equivalence tests.

## 18. Licensing and attribution

This section is engineering guidance, not legal advice.

The supplied source carries MPL-2.0 and KioseffTrading copyright notices. MPL 2.0 is file-level
copyleft. Mozilla’s license text defines modifications to include source files containing covered
software; distributed source-form covered files and modifications must remain under MPL 2.0, notices
must not be removed, and recipients of executable form must be told how to obtain the corresponding
covered source. A larger work may remain under other terms for separate files.

Official references:

- https://www.mozilla.org/MPL/2.0/
- https://www.mozilla.org/MPL/2.0/FAQ/

Recommended engineering boundary:

- place translated Kioseff calculation logic in clearly separated source files;
- put the MPL Exhibit A notice or `SPDX-License-Identifier: MPL-2.0` in every covered file;
- retain `© KioseffTrading` and identify Black Terminal modifications/adapters accurately;
- keep generic worker transport, normalized market-data types, and renderer adapters in separate files
  that do not copy covered expression where feasible;
- add a third-party notice containing the indicator name, author, MPL version/link, modified status,
  and the location/method for obtaining covered source;
- ship a copy of MPL 2.0 with distributions that contain the covered implementation;
- ensure minified/browser and desktop distributions tell recipients where covered source is available.

Because this repository currently has no obvious root project license/notice governing the target
translation, formal legal review is prudent before distribution. Counsel should determine which
translated files are derivative/covered, whether any Pine-library import behavior affects the
translation, how source availability is provided for web and Tauri builds, and whether the indicator
name/branding raises separate trademark or permission questions. Do not claim that MPL alone grants
trademark rights.

## 19. Exact files expected to change after approval

The final list depends on implementation naming, but the smallest repository-specific scope is:

### Existing files

- `src/App.tsx` — settings defaults/schema migration and existing ID presentation
- `src/components/IndicatorLibrary.tsx` — name, runtime, settings metadata, attribution
- `src/components/PixiBlackChart.tsx` — history coordinator, settings panel, worker/render integration
- `src/chart-engine/types.ts` — replace obsolete period contract with migrated settings/render types
- `src/chart-engine/BlackChartEngine.ts` — remove old model integration; add bounded Kioseff Pixi model
- `src/market-data/types.ts` — symbol metadata, provenance, candle revision/quality contracts
- `src/market-data/marketCatalog.ts` — metadata shape where static entries remain
- `src/market-data/adapters/binance.ts` — tick-size filters and canonical 1m support
- `src/market-data/adapters/bybit.ts` — tick size and canonical 1m support
- `src/market-data/adapters/okx.ts` — tick size and canonical 1m support
- other enabled venue adapters if the indicator is advertised there
- `src/market-data/engine/marketDataEngine.ts` — normalized lower-timeframe acquisition/cache
- `src/market-data/cache/marketCache.ts` — provenance-aware bounded 1m history if shared
- `src/features/premium.ts` — display label only; durable key remains
- `src/components/AdminPanel.tsx` — display label only; durable key remains
- `src/indicator-runtime/types.ts` only if adopted as the canonical indicator protocol
- `docs/README.md` — documentation index
- `docs/PYTHON_INDICATORS.md` — correct the runtime story if Python is not used
- relevant test/package scripts in `package.json`

### New files/directories

- `src/modules/kioseff-stop-loss-clustering/core/*`
- `src/modules/kioseff-stop-loss-clustering/data/*`
- `src/modules/kioseff-stop-loss-clustering/workers/*`
- `src/modules/kioseff-stop-loss-clustering/rendering/*`
- `src/modules/kioseff-stop-loss-clustering/components/*`
- `tests/fixtures/kioseff-stop-loss-clustering/*`
- deterministic engine/differential/render/runtime tests
- MPL/third-party notice material for the covered files
- an implementation/parity document linked from the docs index

### Files to retire only after parity acceptance

- `src/chart-engine/heatmap/VolatilityHeatmapModel.ts`
- `src/builtin-python-indicators/volatility_at_entry_clusters.py`
- `tests/test_volatility_at_entry_clusters.py`

Retirement means deliberate removal or archival after the new engine passes go criteria. Neither
approximation should remain as an undocumented fallback.

## 20. Exact files that must not change

Unless a separately reviewed requirement proves otherwise, implementation must not modify:

- durable indicator key `volatilityHeatmap` in existing workspace/user/Supabase records;
- historical Supabase migration files:
  - `supabase/migrations/202607190003_phase5_security_fortress.sql`
  - `supabase/migrations/202607220002_remove_book_heatmap.sql`
- unrelated OMS/EMS, broker, execution, copy-trading, investor, social, messaging, Obsidian, DOM Pro,
  and A.I.F. calculation modules;
- existing user workspace snapshots in place;
- exchange private credential or order-execution code;
- the supplied original Pine source/attribution;
- generated performance and visual-regression baselines unrelated to this indicator.

If database defaults need a new display/schema field, add a new forward migration; never rewrite old
migrations.

## 21. Open questions

1. Can KioseffTrading or the user provide TradingView exports for both models and both VAE
   granularities using identical OHLCV?
2. What exchange/symbol/timeframe will be the initial parity certification target?
3. Can the exact TradingView data vendor/venue be matched, or will parity be defined against normalized
   supplied fixtures?
4. How should missing one-minute bars be represented: reject, explicit empty interval, or deterministic
   zero-volume carry? Pine/provider behavior must guide this.
5. Does TradingView’s current `request.security_lower_tf()` return provisional arrays in a way that
   changes during the open chart bar for the target plan/data feed?
6. What exact `chart.point` object-history/reference behavior is observed around IQZZ updates?
7. Are `time("", -200)` and `time("", -250)` future timestamps available on every target timeframe,
   and how should the renderer project unavailable future sessions?
8. Should pane/table/ratio outputs be visible exactly by Pine defaults or adapted responsively on small
   screens?
9. Is the premium entitlement intended to remain?
10. Which platforms must ship in phase one: browser, Linux/Windows Tauri, mobile?
11. What source-distribution mechanism will satisfy MPL obligations for shipped covered files?
12. Has counsel approved the translated-file boundary, attribution wording, and product name?

## 22. Go/no-go criteria

### Go to implementation

- full Pine source and attribution are preserved;
- authoritative tick size is available for the certification symbol;
- exact 1m history covers the complete warmup interval;
- intrabars are grouped and ordered deterministically;
- history and realtime use one certified source/provenance;
- canonical calculation/render model is approved;
- committed/provisional worker contract is approved;
- TradingView golden fixtures exist for both models;
- MPL distribution plan has been reviewed.

### No-go to replace the old entry

- any certification fixture uses chart bars as fake intrabars;
- tick size falls back to `0.01` or an ATR/price-derived grid;
- history and realtime silently use different venues;
- only the VAE model is implemented;
- current-bar state cannot be rolled back/replayed;
- removed clusters, pane outputs, or summaries are omitted while claiming full parity;
- only screenshots are used as proof;
- old approximation remains as a silent fallback;
- covered source/attribution distribution is unresolved.

### Acceptance to ship

- zero unexplained canonical divergences across approved fixtures;
- realtime-final state equals historical recomputation;
- worker/direct execution hashes match;
- symbol/timeframe/model/settings resets are clean;
- zoom/pan does not change state hash;
- no stale generation can render;
- performance stays within an approved frame/latency/memory budget;
- browser/Tauri normalized inputs and outputs match;
- resource leak soak passes;
- license/notice checklist passes.

## 23. Proposed implementation phases

These phases define dependency order only; no phase is authorized by this audit.

1. **Fixture and legal gate** — freeze Pine source, inputs, reference exports, source provenance, and
   attribution/source-availability plan.
2. **Market metadata** — add exact tick size, asset class, source and session/day metadata.
3. **Intrabar infrastructure** — 1m history/realtime loader, grouping, quality rules, normalized
   fixture serialization.
4. **Pine semantic kernel** — `na/nz`, series/history, collections, ATR/SMA, percentiles, time changes.
5. **Absorbtion engine** — IQZZ, independent side states, volume transfer, violations, typical moves.
6. **VAE engine** — shared intrabar loop, higher and lower granularity, removed stores, gaps, pruning.
7. **Transactional worker runtime** — committed/provisional state, generation/source versions,
   cancellation, reset/disposal.
8. **Canonical outputs and differential harness** — snapshots and first-divergence diagnostics before
   UI integration.
9. **Rendering and UI** — Pixi zones/curves/pane plus React settings/table/ratio, bounded resources.
10. **Migration** — preserve `volatilityHeatmap`, migrate schema, remove obsolete period meaning.
11. **Certification** — parity, reload, reset, pan/zoom, race, performance, memory, browser/Tauri.
12. **Cutover** — remove both approximations, update docs/notices, enable only for certified sources.

## 24. Final audit conclusion

Black Terminal has a strong enough chart/render foundation and a useful worker precedent to host this
indicator, but the current VAE should be regarded as a visual approximation, not an implementation of
the supplied source. The decisive work is to establish a deterministic lower-timeframe data contract
and Pine-compatible state lifecycle. Once those are present, the safest product migration is a
complete in-place engine replacement behind `volatilityHeatmap`, with both source models, explicit
MPL attribution, canonical parity snapshots, and no silent fallback.

