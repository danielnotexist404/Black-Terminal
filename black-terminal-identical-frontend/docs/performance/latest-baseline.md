# Black Core Performance Baseline

Generated: 2026-07-13T17:31:11.832Z

Commit: 12848ab

Node: v22.18.0

Platform: win32

## Source Footprint

| Metric | Value |
| --- | ---: |
| Files | 169 |
| Lines | 41604 |
| requestAnimationFrame | 8 |
| setInterval | 26 |
| setTimeout | 21 |
| addEventListener | 22 |
| removeEventListener | 22 |
| WebSocket constructors | 16 |
| Worker constructors | 2 |
| ResizeObserver references | 5 |
| MutationObserver references | 0 |
| Performance metric publishers | 23 |
| Coalesced event publishers | 6 |
| Explicit resource acquisitions | 14 |

## Bundle Footprint

Bundle available: yes

Total asset bytes: 3297052

| Asset | Bytes |
| --- | ---: |
| index-CHQcHtFf.js | 1134608 |
| chart_preview-C0S4kWWD.jpg | 848950 |
| terminal_mockup-DSkpidIZ.jpg | 758834 |
| index-C3mjXgzD.css | 169085 |
| DomProWindow-Ca5iCpHd.js | 118852 |
| WebGLRenderer-CEaN39Wy.js | 68437 |
| RenderTargetSystem-Ctmk6lZO.js | 46308 |
| browserAll-Cfg7kCn6.js | 43055 |

## Runtime Capture

- Open Black Terminal.
- Press `Ctrl+Shift+P` to show the Performance HUD.
- Use `Copy Snapshot` before and after long DOM Pro+ sessions.
- Run `npm run perf:soak -- --hours=1` for deterministic browser interaction and resource-growth checks.
- Run `npm run perf:stress` with `PERF_STRESS_URL` for server endpoint and IMM health sampling.
