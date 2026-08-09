# BCLIF live-pipeline forensic audit

Date: 2026-08-09
Chapter: Phase V — III-C4
Audited repository commit: `d63d30fd23405c39e55f12501c74664aea32aae5`

## Production identity

The production alias was not serving the audited commit when this chapter began.

| Fact | Verified value |
| --- | --- |
| Alias | `black-terminal.live` / `www.black-terminal.live` |
| Deployment | `dpl_69nieZzvsMAatfKSTqp7DEShiBc1` |
| Deployment creation | 2026-08-05 16:05:35 EEST |
| Inferred repository commit | `921c7a2f9d50b204e61a2f67e402571f3fd4c7e9` |
| Served model visible in reference capture | `BCLIF_MODEL_V3` |
| Audited main model | `BCLIF_MODEL_V5_AUTHENTIC_EXPOSURE` |
| Old main asset | `index-Bw64vDgN.js` |
| Local audited asset | `index-CdofBiBD.js` |
| Local audited raster worker | `rasterWorker-CbGt9UUy.js` |
| Local audited projection worker | `displayProjectionWorker-FgX-hodh.js` |

The clean V5 production build passed TypeScript, security contracts, Vite, and
the secret audit. Vercel refused publication because the project now emits 13
serverless functions while the Hobby plan permits 12. No alias changed. Any
visual judgment based on the supplied production capture is therefore evidence
about the older V3 deployment, not V5.

There is no BCLIF service worker, IndexedDB store, or localStorage tile store.
Persistent tiles use a bounded memory-only LRU whose key contains venue, symbol,
horizon, tile ID, model version, schema version, and checksum. Same-tile
checksum changes, version changes, age, LRU pressure, controller disposal, and
sign-out clear or invalidate relevant bytes.

## Exact production call graph

| Stage | File / symbol | Input | Output | Production? | Absolute-price invariant | State / fallback |
| --- | --- | --- | --- | --- | --- | --- |
| Chart mount | `components/PixiBlackChart.tsx` / `new LiquidationFieldController` | symbol, chart candles, settings | controller snapshots and status | Yes | Does not build prices | One controller owns one authority |
| Authority selection | `data/LiquidationFieldController.ts` / `start` | persistent request | persistent snapshot or safe fallback reason | Yes | Rejects mixed authorities | Browser begins only after a fallback-safe persistent result |
| Browser acquisition | `data/BrowserLiquidationFieldFallback.ts` / `start`, `refreshBootstrap` | symbol, model horizon | canonical bootstrap plus session live state | Yes, while host is absent | Does not rescale price | Session-only; rebuilds from bootstrap |
| Bybit bootstrap | `data/bybitPublicData.ts` / `bootstrapBybitLiquidationField` | public kline, 5-minute OI, ticker, risk tiers, funding, ratios | canonical 5-minute frames | Yes | Entry distributions contain exchange prices | No historical trades, liquidations, or book are invented |
| Live public stream | `data/bybitLiquidationStream.ts` | public trades, all-liquidation, L2 | session CVD, events, depth | Yes | Event/bankruptcy prices stay absolute | Starts at browser connection time |
| Worker boundary | `worker/LiquidationFieldWorkerClient.ts` → `worker/rasterWorker.ts` | frames, events, rules, settings, coverage | structured snapshot | Yes | Typed arrays preserve grid rows | Synchronous fallback runs the same builder |
| Cohort engine | `core/cohortEngine.ts` / `processFrame` | chronological frame and known events | cohorts, particles, mass ledger | Yes | Entry and liquidation means are stored as absolute quote prices | Canonical browser and persistent implementation |
| Liquidation math | `core/bybitLiquidationModel.ts` | side, absolute entry, leverage, risk tier, margin prior | absolute liquidation distribution | Yes | Current mark does not replace the entry anchor | Model uncertainty is explicit |
| Raster | `core/exposureRaster.ts` / `buildLiquidationFieldSnapshot` | particles on stable price lattice | raw long/short exposure per time × absolute-price cell | Yes | Particle row is `(liquidationPrice-minPrice)/priceStep` | One state column per selected causal frame |
| Source normalization | `core/normalization.ts` / `normalizeExposureCausal` | raw raster | 8-bit intensity | Yes | Does not move rows | V5 used a 64-column rolling window |
| Display projection | `rendering/displayProjection.ts` | absolute source raster, chart display domain, UI settings | resampled display raster | Yes | Resampling changes pixels, not source prices | V5 HYBRID mixed 68% source and 32% visible-range contrast |
| PIXI renderer | `rendering/BlackCoreLiquidationFieldRenderer.ts` | display projection and overlays | GPU texture, labels, markers | Yes | Labels map source price to chart coordinates | Current price may change display domain only |

The selected chart timeframe is not a cohort identity input. Browser cohort
birth uses one canonical five-minute Bybit OI clock. The selected BCLIF horizon
changes requested history; chart zoom changes display projection only.

## Mark-price perturbation trace

For a fixed long entry distribution around 58,000 and a fixed short entry
distribution around 72,000, changing only the current mark through
62,000 → 66,000 → 70,000 → 60,000 → 75,000 does not change the liquidation
means produced by `estimateBybitLinearLiquidationDistribution`. It can change
lifecycle traversal, depth/cascade presentation, chart display domain, and
viewport resampling. It cannot legally rewrite `entryMean`,
`liquidationMean`, `liquidationLower`, or `liquidationUpper`.

The production-path regression suite for this chapter records model hash,
raw-exposure hash, grid identity, and raw shelf rows for every perturbation.
Those values must remain identical when no causal traversal or new observation
is introduced.

## Root-cause verdict before correction

**Result A: raw cohorts are horizontally anchored; the thermal presentation
appears swing-following.**

There is no code path that translates a surviving cohort with the mark. The
observed topology was produced by a combination of:

1. one paired cohort family for nearly every material positive five-minute OI
   observation, creating many short-lived shelves near successive entry areas;
2. repeated browser reconstruction from a moving bootstrap window rather than
   a persistent live generation;
3. a 64-column rolling normalization window that repeatedly promoted each
   local generation's strongest values; and
4. default HYBRID projection blending 32% visible-range contrast into source
   intensity.

The V3 reference deployment amplified the same class of problem and is not a
valid V5 certification target.

## Truth boundaries

- Historical browser coverage is OI plus public price-derived entry
  approximation. It is not historical trade, liquidation, or L2 coverage.
- A yellow/high-authority cell requires multiple independent evidence channels.
  Browser historical OI-only cells must remain purple/blue and muted.
- Live calibration begins at browser connection and does not backfill earlier
  columns.
- Cross and unknown margin models contribute raw modeled mass but receive
  bounded visual authority. A renderer may mute uncertainty; it may not move or
  delete the underlying shelf.
- The authoritative internal storage contract is absolute quote-price
  distribution. Normalized values are presentation derivatives only.

## Infrastructure status

- PERSISTENT HOST NOT PROVIDED
- COLLECTOR NOT DEPLOYED
- MIGRATIONS NOT APPLIED
- AUTHORITY BROWSER FALLBACK
- PERSISTENT REPLAY NOT AVAILABLE

No private Bybit endpoint, order execution, broker state, or excluded subsystem
was used in this audit.
