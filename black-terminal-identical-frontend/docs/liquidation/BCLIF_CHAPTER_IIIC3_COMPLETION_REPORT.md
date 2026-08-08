# BCLIF Chapter III-C3 Completion Report

## Release identity and deployment truth

- Starting commit: `fff9cc4f6ccc83767cea9a3e1dc765e6a1ace290`.
- Final commit: the immutable SHA printed in the repository handoff; a Git commit cannot embed its own content-derived SHA.
- Model: `BCLIF_MODEL_V5_AUTHENTIC_EXPOSURE`.
- Source adapter: `BYBIT_V5_PUBLIC_2026_08`.
- Production deployment: **not performed**.
- Infrastructure state: **REPOSITORY COMPLETE / PERSISTENT HOST NOT PROVIDED / COLLECTOR NOT DEPLOYED / MIGRATIONS NOT APPLIED / BROWSER FALLBACK ACTIVE**.

The `PERSISTENT_NODE` golden is a deterministic localhost authority-contract fixture. It is not evidence of a deployed collector or real persistent history.

## Exact root cause

The pre-change V4 browser path mapped horizon-dependent OI observations onto chart candles and supplied the current candle close/mark as the position-entry proxy. Small positive OI noise could therefore create births around successive market prices. The browser model was rebuilt from a rolling session window, older inventory was not preserved as stable cohort state, and per-column/generation normalization promoted each newly centered broad kernel. Broad low-authority entry/margin kernels then rendered those repeated births as swing-following rectangular envelopes. The viewport was not the causal model input, but chart-timeframe-bound source sampling and rolling reconstruction were. The collector path also used the current mark as the entry proxy when interval trade provenance was unavailable. The full read-only trace is in `BCLIF_SWING_FOLLOWING_ROOT_CAUSE_AUDIT.md`.

## Corrected causal methodology

### Birth, death, and noise

Browser historical Bybit single-side OI is sampled on one canonical five-minute clock for every display horizon. Persistent live collection uses timestamped ticker OI observations on its independent event clock; neither path inherits the chart timeframe. A material positive delta creates equal LONG and SHORT gross quote-notional hypotheses; it is represented once per side for liquidation-risk modeling and is not reported as doubled exchange OI. A material negative delta removes existing same-side mass. Flat or immaterial OI creates no mass.

`BCLIF_ROBUST_OI_CHANGE_V1` uses the maximum of a $100,000 absolute-notional floor, 0.0075% of OI, and 3.5 scaled MAD over the recent delta history. The decision, threshold, raw delta, effective delta, method, and version are retained.

### Entry, leverage, tier, and liquidation distributions

Each birth owns an explicit OI interval and one normalized, content-hashed entry distribution with at most 16 rows. Evidence order is exact historical trades, lower-timeframe volume-at-price, lower-timeframe OHLCV approximation, then chart-bar approximation. No future trade, chart swing, or viewport state is read.

Each entry row is crossed with the versioned 5x/10x/20x-centered leverage prior and normalized public Bybit risk-tier hypotheses. Liquidation distributions are derived once from entry, leverage, allocated notional, maintenance margin, fee reserve, and the isolated/cross/unknown assumption. Current price is used for traversal and distance only; it never becomes a historical cohort's new entry.

Funding adjustment is deliberately `0 bps`. No unverified funding/collateral recentering is claimed. Cross and unknown estimates are broader, fainter, and capped at 0.12 and 0.06 contribution respectively; isolated-like estimates are capped at 0.82.

### Persistence and lifecycle

Stable cohort IDs hash venue, symbol, side, OI interval, entry-distribution hash, leverage-prior version, and model version. Cohorts survive later price swings. `BCLIF_DETERMINISTIC_CLOSURE_ALLOCATION_V1` distributes OI contraction by age, price/entry relationship, profitability context, and survival weakness. Confirmed liquidation events match by side, price likelihood, time, confidence, and available mass, then remove posterior mass without moving prior columns. Traversal without confirmed-event coverage records `UNRESOLVED_TRAVERSAL`, reduces mass/confidence conservatively, and explicitly remains uncertain.

The browser state is bounded to 320 cohorts, 24,576 particles, and 4,096 lifecycle events; every capacity expiry is mass-accounted. A true persistent V5 cohort-provenance sidecar is not yet published because the collector is not deployed.

## Field, grid, kernels, and provenance

- Grid origin: zero/instrument tick origin.
- Grid step: deterministic tick-aligned nice step derived from the first canonical source frame.
- Grid version: `BCLIF_ANCHORED_NICE_STEP_V2`.
- Historical normalization: causal 64-column fixed-domain rolling histogram.
- Kernel width: entry dispersion + leverage dispersion + public risk-tier and margin-mode uncertainty.
- Display: worker-projected adaptive raster and worker-built upload-ready RGBA; the chart performs one Pixi texture update.
- Model/render separation: model hash, exposure hash, render-settings hash, and display-raster hash are independent contracts.

Operational shelves expose concentration, local prominence, width, persistence, entropy, overlap count, cohort IDs, evidence, lifecycle state, and provenance coverage. The mandatory provenance mode and birth markers are off in normal trading view.

