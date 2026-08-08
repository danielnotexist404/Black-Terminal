# BCLIF Collector Recovery

Recovery order is strict: validate configuration/schema/storage, load the latest compatible checkpoint, verify its object checksum, restore shared model and source offsets, load the exact dedup tail, replay later canonical events chronologically, reconcile source timestamps, connect public streams, synchronize, then publish live.

A corrupt latest checkpoint falls back to the preceding valid checkpoint and records degraded recovery. A missing object, incompatible model, or irrecoverable checksum never enters `LIVE`. Replayed event IDs and persisted offsets make recovery idempotent.

Graceful shutdown stops new frames, seals or abandons the draft tile safely, writes a checkpoint, persists offsets/dedup, flushes event chunks and metrics, marks the node draining, closes sockets, and exits. Incomplete tiles are never finalized.

Restart certification injects failures during source collection, book resync, OI backfill, cohort updates, tile encoding/upload, checkpoint write, and compaction, then checks for duplicate events/cohorts, missing finalized tiles, offset regressions, and corruption.
