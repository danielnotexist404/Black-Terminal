# Auction Profile Performance Results

Measured locally on 2026-08-03 with `npm run benchmark:auction-profile`. Times are wall-clock Node worker-kernel measurements and will vary by machine.

| Bars | Rows | Blocks | Sparse cells | Cold | Warm | Increment | Projection | Text | Serialize |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 100 | 100 | 994 | 18.83 ms | 9.51 ms | 0.96 ms | 0.20 ms | 0.84 ms | 3.82 ms |
| 250 | 200 | 250 | 4,529 | 43.79 ms | 32.43 ms | 0.45 ms | 0.03 ms | 0.91 ms | 19.98 ms |
| 500 | 300 | 500 | 12,837 | 78.44 ms | 63.34 ms | 6.87 ms | 0.05 ms | 1.27 ms | 61.72 ms |
| 1,000 | 499 | 1,000 | 38,256 | 207.70 ms | 209.15 ms | 4.19 ms | 21.64 ms | 0.59 ms | 131.19 ms |
| 5,000 | 256 | 5,000 | 62,219 | 323.41 ms | 416.26 ms | 0.60 ms | 28.40 ms | 0.87 ms | 223.93 ms |
| 10,000 | 512 | 5,000 | 94,967 | 519.86 ms | 574.07 ms | 7.13 ms | 26.49 ms | 0.85 ms | 323.30 ms |
| 20,000 | 1,024 | 5,000 | 147,297 | 908.23 ms | 1,249.89 ms | 9.22 ms | 38.37 ms | 0.58 ms | 547.82 ms |
| 20,000 | 2,029 | 5,000 | 286,675 | 1,736.96 ms | 2,073.34 ms | 5.20 ms | 73.66 ms | 4.16 ms | 1,062.43 ms |

The requested 1,000 × 500 and 20,000 × 2,048 cases quantized to 499 and 2,029 rows because of deterministic tick alignment. The 5,000-block cap is calculation aggregation, independent of the 500-column display budget. All cases passed matrix/profile conservation, finite-number, grid-boundary, lifecycle, deterministic-version, POC/VA, and node-alignment invariants.

Projection measures semantic row/column downsampling to the 500 × 300 display budget. Text measures culling and formatting of the 2,000-label budget. These are calculation/render-preparation measurements, not a claim about GPU upload time or browser FPS; those require a browser frame profiler. Rebuilds and serialization remain in the dedicated worker. The largest incremental case is comfortably within the intended 5–15 visual-update-per-second envelope; incoming trades may be ingested faster and flushed in batches.
