# BCLIF Persistence Gap Audit

Audit baseline: Git commit `921c7a2`, model `BCLIF_MODEL_V3`, 2026-08-05.

## Already complete

The repository already contains Bybit linear-perpetual liquidation math, risk-tier handling, paired OI cohorts, leverage particles, survival/decay, observed liquidation assimilation, confidence scoring, a Web Worker raster path, and a single-texture Pixi renderer. Public REST endpoints provide bounded historical OI, funding, account-ratio, and mark/index-kline context. Ticker, instrument, and risk-tier adapters provide current snapshots only; they do not create a pre-collector historical rule archive. Browser-session public trades, all-liquidation events, and L2 book updates are observed without fabricating unavailable history.

## Browser-owned and ephemeral before Chapter III-C

`LiquidationFieldController`, `BybitLiquidationStream`, and the raster worker started only while an eligible chart was open. Trade aggregates, confirmed liquidations, reconstructed depth, cohorts, particles, source continuity, and rendered snapshots lived in browser memory. Closing the chart discarded that state. The browser-open duration was used as an approximate event-coverage clock and was not persistent coverage.

## Existing persistence boundary

Migration `202608050001_bclif_liquidation_intelligence_foundation.sql` defines a useful service-only foundation: sources, coverage, observed liquidations, field-chunk metadata, evaluations, and a private binary bucket. It was intentionally not applied. It lacks collector identity, offsets, canonical event chunks, checkpoints, multi-horizon coverage keys, immutable versioned tiles, supersession, retention, and calibration outcome records. It therefore cannot be activated safely by itself.

## History that cannot be reconstructed honestly

Historical public trades, exact order-book deltas/frames, confirmed liquidation events, instrument changes, and risk-tier changes that were not collected at the time are unavailable. Applying a current rule snapshot to older baseline context is explicitly estimated, not historically observed. OHLCV and OI must not be relabeled as missing sources, and the latest browser field must not be stretched backward. Complete three-week coverage can begin only after a persistent collector accumulates continuous source history or a verified equivalent observed archive is introduced.

## Safe shared interfaces

The collector can directly reuse the common liquidation model, leverage priors, certainty scoring, cohort engine, settings, and deterministic fixtures under `src/modules/liquidation-field/core`. The cohort engine now exposes a versioned validated state contract so browser tests and the collector use one model authority. The Pixi renderer remains a consumer and does not become a persistence writer.

## Required persistent ownership

The separate `LIQUIDATION_INTELLIGENCE_NODE_01` service must own public-source collection, deduplication, source offsets, canonical event chunks, chronological frame cutoffs, cohort state, checkpoints, immutable numerical tiles, compaction, coverage, health, and calibration evidence. When verified persistent tiles exist, the client must consume them without starting a competing full-range browser model. The existing browser path remains explicitly labeled fallback only.

## No-lookahead findings

The baseline used whole-field quantiles and symmetric time smoothing, allowing future columns to affect historical color intensity. It also derived one price envelope and sampled columns from the complete requested input. Chapter III-C therefore requires causal normalization/smoothing and immutable fixed-coordinate tiles. Risk tiers and source values must be applied only after their known-at timestamps. Late events are archived for calibration but cannot rewrite finalized history.

## Deployment boundary

No dedicated IMM/BCLIF host, environment manifest, container deployment, or node inventory exists. Supabase and Vercel are not substitutes for an always-on analytics daemon, and the Black Cloud execution node is explicitly excluded. The truthful target is:

```text
REPOSITORY COMPLETE
PERSISTENT HOST NOT PROVIDED
COLLECTOR NOT DEPLOYED
MIGRATION NOT APPLIED
BROWSER FALLBACK ACTIVE
```
