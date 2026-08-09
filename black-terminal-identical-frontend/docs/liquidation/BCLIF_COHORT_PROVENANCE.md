# BCLIF Cohort Provenance

`BCLIF — Cohort Provenance` is an optional diagnostic mode. It is off in the normal trading view and enabled by the repository-owned provenance fixture.

Every model-built operational shelf carries:

- stable shelf ID and price range;
- contributing cohort count and IDs;
- cohort birth time and source OI interval;
- entry range, distribution source, and distribution hash;
- leverage and risk-tier distributions;
- isolated/cross/unknown margin hypotheses;
- remaining notional, survival, confidence, and evidence channels;
- last lifecycle event and the explicit reason for creation;
- concentration, prominence, width, persistence, entropy, and overlap count.

The shelf extractor only reports 100% provenance when at least one compatible cohort distribution overlaps the shelf envelope. Birth markers are subtle chart overlays and appear only when `cohortBirthMarkersVisible` is enabled.

Stable cohort identity is derived from venue, symbol, side, OI interval start/end, entry-distribution hash, leverage-prior version, and model version. Rebuilds, chart timeframes, and viewports therefore cannot generate new IDs.

For a verified persistent raster lacking a V5 cohort sidecar, the UI must not invent cohort IDs: it shows `NO COHORT SIDECAR`/`UNAVAILABLE`, and such a region cannot qualify as fully attributable provenance. No V5 persistent production tile is claimed because the collector is not deployed.

Certification: `COHORT_PROVENANCE` must have a visible detail panel, non-zero attributable shelves, and `provenanceCoverage === 1` at 1920×1080, 2560×1440, and 3840×2160.
# Chapter III-C4 provenance extension

The V6 raw export exposes `BCLIF_ABSOLUTE_RAW_EXPOSURE_V1`. Every shelf names
its cohort ID, side, birth/source interval, entry source/range, absolute
liquidation range, remaining mass, confidence, margin mode, and full leverage
distribution. The 20-cell audit joins high raw cells back to overlapping
cohorts and reports raw/global/column values, cohort ages, leverage
contributions, entry sources, and margin modes. Column percentile is diagnostic
only and cannot authorize color.
