# BCLIF Swing-Following Root-Cause Audit

Status: completed read-only audit before Chapter III-C3 model edits
Baseline: `fff9cc4` (`BCLIF_MODEL_V4_CAUSAL`)
Authority audited: browser fallback and undeployed persistent-collector path

## Finding

The rectangular, swing-following field is not one renderer defect. The primary causal defect is cohort entry construction: every positive OI sample is converted into a new paired cohort whose complete entry hypothesis is centered on the market frame's current mark price. Neither path constructs an interval-specific trade-at-price distribution. In browser fallback, sparse OI observations are projected onto the chart candle stream and the receiving candle supplies the mark/close anchor. The selected BCLIF horizon also changes Bybit's OI sampling interval. Consequently chart timeframe, horizon, fetch window, and refresh boundaries can change the frames on which OI is consumed and therefore change cohort entry prices and IDs.

Four amplifiers make the defect visually dominant:

1. There is no OI materiality/noise threshold, so every positive fluctuation creates two cohorts.
2. Browser fallback rebuilds the complete cohort engine from a rolling candle/OI window on refresh instead of maintaining independent inventory state.
3. Browser causal normalization defaults to a one-column window, giving each new column locally strong contrast even when its absolute exposure is weak.
4. Unknown/cross-margin particles are broad, and optional raster smoothing can widen them further. The visual result is a sequence of wide, similarly normalized envelopes around successive price regions.

The GPU renderer does not create cohorts or move liquidation prices. Viewport-dependent projection changes only the displayed crop and resampling. The defect exists in model input construction and cohort birth before the texture is created.

## Lifecycle trace

| Stage | Source and function | Input → output | Clock / anchor | Persistence and causality |
|---|---|---|---|---|
| Browser OI retrieval | `src/modules/liquidation-field/data/bybitPublicData.ts` — `bootstrapBybitLiquidationField` | Bybit OI rows + chart-engine candles → `LiquidationMarketFrame[]` | OI interval is selected from BCLIF horizon; each OI value is carried over to chart candle timestamps; delta appears on the first receiving candle | Rebuilt from the current requested horizon on every refresh. Chart timeframe changes candle timestamps and prices. Viewport is not read directly, but loaded chart history is the supplied model source. |
| Persistent OI retrieval | `server/liquidation-intelligence/sources/bybitOpenInterest.ts` and collector polling | Bybit OI observation → canonical `BclifOpenInterestPoint` | Source observation timestamp/availability clock | Historical observations are baselines only; live observations may advance cohort state. Durable event/checkpoint infrastructure exists but is not deployed. |
| Persistent OI consumption | `server/liquidation-intelligence/normalization/canonicalFrame.ts` — `consumeOpenInterestObservation`; collector `processFrameAt` | Current and last-consumed OI → one frame delta | Independent collector cadence; a reused observation produces zero delta | Correctly prevents one poll result from creating repeated cohorts. No chart timeframe, swing, or viewport dependency. |
| OI delta | Browser bootstrap loop / `buildCanonicalFrame` | `OI_t - OI_previous` → `openInterestDelta` | Browser: receiving chart candle; collector: current model frame | No robust/percentage/MAD materiality threshold. Tiny positive changes remain births. |
| Cohort birth | `src/modules/liquidation-field/core/cohortEngine.ts` — `processFrame`, `createPairedCohorts` | Positive frame delta → one LONG and one SHORT cohort | Frame timestamp; entry center derived from `frame.markPrice` with a small aggressor-flow offset | One birth family per positive frame. IDs use frame timestamp plus mutable ordinal, not interval/distribution provenance. |
| Entry distribution | `createPairedCohorts` | Mark price + volatility scalar → mean/stddev bounds | Current frame mark price | No `CohortEntryDistribution`; exact trades are ignored as entry-price observations. Persistent frames calculate aggressor totals but do not pass trade-at-price histograms to the engine. |
| Leverage particles | `src/modules/liquidation-field/core/leveragePriors.ts` — `createLeveragePrior` | Preset + current frame regime → leverage buckets | Birth frame | Particles remain stored, but `REGIME_ADAPTIVE` weights depend on birth-frame volatility/OI/funding. Flow is also used to imbalance paired notional, which is not justified by matched-contract semantics. |
| Risk/liquidation model | `core/bybitLiquidationModel.ts` and `createPairedCohorts` | Entry mean + leverage + public risk tier + margin prior → liquidation mean/deviation | Cohort entry is the mathematical anchor | The estimator accepts mark price but does not use it in its liquidation formula. Liquidation means are not re-centered during propagation. Funding estimate is currently zero. |
| Survival and closure | `cohortEngine.ts` — `propagate`, `reduceFromOiContraction`, `assimilateConfirmedEvent`, `prune` | Time, price traversal, OI contraction, observed events → remaining mass/survival/state | Independent chronological frames | Time decay removes mass without an explicit conservation ledger. Unconfirmed traversal applies a fixed 18% reduction. OI contraction scales cohorts with an undocumented distance heuristic and particles with a different uniform factor. Pruning can silently remove model mass. |
| Browser exposure raster | `core/exposureRaster.ts` — `buildLiquidationFieldSnapshot`, `rasterizeParticles` | Engine particles per selected timestamp → time × price arrays | Fixed price lattice derived from first source frame; UTC output buckets | Engine is recreated per build. Cohorts are replayed from the rolling input window. Model grid itself does not follow later swings, but the next rebuild can start with a different first frame/window. |
| Persistent exposure raster | `server/liquidation-intelligence/model/exposureRuntime.ts` — `BclifExposureRuntime.rasterize` | Checkpointed particles → one persistent model column | Collector-owned fixed configured grid | Causal and independent of chart state. Broad particle kernels are still inherited from the flawed entry hypothesis. |
| Normalization | Browser `normalizeExposureCausal`; persistent `BclifCausalNormalizer` | Raw exposure → encoded intensity | Browser defaults to one-column trailing context; persistent uses a trailing causal epoch | Browser per-column scaling makes successive weak regions look equally important. Neither normalizer changes raw exposure, but visual authority is distorted. |
| Display projection | `rendering/displayProjection.ts` | Immutable snapshot arrays + chart transform → adaptive visible raster | Viewport/current price affect crop/resampling only | Model/exposure hashes remain separate from render-settings/display hashes. Viewport does not create model mass. |
| GPU texture | `rendering/BlackCoreLiquidationFieldRenderer.ts` | Display raster → one RGBA texture and overlays | Chart coordinates only | No cohort construction, entry calculation, or liquidation recentering occurs here. |

