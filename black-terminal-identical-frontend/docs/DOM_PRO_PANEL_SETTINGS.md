# DOM Pro Panel Settings

## Ownership

The top-right DOM Pro settings panel owns global cockpit behavior: visibility, total FPS, macro history, shared camera, diagnostics, and global reset/reload actions.

Each panel cog owns only that panel's analytical controls. The registry key is scoped to workspace and symbol:

```text
bt_dom_pro_panel_settings:<workspaceId>:<exchange:marketKind:symbol>
```

The registry schema is versioned. Reads merge stored values over current defaults, add newly introduced panels/fields, and preserve compatible user values.

## Panels

| Panel | Main controls |
|---|---|
| Ladder | levels, minimum size, smoothing, cumulative depth, auto-center, cadence |
| Volume Profile | rows, value area, POC/HVN/LVN, labels, shared camera, cadence |
| Heatmap | persistence, minimum size, decay, wall sides, labels, cadence |
| Wall Detection | thresholds, persistence, observations, sorting, major-only, cadence |
| Trade Tape | size filter, rows, grouping, aggregation, hover freeze, cadence |
| DOM Metrics | EMA, hysteresis, confirmation delay, raw/smoothed view, cadence |
| Heuristic CVD | horizon, source bucket, EMA, candle interval, visible candles, cadence |
| Depth Chart | Raw/Smoothed/Structural/Macro, averaging, persistence, levels, curve, cadence |
| Flow Delta | horizon, time bucket, smoothing, clipping, display mode, cadence |
| Execution | order defaults, sizing, TIF, margin, confirmation, privacy, compact mode |

## Interaction

- Cog buttons have a 26 px target, tooltip, ARIA label, focus ring, and `aria-expanded`.
- Popovers remain inside the viewport and close on `Escape`, outside click, explicit Close, or panel removal.
- Diagnostics are collapsed by default and report source, quality, calculation/render cadence, coalescing, visibility, and worker topology.
- Reset restores the current saved default. Save as Default changes that panel's reset target.

## Presets

Global workspace presets apply a coordinated set once. Panel settings are ordinary registry values afterward, so user overrides are retained until another global preset is explicitly selected.

No Supabase schema is required for this chapter. A future preference API can persist the registry JSON without changing panel components.
