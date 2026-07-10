# Black Core Performance Baseline

Generated: 2026-07-10T18:57:15.617Z

Commit: 8854eef

Node: v22.18.0

Platform: win32

## Source Footprint

| Metric | Value |
| --- | ---: |
| Files | 159 |
| Lines | 37543 |
| requestAnimationFrame | 6 |
| setInterval | 25 |
| setTimeout | 15 |
| addEventListener | 20 |
| removeEventListener | 20 |
| WebSocket constructors | 16 |
| Worker constructors | 1 |
| ResizeObserver references | 2 |
| MutationObserver references | 0 |
| Performance metric publishers | 10 |

## Bundle Footprint

Bundle available: yes

Total asset bytes: 3170448

| Asset | Bytes |
| --- | ---: |
| index-Cu7gv2nQ.js | 1155564 |
| chart_preview-C0S4kWWD.jpg | 848950 |
| terminal_mockup-DSkpidIZ.jpg | 758834 |
| index-nQkvY4mC.css | 154096 |
| WebGLRenderer-CVCHvocA.js | 68435 |
| RenderTargetSystem-CP4JaWxC.js | 46307 |
| browserAll-DQuDxly2.js | 43055 |
| WebGPURenderer-fLBKkXGx.js | 38200 |

## Runtime Capture

- Open Black Terminal.
- Press `Ctrl+Shift+P` to show the Performance HUD.
- Use `Copy Snapshot` before and after long DOM Pro+ sessions.
- Run `npm run perf:stress` with `PERF_STRESS_URL` to record long-session endpoint health.
