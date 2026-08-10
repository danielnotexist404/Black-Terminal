# BCLIF Color Management

The calibrated LUT is generated using an OKLab classification path and linear-light sRGB interpolation. Runtime exposure is a scalar, not an encoded color. The WebGL shader samples the LUT once and the browser performs the final display conversion. There is no multiply blend and no second manual color gamma.

The magnitude gamma (default 0.85) shapes the scalar coordinate; it is not an additional sRGB gamma correction. Dithering is a deterministic half-step (`0.5/255`) perturbation before LUT lookup. Mipmaps are disabled because a heat field is not a photographic texture atlas.

Valid low exposure is never transparent black. It uses at least LUT coordinate 15/255. Invalid data uses `#05020B`, making unknown coverage distinguishable from measured low exposure. The Black Terminal Blood theme uses the same scalar/validity pipeline and replaces only the LUT.
