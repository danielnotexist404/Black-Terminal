# BCLIF Cohort Anchoring

A cohort's immutable anchor is the evidence package that created it:

- source OI interval;
- entry distribution and hash;
- leverage-prior version;
- public Bybit risk-tier hypothesis;
- margin-mode hypothesis;
- V5 model version.

Liquidation means and uncertainty are calculated from each entry row × leverage bucket × margin hypothesis. The current mark is not an entry substitute and does not recenter an existing cohort. Funding adjustment is currently `0 bps`; BCLIF does not claim a funding-driven liquidation shift until a separately tested causal funding model exists.

The authoritative browser grid uses origin zero, the instrument tick, a deterministic nice step, the first canonical source frame, and version `BCLIF_ANCHORED_NICE_STEP_V2`. Later swings and appended data cannot move earlier price rows. Chart Scale is a display projection only; Full Spectrum exposes the same authoritative model range.

Shelf drift acceptance is $0 for unchanged cohorts, excluding future explicitly versioned funding/collateral adjustments.
