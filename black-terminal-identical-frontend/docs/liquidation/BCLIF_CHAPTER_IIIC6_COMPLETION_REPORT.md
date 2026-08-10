# Chapter III-C6 Completion Report

## Release identity

- Starting commit: `0a0c7df015fa36bcd60b065ed1dd8abc3e834afc`
- Final commit: the commit containing this report; recorded in the release handoff
- Production deployment SHA / asset hash: not deployed or verified at report-writing time
- Raw verdict: `RAW FIELD TOO SPARSE — SOURCE/MODEL RESOLUTION LIMIT`
- Explicit verdict: **RENDERER CERTIFIED — RAW FIELD SOURCE DETAIL INSUFFICIENT**

## Root defects and replacement

V9 stretched a pre-colored RGBA field, combined confidence with visibility, applied several display shaping stages, used a separate plasma backdrop, and allowed diagnostic shelves/panels to dominate the field. V2 adds `BlackCoreReferenceThermalRendererV2`, a worker-projected scalar path, R16F exposure, R8 confidence/validity/visibility/yellow masks, RGBA8 LUT, normal blend, one shader pass, high-DPI LOD, validity-aware edge-preserving smoothing, and deterministic half-step dithering. Legacy V1 remains opt-in.

Normalization is `log1p(E)`, Q5/Q99.86 robust global clamping, smoothstep, and gamma 0.85. Confidence remains separate; alpha is `visible × max(0.82, opacity × (0.82 + 0.18C^0.7))`. Missing data is `#05020B`; valid low exposure is opaque calibrated purple. Candles/EMAs are later layers. Event nodes, labels, dashboards, provenance, and full diagnostics are off by default; one collapsed compact authority badge remains.

## Calibration and quantitative evidence

- LUT source SHA-256: `ba8731e83cca5104d379b8db3080fdca455c9d6b37815767938ddaac10b0f9a0`
- LUT: 256 entries, `#350044` → `#F0E705`, linear-light sRGB runtime interpolation
- deterministic occupancy: purple 62.08–62.39%, blue/cyan 28.60–28.61%, green 8.70–8.93%, yellow 0.30–0.40%
- HSV p10 / median / p90 / max: 0.3614 / 0.4329 / 0.576–0.5835 / 0.9035
- valid occupancy: 98.75% unit fixture; 98.96–98.99% browser goldens
- browser repeat comparison: SSIM 1.0, mean sampled perceptual delta 0 at 1080p/1440p/4K
- smoothing: 94% center retention plus 22% validity-aware neighborhood mix
- texture preparation/upload: 1.1 ms median and 3.2 ms maximum in the fresh three-case headless comparison
- cold-start deterministic browser fixture: 11.1–33.4 s, therefore the `<2 s` production checkpoint target is **not certified**
- interactive frame/shader/candle p95: not independently measured; headless screenshot cadence is not an FPS claim

## Truth and deployment boundary

Authenticated live Bybit 1H/4H screenshots were not captured. Persistent history is unavailable, collector is not deployed, and persistent migrations remain unapplied. The local raw model fixture exposes six absolute-price shelves, so reference-like micro-density cannot be claimed for real data. Browser fallback remains readable and explicitly labeled estimated relative exposure; it is not account inventory.

No OMS, EMS, Black Cloud, broker, execution, PositionManager, RADAP, HDLX, Kioseff, DOM Pro, Portfolio, Investment Group, Obsidian, or BCLIF cohort-mathematics code was intentionally changed. No migration was added.

## Required implementation inventory

| item | delivered state |
|---|---|
| New renderer | `src/modules/liquidation-field/rendering/BlackCoreReferenceThermalRendererV2.ts` |
| Projection/worker | scalar magnitude, independent confidence/validity/visibility/yellow masks, high-DPI projection, half-float conversion |
| Palette | generated 256-stop calibrated LUT plus selectable Blood / White / Silver, Monochrome, Directional, and Confidence themes |
| Raw gate | raw long/short/combined export, confidence, validity, absolute price/time audit, grayscale audit view |
| Presets | Reference, Verified Authority, Research Diagnostics; Legacy V1 remains explicit comparison only |
| Visual fixture | localhost-only `SYNTHETIC_TEST` reference-topology fixture; it never enters live model input |
| Golden evidence | 1920×1080, 2560×1440, 3840×2160 dedicated V3 cases, all PASS |
| Calibration | reproducible Python calibration, derived JSON/LUT committed, third-party source image excluded |

