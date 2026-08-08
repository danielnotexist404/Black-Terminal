# BCLIF Visual Spec

Default style is Reference Thermal with an opaque purple floor, blue/cyan/teal middle, green high region and yellow extreme cores. Alternative palettes are Black Terminal Blood, institutional monochrome, directional split and confidence. Defaults: opacity 82, gamma .8, q05/q99.5 normalization, 1.15-row price smoothing and .55-column temporal smoothing.

Historical gaps use a dark desaturated hatch. Confirmed liquidations are separate markers. The optional reference candle palette is cyan/magenta; the default remains silver/blood red. A developer visual fixture exists but is never enabled by default.

In `BCLIF_MODEL_V4_CAUSAL`, confidence-weighted exposure is weighted before causal robust quantile normalization. Every column reads only its current/trailing observations, so future inputs cannot recolor historical intensity. Confidence changes relative rank and remains an independent field while the strongest supported exposure can still occupy the green/yellow endpoint. Applying confidence after normalization is prohibited because it collapses dynamic range whenever aggregate confidence is below 100%.
