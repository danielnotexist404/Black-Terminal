# BCLIF OI Birth–Death Model

For canonical single-side open interest `OI_t`:

`delta = OI_t - OI_(t-1)`

- material positive delta: create equal long and short quote-notional hypotheses;
- material negative delta: remove mass from existing cohorts;
- flat or immaterial delta: create no mass;
- missing OI: invalidate confidence/coverage and do not treat it as zero.

The default `BCLIF_ROBUST_OI_CHANGE_V1` threshold is the maximum of:

- USD absolute floor: $100,000 converted to base quantity at mark;
- OI percentage floor: 0.0075%;
- robust floor: 3.5 × scaled MAD of the last 96 absolute OI deltas.

All inputs are configurable and validated. The materiality decision stores raw delta, effective delta, threshold, method, version, and material flag.

Positive OI is paired gross market exposure. BCLIF creates the same gross quote notional for both side hypotheses; aggressive flow may influence contextual priors but cannot turn a matched-contract expansion into a one-sided birth. This paired representation is not a claim that exchange OI should be doubled for reporting—each side is a probabilistic liquidation hypothesis over the same matched contracts.

The optional hidden-turnover research mode requested by the chapter is intentionally not enabled or implemented as production mass. Flat OI therefore remains zero net cohort birth.
