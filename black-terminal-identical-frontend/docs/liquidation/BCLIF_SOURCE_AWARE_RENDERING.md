# BCLIF Source-Aware Rendering

BCLIF display authority derives from available evidence rather than exposure magnitude alone. The renderer classifies context as:

- OI only;
- OI + price positioning;
- OI + exact trades;
- OI + trades + confirmed liquidations;
- OI + trades + order book;
- full context, including funding/positioning support.

Historical context and live-calibrated context are separate channels. In browser fallback, pre-connection history cannot inherit exact trade, event, or order-book authority. It remains useful OI-derived context at the configured historical opacity. Live columns gain authority only from sources actually observed during the browser session. Persistent snapshots may carry exact source coverage across their verified ledger and therefore support a continuous live-calibrated channel.

The menu can display Historical Context, Live Calibrated, or Combined. The source-start marker is drawn at the first column with live support; the renderer never invents an earlier boundary. Missing validity remains a distinct hatched state and is never interpolated into purple low exposure. Tile and source gaps remain hard boundaries.

The current State A browser fixture uses approximately 93% OI, 0–4% event history, partial live book context, and medium confidence. Its default rendering is low-authority purple/blue historical context with no broad yellow field. This is not persistent three-week event history.
