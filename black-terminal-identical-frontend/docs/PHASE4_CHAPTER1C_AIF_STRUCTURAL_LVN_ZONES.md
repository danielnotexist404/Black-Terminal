# Phase IV Chapter I-C: A.I.F. Structural LVN Zones

Status: Implemented and locally verified on 2026-07-14.

## Root Cause Audit

The original future-LVN path selected isolated local-minimum profile rows under one relative activity threshold. The renderer then projected up to five node centers as dashed horizontal lines. Adjacent minima were not treated as one auction region, width and edge quality were not first-class metrics, lifecycle did not control projection, and the settings surface could not explain or tune the result. The line therefore had no visible lower/upper boundary and minor rows competed with important structures.

## Formal Zone Definition

An A.I.F. LVN is now a bounded, contiguous low-activity region in a profile histogram. `profile-core/structuralZones.ts` is a neutral numerical primitive and does not depend on A.I.F. or HDLX. It supports:

- hybrid structural scoring
- activity percentile
- neighbor contrast
- robust z-score
- valley detection
- activity relative to POC maximum

Candidate rows are grouped with a bounded internal-gap tolerance. Zones are rejected by edge exclusion, contiguous width, maximum width, neighbor contrast, and structural score. Nearby accepted regions are merged. Every result records low/high boundaries, geometric and inverse-activity weighted centers, minimum-activity price, absolute/percent/tick width, activity percentile, contrast, valley depth, strength, method, and algorithm version.

## Projection And Lifecycle

Projection is a second stage, not an alias for detection. A zone must pass configurable strength, stability, contrast, confidence, lifecycle, per-side, and total-display limits. Ranking combines structure, multi-lookback stability, contrast, confidence, freshness, lifecycle, and source quality.

Lifecycle interaction is session-based. Multiple candles inside one encounter do not create duplicate touches. Zones progress through qualified, projected, first-test, retest, rejected, accepted, and invalidated states. Invalidated zones fail closed unless the explicit faded-history policy is selected. Workspace/symbol memory reconciles small bucket shifts by overlap or normalized center distance and preserves the original zone identity.

## Rendering Contract

Projected LVNs render as clipped transparent price strips using the chart engine's authoritative price transform. The primary visual is the bounded region; center and minimum-activity lines are optional. Labels expose score, lookback, and lifecycle state, while the native tooltip carries range, center, minimum activity, width, profile, coverage, algorithm, strength, stability, contrast, touches, projection state, and provenance. Timeline events reference the reconciled zone identity.

## HDLX Reuse Boundary

HDLX was audited for proven profile UX concepts: range selection, rows, value area, POC/VAH/VAL controls, placement, width/offset, and restrained structural presentation. Those concepts informed A.I.F. controls and the neutral zone primitive. No HDLX source, defaults, state, renderer, or behavior was modified. The deterministic HDLX fixture remains a mandatory A.I.F. regression assertion.

## Settings And Persistence

Settings schema version 3 adds grouped/searchable controls, group reset, reset-all, built-in and custom presets, JSON transfer, dynamic profile controls, six normalization modes, range/resolution/value-area controls, structural detection, future-LVN eligibility and display controls, timeline, visuals, and bounded performance settings. The `HDLX-Inspired Structural` preset copies useful interaction ideas, not HDLX state or implementation ownership.

Factory defaults remain a 20,000-bar rolling horizon, 300 rows, hybrid structural detection, and ranked future zones. Browser persistence remains scoped to workspace, venue, symbol, and timeframe.

## Data Integrity And Limitations

- Chart candles produce estimated price-path profiles; classified trades are still required for exact absorption.
- IMM depth-memory confirmation remains unavailable in the current A.I.F. payload and its controls are disabled with that reason.
- Developing POC is represented in settings architecture, but the current render model only publishes the fixed completed-profile POC.
- Source-resolution preference records intent; actual historical resolution remains constrained by the market-data adapter response.
- Research memory is browser-local and bounded. No server research-memory schema was introduced.

## Verification

- `npm run typecheck`: passed.
- `npm run test:aif`: passed, including zone mathematics, lifecycle, ranking caps, identity reconciliation, settings migration, normalization, camera immutability, and the frozen HDLX fixture.
- `npm run benchmark:aif`: passed for 5k-100k bars and 100-1,000 rows; the slowest observed 100k case in this run was approximately 401 ms.
- `npm run test:aif-visual`: passed with eight captures and exact chart-pan synchronization without analytical recalculation.
- `npm run build`: passed.

The prior one-hour platform soak remains valid for the shared lifecycle/resource architecture. This chapter ran targeted deterministic, benchmark, browser, and production-build gates; it did not claim a new one-hour A.I.F.-active soak.
