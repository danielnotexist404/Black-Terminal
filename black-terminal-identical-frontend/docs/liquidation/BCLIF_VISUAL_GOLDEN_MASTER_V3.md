# BCLIF Visual Golden Master V3

V3 adds the renderer-only `REFERENCE_THERMAL_STYLE` fixture. It is query-gated, localhost-only, labeled `SYNTHETIC_TEST`, and never enters production market data. The fixture creates causal-looking horizontal starts, persistence, decay, termination, one missing-data interval, and a fixed family histogram without changing cohort mathematics.

Quantitative result across 1080p, 1440p, and 4K:

- valid occupancy: 98.96–98.99%
- purple: 62.08–62.10%
- blue/cyan: 28.60%
- green: 8.90–8.93%
- yellow: 0.389–0.397%
- HSV p10: 0.3614
- HSV median: 0.4329
- HSV p90: 0.5835
- HSV maximum: 0.9035
- persistent labels/nodes/dashboard: zero

Goldens are `reference-thermal-style-{1920x1080,2560x1440,3840x2160}.png`. Independent repeat capture produced luminance SSIM 1.0 and mean sampled perceptual delta 0 at all three viewports. PNG bytes differ because non-pixel metadata is not required to be byte-identical.

This certifies deterministic renderer behavior and visual topology only. It is not market-data accuracy evidence and does not satisfy authenticated live acceptance.
