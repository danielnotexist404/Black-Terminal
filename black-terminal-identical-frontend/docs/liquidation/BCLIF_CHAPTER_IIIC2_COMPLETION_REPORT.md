# Phase V Chapter III-C2 Completion Report

## Identity and release state

- Starting commit: `3af120d539befc25acabde25336c6f683ac18180`
- Final commit: recorded after publication.
- Production deployment: not performed by this chapter.
- Persistent status: repository complete; host not provided; collector not deployed; migrations not applied; browser fallback active.

## Cause and correction

Candle compression was caused by using the entire modeled BCLIF price range as chart auto-scale input. The correction preserves every distant cohort but separates immutable model domain from disposable display domain. `Trade Focus` now defaults to Chart Scale; `Full Spectrum Research` remains explicit and complete.

The display worker applies source-aware historical/live channels, confidence and continuity gates, adaptive resolution, selective gamma/quantile normalization, uncertainty treatment, and a rare-yellow rule. Yellow requires ≥75% confidence, valid continuity, the top 0.1–0.5% tail (0.3% default), and at least two meaningful evidence sources. Valid low values stay purple; missing columns remain hatched. Live support begins at the real source-start marker.

High-confidence kernels stay precise. Lower-confidence uncertainty is wider but faint. Focus grids use 768–2,048 rows; full range uses 512–1,024; constrained fallback uses 384–512. Time columns cover the full retained span with explicit actual time step and do not blur validity gaps.

## Operator workflow

Presets are Trade Focus, High Confidence, Live Calibrated, Full Spectrum Research, and Raw Model. The compact summary is collapsible/draggable. Cluster rank uses 28% exposure, 22% confidence, 14% prominence, 10% persistence, 10% survival, 10% observed events, and 6% proximity. Default selection is nearest above/below plus strongest high-confidence shelves, capped at four. Authority is always visible. Browser three-week context is never labeled full event history.

## Identity and tests

MODEL, EXPOSURE, RENDER SETTINGS, DISPLAY EVIDENCE, and DISPLAY RASTER identities are separate. Deterministic tests proved eight price-display modes and camera/style changes leave MODEL `fnv1a-ec6472bb` and EXPOSURE `fnv1a-b7a7efae` invariant while producing eight distinct display-raster identities. Custom bounds invalidate only presentation identity. Browser-fallback and persistent snapshots with identical raw exposure now produce different evidence/raster identities. Data-quality gates cover OI-only 50%, exact trades, fully event-calibrated 90%, stale book, missing validity, persistent authority, and browser fallback. The full-quality fixture produced a 0.0977% yellow tail.

## Performance evidence

Deterministic Node pipeline (representative local run):

| Stage | p50 | p95 | p99 |
|---|---:|---:|---:|
| cohort model update | 0.509 ms | 1.173 ms | 1.489 ms |
| exposure rasterization | 2043.373 ms | 2214.053 ms | 2214.053 ms |
| display projection worker kernel | 196.510 ms | 212.511 ms | 212.511 ms |
| worker structured clone | 0.437 ms | 0.965 ms | 1.236 ms |
| texture staging | 5.126 ms | 15.463 ms | 16.719 ms |

Projection runs off the main thread and retains the prior certified texture. The final non-update Playwright comparison measured PIXI texture preparation/update from 9.4 to 123.4 ms across the 21 fixture/viewports; these are isolated update measurements and are not converted into an FPS claim. Headless animation cadence is explicitly not treated as interactive FPS because Chromium may throttle it. Memory deltas for this representative run were heap -2.45 MiB, external/array buffers +36.50 MiB, and RSS +106.75 MiB.

The collector benchmark passed only as `MEASURED_KERNEL_ONLY`, with `hostCapacityClaim: NONE`: the 10-symbol structural steady-state upper bound was 369.64 MiB and publication-peak upper bound was 628.42 MiB. Queue delay, persistent I/O, recovery time, and capacity remain not measured/not certified until a real persistent host exists.

## Boundary audit result

Real source start, real data gaps, model-version changes, verified tile stitches, normalization selection, and worker raster replacement were audited explicitly. Source start remains a visible boundary; gaps remain hatched; model-version identity is isolated; tile columns retain their validated lattice; normalization is display-only; and stale/out-of-generation worker results cannot replace the current texture. The Pixi remount teardown no longer releases shared global texture resources.

## Visual certification

The repository contains 21 new full-resolution baselines for seven fixtures at 1920×1080, 2560×1440, and 3840×2160. Final comparison status is taken from `tests/golden/bclif/manifest.json`; a `CERTIFIED` value means all semantic checks, thresholds, and hash separation passed in a non-update run.

Production build, TypeScript, security contracts/audit, static migration verification (34/34 tables), BCLIF API/migration/client contracts, collector/order-book/recovery/codec/no-lookahead suites, shell syntax, and diff whitespace checks passed. The live anonymous Supabase boundary probe was not run because this workspace has no Supabase URL/anonymous key configured; no credential was invented and no deployment claim is made.

## Remaining limitations

- browser fallback cannot recreate pre-connection exact trades, liquidations, or order books;
- current deployment remains State A and has no persistent three-week event history;
- the Node raster benchmark is synchronous kernel evidence, not main-thread production cost;
- headless browser cadence is not an interactive FPS claim;
- BCLIF estimates exposure ranges and is decision support, not guaranteed liquidation location.

No OMS, EMS, Black Cloud, broker credential, private Bybit, order execution, PositionManager, Investment Group, Obsidian, HDLX, RADAP, Kioseff, or DOM Pro calculation code was changed. No database migration or deployment was executed.
