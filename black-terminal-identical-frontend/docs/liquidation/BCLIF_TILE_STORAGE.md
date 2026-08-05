# BCLIF Tile Storage

Dense time × price channels are designed for chunked binary objects, never one SQL row per cell. The tile header records schema/model version, venue, symbol, horizon, time/price bounds, dimensions, scales, compression and FNV-1a checksum. Channels are timestamps, long exposure, short exposure, combined exposure, normalized intensity, confidence, validity and confirmed-event intensity.

Migration `202608050001_bclif_liquidation_intelligence_foundation.sql` adds service-only source, coverage, event, field-chunk and evaluation metadata plus a private `bclif-field-chunks` bucket. The browser runtime does not upload tiles; that belongs to the future persistent collector.
