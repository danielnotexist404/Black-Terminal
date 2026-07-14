# DOM Pro Final Performance Results

Hardware/runtime: Windows, headless Brave/Chromium, 1920x1080, production Vite bundle. Tests use an admin harness session and never submit orders.

## Before And After

| Metric | Baseline | Recovery smoke |
| --- | ---: | ---: |
| Frame p95 | 354.1 ms | 48.7 ms |
| Frame p99 | 416.6 ms | 83.3 ms |
| Longest long task | 216 ms | 63 ms |
| Heap growth | 82.54 MB / 21 sec | 25.07 MB / 12 sec |
| DOM node growth | 4,444 | 142 |
| Peak heatmap React cells | 4,068 | 0 |
| Worker queue peak | 1 | 1 |

The smoke run passed its exact gates. Frame p95 improved by 86.2%, and heatmap React object growth was eliminated.

## Trace Results

| Span | Average | p95 | Maximum |
| --- | ---: | ---: | ---: |
| Worker aggregate | 2.41 ms | 4.20 ms | 10.60 ms |
| Bucket aggregation | 1.67 ms | 3.00 ms | 3.70 ms |
| Heatmap shaping | 0.24 ms | 0.40 ms | 0.90 ms |
| CVD calculation | 0.03 ms | 0.10 ms | 0.30 ms |
| Canvas heatmap draw | 3.71 ms | 11.70 ms | 30.20 ms |
| Master canvas frame | 3.60 ms | 11.80 ms | 30.20 ms |

Worker request input averaged 2,031 source units while reverse output averaged 192 units, a roughly 90.6% reduction in returned units compared with mirroring source plus historical data. The worker processed 109 of 113 short-run submissions, rejected four stale posted results, dropped no queued work and never exceeded queue depth one.

## Long Soaks

| Run | Duration | Samples | p95 | p99 | Longest task | Heap growth | DOM growth | Queue peak | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 30-minute soak | 1,800.547 s | 1,824 | 69.5 ms | 97.2 ms | 102 ms | 80.27 MB | 240 | 2 | PASS |
| One-hour soak | 3,600.418 s | 3,552 | 69.4 ms | 97.3 ms | 133 ms | 97.02 MB | 178 | 2 | PASS |

Every long-run gate passed: cockpit readiness, A.I.F. exercise, bounded heap/DOM/history/queue/resources, zero per-cell React heatmap nodes, p95 below 75 ms, and no task above 500 ms. Compact raw evidence is stored as `docs/performance/dom-pro-final-30m.json` and `docs/performance/dom-pro-final-1h.json`.

## Acceptance Gates

- p95 browser frame below 75 ms in deterministic headless smoke (79% lower than baseline)
- no frame or long task above 500 ms
- heap growth below 128 MB in short runs and bounded trend in long runs
- DOM growth below 500 nodes after initialization
- worker queue peak at most two
- no worker, listener, timer or socket monotonic growth
- zero per-cell heatmap React nodes
- all execution, Bybit, A.I.F., panel, performance and build gates green

## Remaining Bottlenecks

Canvas historical redraw is now the largest measured DOM-specific visual span, but it remains bounded and below the interactive frame threshold in the recovery trace. The main application bundle is still large and merits independent code-splitting work. Neither limit justifies weakening market data or execution safety.
