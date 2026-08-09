# BCLIF Authentic Exposure Reconstruction

Chapter III-C3 replaces the swing-following V4 hypothesis with `BCLIF_MODEL_V5_AUTHENTIC_EXPOSURE`. BCLIF remains an estimated public-data model: it does not claim access to trader accounts, exact leverage, collateral, or cross-margin equity.

## Causal chain

1. A chart-independent Bybit OI observation defines an explicit interval. Browser history uses canonical five-minute samples; the persistent live collector uses timestamped ticker observations available on its own event clock.
2. `BCLIF_ROBUST_OI_CHANGE_V1` removes immaterial changes.
3. A material positive delta creates equal LONG and SHORT gross hypotheses.
4. Trade-at-price, lower-timeframe volume, or an explicitly named fallback distributes entry probability within that OI interval.
5. Entry rows are crossed with versioned leverage and margin/risk-tier hypotheses.
6. Bybit linear-perpetual liquidation distributions are calculated once from entry evidence.
7. Cohorts persist on the independent event clock and only lose mass through documented lifecycle transitions.
8. The stable price lattice rasterizes those fixed distributions into horizontal shelves.
9. A worker projects the authoritative field and prepares one upload-ready RGBA texture.

Price, chart timeframe, viewport, and moving-average/swing state cannot create cohort mass. Current price is used only for distance, traversal, cascade context, and display placement.

## Authority

The repository implements V5 for browser fallback and the collector model runtime. Current production truth remains:

- repository complete;
- persistent host not provided;
- collector not deployed;
- migrations not applied;
- browser fallback active.

Browser fallback is labeled `OI-DERIVED LIQUIDATION CONTEXT`, is capped at 60% for historical OI-only entry evidence, and cannot be described as observed multi-week liquidation inventory.

## Main implementation

- `core/cohortEngine.ts`: deterministic births, closures, liquidation assimilation, traversal, decay, mass ledger.
- `core/entryDistribution.ts`: interval-bound, normalized, content-hashed entry distributions.
- `core/oiMateriality.ts`: versioned hybrid noise floor.
- `data/bybitPublicData.ts`: canonical five-minute OI clock and lower-timeframe entry approximation.
- `core/exposureRaster.ts`: stable grid, causal raster, immutable historical columns.
- `core/operationalClusters.ts`: price-local shelves, specificity metrics, cohort attribution.
- `rendering/displayProjectionWorker.ts`: off-main-thread projection and RGBA preparation.

The pre-change cause and evidence trail are recorded in `BCLIF_SWING_FOLLOWING_ROOT_CAUSE_AUDIT.md`.

## Chapter III-C4 superseding refinement

V6 retains the C3 absolute entry/liquidation math and adds event-level OI
windowing, a controller-generation absolute grid, expanding causal
normalization, and raw shelf/export diagnostics. Related positive OI points no
longer each create a family. Price crossing without a confirmed liquidation or
OI contraction no longer removes an arbitrary 10% of mass. The current
contract and production-path evidence are in
`BCLIF_LIVE_PIPELINE_FORENSIC_AUDIT.md` and
`BCLIF_CHAPTER_IIIC4_COMPLETION_REPORT.md`.
