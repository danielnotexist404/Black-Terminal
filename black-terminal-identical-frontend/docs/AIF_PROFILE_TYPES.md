# A.I.F. Profile Types

## Production Lenses

| Lens | Question | Calculation | Quality |
|---|---|---|---|
| Volume | Where did volume accumulate? | Conserved OHLC range-overlap allocation | Estimated price path; source volume conserved |
| Delta | Where did buy/sell aggression dominate? | Proportional body, close-location and wick estimate | Estimated until classified trades exist |
| TPO | Where did price repeatedly auction? | Configurable source-period range visits | Estimated from candle ranges |
| Volatility | Where did instability or compression concentrate? | True range, log variance, Parkinson or composite | Estimator/allocation disclosed |
| Pressure | Where did proportional directional pressure concentrate? | Body, close location, wicks and volume | Estimated OHLCV composite |

Absorption is registered but hidden as `blocked-data`. It requires classified aggressive flow plus displacement and preferably persistent IMM refill/wall context.

## Shared Mathematics

Primary and secondary profiles normally share one AuctionDomain so price rows align. Volume allocation uses exact overlap weights normalized back to each candle's source amount. Zero-range candles occupy one close-price bucket. Value area expands from POC by adjacent absolute contribution until 70% is represented.

Bucket modes include fixed rows, fixed price/tick size, percentage, logarithmic, ATR-normalized and adaptive multi-resolution. ATR mode derives row scale from historical true range; adaptive mode derives bounded resolution from source length.

## Interpretation Boundary

The framework reports structural evidence, confidence, quality, and provenance. It does not call estimated delta "true delta," does not turn every node into S/R, and does not generate a trade instruction.
