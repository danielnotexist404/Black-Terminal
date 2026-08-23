# BC-QALC Event Sequencing

Canonical identity is venue/category/symbol/event type plus exchange identity. Trades are additionally deduplicated by `(symbol, tradeId)` because one trade sequence may span multiple messages.

`QalcEventSequencer` rejects envelope duplicates, trade duplicates, receive-time regression outside tolerance, and material exchange-time regression. Its bounded identity window is 120 seconds.

The gateway generation number prevents events from an obsolete socket from entering a new session. Reconnect closes timers, establishes one replacement socket, and requires the provider snapshot before the book returns live.

Bybit update id is treated as monotonic, not falsely assumed gapless. Cross-sequence regression, service reset, stale transport, reconnect and structural book failure all force fail-closed recovery.
