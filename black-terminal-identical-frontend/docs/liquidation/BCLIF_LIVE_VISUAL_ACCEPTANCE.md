# BCLIF Live Visual Acceptance

Required production matrix: Bybit BTCUSDT perpetual, 1H and 4H, Reference Thermal, Browser Fallback unless a certified persistent node exists, captured at 1080p, 1440p, and 4K.

For each capture record raw cohort/shelf counts, model and display price/time steps, OI/trade/liquidation/L2 coverage, authority, renderer version, texture formats, field occupancy, and visible UI. Acceptance requires immediate purple coverage, distinct cyan/green structure when source detail exists, rare yellow only, crisp candles, no cell grid, no permanent nodes, no dashboard, and camera attachment.

Current result: **NOT RUN against an authenticated deployed production session in this chapter.** Local Playwright V3 style fixtures pass. The repository raw fixture verdict is `RAW FIELD TOO SPARSE — SOURCE/MODEL RESOLUTION LIMIT` with six shelves. Persistent history remains unavailable, collector deployment remains absent, and live browser-fallback detail must not be represented as equivalent to the synthetic style fixture.

The production gate must be rerun after deployment. If real raw shelves remain sparse, the renderer may be certified while the data-detail limitation remains explicit; no synthetic micro-levels may be added.
