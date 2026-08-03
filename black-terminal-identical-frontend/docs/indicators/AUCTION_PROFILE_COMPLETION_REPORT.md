# BC-MEAP Completion Report

## Delivered

- original Pine source retained unchanged;
- Pine Compatibility and Black Core Native modes separated;
- canonical trade-side service with deduplication and provenance;
- real-trade CVD plus bar fallback without double counting;
- 20,000-bar scope architecture;
- session, rolling, fixed, visible, composite, periodic, macro, and manual scopes;
- deterministic price grid, value area, POC, IB, off-chart CVD metrics;
- CVD, volume, TPO, activity, USD, volatility, Parkinson, Garman-Klass, trade-statistic, liquidity-weighted, and hybrid engines;
- CVD LVN/HVN classification;
- versioned cancellable worker and incremental trade updates;
- Pixi renderer, settings, legend, loading state, and diagnostics;
- versioned workspace persistence;
- Python analytical package;
- TypeScript and Python deterministic certification fixtures.

## Truth boundary

Exact CVD applies only where certified aggressor trades are present. Existing OHLCV history remains visible as MIXED or APPROXIMATE. No synthetic history is called exact.

## Certification status

Native deterministic fixtures are certified locally. Compatibility behavior is implemented and the source anomalies are retained. Pixel-by-pixel TradingView parity cannot be honestly certified without golden output captured from the same symbol, venue, history, and settings.

## Scope and stability

Session boundaries use Black Terminal's canonical epoch-second timestamps. UTC, London, New York, Asia, custom, week, and month templates are deterministic; London and New York use IANA timezone rules. Periodic composites use actual daily, weekly, monthly, quarterly, custom-hour, or custom-bar boundaries. Locked composites reject bar and trade mutations until unlocked. Macro, rolling, fixed, manual, and composite grids are camera-independent unless Visible Pixel Adaptive rows are explicitly selected.

## Runtime architecture

- Calculation runs in the dedicated `auction-profile.worker` asset.
- Live classified trades use incremental row mutation; chart-bar changes trigger a cancellable rebuild.
- Inputs and snapshots carry generation, calculation-settings, source-revision, and profile-version hashes.
- Canonical trades are deduplicated by venue, symbol, and trade identity.
- The in-memory trade cache is bounded to 250,000 trades per market.
- Rows and render objects are capacity-bounded; Pixi objects are pooled and released on disposal.
- Strategy consumers can freeze and compare immutable version identifiers instead of reading camera state.

## Performance evidence

The local deterministic benchmark covers 5,000, 10,000, and 20,000 bars at 256 through 2,029 resulting rows. The largest run completed a cold rebuild in 160.67 ms, a warm rebuild in 198.01 ms, an incremental trade update in 7.85 ms, and serialization in 34.69 ms. These are calculation-kernel measurements, not browser frame-time guarantees. Full results are in `AUCTION_PROFILE_PERFORMANCE.md`.

## Validation

- TypeScript native-engine certification passed, including conservation, exact/mixed quality, stable grid, value area/POC, node alignment, epoch-second sessions, DST-aware London sessions, calendar/custom periodic scopes, worker incrementality, and locked-profile non-repaint.
- The independent Python validation package passed.
- Existing Market Maker Heatmap regression suites passed.
- Production typecheck, 27 security route contracts, Vite build, and secret audit passed.
- The retained Pine source hash matches the supplied attachment byte-for-byte.

## Deployment and isolation

The implementation is committed to and pushed on the repository's `main` release path, and the linked Vercel production deployment was verified Ready. It requires no Supabase migration. Broker credentials, order submission, portfolio execution, and risk controls were not modified by this chapter.

## Remaining limitations

- Exact historical CVD requires venue trade archives or Black Cloud persisted trades. Candle-only history remains approximate.
- Pine Compatibility preserves the supplied formulas and documented anomalies, but pixel-level parity remains pending a same-market, same-window TradingView golden export.
- Interactive browser visual smoke was unavailable in this session; deterministic rendering, production compilation, and renderer lifecycle checks passed.
- The venue-neutral correlation interface is prepared for future HDLX, DOM, and IMM confluence; it does not fabricate unavailable depth or liquidation history.

## BC-MEAP 2.0 dynamic restoration addendum

This section supersedes the original aggregate-first rendering status.

### Root cause and responsible files

The first implementation serialized only cumulative price rows. `nativeEngine.ts` had no time-block matrix, while `AuctionProfileRenderer.ts` could only draw row histograms and node extensions. Legacy defaults enabled those structural layers together. The missing time dimension—not styling—caused the mismatch.

### Delivered architecture

