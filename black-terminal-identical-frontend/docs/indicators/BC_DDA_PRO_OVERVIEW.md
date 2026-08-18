# BC-RDA overview

Stable indicator ID: `black-core-dda-pro`. UI state key: `ddaProOscillator`. Name: **BC-RDA — Risk Distribution Analysis**. It is a standalone oscillator and compact risk dashboard; it never emits an execution command.

Two visibly distinct engines are retained:

- **BC-RDA — Original Compatibility / Pine Compatibility** preserves the supplied EdgeTools Pine formulas and assumptions for audit comparison.
- **BC-RDA — Institutional / Black Core Native** uses causal raw drawdown, positive depth distributions, drawdown episodes, tail metrics, transparent risk scoring, confidence, and crypto-aware annualization.

The browser runs a deterministic TypeScript mirror in a dedicated worker. The authoritative readable reference lives in `python/black_core_indicators/dda_pro`. Equity sources are capability-gated and are not shown until a canonical equity series exists; price is never silently substituted for a requested equity source.

## Canonical directional signals

BC-RDA direction markers and alerts share one calculation output. `DDA_DRAWDOWN_DEEPENED` produces a blood-red short signal at the episode trough; `DDA_DRAWDOWN_RECOVERED` produces a silver-white long signal at the recovered point. Stable signal IDs use the event timestamp, so rerenders and unchanged snapshots cannot refire the same configured alert.

The renderer consumes this signal collection directly. It no longer creates an unconditional white dot at the latest sample. Developing-preview mode may expose a genuine current signal immediately, while confirmed-bars mode remains closed-bar only. Historical replay continues to suppress external alert dispatch.