## Required questions answered

### Does a price move with zero OI change create new cohorts?

Directly, no: `processFrame` calls `createPairedCohorts` only for `openInterestDelta > 0`. Indirectly in browser fallback, a rolling rebuild can relocate which candle receives a sparse OI change, so the same market history expressed by a different chart candle set can produce a differently anchored cohort. A dedicated flat-OI swing fixture did not exist at the audit baseline.

### Does every positive OI sample create a cohort even when the change is statistical noise?

Yes. Every usable positive delta creates a paired family. There is no absolute, percentage, rolling-deviation, MAD, or hybrid noise floor.

### Are cohorts created once per OI interval or once per chart bar?

Persistent live mode consumes one cohort birth per advancing live OI observation. Browser mode carries an OI value across chart bars and normally produces a delta only when the mapped OI observation changes, but the birth occurs on a chart frame and has no explicit source interval. Coarse chart candles can collapse multiple OI observations; different candle boundaries can move the birth anchor.

### Does changing the chart timeframe change cohort creation?

Yes for browser fallback. `getSourceCandles()` supplies the currently selected chart timeframe and the bootstrap maps OI onto those candles. Frame timestamps, mark/close prices, volatility, number of represented OI changes, output columns, entry anchors, cohort IDs, and model hash can therefore differ. Persistent tiles are chart-timeframe independent.

### Does changing the viewport change the model?

Pan/zoom does not directly change `getSourceCandles()`; it returns the chart engine's complete loaded candle store. Viewport changes the display projection domain/resolution and display raster hash only. However, any history-loading policy that replaces the engine's complete candle store before a fallback rebuild can change the model input. No executable viewport-invariance fixture existed at baseline.

### Are entry distributions centered on candle close?

Effectively yes in browser history. Historical `markPrice` is set to the candle close, then `createPairedCohorts` centers entries on that value (with a flow adjustment that is zero for historical fallback). This is a scalar Gaussian hypothesis, not a price distribution supported by interval trades.

### Are entry distributions centered on swing highs/lows?

