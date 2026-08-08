# BCLIF GPU Renderer

The worker builds typed-array channels. `BlackCoreLiquidationFieldRenderer` samples a 256-entry linear-light palette into one RGBA buffer and uploads it through one Pixi `BufferImageSource`, `Texture`, and `Sprite`. A small `Graphics` layer draws optional confirmed-event and cascade overlays. There are no DOM cells, per-cell Pixi objects, histogram bars, or cell borders.

The sprite is projected with the chart's millisecond-aware `xForTimestampMs` and canonical `yForPrice` transforms and clipped to the plot. Candles are later in the Pixi layer stack and therefore remain crisp. Persistent tile assembly verifies one regular atlas, preserves invalid gap columns, and updates only the live edge; camera movements never recalculate model state.
