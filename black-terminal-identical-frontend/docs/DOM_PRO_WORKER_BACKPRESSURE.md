# DOM Pro Worker Backpressure

## Queue Contract

The DOM aggregation client permits one posted task and at most one useful queued generation per market key. New queued work replaces older unposted work. Posted stale results are rejected by generation. A 1.2 second timeout fails over to the local engine, terminates the unhealthy worker and clears pending work.

Tracked counters:

- submitted
- processed
- coalesced
- dropped
- stale
- queue peak
- input transfer bytes
- output transfer units
- processing and round-trip duration

A growing queue is treated as a defect. Execution and account reconciliation do not use this worker.

## Transfer Contract

The source orderbook is packed into bid and ask `Float64Array` buffers and transferred, not structured-cloned as thousands of nested level objects. The worker reconstructs its private calculation view. Trades remain a bounded 200-row input.

The reverse message omits:

- source orderbook
- ticker
- trades
- prior heatmap frames

It returns derived buckets, walls, metrics, bounded CVD buckets and one heatmap delta column. The client restores source references from the original request and maintains the heatmap ring. This removes repeated reverse cloning of the dominant historical matrix.

## Failure Behavior

- Missing Worker support uses the same deterministic engine on the main thread.
- Timeout resolves only the newest generation through fallback.
- Worker errors terminate the instance and resolve pending visual work as stale.
- Idle workers terminate after 30 seconds.
- Main-thread heatmap caches are capped at eight market keys.
- Stale analytics never modify OMS, Position Manager, account state or execution reports.

## Measured Recovery

The initial recovery smoke test processed approximately 2,031 source units per worker request but returned about 192 derived units. Queue peak remained one. Worker aggregation averaged 2.41 ms, p95 4.2 ms and maximum 10.6 ms. Exact final soak evidence is recorded in `DOM_PRO_FINAL_PERFORMANCE_RESULTS.md`.
