# BCLIF Visual Spec

## Chapter III-C6 default visual contract

The default is now `Reference Thermal` with `Reference Thermal V2`, calibrated purple-plasma LUT, relative exposure, logarithmic notional, global robust Q5/Q99.86 normalization, gamma 0.85, 96% opacity, 15% purple floor, and Ultra high-DPI LOD. Raw shelves, validity, event nodes, labels, dashboards, provenance, and developer diagnostics are off by default. One compact collapsed authority badge remains.

V2 renders a continuous opaque purple field across valid evidence, with crisp horizontal blue/cyan/green shelves and rare high-authority yellow cores. It does not create artificial exposure in invalid cells, and it does not infer additional shelves from color or smoothing. Shelf magnitude and confidence are independent channels: magnitude selects hue; confidence influences alpha/diagnostic eligibility only. The selectable Blood / White / Silver palette changes presentation without changing scalar field identity.

The dedicated V3 renderer goldens pass at 1920×1080, 2560×1440, and 3840×2160. The older 27-case matrix has not been wholly re-recorded for V2 and therefore remains pending as a complete historical-matrix certification.

Default presentation is BCLIF — Trade Focus: Chart Scale, Combined historical/live channels, high candle contrast, full-opacity thermal projection, Hybrid normalization, and at most four cluster labels. Full Spectrum Research is the explicit wide-domain view and is never the operational auto-scale default.

Reference Thermal means the calibrated V2 Purple Plasma visual family. The earlier V9 RGBA/backdrop controls are retained only for Legacy V1 compatibility. Blood / White / Silver · Black Terminal maps the same scalar raster to near-black, blood red, silver, and white without changing shelf locations.

Visual vividness and evidence authority are separate. Browser fallback may render a crisp relative peak for readability, but its yellowEligible metadata remains zero and its HUD remains BROWSER FALLBACK / PERSISTENCE OFF. Exact trades, liquidation events, and order-book support are required for evidence-authorized high-confidence claims. Missing coverage receives the selected theme backdrop, never fabricated exposure and never a black transparent hole.

The model domain and exposure hash are immutable across display modes. Price display, palette, opacity, plasma background, gamma, normalization, LOD, shelf clarity, residual persistence, and camera create render-settings/display-raster identities only. Render-only shelf persistence walks strictly from past to present, keeps a bounded number of distinct price-local peaks while display mass remains, and terminates on zero validity/alpha. Future data cannot repaint historical texture columns.

The compact authority badge is always visible. Browser mode says BROWSER FALLBACK / PERSISTENCE OFF; persistent mode says PERSISTENT NODE / HISTORY CONTINUOUS. A three-week fallback view is labeled OI context with live events collecting, never complete event history.
Chapter II-D adds safe node health to the same authenticated payload: stable node ID, stale-aware status, heartbeat age, deployment commit, connection/strategy counts, queue depth and clock state. Hostname/IP, image internals, keys and raw cryptographic state remain server-only. The UI reports OFFLINE after 45 seconds without heartbeat even if the last database status was READY.
