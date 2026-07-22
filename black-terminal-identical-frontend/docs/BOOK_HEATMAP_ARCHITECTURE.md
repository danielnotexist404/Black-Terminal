# Book Heatmap Architecture

Status: production implementation, July 2026

This document defines the main-chart Book Heatmap and its fullscreen workspace. It does not describe or modify DOM Pro+. The two products remain separate.

## Truth contract

The workspace exposes three mutually explicit data classifications.

| Mode | What is rendered | Provenance | What it must never imply |
| --- | --- | --- | --- |
| Live Book Liquidity | Observed resting bid/ask notional from normalized public order-book snapshots and deltas | Venue, normalized symbol, venue source time, receive time and sequence/update ID where supplied | A resting order is not a liquidation and may be cancelled |
| Estimated Liquidations | Model-derived concentrations from exchange candles, traded volume, volatility and explicit leverage-tier assumptions | The chart's real market series plus documented assumptions | The bands are not exchange-reported liquidation orders or guaranteed liquidation prices |
| Confirmed Liquidations | Individual public liquidation events | Bybit `allLiquidation.{symbol}` and Binance `<symbol>@forceOrder` event streams | An event marker is not resting book liquidity or a prediction |

Missing history remains empty. The UI reports collecting, unavailable, stale, invalid or resynchronizing states instead of projecting the newest book backward or drawing decorative fallback bands.

## Data path

```text
Venue public REST/WebSocket
  -> MarketDataAdapter snapshot/delta reconstruction
  -> normalized OrderBookSnapshot
  -> BookHeatmapWorkerClient
       one in flight + one latest pending snapshot per venue
  -> bookHeatmapWorker / bookHeatmapProcessor
       integrity checks, unit certification, price buckets, quote notional
  -> OrderBookHeatmapModel
       isolated venue frames, bounded time-price memory, analytics, LOD
  -> BlackChartEngine
       shared candle time/price transforms and Pixi raster
  -> main-chart overlay or fullscreen Book Heatmap workspace
```

Ingestion and rendering have independent cadence. The worker compacts levels into transferable `Float64Array` triples containing price, bid notional and ask notional. Superseded queued snapshots are dropped with an explicit backpressure counter; one busy venue cannot remove another venue's queue slot.

## Venue support and normalization

### Certified live/consolidated production view

- Bybit and Binance are selectable in the consolidated workspace.
- Both sources expose base-asset quantity for the supported BTC/USDT-style normalized books. The processor converts every level to quote notional with `price * base quantity` before aggregation.
- A Book-Heatmap-only Binance source reconstructs a local book from a REST snapshot plus buffered WebSocket deltas. It ignores obsolete events and restarts snapshot bootstrap when futures `pu` continuity or the initial update range is invalid. It preserves the exchange update ID without changing the shared adapter used by DOM Pro+.
- The existing Bybit adapter reconstructs the local book from the exchange's initial snapshot and subsequent insert/update/delete deltas. A later exchange snapshot replaces the entire local book. Source `u` and `seq` are preserved. Bybit does not document `seq` as a contiguous per-topic counter, so the Book Heatmap rejects duplicate/regressing observations but does not invent a gap rule that the venue does not guarantee.
- Venue books remain isolated until the model consolidates equivalent price buckets. Consolidated cells retain each venue's bid and ask contribution.

### Additional normalized adapters

- Binance US and Hyperliquid base-quantity snapshots are accepted by the unit-certification processor when used as the current chart venue. They are not exposed in the two-venue consolidated selector in this release.
- Hyperliquid's public L2 channel supplies complete book states rather than an incremental sequence contract; sequence diagnostics are therefore unavailable for that source.
- OKX perpetual quantities are contract quantities. Because contract value and multiplier are not yet carried through the shared normalized snapshot contract, OKX is deliberately rejected as `uncertified_quantity_unit`. Raw contracts are never merged with base quantity.

No L3 order IDs are claimed. The feature is authentic L2 depth unless a future adapter supplies and certifies L3 identity.

## Integrity and recovery

The adapter and model layers reject or surface:

- invalid timestamps, prices and quantities;
- duplicate price levels;
- empty or crossed books;
- duplicate or regressing sequences;
- source-time regression;
- stale observations beyond the configured freshness window;
- uncertified quantity units;
- worker backpressure drops.

The model keeps venue state separately. A stale, invalid or resynchronizing venue is excluded from active consolidated cells, while healthy venues continue. UI diagnostics expose source venue, source/receive latency, live-frame count, historical-cell count, accepted/rejected/stale/backpressure counts and per-venue state.

WebSocket failures cleanly close the affected subscription and use the adapter's bounded REST heartbeat fallback. Symbol, exchange, timeframe, workspace and route cleanup abort history requests, unsubscribe feeds, clear timers and terminate the dedicated worker.

## Historical depth

The browser retains a bounded live ring; it is not the permanent collector. Authenticated historical tiles are requested from `/api/market-depth/tiles`, and the response is accepted only when it identifies `black-core-market-depth-memory` as its source. The client limits each response to 5,000 cells, while the model caps the combined local historical set at 20,000 cells.

Long-running collection belongs to the existing supervised Black Core Market Depth Memory worker and its indexed, retention-bounded Supabase storage. Vercel serverless functions are request/response gateways only; they are not permanent exchange WebSocket collectors.

History requests are source-checked, abortable and throttled by venue/symbol/horizon/price band. A missing session, unavailable service, empty tile range or pre-collection time range is shown honestly. The latest live book is never stretched over those gaps.

## Time-price memory and rendering

