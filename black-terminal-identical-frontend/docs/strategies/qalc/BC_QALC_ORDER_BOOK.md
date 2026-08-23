# BC-QALC Order Book

`QalcOrderBook.apply` builds snapshots into new maps and applies deltas to cloned maps. State is committed only if both sides are non-empty and `bestBid < bestAsk`; invalid mutations cannot partially alter the current book.

Rules:

- snapshot replaces authoritative state;
- quantity zero deletes a level;
- positive quantity inserts/replaces a level;
- duplicate update/cross sequences are idempotent;
- regressions and update id `1` after a snapshot fail closed into gap recovery;
- no undocumented assumption that every Bybit update id increments exactly by one;
- stale age is measured from receive time.

States include snapshot pending, live, gap detected, resynchronizing, stale and failed. Any non-live or >2-second-old book blocks decisions.
