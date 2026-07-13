# Chapter XIV Performance Results

Date: 2026-07-13  
Reference system: Windows 10 Home, Intel i7-7700K 4.20 GHz, 15.9 GB RAM, Brave 150.1.92.139.

## Before And After

| Area | Before | After |
| --- | --- | --- |
| Runtime truth | average frame/heap fragments only | authoritative percentile, long-task, memory, resource, queue, stream and execution snapshots |
| DOM aggregation | synchronous view-path aggregation | dedicated worker, one active plus newest queued task |
| IMM worker | unversioned task flow | request/version protocol, bounded queue and stale rejection |
| Event fan-out | broad events at ingestion cadence | latest-value coalescing at controlled cadence |
| Account reads | overlapping consumers possible | one in-flight request and two-second shared cache |
| Chart camera | repeated synchronous draws per pointer/wheel burst | one rAF-coalesced visual update |
| Hidden tab | chart/DOM visual work could continue | Pixi ticker and DOM visual notifications suspend |
| Buffers | inconsistent retention | explicit market/DOM/OMS/performance limits |
| Socket recovery | reconnect ownership incomplete | intentional close, one reconnect timer, jitter and stale state |
| Production fallback | simulated candles could appear silently | live-only failure status unless simulation is explicitly enabled |

## Profiling Findings During Soak

The first valid one-hour cockpit run failed with 216 MB heap growth. A second run failed with 441 MB growth. Resource ownership remained flat, which isolated retained data rather than duplicate workers or listeners. The causes were:

- DOM Pro+ cloned hundreds of full heatmap frames on every worker response.
- The main chart retained 1,800 full-depth orderbook snapshots, potentially millions of tuple objects.

DOM Pro+ now emits a compact 4 Hz local history tail with at most 180 frames and balanced visible cells. The main chart now retains 360 snapshots and at most 240 levels per side. Persistent long-range liquidity remains owned by IMM instead of browser-local visual memory.

## Final One-Hour Evidence

Run: 3,607.8 seconds, safe chart/panel and repeated DOM Pro+ open/close cycles, 120 samples. The cockpit-readiness assertion passed for every sample.

| Metric | Result |
| --- | ---: |
| p95 of sampled frame p95 | 76.3 ms |
| heap start / final | 10.7 / 66.7 MB |
| observed heap peak | 118.0 MB |
| DOM start / final | 580 / 620 |
| listener growth | 0 |
| interval growth | 0 |
| observer growth | 0 |
| WebSocket growth | 0 |
| worker growth | 0 |
| Pixi containers / Graphics growth | 0 / 0 |
| result | PASS |

Heap repeatedly returned to the 40-80 MB range after garbage collection and showed no monotonic growth. DOM Pro+ mount cycles remain the largest visual spikes, while ordinary chart samples generally measured 7-14 ms p95. Mount spikes are permitted visual degradation and do not block execution priority lanes.

## Build Footprint

The production main chunk grew from 1,117,601 to approximately 1,134,560 bytes because of telemetry and lifecycle code. DOM Pro+ grew from 115,203 to 118,681 bytes and gained a 13,510-byte aggregation worker. This is an accepted measured regression in network footprint for bounded long-session behavior; further route-level code splitting remains available.

## Stability Status

- Deterministic performance checks: PASS.
- TypeScript and production build: PASS.
- Venue execution regression suite: PASS.
- Bybit certification regression suite: PASS.
- Short cockpit smoke: PASS.
- One-hour cockpit soak: PASS (`docs/performance/soak-2026-07-13T16-30-22-133Z-summary.json`).
- Four/eight/twelve-hour soak: not run; no claim is made.

The system is materially more observable and bounded. It is not described as universally performance-complete: full chart dirty layers, geometry batching, transferable DOM matrices, private-stream production soak, and server-side long-session evidence remain valid future work.
