# BCLIF cold-start raster audit

Date: 2026-08-09
Starting commit: `e9edaa11e85195e95480b95ba2949cc12318ae70`
Model: `BCLIF_MODEL_V6_ABSOLUTE_SHELVES`

## Binary root-cause verdict

The model, display-domain intersection, projection worker and texture path are
present. The cold-start field is visually blank because legacy presentation
settings compound browser-fallback authority into an effectively transparent
texture.

A deterministic production-path reproduction of the screenshot state produced:

- 65,536 raw model cells;
- 36,730 non-zero raw exposure cells;
- 65,536 valid model cells;
- 131,072 projected display cells;
- 131,072 cells with a nominal non-zero alpha;
- maximum and minimum positive projected alpha: `2 / 255`;
- restored sprite opacity: 45%;
- effective maximum composite alpha: `0.0035` (0.35%);
- browser historical yellow cells: 0.

The compounding path is:

1. browser-fallback cell confidence is approximately 50%;
2. legacy `minimumConfidence` remains 60%;
3. below-floor context is multiplied by 0.2;
4. historical context opacity is 24%;
5. confidence authority at 50% is 0.3;
6. the two-evidence-channel rule multiplies OI-only context by 0.55;
7. the sprite is then multiplied by 45% opacity.

This produces an uploaded field whose alpha is technically non-zero but
operationally invisible. Cluster extraction reads raw exposure separately, so
the dashboard can list valid shelves while the thermal texture appears absent.

## Stage trace

| Stage | Result before correction |
| --- | --- |
| Worker model snapshot | PASS; V6 snapshot with non-zero exposure |
| Application state | PASS; snapshot and cluster panels populated |
| Confidence filter | DEFECT; visibility, labels and color authority conflated |
| Display-domain clipping | PASS; screenshot shelves intersect chart range |
| Evidence filter | DEFECT; OI context is penalized again for one-channel evidence |
| Display raster | PASS but maximum alpha is 2 |
| Texture allocation/upload | Reachable; no evidence of zero dimensions or missing buffer |
| Black Core pass | Attached; texture is visually transparent |

## Mandatory audit answers

- Model produces non-zero exposure after refresh: **YES**.
- Confidence path removes practical visibility: **YES** (effective 0.35%).
- Price domain clips every row: **NO**.
- Opacity restores as literal zero: **NO**; compounded alpha is effectively zero.
- Shelves-only/raw mode restored: **NO evidence in the supplied capture**.
- Worker publishes before renderer subscribes: not the observed cause, but no
  retained snapshot replay contract existed, so the race remained possible.
- Renderer replays current store snapshot on mount: **NO dedicated store existed**.
- Texture created but never uploaded: **not the observed cause**.
- Texture maximum alpha zero: **NO**; maximum is 2/255 before sprite opacity.
- Legacy Custom settings compatible with V6: **not guaranteed**; schema was V3
  and the single confidence field carried obsolete semantics.
- Stale BCLIF IndexedDB/Cache Storage override: **NO**; BCLIF had no browser
  checkpoint and the persistent tile cache is memory-only.
- Toggling can force a new draw: possible, but it cannot fix the compounded
  alpha contract and is not an acceptable recovery mechanism.

## Interface finding

The screenshot's two large panels are explained by defaults and component
state, not the model: diagnostics and operational summary are enabled by
default, and the summary component initializes open. They are overlays, but
they obscure substantial chart area and duplicate the same runtime state.

## Scope conclusion

No cohort, liquidation-price, leverage, risk-tier, lifecycle, mass-conservation
or no-lookahead formula requires modification. The correction belongs entirely
to renderer settings, snapshot replay, browser public-state recovery, texture
diagnostics and compact HUD presentation.


## Post-deployment live-stream starvation finding

The authenticated 4H production capture exposed a second, distinct blank-field failure after the original transparency repair. The compact HUD remained at `INITIALIZING OI CONTEXT` / Browser Fallback while the live indicator row reported collecting.

Production-origin probes disproved an upstream-data outage: Bybit returned 720 one-hour OI observations and 8,640 canonical five-minute candles with HTTP 200 and valid production CORS in approximately 4.43 seconds. The exact bootstrap completed in approximately 10.05 seconds and the exact V6 model build in approximately 5.49 seconds (approximately 15.54 seconds total), producing 8,640 frames, a 384 x 512 field, 24 cohorts and 196,608 raw cells.

The fault was the browser controller generation policy. The live stream connected before the first multi-second worker build completed. Every trade/depth update scheduled another build, incremented `buildGeneration`, and caused the completed snapshot to fail the generation equality check. Because worker builds serialize and market updates arrive faster than a raster can finish, valid snapshots could be discarded indefinitely. The same high-frequency stream also continuously reset the rebuild debounce timer, postponing refresh indefinitely.

This is a client concurrency/lifecycle defect. It is not an OI availability, CORS, model, cohort, price-grid, or WebGL texture defect.
