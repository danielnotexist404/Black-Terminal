# BCLIF model generation continuity

Browser fallback remains session-scoped, but a controller generation now owns
one immutable absolute price grid. Periodic REST refreshes and live worker
rebuilds reuse that grid. Model/schema/checksum identities still invalidate
decoded persistent cache entries.

Generation identity includes:

- model and source version;
- venue/symbol/horizon;
- absolute grid version/origin/step/bounds/rows;
- causal source timestamps and cutoff;
- cohort IDs and entry-distribution hashes;
- raw long/short exposure checksum.

The canonical OI clock is five minutes for every chart timeframe. Chart
timeframe, zoom, plot size, and current display range are not cohort identity
inputs.

Current limitation: browser fallback reconstructs its bounded bootstrap model
on refresh instead of importing an authoritative persistent checkpoint. This
is deterministic under an unchanged source prefix and grid, but it is not
persistent memory. The dedicated collector remains the only planned owner of
durable generations.
