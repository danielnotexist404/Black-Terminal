# BCLIF Collector Health

The collector exposes `/health/live`, `/health/ready`, and `/metrics` on a loopback-bound configurable port. Liveness means the process event loop responds. Readiness requires valid configuration and identity, safe UTC clock, reachable Supabase schema, private storage, checkpoint repository, compatible model, initialized adapters, and completed recovery/reconciliation.

Lifecycle states cover starting, validation, schema/storage connection, checkpoint load, replay, backfill, source synchronization, live, degraded source states, draining, and terminal configuration/schema/storage/checkpoint/model failures.

The packaged registry emits uptime, heartbeat age, source rates/ages/reconnects/gaps/deduplication, cohorts/particles, model/raster/tile/checkpoint timings, queue/storage failure counters, and the coverage gauges wired by the collector. Timing summaries expose p50/p95/p99 for observations received by the process. Client delivery currently uses protected HTTP manifest polling, so the collector cannot truthfully infer an active-client subscription count; that value is reported as not applicable rather than invented. Production traffic, storage, and long-soak measurements remain unavailable until a dedicated analytics host exists. Structured JSON logs include safe correlation and model identifiers and redact credentials/tokens.
