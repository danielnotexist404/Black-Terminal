# BC-RDA Advanced Distributional Regime Intelligence

## Scope and authority

BC-RDA remains a read-only indicator. The stable indicator ID is `black-core-dda-pro`; no execution, broker, account, RADAP, HDLX, Market Maker Heatmap, or database authority is introduced by this layer.

`RAW` is the compatibility boundary. It returns the pre-chapter `deriveDDAProSignals(events)` sequence and IDs unchanged. The legacy final-trough marker can follow its pre-existing open-episode semantics. Filtered modes do not confirm from that moving final-trough projection: they consume a separate prefix-stable closed-bar candidate stream so a confirmed event cannot move when later candles arrive.

## Causal feature definitions

For bar `t`, let `B(t)` be the finite values of BC-RDA bands `p05,p10,p25,p50,p75,p90,p95,p99`.

- Distribution centroid: `C(t) = mean(B(t))`.
- Distribution width: `W(t) = max(B(t)) - min(B(t))`.
- Width baseline: causal EMA `WB(t) = 0.92*WB(t-1) + 0.08*W(t)`.
- Normalized centroid velocity: `V(t) = (C(t)-C(t-1)) / max(W(t),WB(t),1e-6)`. Its unit is distribution widths per closed bar.
- Normalized centroid acceleration: `A(t) = V(t)-V(t-1)`.
- Coherence: for non-trivial band slopes, `100 * abs(sum(sign(delta band))) / slopeCount`. Zero slopes do not manufacture agreement.
- Expansion: `clamp100(50 + 55*(W/WB-1) + 95*(W-Wprev)/normalizationWidth)`.
- Signed tail asymmetry: `clamp[-100,100]((smoothedDrawdown-C)/(W/2)*50)`. Negative is lower-tail dominance; positive is upper-tail dominance.
- Transition entropy: over the last 12 closed bars, `72*directionSwitchRate + 28*min(1,causalRawCandidateCount/4)`.
- Chop probability: `0.55*entropy + 0.30*(100-coherence) + 0.15*(100-expansion)`.
- Directional centroid movement combines normalized velocity (35 points) and same-direction acceleration (10 points), then clamps to 0–100. Directional confidence is `0.22*coherence + 0.20*directionalCentroidMovement + 0.17*expansion + 0.20*directionalTail + 0.21*(100-chop)`.

Every score is clamped to 0–100. The formulas consume the current and preceding closed-bar prefix only; they do not use centered windows or the viewport.

## Regime classification

Classification is deterministic and evaluated in this order:

1. fewer than four finite bands → `UNCLASSIFIED`;
2. chop above its configured maximum → `CHOP`;
3. expansion below 35 → `COMPRESSION`;
4. extreme tail with decelerating expansion → `EXHAUSTION`;
5. coherent material centroid movement with sufficient expansion → `DIRECTIONAL_EXPANSION`;
6. a causal raw candidate on the bar → `REDISTRIBUTION`;
7. otherwise → `TRANSITION`.

Regime confidence uses the corresponding causal chop, compression, coherence/expansion/velocity, tail/deceleration, or directional-confidence components. It is descriptive, not “AI confidence.”

## Causal candidates and episodes

The filtered candidate stream emits:

- a silver/white long candidate whenever a closed bar establishes a strictly deeper maximum within an active drawdown episode;
- a blood-red short candidate when that episode reaches the existing recovery boundary.

This candidate history is prefix-stable. One direction cannot mutate the other direction's state. Episodes are keyed by exchange, symbol, timeframe, episode-start bar close, direction, intelligence mode, and engine version. At most 512 episode records and 2,048 provisional records are retained; the worker retains at most 20,000 bars.

## State machine

| From | Condition | To |
|---|---|---|
| `NEUTRAL` | directional confidence begins building | `WATCHING` |
| `WATCHING` | confirmation score, migration and organized-regime thresholds are met | `ARMED` |
| `ARMED` | a causal raw candidate passes every enabled gate on a closed bar | `CONFIRMED` |
| `CONFIRMED` | immutable event is published | `COOLDOWN` |
| `COOLDOWN` | safety floor elapsed and the tail/centroid genuinely neutralizes, or a materially separated reversal/reset regime forms | `RESET` |
| `RESET` | new episode state is cleared | `NEUTRAL` |

