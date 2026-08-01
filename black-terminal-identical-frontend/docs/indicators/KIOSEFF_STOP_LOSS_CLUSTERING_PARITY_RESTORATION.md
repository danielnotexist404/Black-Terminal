# Stop Loss Clustering Parity Restoration

## Status

The active implementation is **Pine Compatibility / parity pending**. It must not be described as
TradingView-identical until approved golden snapshots pass. Black Core Enhanced Mode exists as a
named, rejected engine mode and remains disabled.

## Restored contracts

- A clean worker rebuild consumes one immutable, complete chronological history revision.
- Warmup states are explicitly marked `PARITY STATE NOT FINAL · PREVIEW ONLY`.
- The debug surface exposes venue, symbol, market, chart/LTF, bar progress, LTF completeness,
  settings/data/cluster hashes, last closed candle and the invariant that viewport affects
  calculation: `NO`.
- VAE lower display percentiles preserve signed values. Magnitudes are used only at Pine stages that
  call `math.abs` or aggregate absolute higher-map volume.
- Lower and higher historical time spans use Pine-equivalent backward overlap searches.
- Active cluster rendering uses continuous color and alpha interpolation; weak dark clusters are
  retained.
- The active text pool supports Pine's 496-object capacity and signed compact volume labels.
- The price camera supports candles-only, active-cluster, visible-geometry and manual policies. The
  compatibility default includes nearby visible cluster geometry without feeding camera state into
  calculation.
- Inputs, Style and Visibility are separate settings groups and all values participate in the
  settings hash.

## Reported BTCUSDT 4H case

The supplied Black Terminal capture was still rebuilding 500 of 5,000 bars, so it is not a valid
golden result. The prior 65.8–66.1K versus TradingView 67–69K displacement can be influenced by the
incomplete historical start and frozen lower-grid initialization. Static audit also found signed
threshold, higher-bin slicing, historical-duration and renderer omissions. Those defects are now
covered by structural tests, but their contribution to each historical price band cannot be assigned
honestly until the exact 5,000-bar Bybit dataset and TradingView outputs are captured.

## Calculation findings

- The Pine kernel already used Wilder/RMA ATR seeding and explicit nearest-rank percentile helpers;
  the restored tests keep those semantics exact rather than introducing a Python approximation.
- Lower mode freezes its grid width once, at the first defined chart ATR SMA, then initializes around
  that bar's open and only extends/prunes the ordered grid. Camera changes do not rebuild it.
- The production Bybit 5K data path previously failed before the worker because a 299,991-timestamp
  spread exceeded the JavaScript call stack. Bounded aggregation fixed that operational defect and
  the readiness state now exposes incomplete history rather than silently presenting it as final.
- This restoration found calculation-level divergence in signed lower percentiles/top-five state and
  higher-bin slicing, plus historical lifecycle and renderer omissions. The exact contribution of
  each defect to the reported 67–69K, 60.6K, and 57.6K bands remains unassigned pending the golden
  dataset.

## Verification results

- `npm run test:kioseff`: pass, including data, kernel, canonical, engine, edge, worker, parity,
  rendering, browser/Tauri, and operational suites.
- `npm run build`: pass, including TypeScript, security contracts, production bundle, and secret
  audit.
- Browser/Tauri normalized fixture hash: `dfc85165e89b88ba`.
- Current local benchmark: higher 5,000 bars in 93.687 ms; higher 20,000 bars in 378.689 ms; lower
  5,000 bars in 113.247 ms. These are local structural timings, not TradingView parity evidence.
- Golden matrix: five required rows present, all `pending-reference`.
- Screenshot comparison/difference overlay: not run because the numerical reference gate is absent.

## Required completion report

| Area | Finding / result |
|---|---|
| Root causes found | Lower ranking incorrectly used absolute values; lower historical records were zero-width; higher display slicing included the wrong terminal key and omitted empty bins; higher buy cells were artificially negated; hot eligibility was not limited to five line pairs; gradients were reduced to fixed states; historical lines became filled boxes; labels stopped at 120; candle-only auto-scale hid valid geometry; incomplete warmup could look final. |
| Signed percentile | Before: lower p95/top-five used magnitude. After: lower uses signed Pine values, including Pine's zero-seeded top-five behavior; higher uses absolute bin aggregates only where Pine does. The deterministic fixture proves p95 `5` signed versus `100` by magnitude for `[-100,-50,1,2,3,4,5]`. |
| ATR and grid | No replacement formula was introduced. Wilder/RMA ATR and Pine SMA primitives remain under kernel tests. Lower grid width freezes at the first defined chart ATR-SMA proxy and is not recalculated by camera changes. TradingView numeric confirmation is still pending. |
| Lower-timeframe coverage | The 5K stack-overflow defect was fixed by bounded aggregation. Production rejects missing, duplicate, out-of-order, conflicting, cross-source, or incomplete coverage and exposes counts/hashes. Golden rows still need the exact TradingView comparison dataset. |
| Historical lifecycle | Lower and higher backward-overlap searches now produce duration-preserving historical line geometry; the universal equal start/end defect is covered by an engine test. |
| Capacity | Active label pool raised from 120 to Pine's 496. Calculation state remains separately bounded by Pine-equivalent model limits. |
| Gradient | Active VAE cells preserve continuous normalized RGB/alpha interpolation from background through weak/strong intensity. Lower historical lines use Pine's 50% midpoint color. |
| Labels | Active VAE labels are setting-gated, signed, compact-formatted, price-anchored, right-aligned, pooled, and available through the full 496 slots. Pixel certification is pending. |
| Settings/menu | All 18 retained Pine inputs are mapped and tested. Inputs, Style, and Visibility are separate; ticks through months and the price-domain policy are persisted and hashed. |
| Viewport independence | Five camera-domain variations leave the canonical cluster hash unchanged. Worker effects do not depend on visible bar indices. |
| Price scale | Projection can include active or time-intersecting historical geometry without passing viewport state into the worker. Manual and candles-only policies remain available. |
| Golden fixtures | Five machine-readable rows exist under `tests/golden/kioseff/`; 0/5 are approved and all are `pending-reference`. |
| Screenshot comparison | Not eligible until numerical golden parity passes; no difference overlay or pixel-pass claim exists. |
| Performance | Current local results: higher 5K 93.687 ms, higher 20K 378.689 ms, lower 5K 113.247 ms. |
| Remaining mismatches | TradingView feed/current-bar export, exact 4H band attribution, synchronized visual geometry/font/color validation, and Absorbtion qCurve/x-ray pixel validation. |
| Compatibility approval | **Not approved; parity pending.** |
| Enhanced Mode | **Disabled and fail-closed.** |
| Scope | OMS, EMS, broker routing, Black Cloud, copy trading, Portfolio Manager, Obsidian, HDLX, IMM, DOM wall detection, and unrelated indicators were not modified. |

## Acceptance gate

Compatibility approval requires all of the following at the same terminal timestamp:

1. Bybit BTCUSDT perpetual chart bars and ordered 1m bars with zero missing, duplicate or out-of-order
   intervals.
2. Matching 1H and 4H settings hashes and complete 5,000/5,000 state.
3. Numeric equality for active/violated boundaries, signed volumes, strength, normalized gradient,
   label and duration.
4. Stable cluster hash through camera changes and rebuild/stream replay.
5. Synchronized TradingView, Black Terminal and difference-overlay screenshots.

Until then the diagnostics and engine version continue to say `parity-pending`.
