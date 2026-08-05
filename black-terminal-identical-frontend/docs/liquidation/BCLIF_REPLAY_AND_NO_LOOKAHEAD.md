# BCLIF Replay and No Lookahead

Frames and events are sorted chronologically. At frame `t`, the cohort engine only assimilates events after the previous frame and at or before `t`. Cohorts begin when OI expansion is observed; no latest snapshot is projected backward. Field timestamps are stored explicitly and remain attached to chart coordinates during pan, zoom and resize.

Full persistent replay is pending tile ingestion from the future collector. Browser-session history alone cannot reconstruct earlier public-trade, order-book or liquidation streams.