## Executable correctness results

The final authentic-exposure suite reports:

- 24 invariant groups: **PASS**;
- model hash: `fnv1a-0f383006`;
- exposure hash: `fnv1a-94cad7d3`;
- deterministic cohorts: 6;
- attributable operational clusters: 12;
- mass-conservation error: 0 in the main deterministic contract fixture;
- anchored grid: $19,000–$121,300, $100 step, origin 0;
- swing-independence: 0 cohorts / 0 shelves under flat OI;
- flat-OI false-shelf rate: 0;
- unchanged-cohort shelf drift: $0;
- chart-timeframe invariance: identical model/cohort/exposure identity;
- viewport invariance: identical model/exposure identity with distinct display-raster identity;
- fetch-chunk/reconnect invariance: identical canonical output and hashes;
- append invariance: finalized historical prefix unchanged;
- provenance coverage: 100% for every model-built displayed shelf;
- missing evidence: invalid/uncertain, never silently converted to zero.

The deterministic visual fixture contains three material OI expansions, interval-specific entry shapes, 5x/10x/20x priors, five later major price swings, one contraction, confirmed events, missing-event traversal, and persistent/decaying/terminated shelves. No exposure cells are painted by the fixture; the golden uses direct model output.

## Visual certification

Repository-owned Playwright coverage is 27 cases:

- Cohort Provenance;
- Swing Independence;
- OI Expansion;
- OI Contraction;
- Confirmed Liquidation;
- Trade Focus;
- Full Spectrum Research;
- Browser Fallback;
- Persistent Authority contract fixture;

at 1920×1080, 2560×1440, and 3840×2160. Each capture enforces model-ready cohort/lifecycle counts, one canvas/texture, authority and horizon truth, display-domain correctness, provenance, bounded labels/yellow tail, mass tolerance, and `<16.7 ms` measured texture preparation/update. Candidate recording is not a pass; the final comparison run must report `PASS` before handoff.

The final whole-frame comparison is complete: **27/27 PASS**, and `tests/golden/bclif/manifest.json` is `CERTIFIED`. The minimum observed SSIM was 0.995239 and the maximum observed mean perceptual delta was 0.000588. Across the 27 browser captures, measured texture preparation plus GPU update was 0.7 ms p50, 1.0 ms p95, and 2.9 ms p99; the maximum single observation was 3.0 ms. Golden recording and comparison were separate runs.

## Performance and memory

Measured Node 22 model/kernel benchmark (deterministic synthetic data):

| Stage | p50 | p95 | p99 |
|---|---:|---:|---:|
| cohort birth | 0.270 ms | 0.974 ms | 1.311 ms |
| lifecycle update | 0.063 ms | 0.109 ms | 0.393 ms |
| contraction allocation | 0.043 ms | 0.145 ms | 0.312 ms |
| confirmed-event assimilation | 0.038 ms | 0.136 ms | 0.339 ms |
| authoritative raster | 198.635 ms | 226.640 ms | 226.640 ms |
| display projection | 206.520 ms | 216.944 ms | 222.578 ms |
| worker-side texture preparation | 4.554 ms | 14.259 ms | 18.037 ms |

The first two heavy field stages are off-main and operate at model/raster cadence, not chart-frame cadence. Node memory deltas were heap -0.46 MiB, external/array 70.51 MiB, and RSS 131.75 MiB. These are benchmark-process measurements, not browser or host-capacity certification. Headless Chromium animation cadence is explicitly not an interactive FPS claim; real 55–60 FPS acceptance still requires the target production browser/device.

## Source surface

Primary affected code is confined to:

- `src/modules/liquidation-field/core/` cohort, entry, materiality, raster, normalization, leverage, settings, types, and cluster logic;
- `src/modules/liquidation-field/data/` public-source/controller/tile assembly logic;
- `src/modules/liquidation-field/rendering/` projection, worker texture preparation, and Pixi upload;
- `src/modules/liquidation-field/components/` settings and provenance overlays;
- `server/liquidation-intelligence/model/`, canonical normalization, risk-tier source, API contracts, preflight, and tests;
- Chapter III-C3 scripts, docs, and visual goldens.

## Remaining limitations

- Browser historical entry evidence is lower-timeframe OHLCV approximation when exact public trade history is unavailable.
- Trader leverage, collateral, margin mode, equity, and exact entry remain unobservable; BCLIF is an estimated exposure distribution.
- Funding/collateral adjustment is not modeled.
- Historical book and liquidation-event coverage remain unavailable before the live browser session unless persistently collected.
- Browser OI-only historical authority remains capped at 60%.
- Full multi-week event-history certification, real persistent provenance sidecars, target-device GPU/FPS acceptance, runtime migrations/RLS/storage verification, and collector soak remain blocked by the absent persistent host/deployment.

## Exclusion confirmation

No Black Cloud, OMS, EMS, private broker credential, execution, position-protection, Portfolio Manager, Investment Groups, Obsidian, RADAP, HDLX, Kioseff, DOM Pro wall-detection, or BC-LPP behavior was modified. BCLIF remains estimated liquidation exposure; observed resting L2 liquidity remains a separate system.
