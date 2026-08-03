# Auction Profile Performance Results

Measured locally on 2026-08-03 with `npm run benchmark:auction-profile`. Times are wall-clock Node worker-kernel measurements and will vary by machine.

| Bars | Rows | Blocks | Sparse cells | Cold | Warm | Increment | Footprint projection | Profile projection | Text | Serialize |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 100 | 100 | 994 | 41.72 ms | 23.70 ms | 1.13 ms | 0.18 ms | 0.60 ms | 0.73 ms | 4.96 ms |
| 250 | 200 | 250 | 4,529 | 68.21 ms | 51.04 ms | 1.35 ms | 0.08 ms | 0.40 ms | 2.18 ms | 20.54 ms |
| 500 | 300 | 500 | 12,837 | 106.52 ms | 90.56 ms | 1.56 ms | 0.05 ms | 0.59 ms | 3.52 ms | 72.73 ms |
| 1,000 | 499 | 1,000 | 38,256 | 319.04 ms | 273.24 ms | 2.75 ms | 23.80 ms | 1.04 ms | 1.32 ms | 186.03 ms |
| 5,000 | 256 | 5,000 | 62,219 | 553.27 ms | 434.08 ms | 1.33 ms | 30.48 ms | 0.28 ms | 1.33 ms | 294.12 ms |
| 10,000 | 512 | 5,000 | 94,967 | 769.36 ms | 841.83 ms | 0.92 ms | 34.73 ms | 0.64 ms | 9.06 ms | 396.52 ms |
| 20,000 | 1,024 | 5,000 | 147,297 | 1,332.56 ms | 1,047.87 ms | 2.49 ms | 55.36 ms | 8.24 ms | 0.71 ms | 636.79 ms |
| 20,000 | 2,029 | 5,000 | 286,675 | 2,212.89 ms | 2,274.58 ms | 13.98 ms | 85.22 ms | 2.63 ms | 0.61 ms | 1,112.63 ms |

The requested 1,000 × 500 and 20,000 × 2,048 cases quantized to 499 and 2,029 rows because of deterministic tick alignment. The 5,000-block cap is calculation aggregation, independent of the 500-column display budget. All cases passed matrix/profile conservation, finite-number, grid-boundary, lifecycle, deterministic-version, POC/VA, and node-alignment invariants.

Footprint projection measures semantic row/column downsampling to the 500 × 300 display budget. Profile projection measures aggregate range × price row construction, normalization, and optional segment indexing. Text measures culling and formatting of the 2,000-label budget. These are calculation/render-preparation measurements, not a claim about GPU upload time or browser FPS; those require a browser frame profiler. Rebuilds and serialization remain in the dedicated worker.