- X coordinates use the same fractional candle-time index as candles and all other chart geometry.
- Y coordinates use the chart's authoritative price transform.
- Prepending candle history reindexes both live and historical observations by timestamp.
- Live frames default to a 1,200-frame hard bound and are configurable only inside a 60–7,200 range. Correlated trades are capped at 5,000.
- LOD limits observation columns for wide views while retaining the original time positions; skipped columns are not stretched.
- Historical cells are rendered from their real start/end buckets. Live cells begin only at their observation time.
- Robust percentile, adaptive, logarithmic and linear intensity modes prevent one outlier from flattening the entire display.
- The blood-red palette progresses from deep red through crimson/orange to silver-white. Glow is reserved for exceptional concentrations.

The main overlay and fullscreen workspace are rendered by Pixi rather than per-cell React elements. Opacity, visual smoothing, visibility threshold, palette, history horizon, visible price range, source mode and venue selection are user-controlled.

## Camera and indicator coexistence

The Book Heatmap owns no parallel chart camera. It consumes `BlackChartEngine`'s existing time and price transforms.

- Magnet/live-follow enabled: the newest candle remains aligned to the right anchor.
- Magnet/free-explore enabled: negative horizontal scroll permits room to the right of the newest candle.
- Pan, wheel zoom, history prepend, reset camera and responsive resize use the same transforms for candles, Book Heatmap, HDLX, AIF, drawings, alerts and other overlays.
- Changing Book Heatmap mode or opening its workspace does not toggle Book Heatmap, Volume or another indicator.

Stored workspaces use schema version 2. Migration merges new settings onto safe defaults while preserving explicit old visibility values. Book Heatmap and Volume both default to disabled.

## Explainable analytics

For consecutive observed book states, the model derives:

- wall persistence and lifetime;
- stacking and pulling notional;
- side imbalance;
- replenishment and iceberg probability heuristics;
- spoof-risk heuristic;
- aggressive-trade correlation near the same time/price bucket;
- estimated consumed versus cancelled notional;
- absorption score;
- venue agreement/divergence through retained venue contributions.

Inputs and confidence are carried on each cell. Consumed/cancelled attribution uses a time/price correlation with public aggressive trades and is displayed with an estimate marker; L2 cannot prove whether a reduction was a fill, cancellation or queue replacement. Heuristics never receive 100% confidence or a confirmed label.

Estimated liquidation cells are separately classified `ESTIMATED LIQUIDATION`, cap confidence below 1, and list price, volume, volatility and leverage assumptions as inputs. This release does not yet include synchronized open-interest and funding history, so its UI explicitly limits confidence.

Confirmed liquidation events are stored in a separate 5,000-event ring and rendered as discrete markers. The tooltip identifies venue, liquidated side, event price meaning, notional and exact event time. They never enter the resting-liquidity matrix.

## Security and privacy

- Public market feeds require no user exchange credentials.
- Historical tiles require the current Supabase access token and an authenticated Black Terminal session.
- No token, password, provider key or private endpoint is stored in fixtures or browser output.
- `perpdexwars.com`, Coinglass and other third-party heatmap products are not runtime dependencies.
- The hardened local reference project informed representation and rendering concepts only; its code and external services are not shipped.

## Bounded resource ownership

| Resource | Bound / cleanup |
| --- | --- |
| Worker work | One in flight, one latest queued snapshot per venue; superseded work counted |
| Live book frames | Configured hard ring, default 1,200 |
| Historical cells | 20,000 model cap; 5,000 requested per venue response |
| Correlated trades | 5,000 |
| Confirmed events | 5,000 with ID deduplication |
| WebSockets/timers | Unsubscribed or cleared on dependency change and unmount |
| Worker | Terminated on engine destruction |

## Verification

Deterministic suites cover model integrity, duplicate/regressing/stale data, notional conversion, venue consolidation, no backward projection, historical gaps, wall/stack/pull analytics, trade correlation, ring bounds, worker latest-wins/fairness, recorded Bybit/Binance/OKX fixtures, liquidation parsers, shared fractional camera alignment, prepend reindexing, magnet behavior, settings migration and indicator defaults.

The visual regression harness records 11 authenticated local chart/workspace states at 1920×1080: normal, thin, wall/outlier, partial history, free camera, estimated, confirmed, venue disagreement, resynchronizing venue, zoomed in and zoomed out. It fails on runtime/console errors, forced Volume activation or a forbidden third-party request.

The 50,000-snapshot bounded soak uses 200 levels per side and asserts a 600-frame hard ring, non-empty rendering, average compaction under 4 ms, cell construction under 1.5 seconds and retained heap delta under 192 MB. The latest measured results are recorded in `BOOK_HEATMAP_IMPLEMENTATION_HISTORY.md`.

## Remaining factual limitations

1. Historical depth can begin only when the Black Core collector has observed and retained it; pre-collection periods remain empty.
2. OKX perpetual contract-size normalization is not certified and is rejected.
3. The estimated liquidation model does not yet have synchronized historical open interest and funding inputs.
4. Confirmed liquidation events are retained only for the active browser session; persistent confirmed-event history is not yet available.
5. L2 reductions cannot prove execution versus cancellation. Those fields remain estimates.
6. Bybit cross-sequence is an ordering signal, not a documented contiguous counter; the adapter does not fabricate a numeric gap rule.
7. Hyperliquid's current normalized feed supplies complete states without source sequence metadata.
8. No source is represented as L3 unless order identity is added and certified in a future adapter.

## DOM Pro+ isolation

DOM Pro+ files, workers, aggregation, state, camera, styles, tests, presets, documentation and shared venue adapters are unchanged. Binance sequence-aware reconstruction is isolated in the Book Heatmap module. Book Heatmap uses only the main chart indicator/workspace architecture. Existing DOM Pro+ regression suites are run as compatibility gates, and the final diff must contain zero DOM Pro+ paths.
