# BCLIF Model Domain vs Display Domain

The BCLIF model domain is the immutable price/time lattice emitted by the causal exposure engine or verified persistent tile assembly. Camera state is not an engine input.

The display domain is a disposable projection:

1. retain the full model snapshot and typed exposure arrays;
2. resolve a display price interval from chart scale or an explicit display mode;
3. choose adaptive display rows/columns for the current plot and device;
4. resample source exposure, confidence, and validity into that visible lattice;
5. apply source-aware authority, normalization, and palette rules;
6. upload one RGBA texture and attach it through canonical time/price transforms.

`CHART_SCALE` uses the candle camera bounds. Explicit ± modes use mark-relative bounds clipped to the model. `AUTO_FOCUS` includes the nearest qualifying cluster above/below mark plus a configurable margin. `FULL_MODEL_RANGE` uses the complete model bounds. Custom bounds are validated and clipped.

Identity is deliberately separated:

- `MODEL` hashes model geometry and cohorts;
- `EXPOSURE` hashes raw long/short exposure and validity;
- `RENDER SETTINGS` hashes presentation controls;
- `DISPLAY RASTER` hashes exposure identity, render settings, display domain, LOD, and current mark bucket.

Changing camera, palette, opacity, preset, or display domain cannot change MODEL or EXPOSURE. It may change RENDER SETTINGS and DISPLAY RASTER. Model-sensitive settings retain their separate rebuild key, so display-only menu actions do not rebuild cohorts or browser fallback history.
