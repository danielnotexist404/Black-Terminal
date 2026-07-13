# Phase IV Chapter I-A - A.I.F. Price Synchronization

Status: implemented and regression-tested on 2026-07-14.

## Root Cause

The analytical model correctly retained market prices, but `AifIndicatorOverlay` converted them to CSS percentages using the profile's own minimum and maximum. Candles, drawings, alerts, positions, and execution lines used `BlackChartEngine`'s camera. A.I.F. therefore had a second visual coordinate system and detached whenever the chart price camera moved.

## Corrected Architecture

`BlackChartEngine` now owns the sole public `priceToScreenY(price)` / `screenYToPrice(y)` contract and publishes an immutable `ChartPriceTransformSnapshot` after its existing request-animation-frame draw. The snapshot includes plot clipping bounds, camera price range, price-scale mode, visible indices, dimensions, and a monotonic transform revision.

`PixiBlackChart` forwards transform revisions only while A.I.F. is active. `AifIndicatorOverlay` projects every primary/secondary profile row from `row.high` and `row.low`, and projects POC, VAH, VAL, support/resistance nodes and projected LVNs from their market price. Off-screen rows and lines are culled against the chart plot. The right price axis, header, timeline, and adjacent panels remain outside the A.I.F. drawing region.

Standalone HVN/LVN/pressure/auction nodes and priced CHoB events use the same projection. IMM remains visibly `UNAVAILABLE` because the current A.I.F. payload has no persistent-depth boundary price; the renderer does not invent an IMM coordinate.

Camera changes do not enter the worker request or analytical-model dependencies. Pan, scale, zoom, resize, replay and visible-range changes update screen geometry only. Linear and logarithmic transforms use the chart-engine transform utility; A.I.F. has no independent logarithmic camera.

## Automatic Initialization

Factory settings use Volume, automatic rolling lookback, and 20,000 bars. History paging requests one additional bar, removes the incomplete candle, and continues until the requested completed-bar horizon or venue exhaustion. A shorter truthful result is calculated without user intervention. Workspace/symbol settings persist 2,000, 5,000, 20,000, 50,000, 100,000, or custom horizons.

## Verification

- `npm run test:aif`: deterministic profile, clipping, linear/log transform, round-trip, completed-candle anchor, and camera/model-isolation assertions pass.
- `npm run test:aif-visual`: eight browser states pass. A 72 px vertical drag moved a tracked A.I.F. row by 72 px, changed the transform revision, and did not change `calculatedAt`.
- `npm run test:performance`: 5/5 Black Core performance regressions pass.
- `npm run benchmark:aif`: worst observed 100,000-bar paired case was 448.43 ms, below the previously recorded 488 ms ceiling.
- `npm run build`: TypeScript and production Vite build pass.

No database contract changed. No Supabase migration is required.
