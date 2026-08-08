# BCLIF Storage Retention

Retention is policy-driven and bounded:

- Hot: approximately 15–60 minutes, high resolution, bounded memory/spool.
- Warm: approximately 1–7 days, compressed high/moderate-resolution tiles and event chunks.
- Historical: approximately 1–12 weeks, deterministic downsampled tiles and required replay/checkpoint material.

Raw order-book deltas are not retained indefinitely. Reconstructed frames move from configurable 1–5 second cadence to 15–60 second cadence. Trade chunks retain only what the replay/calibration policy requires.

Retention uses a claim/verify/finalize workflow. An active, unsuperseded, unverified, or checkpoint-referenced object cannot be deleted. Object deletion precedes metadata finalization and is retryable through a deletion queue. No `pg_cron` job is installed blindly; the collector owns scheduling until database extension availability is certified.
