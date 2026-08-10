# BCLIF Reference Palette Calibration

The local tool `scripts/calibrate-bclif-reference-palette.py` derives a 256-entry LUT and visual statistics from a user-supplied screenshot. The input screenshot is never copied into the repository.

Committed derived artifacts:

- `reference/bclif-reference-thermal-spec.json`
- `rendering/referenceThermalLut.generated.ts`
- source SHA-256 `ba8731e83cca5104d379b8db3080fdca455c9d6b37815767938ddaac10b0f9a0`
- dimensions `1232 × 539`
- missing color `#05020B`

The calibration rejects red/magenta candle contamination, projects eligible pixels onto the formal C6 thermal path in OKLab, smooths the sampled path, and emits colors interpolated in linear-light sRGB. Endpoints are `#350044` and `#F0E705`. No logo, watermark, product name, API, dataset, or original image is retained.

Measured reference-image distribution was 73.914% purple, 20.544% blue/cyan, 5.458% green, and 0.084% yellow. Reference-image HSV values were p10 0.361, median 0.424, p90 0.557, maximum 0.965. These describe the supplied pixels; the independent deterministic style fixture has its own acceptance ranges.

Recalibration is explicit and reviewable. A changed screenshot hash or generated LUT must update the spec, renderer contract tests, and V3 golden master. A generic named palette must never be substituted and described as calibrated parity.