No explicit swing detector is referenced. The apparent swing following is emergent: positive OI changes at successive market-price frames create new mark-centered envelopes.

### Are old cohorts re-centered on current price?

Not inside one engine lifetime. Stored cohort and particle entry/liquidation values remain fixed. They can nevertheless be replaced by differently anchored cohorts when browser fallback rebuilds from a shifted/changed rolling input window.

### Are liquidation prices recalculated from current price rather than entry price?

No. Liquidation prices are calculated once at birth from the cohort entry hypothesis, leverage, risk tier, and margin model. `markPrice` is passed into the input object but is not used by `estimateBybitLinearLiquidationDistribution`. The problem is that birth entry itself is the current frame mark.

### Does a rolling model window delete or rebuild older cohorts?

Yes in browser fallback. Every worker build creates a fresh `LiquidationCohortEngine`, and the refresh fetch is bounded by `requestedStart/requestedEnd`. Cohorts before the rolling window are absent. Within an engine, `prune` also retains only the strongest 640 cohorts and 4,096 particles without an explicit mass ledger.

### Are model generations stitched as independent rectangular fields?

Persistent published tiles are generated by one checkpointed engine and are not independent horizon models. Browser fallback returns one newly rebuilt window at a time rather than stitching generations, but its replacement snapshots present rolling generations as if they were continuous inventory. Persistent tile assembly currently carries no cohort provenance (`cohorts: []`).

### Are normalization boundaries reset at every generation?

Yes on browser rebuild. More importantly, browser `normalizeExposureCausal` is invoked with its default one-column trailing window, so each column is normalized independently. Persistent runtime retains a 64-column causal normalizer and checkpoints it.

### Are high-uncertainty cohorts rendered with excessively narrow or bright kernels?

They are broad by formula, but not sufficiently authority-capped. The mixed margin prior assigns 28% to an `UNKNOWN` model presented as `CROSS_ESTIMATE`; low-confidence particles still enter the raw field, and one-column normalization can promote their local maximum. Renderer confidence gating mutes the result but cannot repair over-generated raw mass.

### Why does every major price swing appear to begin a new exposure envelope?

Because positive OI fluctuations near successive price regions create new paired cohorts centered on each receiving frame's current price, even when changes are immaterial. Those broad entry/liquidation hypotheses persist horizontally, while local one-column normalization makes each region visible. Browser horizon/timeframe mapping and rolling rebuilds reinforce the alignment. The envelopes follow swings statistically because the model uses price-at-OI-sample as the entire entry hypothesis, not because the renderer explicitly tracks swing extrema.

## Baseline invariant status

| Invariant | Baseline result |
|---|---|
| Price movement alone creates no cohort | Implemented in the narrow `delta > 0` branch, but not certified across browser rebuild/timeframe mapping |
| Positive OI creates paired gross exposure | Partially implemented; both sides are created, but aggressor flow changes side notional and breaks strict pair equality |
| Negative OI removes exposure | Implemented heuristically; cohort/particle reductions are not conserved through one ledger |
| Cohorts remain entry anchored | True within an engine lifetime; false across rolling browser reconstruction guarantees |
| Chart-timeframe independence | Failed by construction in browser fallback |
| Viewport independence | Model path is viewport-free; no permanent fixture existed |
| Historical columns immutable | Causal raster/downsampling exists, but rolling fallback reconstruction and window-dependent input are not certified |
| Missing data is not zero | Coverage/validity mostly preserves this; historical trades/events/books are unavailable, yet scalar OI-only entry estimation remains visually over-authoritative |

## Corrective boundary

Chapter III-C3 must correct the model before palette or resolution work by introducing:

- canonical OI intervals with a versioned robust materiality decision;
- deterministic interval-specific entry distributions and evidence provenance;
- stable content-derived cohort IDs;
- strictly paired birth mass with contextual flow only;
- explicit, conserved lifecycle mass accounting;
- source-aware cross/unknown caps and uncertainty-derived kernels;
- stable price-grid metadata independent of horizon, chart timeframe, and viewport;
- provenance-bearing shelves and cohort birth diagnostics;
- fixtures proving flat-OI, anchoring, timeframe, viewport, chunk, append, and mass invariants;
- stable causal normalization epochs rather than per-column local authority.

No excluded execution, broker, Black Cloud, HDLX, RADAP, Kioseff, DOM Pro, OMS, or EMS component is implicated by this finding.
