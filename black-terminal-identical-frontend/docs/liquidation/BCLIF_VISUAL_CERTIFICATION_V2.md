# BCLIF Visual Certification V2

The repository-owned harness is `scripts/bclif-visual-regression.js`; it uses `playwright-core`, local Vite, and the installed Chromium-family browser. It does not depend on an external browser-control runtime.

## Matrix

Seven deterministic fixtures are captured at 1920×1080, 2560×1440, and 3840×2160:

1. Trade Focus;
2. High Confidence;
3. Live Calibrated;
4. Full Spectrum Research;
5. Missing Data;
6. Browser Fallback;
7. Persistent Node.

The 21 baselines and SHA-256 values are owned by `tests/golden/bclif/manifest.json`. Goldens are generated only with `BCLIF_UPDATE_GOLDENS=1`; generation leaves the manifest `RECORDED_PENDING_COMPARISON`. A later normal run must pass before it becomes `CERTIFIED`.

Every case verifies one canvas, compact badge area, expected authority/persistence, chart and venue identity, adaptive grid presence, movable summary presence, label limit, renderer timing, and correct price display. Chart Scale must equal the candle camera; Full Spectrum must equal model bounds. Cross-case checks require invariant MODEL and EXPOSURE hashes (except the deliberately changed missing-data validity) and multiple RENDER SETTINGS / DISPLAY RASTER hashes.

Screenshots are retained at native viewport resolution. Byte-identical PNGs pass directly; otherwise the complete frame is downsampled deterministically to at most 960 pixels wide for 8×8 luminance SSIM and mean perceptual delta. Thresholds are SSIM ≥0.985 and mean delta ≤0.025.

The visual fixture is localhost-only, fixed-time, synthetic, and prominently test-authoritative. Browser and persistent authority cases change only fixture provenance/coverage; they never claim live market data.
