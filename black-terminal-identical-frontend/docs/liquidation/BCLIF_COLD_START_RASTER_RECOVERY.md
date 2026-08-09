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
