# Phase V Chapter III-C4 completion report

## Outcome

The live-path model is corrected, certified against deterministic
production-path fixtures and a bounded public Bybit replay, and published as
the verified V6 production bundle. Authenticated visual capture remains pending.

## Implemented

- immutable `AbsoluteLiquidationDistribution` and controller-generation grid;
- V6 model/source version;
- bounded OI event window with continuation, termination, and hysteresis;
- raw mass separated from visual confidence;
- unresolved mark traversal no longer fabricates a 10% liquidation;
- expanding causal normalization and 12% bounded viewport contrast;
- explicit no-yellow rule for browser historical OI-only context;
- internal raw shelf renderer and machine-readable raw export;
- 20-cell raw/global/column/cohort/leverage/margin/evidence audit;
- full worker protocol support for an explicit absolute grid;
- same-checksum/version cache contract retained;
- BCLIF API function consolidated behind an external-path-preserving Vercel
  rewrite to keep the Hobby deployment at 12 functions.

## Deterministic evidence

`npm run test:bclif-live-pipeline`:

- decision: PASS
- perturbations: 62k, 66k, 70k, 60k, 75k
- model hash: `fnv1a-0347f693`
- exposure hash: `fnv1a-3e1e8b7c`
- raw shelves: 4
- browser historical yellow cells: 0
- high-intensity cells audited: 20
- OI event families from three related increases: 1

Existing authentic-exposure and operational-clarity suites also pass.
Application TypeScript and strict collector TypeScript pass.

Bounded public Bybit replay:

- decision: PASS
- 24 five-minute frames / 2 hours / 100% OI transport coverage
- model hash: `fnv1a-59ef9777`
- exposure hash: `fnv1a-bc049a0e`
- truthful historical trade / liquidation / order-book coverage: 0% / 0% / 0%
- raw shelves in this market window: 0; no synthetic shelf was introduced

Measured deterministic Node performance:

| Stage | p50 | p95 | p99 |
| --- | ---: | ---: | ---: |
| Cohort/event update | 0.248 ms | 1.000 ms | 2.245 ms |
| Lifecycle update | 0.069 ms | 0.102 ms | 0.285 ms |
| Exposure raster | 196.963 ms | 221.904 ms | 221.904 ms |
| Display projection | 202.697 ms | 262.575 ms | 263.467 ms |
| GPU-upload preparation (CPU staging) | 4.487 ms | 15.392 ms | 19.531 ms |

Actual browser GPU upload/FPS is not inferred from these Node measurements.

## Deployment truth

The original alias served V3 at deployment
`dpl_69nieZzvsMAatfKSTqp7DEShiBc1` (inferred commit `921c7a2`). A clean
`d63d30f` V5 build passed every build gate but publication was rejected because
13 functions exceeded the Hobby limit.

Corrected code commit `541c6d37d9e5721637ccd6296855676815c32e71` is now
published at production deployment `dpl_6JXKDs5GVwXjbYrefT5BGyPuuXVs` and
aliased to both `black-terminal.live` and `www.black-terminal.live`. Vercel
reports `READY`; the apex redirects to `www` and the canonical page returns 200.

- production application asset: `index-BqyBsMPl.js`
- asset SHA-256: `d31c7be87ae1643b846f5c3b4e07e6cc6c0b978e3c6432d8e73ec638fed40708`
- verified signatures: V6 model/source, raw shelf toggle, raw export hook
- external BCLIF status path: secured 401 without a token, not 404
- production build: TypeScript, 27 route contracts, Vite, and 26-asset secret
  audit PASS

The packaging correction preserved the public BCLIF URL while remaining within
the 12-function Hobby limit.

## Deferred / not claimed

- authenticated production browser capture: NOT RUN
- persistent replay: NOT AVAILABLE
- migration/RLS runtime: NOT RUN
- collector soak: 0 hours

## Infrastructure state

- PERSISTENT HOST NOT PROVIDED
- COLLECTOR NOT DEPLOYED
- MIGRATIONS NOT APPLIED
- AUTHORITY BROWSER FALLBACK
- PRODUCTION MODEL V6 DEPLOYED

## Final verdict

**LIVE MODEL CORRECTED.** The production alias runs the inspected V6 bundle and
the absolute-shelf/event-window/normalization contracts pass deterministic and
public replay evidence. Authenticated visual certification is explicitly still
NOT RUN, so this verdict does not claim user-session screenshot parity.
