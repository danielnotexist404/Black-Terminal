# BCLIF cold-start raster recovery

Chapter III-C5 repairs a client/rendering failure without changing BCLIF model mathematics.

## Recovery contract

A completed compatible snapshot is retained in a replaying in-memory store. The renderer reads the latest snapshot when it mounts and then subscribes for later generations. Browser fallback also attempts a bounded public IndexedDB checkpoint before fresh OI backfill. The visible sequence is:

RESTORING_LOCAL_PUBLIC_CACHE → BACKFILLING_OI → OI_CONTEXT_READY → LIVE_CALIBRATING.

A compatible checkpoint remains visible while public sources reconcile. A corrupt, expired, oversized, future-dated, wrong-model, wrong-venue, wrong-symbol, wrong-horizon or wrong-presentation record is deleted and source rebuild proceeds.

## Root cause

The V6 model was healthy. Legacy V3 presentation state multiplied a roughly 50% browser-fallback field through one shared confidence threshold, historical opacity, evidence-count, authority and sprite-opacity factors. The resulting texture had a maximum channel alpha of 2/255 and an effective composite maximum near 0.35%, while raw cluster extraction still found shelves. A renderer mount race also had no latest-snapshot replay guarantee.

The repair separates visibility, labels and color authority, migrates legacy state to renderer schema V7, enforces opacity >= 10%, retains one compatible snapshot, instruments every renderer stage, and reports filtered/texture/domain failures in one compact HUD.

## Browser evidence

The deterministic Browser Fallback case at 1920×1080 produced 349,074 raw non-zero cells and 349,074 visible cells, zero yellow cells, zero cluster labels at 52% confidence, a 396,288-cell display raster, 3.0 ms texture preparation/upload, generation lag zero, and successful synthetic WebGL context restoration. The full deterministic fixture reload measured 5.465 seconds; it bypasses the production IndexedDB restoration route, so it is not used as a checkpoint-latency claim.


## Production follow-up: single-flight live raster publication

Browser Fallback raster construction is now guarded by a single-flight coalescer. While one worker build is active, any number of public-stream updates set one pending refresh instead of starting or invalidating additional builds. The completed first snapshot always publishes; the gate then runs at most one follow-up using the latest state.

The stream scheduler now throttles instead of resetting a debounce timer on every market message, so a continuously active market cannot postpone updates forever. Before the first snapshot, the HUD truthfully remains `BACKFILLING_OI` or `RENDERER_INITIALIZING`; `LIVE_CALIBRATING` is reported only after a snapshot has actually published.

The cold-start regression injects 1,000 updates while the first build is blocked and proves one active build, two total invocations (initial plus one coalesced refresh), maximum concurrency one, and publication order `[1, 2]`. Typecheck, security contracts, production build, cold-start, model, operational-clarity, authentic-exposure, and live-pipeline gates pass.


## Renderer projection recovery

The display worker now uses a latest-only single-flight projection queue. A completed projection is allowed to publish and upload; updates received while it is active collapse to one newest follow-up. Same-market snapshots retain the last certified texture while the replacement is constructed, eliminating label-only frames and parameter-change blinking. A semantic scope change (authority, venue, symbol, horizon, schema/model, price lattice or dimensions) resets the queue and rejects an old-scope response.

The regression floods an active projection with 1,000 distinct updates and proves that only `initial` and `update-999` start. It also proves that a response from a reset scope is rejected. A wide 4H domain matching the production capture retains 566,366 visible cells. The focused 1920 x 1080 Brave Browser Fallback comparison passes at SSIM 1.0 with 349,074 raw and visible cells, WebGL context recovery, and one active texture.
