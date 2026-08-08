# BCLIF Model Certification

Chapter III-C3 uses three independent gates.

## Causal model

`npm run test:bclif-authentic-exposure` must pass all 24 invariants: flat-OI, noise, explicit interval, canonical five-minute OI clock, paired single-side-OI birth, quote-notional mass units, risk-tier normalization, flow neutrality, entry/liquidation anchoring, contraction, observed event, margin caps, OI-only confidence, append invariance, chunk invariance, viewport/timeframe separation, stable grid, provenance, missing-not-zero, and mass conservation.

## Performance

`npm run benchmark:bclif-authentic-exposure` reports p50/p95/p99 separately for birth, lifecycle, closure, event assimilation, rasterization, display projection, and texture staging. Node results are deterministic model/kernel evidence only. Actual upload/update `<16.7 ms` is enforced by Playwright; headless animation cadence is reported but is not claimed as interactive FPS.

## Visual

`npm run test:bclif-visual` owns 27 baselines: Cohort Provenance, Swing Independence, OI Expansion, OI Contraction, Confirmed Liquidation, Trade Focus, Full Spectrum, Browser Fallback, and Persistent Authority at 1920×1080, 2560×1440, and 3840×2160.

Goldens enforce one canvas/texture, bounded badges/labels/yellow tail, authority labels, model/exposure/render/display hash separation, display-domain correctness, causal fixture counts, provenance coverage, mass error, and measured texture update. An update run only records candidates; a subsequent comparison run is the pass gate.

## Certification boundary

Repository model architecture can be certified locally. Multi-week observed event history cannot be certified until the persistent collector runs continuously or an equivalent verified source exists. Current host/deployment/migration status must remain explicit.
