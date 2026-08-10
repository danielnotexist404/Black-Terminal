# BCLIF Reference Thermal Renderer V2

Status: implemented and deterministic-style certified on 2026-08-10.

`BlackCoreReferenceThermalRendererV2` is the production-default BCLIF presentation path. It consumes one normalized scalar exposure texture, separate confidence/validity/visibility/authority masks, and a 256-entry LUT. Color is resolved in one WebGL fragment pass at the display raster resolution. Candles and selected chart studies are rendered later and never participate in heat-field construction.

The default `BCLIF — Reference Thermal` preset means **estimated relative modeled exposure**. Purple is valid low exposure, blue/cyan is medium, green is strong, and yellow is the rare upper magnitude tail. Yellow is not proof of an observed position. `Verified Authority` is a distinct opt-in mode that restricts yellow and subtly desaturates lower-authority cells.

Final alpha is normal premultiplied-alpha compositing. Visibility is independent from magnitude; confidence cannot erase valid exposure. The shader applies `visible × max(0.82, opacity × (0.82 + 0.18 × confidence^0.7))`. Missing cells resolve to `#05020B`; valid zero exposure resolves to the opaque purple floor. No multiply/darken blending or parent/CSS opacity is used.

Balanced smoothing samples the two adjacent price and time texels, respects validity, mixes only 22% of the neighborhood, and retains at least 94% of a narrow shelf center. A fixed 0.5/255 shader dither removes 8-bit banding without nondeterministic noise.

Legacy RGBA V1 remains selectable only for regression. It is not the default and does not define V2 certification.

The mandatory raw audit currently reports `RAW FIELD TOO SPARSE — SOURCE/MODEL RESOLUTION LIMIT` for the repository live-style model fixture (six raw shelves). V2 makes those shelves readable; it does not invent micro-levels.
