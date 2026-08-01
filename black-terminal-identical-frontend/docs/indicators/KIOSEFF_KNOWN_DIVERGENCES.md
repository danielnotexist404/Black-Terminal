# Kioseff Known Divergences

## Open certification blockers

1. No machine-readable TradingView active/historical cluster snapshots have been supplied.
2. The reported BTCUSDT 4H Black Terminal image was captured at 500/5,000 bars, not `READY`.
3. Exact TradingView feed revisions, lower-timeframe candles and terminal timestamp for that image are
   not available as a canonical dataset.
4. Pixel-level mobile font/label metrics and the live TradingView chart background have not been
   certified.
5. Absorbtion qCurve and multi-strip gradient visuals have structural coverage but no synchronized
   screenshot golden.

## Corrected implementation divergences

- Absolute lower percentile in place of signed percentile.
- Missing empty higher display bins and inclusive rather than Pine end-exclusive key slicing.
- Higher buy display values assigned an artificial negative sign.
- Unlimited/tied hot rendering rather than five Pine line pairs.
- Lower historical start and end set to the same timestamp.
- Fixed weak/strong opacity rather than continuous Pine gradients.
- Historical VAE ranges rendered as filled boxes rather than Pine line geometry.
- Active text silently capped at 120 rather than 496.
- Visible-candle-only automatic price domain.
- Generic single settings surface rather than Inputs/Style/Visibility.
- No durable settings/data/cluster hash diagnostics.

## Deliberate non-divergences

Pine drawing objects are represented by batched Pixi geometry and pooled text rather than one GPU
object per Pine object. This is permitted only while numeric geometry, color, label and lifecycle
remain equivalent. Python is validation-only and is not a production fallback.

## Status language

Allowed: `Pine Compatibility`, `parity pending`, `structurally verified`, `golden reference absent`.
Forbidden until certification: `identical`, `parity complete`, `TradingView certified`, or any claim
that the 4H reported mismatch is resolved numerically.
