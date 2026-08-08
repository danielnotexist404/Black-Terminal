# BCLIF Tile Storage

Dense time × price channels use chunked binary objects, never one SQL row per cell. The `BCLF` header records schema/model/tile version, venue, symbol, horizon, immutable time/price grid, source cutoff, dimensions, channel scales, deterministic gzip lengths, and SHA-256. Numerical channels retain timestamps, quantized long/short/combined exposure, confidence, validity, confirmed-event intensity, and causal normalization metadata.

Migrations `202608050001` and `202608050002` define the service-only metadata and private `bclif-field-chunks` bucket. The persistent collector is the only writer; clients receive protected manifests and verified bytes without object paths. Both migrations remain intentionally unapplied until an analytics host passes the activation gate.