- `core/types.ts`: versioned block, cell, matrix, presentation, normalization, density, and extension contracts.
- `core/blockMatrix.ts`: deterministic block cadence, sparse cell construction, exact/fallback allocation, normalization, TPO/volatility components, lifecycle, and indexed live mutation.
- `engines/nativeEngine.ts`: matrix snapshots, retained/finalized historical sessions, and BC-MEAP 2.0 versions.
- `rendering/AuctionProfileRenderer.ts`: batched cells, stable keyed label reuse, optional aggregate/nodes, precise key levels, current-column border, hover inspection, and multi-session drawing.
- `rendering/cells.ts`: display-only row/column aggregation with signed conservation.
- `components/AuctionProfileSettings.tsx`: independent scope/presentation, presets, cell controls, budgets, and structural controls.

### Behavioral result

Native Real CVD maps each trade to exactly one time block and price row. Pine Compatibility keeps lower-timeframe directional distribution and observed source quirks. The latest block updates incrementally; closed blocks and prior sessions remain finalized. Default rendering is Dynamic Blocks + Key Levels with aggregate, LVN/HVN, labels, midpoint, macro S/R, and historical extensions off.

Cell text supports signed compact CVD, ratios, USD, TPO/activity, and volatility formatting. Hover exposes the complete cell evidence record. Continuous positive intensity runs dark gray to silver-white; negative intensity runs dark red to blood red; borders are near-black.

### Certification

- native exact fixture: `+3` at 63,000, `-4` at 63,050, and `+6` at 63,100 passed;
- multiple trades per cell, block creation, current-cell increment, frozen history, conservation, data quality, label culling, compact formatting, palette endpoints, session retention, worker incrementality, and locked composites passed;
- Pine semantic compatibility remains implemented with seven documented source anomalies;
- pixel-identical Pine certification remains pending synchronized TradingView cell exports.

### Performance

Capacity tests cover requested 100×100, 250×200, 500×300, and approximately 1,000×500 matrices plus 5,000–20,000-bar macro cases. The largest recorded run produced 286,675 sparse cells: 1,736.96 ms cold worker build, 2,073.34 ms warm build, 5.20 ms incremental update, 73.66 ms display projection, and 4.16 ms label culling/formatting. Full numbers and the browser-FPS truth boundary are in `AUCTION_PROFILE_PERFORMANCE.md`.

### Build and deployment boundary

Typecheck, Auction Profile certification, 27 security contracts, production Vite build, and secret audit pass. No Supabase migration is required. Git/Vercel deployment status is reported with the release handoff because it is external state.

### Visual evidence and remaining limitations

The supplied Pine and Black Terminal images remain the comparison evidence. Automated in-app screenshot capture could not be executed because the browser-control runtime was unavailable; no screenshot is fabricated.

- exact historical CVD still requires a venue trade archive;
- pixel Pine parity requires a synchronized export;
- touch/mitigation/invalidation extension modes currently extend right; event-terminated zone state is future work;
- TPO display downsampling sums finalized bracket counts because bracket identities are not serialized;
- color freeze is guaranteed for incremental updates; a deliberate full source rebuild may recompute robust profile bounds.

## BC-MEAP 2.1 shape restoration addendum

This section supersedes the 2.0 addendum's classification of the dynamic matrix as the default Auction Profile.

### Corrected architecture

- Auction Profile is now the default **range × price** renderer and consumes aggregate price rows.
- The professional **time × price** matrix is preserved as `CvdFootprintRenderer` and replaces the old synthetic Volume Footprint candle mode.
- Auction Profile, CVD Footprint, and Combined are explicit visualization choices.
- Bidirectional Delta is the default geometry; six additional profile geometries, five placements, eight width metrics, row-label policies, and optional internal time segmentation are available.
- Session, Fixed Start, Rolling, Visible, Composite, Periodic, Macro, and Manual scopes retain their calculation semantics.
- POC/VA/IB and restrained LVN/HVN context are bounded to each profile instead of extending chart-wide.

### Certification result

The exact `+3 / -4 / +6` matrix fixture remains certified. After a `-2` developing update, the aggregate profile certifies `+3 / -4 / +4` at the corresponding price rows. Tests prove one aggregate bar per row, negative-left/positive-right geometry, split geometry, opt-in internal segmentation, separate renderer contracts, conservation, finalized-history stability, worker incrementality, and data-quality honesty.

The latest local benchmark covers 100–20,000 bars. The 20,000-bar/2,029-row case completed a cold worker build in 2,212.89 ms, a warm build in 2,274.58 ms, and the restored profile projection in 2.63 ms. These remain machine-local preparation timings, not a browser FPS claim.

No database schema, broker execution, OMS/EMS, Black Cloud deployment, HDLX, Market Maker Heatmap, AIF, DOM Pro, or IMM calculation was changed by this corrective chapter. No Supabase migration is required.
