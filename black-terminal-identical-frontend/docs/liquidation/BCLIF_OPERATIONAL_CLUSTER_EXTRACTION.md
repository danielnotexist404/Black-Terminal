# BCLIF Operational Cluster Extraction

Operational clusters are a ranked read model built from the existing exposure snapshot. They do not create or alter cohorts.

For long- and short-liquidation sides independently, the extractor builds a 24-column recency-weighted price profile. Candidate peaks must exceed 10% of the side maximum, be local maxima, and be on the economically valid side of mark (long-liquidation shelves below; short-liquidation shelves above). The range expands from the peak while adjacent exposure remains at least 42% of peak. Overlapping candidates on the same side are deduplicated.

Confidence, persistence, cohort survival, observed liquidation notional, prominence, and distance are retained. Estimated exposure is shown as an explicit ±18% display interval, not an exact promised liquidation size.

Rank score is:

```text
0.28 × log exposure
+ 0.22 × confidence
+ 0.14 × prominence
+ 0.10 × persistence
+ 0.10 × cohort survival
+ 0.10 × observed liquidation support
+ 0.06 × proximity
```

State is `TRIGGERED` when an observed event is inside the range; otherwise recent intensity determines `STRENGTHENING`, `DECAYING`, `FORMING`, or `ACTIVE`.

Default label selection takes nearest above mark, nearest below mark, strongest ≥75% confidence above, strongest ≥75% confidence below, then fills by rank. Duplicates are removed and the default hard maximum is four. Labels include side, price range, estimated exposure interval, confidence, and distance context through the dashboard.
