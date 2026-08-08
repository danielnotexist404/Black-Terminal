# BCLIF Entry-Price Distribution

`CohortEntryDistribution` is bound to one explicit OI interval and contains at most 16 deterministic price rows. Weights are finite, non-negative, sum to one within `1e-9`, and are covered by a stable FNV-1a content hash.

Evidence priority is:

1. `EXACT_TRADES`;
2. `LOWER_TF_VOLUME_AT_PRICE`;
3. `LOWER_TF_APPROXIMATION`;
4. `CHART_BAR_APPROXIMATION`.

The browser adapter requests canonical five-minute Bybit candles independently of chart timeframe, bins lower-timeframe volume across the exact OI interval, and uses a lower-confidence approximation when historical public trade ticks are unavailable. The collector canonical-frame path can construct an exact trade-at-price histogram from the in-memory historical/live trade stream.

Source authority caps are 0.95, 0.82, 0.60, and 0.42 respectively. Historical missing/unavailable trades impose an additional hard 0.60 browser authority cap. Renderer controls cannot raise these model caps.

The distribution interval must equal the frame's OI interval. A price delta without explicit interval provenance cannot create a cohort. Future trades, chart swings, and viewport state are never read.
