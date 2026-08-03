# Auction Profile Performance Results

Measured locally on 2026-08-03 with `npm run benchmark:auction-profile`. Times are wall-clock Node worker-kernel measurements and will vary by machine.

| Bars | Rows | Cold rebuild | Warm rebuild | Incremental trade | Serialization | Engine estimate |
|---:|---:|---:|---:|---:|---:|---:|
| 5,000 | 256 | 89.30 ms | 56.81 ms | 2.67 ms | 11.26 ms | 305,536 B |
| 10,000 | 512 | 97.33 ms | 85.73 ms | 1.22 ms | 19.01 ms | 611,072 B |
| 20,000 | 1,024 | 165.87 ms | 151.17 ms | 3.38 ms | 31.69 ms | 1,222,144 B |
| 20,000 | 2,029 | 160.67 ms | 198.01 ms | 7.85 ms | 34.69 ms | 1,479,424 B |

The last case requested 2,048 target rows; deterministic price/tick quantization produced 2,029 occupied grid rows. All cases passed conservation, finite-number, grid-boundary, deterministic-version, POC/VA, and node-alignment invariants.

These figures measure calculation and JSON serialization, not GPU frame time. The production bundle contains a separate `auction-profile.worker` asset, so rebuilds remain off the UI thread.

