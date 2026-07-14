# DOM Pro Render Pipeline

## Ownership

```text
Venue adapter
  -> DomFeedStore (one book/trade source per venue, product and symbol)
  -> latest immutable feed snapshot
  -> DOM aggregation worker (latest-wins, one in flight)
  -> delta transport contract
  -> bounded main-thread heatmap ring
  -> panel cadence scheduler
  -> canvas master visual scheduler / bounded React panels
```

`DomFeedStore` is the only DOM Pro market subscription owner. Panels never open sockets, poll venues, or clone source books. Account and execution streams remain independently owned by Connection Manager and execution infrastructure because they have higher safety priority.

## Cadences

Raw data can arrive continuously. Feed publication is coalesced to at most 20 Hz. Aggregation follows the workspace FPS ceiling and rejects stale generations. The panel scheduler independently clamps calculation and render cadence: ladder and tape can remain responsive, while profile, walls, structural depth, CVD and metrics calculate at slower material cadences. Unsafe panel values are clamped by panel type.

Hidden tabs stop visual aggregation. An `IntersectionObserver` suspends offscreen panel calculation and rendering. Returning to visibility consumes the latest shared snapshot; obsolete visual history is not replayed.

## Heatmap

The worker owns bounded per-price liquidity memory and emits only its newest changed time column. It does not return the source book, trade list or previous heatmap matrix. The main thread restores source references from the submitted immutable snapshot and appends the changed column to a bounded ring.

`DomHeatmapCanvas` replaces per-cell React nodes. A single typed row workspace merges price rows and historical columns according to visual LOD, culls prices outside the camera, and draws one canvas surface. Macro bands, depth memory, structural ribbons and the live price line share that surface. No heatmap cell owns a React element, Pixi object, interval, or RAF.

The shared `DomVisualScheduler` owns transient animation frames. Dirty visible surfaces register work; clean and hidden surfaces do nothing. The frame budget is 7 ms and lower-priority work rolls to the next master frame.

## Interaction

Wheel, heatmap drag and CVD drag enter internal `INTERACTION_ACTIVE`. Camera mutations are coalesced through the master visual scheduler. During interaction the canvas reduces historical columns, labels and minor depth marks but preserves all source data. Tooltip lookup is deferred and scans only the selected time column with linear nearest-item indexes. A.I.F. background calculation yields briefly while DOM interaction is active.

## Quality

User-facing modes are Maximum Performance, Balanced and Maximum Detail. The adaptive controller can temporarily lower only canvas detail and cadence when work duration rises. It never changes source ingestion, OMS, EMS, risk, account reconciliation or execution correctness.

## Retention

| Structure | Browser limit | Long-term owner |
| --- | ---: | --- |
| Source trades | 200 DOM / 1,000 market cache | Venue/server history |
| Seen trade IDs | 3,000 | None |
| CVD buckets | 2,400 | IMM/research persistence |
| Heatmap frames | 180 maximum | IMM depth history |
| Heatmap price memory | 3,000 cells | IMM depth history |
| Flow buckets | 420 | IMM/research persistence |
| Depth history | 900 points per symbol | Supabase IMM |
| Performance trace | 600 samples per span | Test artifacts |
| Watchdog incidents | 20 per tab | Session diagnostic only |

## Diagnostics

Open the application with `?domPerfTrace=1`. `window.__DOM_PRO_PERFORMANCE__.snapshot()` reports feed, worker, panel, tooltip, React and canvas spans. `window.__DOM_PRO_INCIDENTS__()` returns bounded secret-free watchdog incidents. Production does not emit per-tick logs.
