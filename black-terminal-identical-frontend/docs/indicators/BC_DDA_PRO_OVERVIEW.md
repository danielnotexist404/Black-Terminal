# BC-RDA overview

Stable indicator ID: `black-core-dda-pro`. UI state key: `ddaProOscillator`. Name: **BC-RDA — Risk Distribution Analysis**. It is a standalone oscillator and compact risk dashboard; it never emits an execution command.

Two visibly distinct engines are retained:

- **BC-RDA — Original Compatibility / Pine Compatibility** preserves the supplied EdgeTools Pine formulas and assumptions for audit comparison.
- **BC-RDA — Institutional / Black Core Native** uses causal raw drawdown, positive depth distributions, drawdown episodes, tail metrics, transparent risk scoring, confidence, and crypto-aware annualization.

The browser runs a deterministic TypeScript mirror in a dedicated worker. The authoritative readable reference lives in `python/black_core_indicators/dda_pro`. Equity sources are capability-gated and are not shown until a canonical equity series exists; price is never silently substituted for a requested equity source.

## Canonical directional signals

BC-RDA direction markers and alerts share one calculation output. The protected downside pathway is unchanged: `DDA_DRAWDOWN_DEEPENED` produces the same silver-white long signal at the episode trough. `DDA_DRAWDOWN_RECOVERED` remains available as a neutral risk/episode lifecycle event and can no longer create a short, dot, strategy signal, or signal episode.

Blood-red shorts now come only from the independent mirrored causal top engine. It freezes a causal episode trough after a volatility-adaptive advance, measures its own drawup distribution, enters a non-alerting upper-tail watch, and confirms only after maturity, exhaustion, adaptive reversal, bearish change-point, and configured price-structure/flow gates. Its provisional hollow extremity may advance with a new high; the solid confirmed marker is permanently attached to the later causal confirmation candle. Optional BALANCED, INSTITUTIONAL and CUSTOM modes continue to arbitrate the protected downside candidates. See [BC_RDA_SIGNAL_INTELLIGENCE.md](./BC_RDA_SIGNAL_INTELLIGENCE.md).

The renderer and alerts consume the same selected immutable stream and use fixed BC-RDA signal colors so a theme cannot invert their meaning. Provisional or suppressed events cannot enter confirmed alerts. Configured signal alerts arm at the latest confirmed candle and fire only for a newly confirmed signal on the newest calculated bar; historical and developing-bar signals are never replayed as fresh alerts. Historical replay continues to suppress external alert dispatch.

The crimson dynamic top barrier is a projected upside-distribution threshold, not the optional worsening-drawdown-velocity trace. Touching it creates at most a provisional candidate and never directly confirms a short.
