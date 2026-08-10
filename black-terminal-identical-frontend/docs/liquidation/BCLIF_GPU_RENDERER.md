# BCLIF GPU Renderer

## Chapter III-C6 reference-thermal path

`BlackCoreReferenceThermalRendererV2` is the default renderer. The display worker sends scalar half-float exposure plus independent confidence, validity, visibility, and yellow-authority masks. WebGL uploads those channels as one `R16F` texture and four `R8` textures, with a calibrated 256-entry `RGBA8` LUT. A single normal-blend shader pass performs the LUT lookup, validity-aware edge-preserving smoothing, confidence-aware alpha, and half-step dithering. The V2 path does not upload or stretch a pre-colored RGBA heatmap.

The authoritative scalar grid and price/time transforms remain unchanged by palette, opacity, gamma, smoothing, camera, or viewport DPI. Candles and EMAs are rendered after the thermal pass. Missing evidence is the explicit near-black missing color; valid low exposure is opaque purple. Legacy V1 remains available only as an explicit diagnostic selection and is not the default visual path.

High-DPI projection is bounded by the selected display LOD. The repository golden fixture measured 1,536×1,024, 2,007×1,024, and 3,159×1,528 scalar rasters for the 1080p, 1440p, and 4K captures. These are presentation rasters, not model lattices. See `BCLIF_SCALAR_TEXTURE_PIPELINE.md` and `BCLIF_HIGH_RESOLUTION_RENDERING.md`.

The following paragraphs describe the retained Legacy V1 implementation. They no longer describe the default V2 upload path. The causal worker builds typed-array model channels. V1 prepares a row-flipped upload-ready RGBA buffer and renders one Pixi sprite; V2 uses the scalar shader path above. A small `Graphics` layer draws optional cohort births, confirmed events, cascades, focus bands, and uncertainty envelopes. There are no DOM cells, per-cell Pixi objects, histogram bars, or cell borders.

The sprite is projected with the chart's millisecond-aware `xForTimestampMs` and canonical `yForPrice` transforms and clipped to the plot. Candles remain later in the Pixi layer stack with high contrast and therefore stay crisp. Persistent tile assembly verifies one regular atlas, preserves invalid gap columns, and updates only the live edge; camera movements never recalculate model state.

Projection generations are keyed by the model/exposure identity and complete render-settings identity. While a newer generation is in flight, the last certified texture stays visible; obsolete worker responses are discarded. Focus views use 768–2,048 price rows, research views use 512–1,024, and constrained fallback uses 384–512. Time columns retain the entire source span with an explicit derived display cadence.

The renderer records texture preparation/update timing in `__BCLIF_RENDER_METRICS__`. Axis labels are pooled, and normal redraws reuse the same GPU/display objects instead of destroying shared Pixi textures. These diagnostics are instrumentation, not an interactive-FPS claim.

Chapter III-C3 separates a stable 512–1024-row authoritative price lattice from adaptive 512–2048-row presentation. Camera movement changes only projection/display hashes. Model and exposure hashes include cohort/grid provenance but exclude viewport state. Visual smoothing cannot create raw model exposure outside a cohort distribution.
# Chapter III-C4 raw shelf path

The renderer retains one thermal texture for the operational path. The internal
`rawCohortShelvesVisible` diagnostic hides that sprite and draws only thin
PIXI lines at immutable absolute liquidation means and bounds from cohort birth
to model cutoff. No cell objects or DOM matrix is added. V6 display projection
uses 88% expanding source normalization and at most 12% visible-range detail in
the default HYBRID mode. Historical browser OI-only cells are explicitly
ineligible for yellow.
## Chapter III-C5 recovery instrumentation

The renderer validates projection dimensions, channel lengths and price domains before upload and publishes readiness, raw/visible/filtered counts, alpha bounds, texture dimensions, upload timing/count, draw state and generation lag. BlackChartEngine handles WebGL context loss/restoration and rebuilds from the retained snapshot without awaiting new market input. Confidence gates are presentation-only.
