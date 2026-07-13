# Phase IV Chapter I - A.I.F. Long-Horizon Profile Engine

Status: Implemented foundation, chart-native production integration

## Purpose

A.I.F. is the Auction Intelligence Framework: a native proprietary analytical system for long-horizon accepted value, auction gaps, structural zones, projected LVNs, node interactions, and auction-event lifecycle research. It remains separate from HDLX. HDLX source, settings, visible identity, and output behavior were not modified.

The default experience deliberately shows one primary profile, one optional dim comparison profile, structural levels, a compact state summary, and a bottom event timeline. A.I.F. never emits orders.

## Runtime Flow

`native indicator -> historical coverage loader -> normalized arrays -> dedicated worker -> profile registry -> node/stability/confluence engine -> event/CHoB engine -> bounded cache -> render model -> chart overlay`

The loader pages the venue adapter independently of the visible chart window and supports truthful requests from 5,000 through 100,000 bars. Results disclose requested, available, effective, missing, and clamped coverage. Hidden A.I.F. terminates its worker and clears its in-memory cache.

## Delivered

- Versioned native manifest and Indicators-panel registration.
- Volume, estimated Delta, TPO, Volatility, and estimated Pressure lenses.
- Absorption remains `blocked-data` until classified flow and persistent depth are supplied.
- Shared linear/log auction domain and configurable 40-2,000 row buckets.
- Conserved volume allocation, zero-range handling, POC and value area.
- HVN/LVN and lens-specific nodes, deterministic IDs, nearby-lookback stability, secondary-profile confluence, S/R selection, and forward LVN extension.
- Deduplicated node-test sessions, rejection/acceptance scoring, intermediate swing, and explicit CHoB candidate/confirmation states.
- Optional IMM bridge that reports `UNAVAILABLE` rather than fabricating confirmation.
- Workspace/symbol settings and bounded local research memory.
- Incremental source coordination: current-bar corrections coalesce for five seconds, completed bars append immediately, the expired lookback bar is removed, source versions invalidate stale work, and settings/range changes rebuild from retained history.

## Limitations

- Candle-derived Delta and Pressure are estimates, not aggressor-classified truth.
- TPO reflects source-period range visits; it is not exchange floor-letter data.
- IMM confirmation is unavailable unless IMM memory is explicitly included in a future calculation payload.
- A browser cannot conceal shipped client code from an authorized user. Proprietary enforcement must ultimately place sensitive models server-side or in signed native modules.

## Validation

`npm run test:aif`, `npm run benchmark:aif`, `npm run test:performance`, and `npm run build` are the required gates. The frozen HDLX regression fixture is part of `test:aif`.
