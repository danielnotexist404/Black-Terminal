# A.I.F. Benchmarks

Benchmark command: `npm run benchmark:aif`

Environment: Node 22, deterministic synthetic one-minute candles, logarithmic domain, full profile/node/stability/event/render pipeline. The matrix covers all five production lenses at 100, 300, 500 and 1,000 rows plus Volume paired with Delta, TPO and Volatility. Stage timing records normalization, profile calculation, node/stability work, event generation and render-model creation. Memory deltas are noisy because garbage collection is nondeterministic; cache capacity is separately asserted.

| Bars | Rows | Observed range |
|---:|---:|---:|
| 5,000 | 100-1,000 | 8-118 ms |
| 20,000 | 100-1,000 | 29-94 ms |
| 50,000 | 100-1,000 | 101-209 ms |
| 100,000 | 100-1,000 | 242-488 ms |

Recorded 2026-07-14 on the project workstation. The slowest observed single-lens case was 100,000-bar Volatility at 1,000 rows (488 ms); the slowest 100,000-bar pair was Volume + Volatility at 300 rows (443 ms). These are isolated engine measurements, not a promise of network-load or frame latency. Historical network paging normally dominates first load. Calculations execute in one dedicated latest-wins worker, results use an eight-entry LRU cache, current-bar changes coalesce for five seconds, and hidden A.I.F. disposes both.
