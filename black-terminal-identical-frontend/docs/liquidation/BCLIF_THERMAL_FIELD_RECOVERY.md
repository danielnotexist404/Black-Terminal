# BCLIF Thermal Field Recovery and V9 Plasma Presentation

## Production symptom

A restored workspace first displayed only two or three short red, white, or grey cohort shelves. A later corrective build removed the shelf-only state but could still appear nearly black because sparse browser-fallback intensity was allowed to become transparent. The BCLIF model and OI bootstrap were alive in both cases; neither symptom represented a zero-exposure market.

## Exact root causes

Renderer schemas through V7 treated rawCohortShelvesVisible as an exclusive presentation mode. The flag enabled diagnostic shelf strokes and hid the GPU thermal sprite. Persisted workspace state therefore made a valid raster look absent.

The V8 layer repair exposed a second presentation failure: invalid and low-intensity pixels resolved toward transparent black, the sprite covered only its snapshot rectangle, and short-lived source-column peaks produced isolated strokes instead of legible price shelves. That combination caused black side voids, flicker, and visually weak liquidity structure even when modeled exposure existed.

## Renderer V9 contract

- The renderer paints a theme-aware backdrop across the complete plot before drawing the thermal texture. Snapshot edges and unavailable cells therefore remain deep plasma purple, or near-black blood red in the Black Terminal theme, instead of becoming black holes.
- The thermal texture and raw shelf diagnostic remain independent layers. Enabling the diagnostic adds an overlay and never hides the raster.
- Display projection uses one display column per available plot pixel within the bounded 512–1536 grid and retains the high-resolution price grid.
- Reference Thermal is the CoinGlass-style Purple Plasma theme: deep purple, blue and cyan context, green active shelves, and rare yellow extreme cores.
- Blood / White / Silver is the Black Terminal theme: black and blood-red context with silver and white high-intensity shelves.
- Plasma Background, Shelf Clarity, and Residual / Half-Mitigated Shelves are persisted presentation controls. They change no cohort, exposure, liquidation, or confidence calculation.
- Shelf persistence is causal and render-only. Each column can inherit a bounded set of strong price-local peaks from past columns. A shelf fades according to remaining display mass and stops immediately when the underlying validity/alpha channel reaches zero. Future columns are never read while painting an earlier column.
- The V9 workspace migration upgrades old Reference Thermal settings to the production plasma defaults and invalidates older renderer checkpoints. Other indicators and workspace preferences are preserved.

## Evidence and authority boundary

The vivid palette is a display transfer, not a source upgrade. Browser fallback can show crisp relative OI-derived exposure peaks, but its evidence metadata remains browser fallback and its yellow-eligible count remains zero. Exact-trade, liquidation, and order-book inputs are still required before the engine may report those colors as evidence-authorized liquidation observations. A residual shelf means modeled exposure remains at that price; it is not proof that an order or liquidation exists there.

The persistent collector remains required for continuous historical event memory. V9 does not stretch a short model window over unevidenced history, mutate model/exposure hashes, or fabricate data to fill the backdrop.