## Render and display contract

- Texture formats: exposure `R16F`; confidence, validity, visibility, and yellow eligibility `R8 UNORM`; LUT `RGBA8 UNORM`.
- Physical-pixel handling: CSS plot dimensions are multiplied by device pixel ratio bounded to 2, then constrained by the selected display LOD/GPU caps. This changes only the disposable display raster.
- Fresh target resolutions: 1,536×1,024 at 1080p; 2,007×1,024 at 1440p; 3,159×1,528 at 4K.
- Magnitude: `L=log1p(max(E,0))`, robust horizon Q5/Q99.86 clamp, smoothstep, then `I=u^0.85`.
- Confidence: separate `R8` metadata; Reference Relative magnitude is invariant when confidence bytes change. Verified Authority may cap yellow and desaturate lower confidence.
- Alpha: normal premultiplied compositing with `visibility × max(0.82, opacity × (0.82 + 0.18C^0.7))`; no multiply/darken/CSS opacity chain.
- Color: OKLab classification during calibration, linear-light sRGB LUT interpolation, one runtime LUT lookup, scalar gamma exactly once.
- Smoothing: adjacent price/time texels, validity-aware, 22% neighborhood mix, at least 94% narrow-shelf center retention; no gap crossing.
- Dither: deterministic `0.5/255` scalar half-step before LUT lookup.
- Missing data: `#05020B`; valid low exposure uses the opaque LUT purple floor (15/255), never transparent black.
- Candles: high contrast and rendered after the thermal pass; candle/EMA appearance does not enter scalar identity.
- Default clutter: event nodes, cohort births, shelf labels, dashboards, provenance, raw shelves, and full diagnostics are off. One collapsed compact authority badge remains.
- Browser fallback: readable `ESTIMATED RELATIVE EXPOSURE`, persistence off, OI context/live collection truth retained; no observed-inventory claim.
- Unsupported half-float/WebGL path: no packed-scalar WebGL1 fallback was certified in this chapter; failure is exposed as compatibility/unavailable rather than silently using a small Canvas bitmap.

## Hash and invariance evidence

The renderer exposes MODEL, EXPOSURE, SCALAR FIELD, LUT, RENDER SETTINGS, and DISPLAY RASTER/final-frame identities. Palette, opacity, gamma, LOD, annotations, and diagnostics were varied while model, exposure, and scalar hashes remained unchanged. The style fixture is independent from candles and carries an explicit `SYNTHETIC_REFERENCE_THERMAL_STYLE_V3` checksum suffix.

## Acceptance matrix

| gate | result |
|---|---|
| raw absolute-price shelf gate | six shelves; `RAW FIELD TOO SPARSE — SOURCE/MODEL RESOLUTION LIMIT` |
| renderer unit/quantitative contract | PASS |
| liquidation model contract | PASS |
| operational clarity | PASS |
| authentic exposure / no-lookahead | PASS |
| live-pipeline contract | PASS |
| cold-start/mount-order contract | PASS; Node projection p95 1,473.82 ms |
| persistent API/migration/client contracts | PASS; migrations still unapplied |
| collector/recovery/codec/no-lookahead contracts | PASS; collector still undeployed |
| TypeScript and production build | PASS |
| security contracts/audit | PASS; 27 routes and 26 emitted assets inspected |
| 1080p V3 golden | PASS; SSIM 1.0, perceptual delta 0, upload 3.2 ms |
| 1440p V3 golden | PASS; SSIM 1.0, perceptual delta 0, upload 1.0 ms |
| 4K V3 golden | PASS; SSIM 1.0, perceptual delta 0, upload 1.1 ms |
| older 27-case matrix under V2 | PENDING complete re-record/review; one stale legacy comparison remains |
| authenticated production 1H/4H matrix | NOT RUN |
| interactive main-thread/shader p95 and 55 FPS | NOT MEASURED / NOT CERTIFIED |
| compatible-checkpoint `<2 s` cold start | NOT CERTIFIED; deterministic browser fixture measured 10.647–33.672 s |

The dedicated visual result is deterministic and within the formal brightness/palette/occupancy bounds. It does not close the authenticated-production gate, persistent-history gate, model-detail gate, or predictive-accuracy gate.
