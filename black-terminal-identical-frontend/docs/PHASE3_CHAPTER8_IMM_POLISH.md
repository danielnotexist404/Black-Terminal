# Phase III Chapter VIII - IMM Polish And Professional UX

Status: foundation implemented, further interaction polish planned.

## Objective

Chapter VIII turns DOM Pro+ from a working market-memory cockpit into a calmer institutional desk surface. The goal is not a new data model. The goal is predictable camera control, visible operational state, persistent user preferences, and fewer surprises while a trader explores large historical liquidity domains.

## Implemented

- Added DOM workspace presets:
  - Scalper
  - Intraday
  - Institutional
  - Macro
- Presets change mode, bucket scale, visible range, CVD horizon, heatmap horizon, frame budget, smoothing, and camera target as one deliberate workspace action.
- Added persistent camera mode controls:
  - Center
  - Fit
  - Follow
  - Explore
- Added persistent settings for:
  - `workspacePreset`
  - `followMarket`
  - `freeExplore`
  - `showDepthChart`
- Manual wheel zoom or drag exploration automatically exits follow mode and enters free-explore mode.
- Follow mode uses the same shared price camera as the heatmap, volume profile, and depth chart. It does not create a second viewport model.
- Added keyboard shortcuts:
  - Space: center market
  - F: fit visible data
  - M: toggle follow market
  - R: reset camera
  - H: toggle heatmap
  - P: toggle volume profile
  - D: toggle depth chart
  - Esc: close hover/settings overlays
- Added a compact IMM status bar to DOM Pro+ with:
  - IMM overall status
  - venue and symbol
  - active horizon
  - camera mode
  - bucket scale
  - render FPS
  - worker status
  - quality or local depth-memory source
  - replay confidence or local memory points
  - active price domain
  - buy/sell wall counts
  - heartbeat and persistence age
- The status bar consumes `/api/imm/status` and falls back to browser feed status when the endpoint is unavailable.

## Architecture Rule

DOM Pro+ continues to use one shared price-space camera. Presets, follow mode, free exploration, wheel zoom, drag panning, heatmap rendering, volume profile alignment, and depth chart rendering all consume that camera. No parallel viewport state was added.

## Validation

```bash
npm run build
```

Build passed after the Chapter VIII changes.

## Remaining

- Add inertia/momentum panning.
- Add persistent user-resizable panel geometry.
- Add a future minimap/navigator that consumes the existing camera domain.
- Expand tooltips with wall id, venue, timestamp, reliability, and persistence metadata.
- Add automated browser interaction tests for pan, zoom, presets, follow mode, and keyboard shortcuts.
- Add optional server-side or account-level persistence only if DOM workspaces must sync across devices.
