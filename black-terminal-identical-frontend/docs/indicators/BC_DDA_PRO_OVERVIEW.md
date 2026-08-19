# BC-RDA overview

Stable indicator ID: `black-core-dda-pro`. UI state key: `ddaProOscillator`. Name: **BC-RDA — Risk Distribution Analysis**. It is a standalone oscillator and compact risk dashboard; it never emits an execution command.

Two visibly distinct engines are retained:

- **BC-RDA — Original Compatibility / Pine Compatibility** preserves the supplied EdgeTools Pine formulas and assumptions for audit comparison.
- **BC-RDA — Institutional / Black Core Native** uses causal raw drawdown, positive depth distributions, drawdown episodes, tail metrics, transparent risk scoring, confidence, and crypto-aware annualization.

The browser runs a deterministic TypeScript mirror in a dedicated worker. The authoritative readable reference lives in `python/black_core_indicators/dda_pro`. Equity sources are capability-gated and are not shown until a canonical equity series exists; price is never silently substituted for a requested equity source.

## Canonical directional signals

BC-RDA direction markers and alerts share one calculation output. `RAW` preserves the original episode sequence: `DDA_DRAWDOWN_DEEPENED` produces a silver-white long signal at the episode trough and `DDA_DRAWDOWN_RECOVERED` produces a blood-red short signal at recovery. Optional BALANCED, INSTITUTIONAL and CUSTOM modes arbitrate prefix-stable causal candidates through native distribution coherence, centroid migration, expansion, tail asymmetry, transition entropy, persistence and episode reset logic. See [BC_RDA_SIGNAL_INTELLIGENCE.md](./BC_RDA_SIGNAL_INTELLIGENCE.md).

The renderer and alerts consume the same selected immutable stream and use fixed BC-RDA signal colors so a theme cannot invert their meaning. Provisional or suppressed events cannot enter confirmed alerts. Configured signal alerts arm at the latest confirmed candle and fire only for a newly confirmed signal on the newest calculated bar; historical and developing-bar signals are never replayed as fresh alerts. Historical replay continues to suppress external alert dispatch.
