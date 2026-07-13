# Chapter XIV Memory And Resource Audit

Date: 2026-07-13

## Findings And Fixes

| Risk | Root cause | Fix | Verification | Remaining risk |
| --- | --- | --- | --- | --- |
| Reconnect growth | socket retries lacked complete intentional-close ownership | centralized reconnect timeout, jitter, stale timestamps and close cleanup | active WebSocket count must remain flat during reconnect cycles | venue/browser behavior needs long production observation |
| Heartbeat overlap | interval could start a new async heartbeat before the prior one completed | one in-flight heartbeat per connection | tracked interval count and connection diagnostics | external request latency can still delay freshness |
| DOM worker backlog | every snapshot could become an independent worker task | one active plus newest queued task; stale versions discarded | worker queue high-water and dropped-frame metrics | structured cloning still costs memory for large snapshots |
| IMM stale results | worker responses had no generation ownership | request/version protocol and stale-result rejection | rapid horizon/camera switching | transferable matrix protocol remains future work |
| DOM visual work while hidden | visual notifications continued while the document was hidden | suppress notification work and flush newest state on visibility return | listener/interval counters across visibility cycles | globally required cache ingestion intentionally continues |
| Market cache growth | symbol-key maps and trade arrays were not uniformly bounded | bounded keys and per-key candle/trade retention | deterministic regression test | persisted server depth has separate retention policy |
| OMS history growth | orders and per-order reports could grow for the full browser session | 2,000-order cap, terminal-order pruning and 50 reports/order | test and code invariant | active non-terminal orders are never pruned automatically |
| DOM heatmap memory | full history was cloned at visual cadence | 3,000 active-price memory cap, 180 compact frames, balanced cell culling and 4 Hz frame creation | worker snapshots and final soak | a typed-array ring buffer would reduce clone/allocation cost further |
| Chart orderbook heatmap | 1,800 snapshots retained complete venue depth and warmed toward hundreds of MB | 360 snapshots, 240 levels/side; persistent history delegated to IMM | final one-hour soak peaked at 118 MB and passed with 56 MB start-to-end growth | browser-local depth is intentionally shorter than IMM history |
| Pixi lifecycle opacity | no authoritative active object view | tracked containers, Graphics, Text, textures and geometries; destroy clears gauges | DOM Pro/chart mount cycles in soak harness | draw-call value is currently a layer estimate, not a renderer counter |
| Production mock data | live history failure could silently create fake candles | simulated fallback requires mock venue or explicit environment flag | code audit and production data status | explicit simulation remains available for controlled development |

## Retention Rules

- Performance frame history: 600 samples; capture history: 7,200 snapshots.
- Performance latest metrics: one value per metric/tag key.
- Market cache: 24 candle symbols, 16 trade symbols, 32 snapshots; 5,000 candles and 1,000 trades per key.
- DOM aggregation engines: maximum eight symbols in the worker.
- DOM heatmap memory: maximum 3,000 active price memories and 180 compact browser-local frames.
- Worker queues: one active task and one latest queued snapshot per DOM/IMM client.
- OMS: maximum 2,000 orders, 50 reports per order.
- Event-bus latest publications: one pending value per event type.

## Repeatable Procedure

1. Build production assets with `npm run build`.
2. Run `npm run perf:soak -- --hours=1`.
3. Compare startup, panel-cycle, DOM Pro-cycle, and final samples in `docs/performance/*.jsonl`.
4. Check heap trend after garbage-collection troughs, not individual peaks.
5. Require flat WebSocket, worker, listener, interval, observer, and Pixi object counts after equivalent UI state returns.
6. Inspect a DevTools heap snapshot if retained counts grow after the UI returns to the same state.

Detached DOM node counts and browser GPU allocations require DevTools/Chrome tracing and are not available from standard production JavaScript. The harness records the observable proxies and does not mislabel them as heap snapshots.
