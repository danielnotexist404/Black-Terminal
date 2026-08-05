# Reference Screenshot Visual Specification

The supplied 1232×541 screenshot is the visual golden target. It uses an opaque, continuous field: near-black violet at minimum intensity; violet/indigo at low exposure; blue, cyan and teal at medium exposure; green at high exposure; and narrow yellow cores at the extreme tail. Candles are cyan/magenta in the reference and remain crisp above the field. The Black Terminal high-contrast silver/blood-red candle palette remains the default.

The sampled fallback LUT is `#070310, #30004c, #43085d, #3e1864, #392b6d, #334078, #2d5883, #27728b, #228887, #229f7e, #3bb469, #82cd45, #d9e323` at normalized stops `0, .05, .12, .22, .34, .46, .57, .67, .76, .84, .91, .96, 1`. Colors interpolate in linear-light sRGB. Default opacity is 82%, gamma 0.8, robust quantiles .05/.995, price sigma 1.15 rows and temporal sigma .55 columns. Cell edges are not drawn.

Golden topology criteria: visible purple floor, broad horizontal shelves with truthful temporal starts/ends, constrained vertical blur, no histogram silhouette, no cell-border grid, high candle contrast, and texture registration to chart price/time transforms. Automated SSIM is not yet certified because the repository lacks a pixel-capture baseline containing the supplied market data; this is recorded as an open production-certification item rather than reported as passed.
