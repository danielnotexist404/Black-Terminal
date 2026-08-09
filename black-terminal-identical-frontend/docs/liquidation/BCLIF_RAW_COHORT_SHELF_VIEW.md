# BCLIF raw cohort shelf view

`BCLIF — Raw Model` now enables `rawCohortShelvesVisible`. The diagnostic
turns off the thermal sprite and renders each surviving cohort directly:

- the center line is the immutable absolute `liquidationMean`;
- the two faint lines are `liquidationLower` and `liquidationUpper`;
- the line begins at `createdAt` and ends at the model cutoff;
- blood red represents liquidation exposure of long positions; silver/white
  represents liquidation exposure of short positions;
- opacity/width are functions of remaining mass only.

It bypasses thermal smoothing, gamma, percentile normalization, palette
mapping, display interpolation, and visible-range blending. It is disabled in
ordinary presets. The full machine-readable shelf and raw raster payload is
available at runtime through:

```js
globalThis.__BCLIF_RAW_EXPOSURE_EXPORT__()
```

The export includes cohort ID, entry interval/range/source, leverage
contributions, margin mode, absolute liquidation bounds, remaining mass,
confidence, raw long/short arrays, validity, and a 20-cell intensity audit.

Chapter III-C4 binary result: **raw shelves are horizontal; the pre-correction
thermal topology was the swing-following layer.**
