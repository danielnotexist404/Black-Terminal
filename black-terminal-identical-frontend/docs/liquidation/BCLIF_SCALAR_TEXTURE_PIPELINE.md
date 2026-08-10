# BCLIF Scalar Texture Pipeline

The immutable absolute-time/absolute-price BCLIF snapshot is projected independently of chart presentation:

`raw long + short exposure → log robust horizon normalization → absolute camera resampling → scalar/mask upload → LUT shader → candles`.

V2 uploads exposure as R16F, confidence as R8 UNORM, validity as R8 UNORM, visibility as R8 UNORM, yellow eligibility as R8 UNORM, and the LUT as RGBA8 UNORM. Textures use linear filtering, clamp-to-edge, no mipmaps, and normal blending. The worker produces no pre-colored RGBA heatmap for V2. Legacy V1 alone retains that path.

The default magnitude transfer uses `L = log(1 + max(E, 0))`, Q5 and Q99.86 over valid horizon exposure, clamping, smoothstep, and gamma 0.85 exactly once. Global model normalization is default; viewport-relative and confidence-weighted modes are explicit non-default research choices.

The scalar-field identity hashes the immutable combined exposure and validity lattice before LOD, palette, opacity, gamma, annotations, or camera projection. Model, exposure, scalar, LUT, render-settings, and final display identities are shown only in the collapsed diagnostics view.

No WebGL1 packed-scalar compatibility implementation has been certified in this chapter. Unsupported hardware must be treated as compatibility/unavailable, never silently replaced with a tiny stretched Canvas bitmap.
