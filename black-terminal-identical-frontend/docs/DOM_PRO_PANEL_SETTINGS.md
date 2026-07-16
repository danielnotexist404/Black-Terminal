# DOM Pro Panel Settings

## Ownership

The top-right DOM Pro settings panel owns global cockpit behavior: visibility, total FPS, macro history, shared camera, diagnostics, and global reset/reload actions.

The shared camera setting synchronizes price geometry only. Ladder, Volume Profile and Liquidity Heatmap retain independent data grids; profile row count never changes IMM or ladder aggregation.

The Liquidity Heatmap panel includes `Enhanced Liquidity Graphics`. It is a rendering-only option that restores high-contrast neon macro walls and embeds price, touch count and strength inside each visible level. `Show Level Details` controls the embedded text independently. Neither option changes IMM history, wall selection, camera geometry or analytics.

Volume Profile annotations use a dedicated dense overlay above the native profile rows. This preserves the complete institutional price/classification columns without clipping or reducing profile resolution.

Each panel cog owns only that panel's analytical controls. The registry key is scoped to workspace and symbol:

```text
bt_dom_pro_panel_settings:<workspaceId>:<exchange:marketKind:symbol>
```

The registry schema is versioned. Reads merge stored values over current defaults, add newly introduced panels/fields, and preserve compatible user values.

## Panels

| Panel | Main controls |
|---|---|
| Ladder | shared/follow/independent camera, shared rows, live coverage, uncovered-row mode, minimum size, wall confluence, cadence |
| Volume Profile | rows, value area, POC/HVN/LVN, labels, shared camera, cadence |
| Heatmap | persistence, minimum size, decay, wall sides, labels, cadence |
| Wall Detection | thresholds, persistence, observations, sorting, major-only, cadence |
| Trade Tape | size filter, rows, grouping, aggregation, hover freeze, cadence |
| DOM Metrics | EMA, hysteresis, confirmation delay, raw/smoothed view, cadence |
| Structural CVD | venue candle timeframe, historical bars, SUM/EMA/SMA cumulation, cumulation length, scale, visible structure bars, delta clipping, layers, cadence |
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

Shared is the ladder factory default. `Dim`, `Show` and `Hide` control presentation of uncovered prices only; they never convert historical IMM observations into live size. Settings schema version 6 also migrates the old session-scale Heuristic CVD to a broad Structural CVD using venue OHLCV history. See `DOM_PRO_STRUCTURAL_CVD.md`.
