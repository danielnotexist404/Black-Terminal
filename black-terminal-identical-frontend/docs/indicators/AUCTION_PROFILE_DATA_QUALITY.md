# Auction Profile Data Quality

The dashboard reports requested/loaded bars, exact trade coverage, lower-timeframe approximation, chart-bar approximation, unknown aggressor share, source mix, build time, row count, and profile hash.

Quality labels:

- EXACT: at least 99% of chart intervals have certified aggressor trades;
- HIGH: at least 80%;
- MIXED: some certified trades plus fallback;
- APPROXIMATE: only bar-derived allocation;
- INSUFFICIENT: no usable source.

Coverage is counted by chart interval, not by drawing width. Hybrid aggregation skips bar fallback for intervals already covered by exact trades, preventing double counting. The application never relabels candle-direction estimates as real CVD.
