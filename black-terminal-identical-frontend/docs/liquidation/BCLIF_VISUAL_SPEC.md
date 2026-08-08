# BCLIF Visual Spec

Default presentation is `BCLIF — Trade Focus`: Chart Scale, 60% confidence floor, Combined historical/live channels, High candle contrast, 45% heatmap opacity, Hybrid normalization, and at most four cluster labels. `Full Spectrum Research` is the explicit wide-domain view; it is never the operational auto-scale default.

Reference Thermal — Selective uses a valid deep-purple floor, blue/cyan middle structure, green important structure, and rare yellow extreme cores. Its defaults are q50/q99.8 robust bounds, gamma 1.55, 45% opacity, confidence weighting, and a 0.3% yellow tail. Gamma greater than one suppresses ordinary mid-range authority without changing exposure. Alternative palettes remain available.

Historical OI-only context is subdued purple/blue. Live trade, liquidation, and order-book support may earn cyan/green authority. Yellow requires at least 75% confidence, valid continuity, exposure in the configured exceptional tail, and two meaningful evidence channels. OI-only history cannot become broad yellow by default. Historical gaps use a dark desaturated hatch and never share the valid thermal floor. Confirmed liquidations are separate markers. The default candle palette remains silver/blood red.

In `BCLIF_MODEL_V5_AUTHENTIC_EXPOSURE`, entry-anchored remaining exposure is normalized with a fixed-domain 64-column rolling histogram. Every column reads only its current/trailing observations, so future inputs cannot recolor historical intensity. Confidence remains an independent causal channel and limits authority/alpha without moving, narrowing, or creating exposure. Applying display confidence in a way that changes cohort mass or historical price anchors is prohibited.

The model domain and exposure hash are immutable across display modes. Price display, palette, opacity, gamma, normalization, LOD, and camera create separate render-settings and display-raster identities only. High-confidence structure keeps a narrow bright core; uncertain structure receives a broader, faint display envelope without narrowing the underlying model distribution.

The compact authority badge is always visible. Browser mode says `BROWSER FALLBACK / PERSISTENCE OFF`; persistent mode says `PERSISTENT NODE / HISTORY CONTINUOUS`. A three-week fallback view is labeled OI context with live events collecting, never complete event history.
