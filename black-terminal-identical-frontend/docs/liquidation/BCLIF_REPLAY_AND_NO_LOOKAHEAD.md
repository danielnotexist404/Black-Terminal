# BCLIF Replay and No Lookahead

Frames and events are sorted chronologically. At frame `t`, the cohort engine only assimilates events after the previous frame and at or before `t`. Cohorts begin when OI expansion is observed; no latest snapshot is projected backward. Field timestamps are stored explicitly and remain attached to chart coordinates during pan, zoom and resize. Model V4 normalizes each column from a trailing-only window and temporal smoothing reads no future column.

The Chapter III-C collector package replays canonical events after a validated checkpoint and finalizes fixed-coordinate immutable tiles. Appending later events cannot rewrite a finalized tile. Risk tiers, funding, OI, and books are usable only after their known-at timestamps. Persistent replay is packaged but not running until a separate analytics host and the audited migrations are activated. Browser-session history still cannot reconstruct earlier public-trade, order-book, or liquidation streams.
