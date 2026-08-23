# BC-QALC Event Replay

Hourly gzip NDJSON chunks preserve canonical event order and exact timestamps; each closed chunk receives a SHA-256 manifest with event count, byte count and time bounds. Raw events are stored on private NVMe, not row-by-row in PostgreSQL.

`replayArchivedEvents` streams decompressed events without loading a complete chunk into memory. `replayQalcArchive` supports wall-clock speed or maximum deterministic mode and uses the same `QalcEngine` state machine as forward Paper processing.

Replay requires instrument metadata from the archive or explicit historical tick/quantity-step parameters. It never enables live submission.

Parquet/Arrow research export and checkpoint/restart parity are remaining certification tasks.
