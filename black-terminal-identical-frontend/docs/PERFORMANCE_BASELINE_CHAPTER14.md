# Chapter XIV Performance Baseline

Date: 2026-07-13  
Source revision: `12848ab`  
Runtime: Windows 10 Home, Intel i7-7700K 4.20 GHz, 15.9 GB RAM, Brave 150.1.92.139, Node 22.18.0.

## Measurement Boundary

The pre-change runtime had no authoritative p50/p95/p99, resource ownership, worker queue, or execution-span telemetry. Exact historical browser values for scenarios A-J therefore cannot be reconstructed honestly. The minimal telemetry required to measure those values was the first Chapter XIV change. This report preserves the source and bundle baseline taken before behavioral changes and labels missing runtime values as unavailable rather than inventing them.

## Pre-Change Static Baseline

| Metric | Value |
| --- | ---: |
| Source files | 165 |
| Source lines | 40,634 |
| `requestAnimationFrame` sites | 6 |
| `setInterval` sites | 26 |
| `setTimeout` sites | 15 |
| listener add/remove sites | 20 / 20 |
| WebSocket constructor sites | 16 |
| Worker constructor sites | 1 |
| ResizeObserver references | 2 |
| performance publishers | 10 |
| built asset bytes | 3,262,394 |
| main JavaScript chunk | 1,117,601 bytes |
| DOM Pro+ chunk | 115,203 bytes |

The pre-change production build passed. Static counts identify audit surface, not active runtime resources.

## Scenario Matrix

| Scenario | Pre-change evidence | Chapter XIV measurement path |
| --- | --- | --- |
| A Idle chart | Runtime percentiles unavailable | Admin HUD and soak sampler |
| B Indicators | Runtime percentiles unavailable | chart surface metrics |
| C Chart + Positions + Bybit | No unified account timing | account snapshot and stream freshness metrics |
| D Compact DOM | No bounded-resource counters | resource tracker and DOM feed metrics |
| E DOM Pro+ / IMM | Render time only, no queue truth | DOM worker queue, aggregation and render spans |
| F IMM + ticket | No execution span chain | OMS/EMS/risk/venue spans |
| G Panel switching | No repeatable harness | automated safe panel cycles |
| H Heatmap replay | No stale-task metric | versioned worker results and queue depth |
| I Symbol/timeframe switching | No cancellation evidence | generation guards and bounded caches |
| J One-hour session | Not previously run | `npm run perf:soak -- --hours=1` |

## Initial Bottlenecks

- DOM aggregation ran synchronously in the browser view path.
- High-frequency event-bus publications could drive broad subscribers at ingestion cadence.
- Market and account collections lacked consistent cross-domain retention rules.
- Connection heartbeat and polling work could overlap.
- Account snapshots could be requested independently by multiple consumers.
- Worker clients did not consistently discard obsolete results or bound queued work.
- Pixi pan and wheel paths could issue multiple synchronous redraws per browser frame.
- Production chart history could silently fall back to simulated candles.
- The existing HUD had no ownership counts, execution spans, capture sessions, or percentile truth.

This baseline is the honest starting record. Runtime comparisons begin after telemetry installation.
