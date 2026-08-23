# BC-QALC No-Lookahead Contract

At event time `t`, calculations read only events accepted through `t`. Rolling windows use receive/event boundaries and never reorder using future data. Trade ids are deduplicated before feature ingestion.

Paper fills require an order active before the source trade. Queue-ahead is consumed sequentially. Future price, future depth, future trade volume, candle high/low and full-sample normalization are prohibited.

The core suite verifies prefix invariance by processing the same prefix in two engines, comparing finalized telemetry, appending a future event to one engine, and confirming the untouched prefix engine remains identical.

Random truncation, persisted checkpoint parity and long archived stream/live parity remain certification tasks.
