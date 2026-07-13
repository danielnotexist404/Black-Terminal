# A.I.F. Data Quality and Provenance

Every profile carries venue, symbol, market type, timeframe, source type/resolution, lens/version, bucket method, allocation method, engine version, calculation time, and coverage.

Coverage always distinguishes:

- requested lookback
- effective lookback
- available bars
- calculation start/end
- missing intervals
- coverage percentage
- whether and why the request was clamped

Source preference is classified trades, trades, one-second candles, lower-timeframe candles, then chart candles. The current browser integration receives normalized venue candles and therefore marks price-path-dependent calculations `estimated`. A 20,000-bar request that receives 12,483 bars displays both numbers and `HISTORICAL COVERAGE LIMIT`.

IMM absence is reported as unavailable. Absorption absence is reported as blocked data. Neither becomes a neutral or false confirmation.
