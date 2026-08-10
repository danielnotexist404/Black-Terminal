# BCLIF High-Resolution Rendering

Display LOD is independent of model resolution and hashes. CSS dimensions are multiplied by device pixel ratio (bounded to 2), then projected within safe GPU caps.

Measured V3 golden display grids:

| viewport | scalar grid | valid cells | preparation/upload |
|---|---:|---:|---:|
| 1920×1080 | 1536×1024 | 1,556,480 | 3.2 ms |
| 2560×1440 | 2007×1024 | 2,034,688 | 1.0 ms |
| 3840×2160 | 3159×1528 | 4,778,056 | 1.1 ms |

Auto, High, Ultra, and Low Performance alter only the projected display lattice. Model/cohort IDs, absolute shelf prices, raw exposure, confidence, and historical state remain fixed. The worker uses latest-wins projection, transfers typed-array buffers, and retains the last certified texture while a replacement is prepared.

The fresh three-case browser comparison reports 1.1 ms median preparation/upload and 3.2 ms maximum. This metric is not an interactive-FPS claim. Headless screenshot cadence includes fixture generation and browser automation and is therefore recorded as non-representative. A real authenticated camera-interaction trace is still required for the 55 FPS target.
