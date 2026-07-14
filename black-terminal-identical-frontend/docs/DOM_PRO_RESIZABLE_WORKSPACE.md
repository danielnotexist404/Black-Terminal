# DOM Pro Resizable Workspace

Status: Implemented, browser-local persistence

## Ownership

`src/modules/dom-pro/domWorkspaceLayout.ts` owns DOM Pro geometry. Market data, aggregation, workers, cameras and execution services do not own panel dimensions.

The versioned layout contains:

- a horizontal root split between analysis and the compact bottom row;
- a nested six-panel upper split;
- a nested Depth Chart / Liquidity Flow Delta / Execution split;
- collapsed, visible and maximized panel state;
- normalized ratios, factory preset and auto-save preference.

Factory layouts are Scalper, Intraday, Institutional, Macro, Compact Execution and Analysis Focus. Custom layouts can be stored per workspace/window. The default Institutional layout assigns 70% to the upper region and 30% to the bottom row.

## Interaction

Separators use an 8 px pointer target, `separator` ARIA semantics, arrow-key resizing, Shift plus arrow for larger steps and double-click reset. Ratios are clamped before rendering. Collapse reduces a panel to a header-width track; maximize preserves the underlying split tree and Escape restores it.

During a drag, DOM Pro enters `RESIZE_ACTIVE` through the existing interaction coordinator. Pointer movement is coalesced through one animation frame. Analytics, feeds, workers and historical stores are not restarted or recalculated. On release, the shared visual scheduler performs one geometry redraw from existing data.

## Persistence

Primary state key: `bt:dom-pro-layout:v1:<workspaceId>:<windowId>`

Custom presets: `bt:dom-pro-layout-preset:<workspaceId>:<presetName>`

Writes occur after resize completion and are debounced by 500 ms when auto-save is enabled. Layout state uses local workspace storage; no Supabase migration is required.

## Constraints

The split model records minimum panel dimensions and enforces split-ratio limits. Content uses container queries, preserves chart/canvas coordinates and never scales the cockpit with CSS transforms. Detached windows receive an independent layout key.
