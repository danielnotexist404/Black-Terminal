# Phase III Chapter IX - Black Core Performance And Long-Session Stability

Status: instrumentation foundation implemented; 12-hour certification still pending.

## Objective

Chapter IX begins the performance engineering discipline for Black Terminal. The goal is consistency over long sessions: the chart, DOM Pro+, market streams, positions, portfolio views, and connectivity surfaces should not progressively degrade simply because the terminal remains open all day.

This chapter does not claim the platform is fully optimized yet. It adds the measurement layer required before deeper Pixi, worker, and DOM optimizations are made.

## Implemented

- Expanded `src/performance/performanceMonitor.ts` into a Black Core runtime monitor.
- Added live measurement for:
  - FPS
  - average frame time
  - p99 frame time
  - worst frame
  - dropped-frame count
  - long-task count
  - longest long task
  - JS heap usage where Chromium exposes it
  - DOM node count
  - latest throttled performance metrics
  - Black Core event-bus listener and publish counts
- Added event-bus diagnostics in `src/core/events/eventBus.ts`.
- Added hidden Performance HUD:
  - Toggle: `Ctrl+Shift+P`
  - File: `src/performance/PerformanceHud.tsx`
  - Snapshot copy for manual baseline records.
- Connected telemetry from:
  - Pixi chart ticker
  - DOM Pro+ render loop
  - DOM Pro feed listener lifecycle
- Throttled metric publishing so telemetry does not create a high-frequency event storm.
- Added DOM feed cleanup guards so stopped feed entries ignore late async REST fallback completions.
- Added benchmark commands:
  - `npm run perf:baseline`
  - `npm run perf:stress`
- Added baseline output:
  - `docs/performance/latest-baseline.md`
  - `docs/performance/latest-baseline.json`

## Baseline

The first Chapter IX baseline is stored under `docs/performance/` and should be regenerated after each performance optimization pass.

Baseline command:

```bash
npm run perf:baseline
```

Current baseline tracks source footprint, timer/listener/WebSocket/Worker counts, and production bundle footprint after `npm run build`.

Runtime browser baselines are captured through the Performance HUD. Use `Copy Snapshot` at the beginning and end of a live session.

## Long-Session Stress Harness

The stress harness writes JSONL samples while polling a running deployment:

```bash
PERF_STRESS_URL=http://127.0.0.1:4173 npm run perf:stress
```

Optional settings:

```bash
PERF_STRESS_MINUTES=720
PERF_STRESS_INTERVAL_MS=60000
```

It records response latency, Node harness memory, and `/api/imm/status` health when available.

## Architecture Rule

Performance telemetry must remain lower frequency than market data. High-frequency samples stay in memory; only throttled metrics publish to Black Core events.

Future optimizations must start with a baseline snapshot, then record an after snapshot in this folder.

## Remaining

- Run an actual 12-hour browser session with chart + DOM Pro+ + positions + portfolio.
- Add browser automation for long-session UI telemetry when a supported browser test dependency is approved.
- Move additional IMM analytics to workers:
  - live aggregation
  - wall detection
  - CVD smoothing
  - depth curve generation
- Audit Pixi draw calls and GPU resource counts with renderer-level diagnostics.
- Add object pools for recurring chart labels, heatmap nodes, and DOM Pro row primitives.
- Add React render profiling for panel switches and large state updates.
- Add WebSocket queue/backpressure counters per exchange adapter.
