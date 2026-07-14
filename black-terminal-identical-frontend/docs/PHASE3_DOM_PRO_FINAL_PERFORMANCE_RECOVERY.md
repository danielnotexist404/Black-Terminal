# Phase III DOM Pro Final Performance Recovery

Status: implemented; final long-soak evidence recorded in the results document.

Release evidence passed both required durations: 30 minutes at 69.5 ms p95 and one hour at 69.4 ms p95, with bounded resources and no multi-second lock.

## Scope

This chapter recovers DOM Pro responsiveness without changing market truth, adding analytics, redesigning the cockpit, or creating an execution path. The existing shared feed, OMS, EMS, Risk, Position Manager, Connection Manager and venue adapters remain authoritative.

## Findings

The pre-change deterministic trace identified three primary bottlenecks:

1. Historical heatmap cells were individual React elements and grew continuously with retained frames.
2. Worker results repeatedly cloned source depth, trades and the complete historical heatmap.
3. One broad cockpit component revisited derived panel work and pointer tooltip scans during live updates.

Worker queue depth and socket ownership were already bounded, so they were not blamed for the freeze.

## Recovery

- Replaced per-cell heatmap DOM with a culled, LOD-aware canvas using reusable typed row buffers.
- Added one dirty-surface master visual scheduler with a 7 ms cooperative budget.
- Changed worker output to one heatmap delta column and restored shared source references on the main thread.
- Packed full depth into transferable typed arrays for worker input.
- Added latest-wins counters, stale rejection, queue peaks and transfer telemetry.
- Time-bucketed CVD incrementally and removed per-update trade sorting and series slicing.
- Preserved bounded wall, depth, flow, trade, metric and heatmap memory.
- Added interaction mode, RAF-coalesced camera work, deferred indexed tooltip lookup and A.I.F. yielding.
- Added safe panel cadence clamps, debounced/fail-soft settings persistence, actual offscreen suspension and hidden-tab suspension.
- Added Maximum Performance, Balanced and Maximum Detail visual modes plus adaptive quality recovery.
- Added a secret-free freeze watchdog and deterministic DOM/A.I.F. smoke and soak harness.

## Safety

The harness never submits orders. Analytics may coalesce or drop obsolete generations; execution, cancel, close, stop, account and audit work do not adapt downward. No Supabase schema or runtime secret is introduced.

## Commands

```bash
npm run perf:dom-pro-smoke
npm run perf:dom-pro-soak -- --minutes=30
npm run perf:dom-pro-soak -- --hours=1
npm run test:performance
npm run test:dom-pro-panels
npm run test:aif
npm run test:venue-execution
npm run test:bybit-certification
npm run build
```

## Known Limits

- The aggregation worker still reconstructs object levels after receiving transferable arrays because the established analytical engine consumes typed domain objects.
- React isolation is materially improved by removing thousands of heatmap nodes, but the cockpit remains one top-level component. Further panel extraction should be driven by traces rather than broad refactoring.
- Canvas historical LOD redraws the bounded visible surface when camera/domain or retained columns change. Worker transfer is incremental; future dirty-tile caching is only warranted if later traces show canvas draw cost becoming dominant.
