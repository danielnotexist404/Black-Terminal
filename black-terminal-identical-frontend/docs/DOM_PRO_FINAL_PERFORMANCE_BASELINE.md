# DOM Pro Final Performance Baseline

Captured 2026-07-14 on Windows with headless Brave/Chromium at 1920x1080 from commit `a9d2bfc` before recovery changes. The deterministic harness exercised the chart, DOM Pro, Macro 3D, preset switching, settings, heatmap pan/zoom, mount cycles, A.I.F. plus DOM, and visibility recovery. Raw evidence is in `docs/performance/dom-pro-final-baseline.json`.

## Baseline

| Metric | Result |
| --- | ---: |
| Runtime sample | 21.2 seconds / 17 samples |
| Frame p95 | 354.1 ms |
| Frame p99 | 416.6 ms |
| Longest long task | 216 ms |
| Heap growth | 82.54 MB |
| DOM node growth | 4,444 |
| Peak heatmap cell elements | 4,068 |
| Worker queue peak | 1 |
| Feed messages peak | 11/sec |

The result fails the recovery thresholds. Frame latency and DOM growth worsen monotonically as heatmap history fills; this is reproducible without feed overload.

## Top Bottlenecks

1. **Per-cell React heatmap rendering.** Every retained heatmap frame creates React `<i>` elements for each visible cell. The short run reached 4,068 heatmap elements and 6,163 total DOM nodes, with p95 frame time rising from 83 ms to 354 ms.
2. **Full worker result cloning.** Every aggregation response returns source book, trades, and the complete historical heatmap array. Historical frames are repeatedly structured-cloned even when only the newest time column changed.
3. **Broad cockpit commits.** One snapshot state drives the full `DomProWindow`; panel snapshots, derived arrays, hover work, and unrelated panels are revisited together. Pointer movement also scans heatmap history for tooltip data.

The worker queue remained bounded at one, so queue length is not the primary baseline failure. The shared feed also remained singular. The recovery therefore targets render-object growth, transfer amplification, and broad commit work before changing feed fidelity.

## Scenario Status

| Scenario | Status | Reason |
| --- | --- | --- |
| A DOM Pro alone | Reproduced | DOM history starts accumulating immediately. |
| B Chart + DOM | Failed | p95 reached 354.1 ms. |
| C A.I.F. + DOM | Failed | p95 reached 298.6 ms in the short combined run. The deterministic 20,000-bar A.I.F. benchmark remains a separate regression input. |
| D Macro 3D | Failed | p95 reached 236.1 ms despite lower source cadence. |
| E Preset switching | Failed | Broad settings invalidation compounded accumulated render cost. |
| F Settings open/close | Failed | Popover interaction occurred during full cockpit churn. |
| G Pan/zoom | Failed | p95 reached 270.9 ms and interaction rebuilt thousands of elements. |
| H Mount/unmount | Failed | Resource counts did not multiply, but remounting resumed the same growth pattern. |
| I One hour | Deferred until recovery | Running the known failing build for an hour would not add diagnostic value. The final one-hour run is mandatory after fixes. |

## Baseline Method

Run `node scripts/dom-pro-performance-harness.js --baseline --minutes=0.34` against the pre-recovery bundle. The harness never submits orders. It captures browser telemetry, heap, node counts, worker queues, feed rates, scenario labels, and CDP performance counters.
