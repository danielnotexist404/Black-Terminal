# Phase III Chapter XIV - Performance Stability

Status: Implemented and one-hour cockpit soak validated.

## Runtime Architecture

```text
Venue ingestion
  -> bounded market cache / DOM feed
  -> latest-value event cadence
  -> DOM aggregation worker (one active + newest queued)
  -> generation-checked render snapshot
  -> React/Pixi visual cadence

Unified Ticket
  -> OMS span
  -> EMS risk span
  -> Router/venue span
  -> normalized report
  -> immediate account snapshot invalidation
```

`blackCorePerformanceMonitor` is the single telemetry authority. `blackCoreResourceTracker` owns runtime resource counts. `blackCoreWorkloadScheduler` defines priorities 0-5: critical execution, normal execution, account state, interaction, visual analytics, and historical/background work. Priorities 0-1 execute immediately; lower-priority tasks use a bounded six-millisecond frame budget and visual tasks may coalesce.

## Implemented Hardening

- Admin-only performance HUD with capture, snapshot, session export, marks and reset.
- Browser, chart, DOM Pro+, React, worker, stream, account, OMS, EMS, risk, venue and route timing metrics.
- Long-task observation, p50/p95/p99 frames, heap growth, DOM count, event rate and resource ownership.
- Latest-value event-bus cadence while direct market subscribers retain raw feed accuracy.
- DOM and IMM worker offload with bounded queues, versioning, stale rejection and idle shutdown.
- Pixi wheel/pan rAF coalescing, hidden-tab ticker suspension and deterministic observer/listener/GPU cleanup.
- Central account snapshot request deduplication and short-lived cache.
- Bounded market, DOM history, OMS order and execution-report collections.
- Main-chart orderbook heatmap retention capped at 360 snapshots and 240 levels per side; long-range depth remains in IMM.
- WebSocket intentional-close semantics, heartbeat/stale state and exponential jittered reconnect.
- Server route stage timing and parallel independent account reads without weakening fail-closed checks.
- Explicit simulation isolation: production no longer silently substitutes fake chart candles.

## Cadence And Degradation

- Raw venue ingestion remains adapter controlled.
- Broad orderbook events publish newest state at 50 ms; trades at 100 ms.
- DOM feed visual notifications are capped at 20 Hz.
- DOM Pro+ mode FPS remains user/mode controlled; obsolete worker frames are dropped.
- Hidden chart rendering stops; hidden DOM visual notifications pause while core data stays current.
- Performance status is `stable`, `watch`, or `degraded`; recent severe long tasks and sustained heap/frame pressure trigger degradation.
- Execution, cancel, close, reduce-only, protection, reports and reconciliation are never queued behind visual analytics.

## Resource Ownership

The resource tracker records timers, rAF loops, listeners, observers, workers, WebSockets, Supabase subscriptions, Pixi objects and queue depths by owner. Every newly hardened resource has an idempotent release. Existing server-owned Bybit and depth workers remain supervised processes and are not browser resources.

## Commands

```bash
npm run perf:baseline
npm run test:performance
npm run perf:soak -- --hours=1
npm run perf:soak -- --hours=4
npm run perf:soak -- --hours=8
npm run perf:soak -- --hours=12
```

The soak harness launches a local production preview, uses a local-only performance identity, exercises safe chart/panel/DOM interactions, samples metrics, and never invokes order submission.

## Known Limits

- The chart still uses predominantly immediate-mode full-scene redraws. Camera events are coalesced, but full dirty-layer rendering and batched candle geometry remain future profiling-led work.
- DOM snapshots are bounded but still structured-cloned; transferable typed-array heatmap matrices are not yet implemented.
- DOM Pro+ mount can produce a startup long task on this reference machine.
- Browser JavaScript cannot authoritatively report detached DOM nodes or driver-level GPU memory.
- Vercel serverless functions provide route spans but cannot host persistent private streams.
- No 4h, 8h, or 12h stability claim is made until those runs actually pass.

## Validation Result

The final one-hour production-preview soak passed all harness checks across 120 samples. Heap growth was 56.0 MB, observed heap stayed below 118 MB, DOM growth was 40 nodes, p95-of-p95 was 76.3 ms, and WebSocket, worker, listener, timer, observer, Pixi container and Graphics counts remained flat. See `PERFORMANCE_RESULTS_CHAPTER14.md` and the timestamped report under `docs/performance/`.

No Supabase schema change is required for Chapter XIV.
