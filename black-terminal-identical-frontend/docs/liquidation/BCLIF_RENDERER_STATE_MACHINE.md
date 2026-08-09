# BCLIF renderer state machine

Client lifecycle states are UNMOUNTED, MOUNTING, RESTORING_LOCAL_PUBLIC_CACHE, WAITING_FOR_MODEL, BACKFILLING_OI, OI_CONTEXT_READY, LIVE_CALIBRATING and PERSISTENT_READY. Explicit exceptional states are FILTERED_EMPTY, RENDERER_INITIALIZING, TEXTURE_ERROR, SOURCE_UNAVAILABLE, VENUE_UNSUPPORTED and FATAL.

Renderer readiness reports WebGL context readiness, texture allocation, buffer validity, snapshot application, upload completion, draw-pass activity, upload count/timestamps/duration, cell counts, alpha bounds, dimensions and generation lag.

Before upload, dimensions, channel lengths and price domain are validated. Projection byte arrays cannot contain NaN or Infinity. A raw-nonzero/visible-zero projection becomes FILTERED_EMPTY; zero maximum alpha becomes INVISIBLE_TEXTURE; projection or upload failures become TEXTURE_ERROR.

BlackChartEngine handles webglcontextlost and webglcontextrestored. On restoration it rebuilds the texture from the retained projection/snapshot and settings, then resumes drawing without waiting for market input.
