# BCLIF Adaptive Resolution

Adaptive resolution belongs to the disposable display raster, not the causal model grid. The source snapshot remains unchanged.

## Price rows

- operational focus: 768–2,048 rows (`plotHeight × 1.18` in Auto);
- full model/research: 512–1,024 rows (`plotHeight × 0.72` in Auto);
- constrained touch/low-performance fallback: 512 focus rows or 384 research rows;
- explicit Balanced: 1,024 focus / 768 research;
- explicit High: 2,048 focus / 1,024 research.

The settings panel and diagnostics expose both model grid and actual display grid. Display price step is `(displayMaximum - displayMinimum) / (rows - 1)` and therefore reflects the visible domain rather than pretending that the source step changed.

## Time columns

Columns preserve the entire retained timestamp span. They are bounded by source columns and by 512–1,536 display columns based on plot width; constrained devices cap at 512. Display time step is reported explicitly. Sampling maps endpoints to endpoints, so source start/end remain attached and camera changes cannot add future data.

Invalid source columns remain invalid in projection. There is no blur across validity gaps or tile seams. The live-calibration marker uses the first display column supported by live sources.

The production renderer computes the projection in a module worker, retains the previous certified texture while a new projection is in flight, and accepts only the latest generation/key. One RGBA buffer, one `BufferImageSource`, one texture, and one sprite are retained. Axis text is pooled to avoid per-frame PIXI texture churn.
