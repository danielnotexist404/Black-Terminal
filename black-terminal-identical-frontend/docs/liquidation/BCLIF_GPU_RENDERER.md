# BCLIF GPU Renderer

The causal worker builds typed-array model channels. Chapter III-C2 adds a separate display-projection worker which clips that immutable snapshot to the selected display domain, applies source/confidence authority, and returns one disposable RGBA raster. `BlackCoreLiquidationFieldRenderer` uploads that result through one Pixi `BufferImageSource`, `Texture`, and `Sprite`. A small `Graphics` layer draws optional confirmed-event and cascade overlays. There are no DOM cells, per-cell Pixi objects, histogram bars, or cell borders.

The sprite is projected with the chart's millisecond-aware `xForTimestampMs` and canonical `yForPrice` transforms and clipped to the plot. Candles remain later in the Pixi layer stack with high contrast and therefore stay crisp. Persistent tile assembly verifies one regular atlas, preserves invalid gap columns, and updates only the live edge; camera movements never recalculate model state.

Projection generations are keyed by the model/exposure identity and complete render-settings identity. While a newer generation is in flight, the last certified texture stays visible; obsolete worker responses are discarded. Focus views use 768–2,048 price rows, research views use 512–1,024, and constrained fallback uses 384–512. Time columns retain the entire source span with an explicit derived display cadence.

The renderer records texture preparation/update timing in `__BCLIF_RENDER_METRICS__`. Axis labels are pooled, and normal redraws reuse the same GPU/display objects instead of destroying shared Pixi textures. These diagnostics are instrumentation, not an interactive-FPS claim.
