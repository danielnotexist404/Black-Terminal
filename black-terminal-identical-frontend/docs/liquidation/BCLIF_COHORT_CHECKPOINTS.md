# BCLIF Cohort Checkpoints

The shared cohort engine exports a versioned JSON-safe state containing cohorts, particles, prior frame, cohort ordinal, and traversed-cohort IDs. Collector checkpoints additionally bind the frame clock, source cutoff, offsets, dedup tail, rules/config hashes, and active draft-tile reference.

Checkpoint publication is immutable:

1. Serialize deterministically and compute SHA-256.
2. Upload to private object storage.
3. Read back with bounded size and verify checksum/schema/model/source version.
4. Insert checkpoint metadata.
5. Advance the latest valid pointer.

Checkpoints are written periodically, after substantial backfill, and during graceful drain—not per event. The collector continues only from a compatible validated checkpoint. Unsupported model versions require canonical cold replay or an explicit migration.
