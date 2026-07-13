# React Render Audit

Date: 2026-07-13

React Profiler instrumentation now records commit duration as `react.commit_ms`. High-frequency orderbook, trade, chart camera, DOM aggregation, and Pixi hover state remain outside broad React application state.

| Surface | Previous behavior / cause | Change | Current behavior | Remaining limit |
| --- | --- | --- | --- | --- |
| `App` | Broad state owner; runtime commit timing absent | Root Profiler added; live market ticks remain in engines/stores | Commits are measured without publishing every tick to React | App is still large and should be split by future module boundaries |
| Pixi chart | Pointer and wheel events could draw synchronously per event | visual updates coalesced with one rAF | camera input renders at most once per browser frame | chart draw is still mostly full-scene immediate mode |
| DOM Pro+ | aggregation work executed in the view process and each feed notification could render | aggregation moved to worker; feed notifications capped at 20 Hz; stale generations rejected | React consumes bounded render snapshots | DOM cockpit mount has a measurable startup long task |
| Trade tape / DOM | raw data could notify consumers at raw cadence | direct feed retains accuracy; broad event bus uses latest-value cadence | UI frequency is independent from raw ingestion | row virtualization remains useful for larger configured buffers |
| Portfolio / Positions / Ticket | independent snapshot calls could overlap | one in-flight, two-second account snapshot cache with execution invalidation | all consumers converge on the portfolio store snapshot | private stream should become the primary freshness source in persistent deployments |
| Connection state | heartbeats could overlap and allocate additional promises | one heartbeat in flight per connection and tracked interval ownership | bounded updates and deterministic stop | adapter-specific private workers remain server-owned |
| Performance HUD | could expose diagnostics regardless of role | component mounts only for Admin and is disabled until shortcut use | no ordinary-user render cost | capture is browser-local only |

## Provider Findings

- Black Core services register once; conflicting duplicate registrations now throw.
- High-frequency market state is not copied into a new React context.
- DOM worker output uses latest-wins backpressure instead of accumulating React updates.
- `performance.metric` is throttled and the HUD samples at a controlled interval.
- React Profiler measures commits; it does not retain component props or account data.

## Verification

Use Admin `Ctrl+Shift+P`, start a capture, exercise the desired scenario, stop capture, and export the session report. The report contains aggregate timings and resource counts, never credentials.