The safety floor is not the primary re-arm mechanism. Neutralization requires tail magnitude at or below half the reset-sensitivity score plus a quiet/reversed centroid; material separation also requires a reversal or `COMPRESSION`, `CHOP`, or `EXHAUSTION` reset regime. A rejected same-episode recross cannot overwrite `COOLDOWN`.

For `BALANCED` and `INSTITUTIONAL`, centroid migration and tail asymmetry are alternative native directional confirmations; one must pass. In `CUSTOM`, enabled checkboxes are independent gates, so enabling both requires both.

## Presets

| Parameter | RAW | BALANCED | INSTITUTIONAL |
|---|---:|---:|---:|
| Coherence minimum | not applied | 54 | 68 |
| Centroid displacement (widths/bar) | not applied | 0.075 | 0.11 |
| Centroid persistence (bars) | not applied | 2 | 3 |
| Expansion minimum | not applied | 44 | 57 |
| Tail asymmetry minimum | not applied | 28 | 42 |
| Maximum chop | not applied | 62 | 45 |
| Maximum entropy | not applied | 68 | 50 |
| Excursion persistence (bars) | not applied | 2 | 3 |
| Confirmation minimum | not applied | 58 | 70 |
| Reset tail score | not applied | 38 | 28 |
| Episode separation (widths) | not applied | 0.65 | 0.90 |
| Safety floor (bars) | not applied | 3 | 5 |

Both filtered presets enable native coherence, centroid/tail, expansion, entropy, persistence, clustering and reset logic. Orthogonal price structure, volume, CVD and higher-timeframe confirmation remain off unless explicitly selected. `CUSTOM` exposes every gate and bounded threshold. Reset restores deterministic mode defaults.

## Orthogonal confirmation

- Price structure compares only the current closed candle with a bounded prior range and accepts directional range displacement or directional candle-body efficiency.
- Volume compares current volume with a causal 20-bar history.
- CVD fails closed if a genuine causal CVD series is not supplied. BC-RDA never manufactures synthetic CVD.
- Higher-timeframe confirmation uses only buckets whose end time is at or before the current base-bar close. The menu exposes 4x, 12x and 24x base-timeframe aggregation.

## Display and alerts

- RAW dots: legacy size and sequence when `Show Raw Signals` is enabled.
- Filtered raw candidates: small/faded diagnostics only.
- Provisional: small/faded and never alertable.
- Confirmed long: silver/white. Confirmed short: blood red. Confidence at or above 82 receives a subtle halo.

The renderer and alert effect consume the same immutable snapshot event. `Confirmed Alerts Only` selects `snapshot.signals`; disabling it selects the visible causal raw-candidate stream and explicitly labels the alert `RAW`. A hidden stream is not alertable. Canonical confirmed identity is:

`bc-rda-intel-v1:exchange:symbol:timeframe:barClose:direction:mode`

Configured alert IDs are combined with that identity for local idempotency. Alerts arm after the latest confirmed candle, so history, reconnects, rerenders and repeated mounts cannot replay old signals. Developing/provisional signals never enter the confirmed stream.

## Validation and limitations

Run:

- `npm run test:dda-pro-all`
- `npm run validate:dda-pro-signal-intelligence`
- `npm run benchmark:dda-pro`

The validation suite uses 12 deterministic regimes, three price scales, 5m through 1D timeframes, sparse timestamps, prefix replay, causal forward horizons, and fixed development/validation/holdout partitions. It measures selectivity and semantics; it is not a profitability backtest and is not used to claim predictive certainty.

Known limitations:

- Production still performs deterministic bounded full-prefix worker calculation for a changed candle history; the stateful worker protocol supports bounded append/rebuild, but the chart does not yet use an incremental feature accumulator.
- CVD confirmation remains unavailable until genuine CVD values are passed into BC-RDA.
- Higher-timeframe confirmation is a causal close-direction check, not a separate full BC-RDA higher-timeframe model.
- Thresholds are explicit engineering defaults, not instrument-optimized parameters.
- Visual acceptance still depends on representative authenticated market data and device/browser inspection.
